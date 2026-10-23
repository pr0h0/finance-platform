// The web app running inside the Tauri shell (apps/native): desktop (Linux/Windows/macOS) and mobile
// (Android/iOS). Everything here is a no-op in a browser; the Tauri packages are imported lazily so the
// web bundle does not load them. What changes in the native app:
//   - storage: MemoryStore persisted to SQLite (apps/native/src-tauri/src/store.rs), not IndexedDB;
//   - network: tauri-plugin-http (no CORS), so the app can talk to any compatible server;
//   - auth: a bearer token for this device (native devices get one at sign-in), not a cookie;
//   - no service worker / Web Push / passkeys (WebAuthn is bound to the server's web origin).
import { MemoryStore, type StoreCommit, type StorePersistence } from '@finplat/storage';

export const isNative = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type NativePlatform = 'linux' | 'windows' | 'macos' | 'android' | 'ios' | 'other';

let httpFetch: typeof fetch | undefined;
let platform: NativePlatform = 'other';

/** Loads the native bridges. Awaited once before the app renders (main.tsx). */
export async function initNative(): Promise<void> {
  if (!isNative) return;
  const [http, os] = await Promise.all([
    import('@tauri-apps/plugin-http'),
    import('@tauri-apps/plugin-os'),
  ]);
  httpFetch = http.fetch as typeof fetch;
  const p = os.platform();
  platform = (['linux', 'windows', 'macos', 'android', 'ios'] as string[]).includes(p)
    ? (p as NativePlatform)
    : 'other';
  document.documentElement.dataset.platform = platform;
  if (platform === 'android') await handleAndroidBack();
  await initKeychain();
  // Links to other sites open in the system browser: inside the app window they would replace the app.
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented) return;
      const url = new URL(a.href, location.href);
      if (url.origin === location.origin || !/^(https?|mailto):$/.test(url.protocol)) return;
      e.preventDefault();
      openExternal(url.href).catch(() => undefined);
    },
    true,
  );
}

export const nativePlatform = (): NativePlatform => platform;

/** Device registration sent with the native sign-in: the server answers with a bearer token. */
export const nativeDevice = () => ({
  name: `Finance Platform (${platform})`,
  platform,
  clientVersion: '0.1.0',
});
export const isMobileNative = () => platform === 'android' || platform === 'ios';
export const isDesktopNative = () => isNative && !isMobileNative() && platform !== 'other';

/** Desktop: is the app started at login (tauri-plugin-autostart)? */
export async function autostartEnabled(): Promise<boolean> {
  return (await import('@tauri-apps/plugin-autostart')).isEnabled();
}
export async function setAutostart(on: boolean): Promise<void> {
  const a = await import('@tauri-apps/plugin-autostart');
  await (on ? a.enable() : a.disable());
}

/** fetch for the API: Rust-side HTTP in the native app, the browser's fetch on the web. */
export const appFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  (httpFetch ?? fetch)(input, init)) as typeof fetch;

/** Android back button / gesture. The WebView does not treat the app's own page changes as history
 * (back would close the app), so: close an open dialog or drawer, else go back in the app's
 * history, else go to the dashboard, and only there leave the app. */
async function handleAndroidBack() {
  const { onBackButtonPress, exit } = await import('@tauri-apps/api/app');
  await onBackButtonPress(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (dialog) {
      dialog.dispatchEvent(new Event('cancel')); // the app's <dialog> closes on cancel
      return;
    }
    if (document.querySelector('[role="dialog"]')) {
      // Radix dialogs, menus and the navigation drawer close on Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    const idx = (history.state as { idx?: number } | null)?.idx ?? 0; // react-router's history index
    if (idx > 0) history.back();
    else if (location.pathname !== '/') {
      history.replaceState(history.state, '', '/');
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } else void exit(0);
  });
}

// ------------------------------------------------------------ OS credential store

// The server's bearer token lives in the OS credential store (Keychain, Credential Manager, Secret
// Service) when there is one; app/store.ts then keeps it out of localStorage. Without a usable store
// (Android, a Linux session without Secret Service) it stays in the app's private storage.
const TOKEN_KEY = 'server-token';
let keychain = false;
let keychainToken: string | undefined;

async function secret<T>(cmd: string, args: Record<string, unknown>) {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

async function initKeychain() {
  if (platform === 'android' || platform === 'other') return;
  try {
    keychainToken = (await secret<string | null>('secret_get', { key: TOKEN_KEY })) ?? undefined;
    keychain = true;
  } catch {
    keychain = false; // no credential store: keep using app storage
  }
}

/** True when the token is kept in the OS credential store instead of localStorage. */
export const keychainInUse = () => keychain;
/** The token read from the credential store at start (app/store.ts puts it back into the state). */
export const keychainServerToken = () => keychainToken;
/** Stores (or with undefined removes) the token in the credential store. */
export function saveServerToken(token: string | undefined): void {
  if (!keychain || token === keychainToken) return;
  keychainToken = token;
  const done = token
    ? secret('secret_set', { key: TOKEN_KEY, value: token })
    : secret('secret_delete', { key: TOKEN_KEY });
  done.catch((e) => console.error('credential store', e));
}

// ------------------------------------------------------------ storage

/** Binary values (attachments, original statement files) cannot travel as JSON: tag them. */
type Tagged = { $bin: 'blob' | 'buffer' | 'bytes'; type?: string; b64: string };

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Deep copy with Blobs/ArrayBuffers replaced by tagged base64 (async: Blobs are read). */
async function encodeValue(v: unknown): Promise<unknown> {
  if (v instanceof Blob)
    return {
      $bin: 'blob',
      type: v.type,
      b64: toB64(new Uint8Array(await v.arrayBuffer())),
    } satisfies Tagged;
  if (v instanceof ArrayBuffer)
    return { $bin: 'buffer', b64: toB64(new Uint8Array(v)) } satisfies Tagged;
  if (ArrayBuffer.isView(v))
    return {
      $bin: 'bytes',
      b64: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)),
    } satisfies Tagged;
  if (Array.isArray(v)) return Promise.all(v.map(encodeValue));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = await encodeValue(x);
    return out;
  }
  return v;
}

export async function encodeRow(row: unknown): Promise<string> {
  return JSON.stringify(await encodeValue(row));
}

/** JSON.parse reviver for encodeRow output. */
export function reviveBinary(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && '$bin' in v && 'b64' in v) {
    const t = v as Tagged;
    const bytes = fromB64(t.b64);
    if (t.$bin === 'blob') return new Blob([bytes], { type: t.type ?? '' });
    if (t.$bin === 'buffer') return bytes.buffer;
    return bytes;
  }
  return v;
}

/** StorePersistence on the Tauri store_* commands (one SQLite file per store name). */
export function sqlitePersistence(name: string): StorePersistence {
  const invoke = async <T>(cmd: string, args: Record<string, unknown>) =>
    (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
  return {
    async load() {
      const json = await invoke<string | null>('store_load', { name });
      return json ? JSON.parse(json, reviveBinary) : null;
    },
    async commit(c: StoreCommit) {
      const changes = await Promise.all(
        c.changes.map(async (ch) => ({
          table: ch.table,
          key: ch.key,
          row: ch.row ? await encodeRow(ch.row) : null,
        })),
      );
      await invoke('store_commit', { name, commit: { version: c.version, seq: c.seq, changes } });
    },
    async destroy() {
      await invoke('store_destroy', { name });
    },
  };
}

/** The LocalStore of the native app for one store name (local mode or one server cache). */
export const nativeStore = (name: string) => new MemoryStore(undefined, sqlitePersistence(name));

// ------------------------------------------------------------ desktop / mobile integration

/** Calls fn when the tray menu or the global shortcut asks for quick entry (desktop). */
export async function onNativeQuickAdd(fn: () => void): Promise<() => void> {
  if (!isNative) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('native:quick-add', fn);
}

/** Opens a link in the system browser (inside the app window a link would replace the app). */
export async function openExternal(url: string): Promise<void> {
  if (!isNative) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  await (await import('@tauri-apps/plugin-opener')).openUrl(url);
}

/** Saves a file through the OS save dialog (native app; a WebView ignores <a download>). Resolves
 * false when the user cancelled. fs may write only the path chosen in the dialog. */
export async function nativeSave(name: string, blob: Blob): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({ defaultPath: name });
  if (!path) return false;
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

/** OS notification (native app), when the user allowed it. Returns false when not shown. */
export async function nativeNotify(title: string, body: string): Promise<boolean> {
  if (!isNative) return false;
  const n = await import('@tauri-apps/plugin-notification');
  let ok = await n.isPermissionGranted();
  if (!ok) ok = (await n.requestPermission()) === 'granted';
  if (ok) n.sendNotification({ title, body });
  return ok;
}

/** Permission for OS notifications in the native app ('default' = not asked yet). */
export async function nativeNotifyPermission(ask: boolean): Promise<NotificationPermission> {
  const n = await import('@tauri-apps/plugin-notification');
  if (await n.isPermissionGranted()) return 'granted';
  return ask ? n.requestPermission() : 'default';
}

/** Fingerprint / Face ID check (mobile). Resolves false when unavailable or cancelled. */
export async function biometricUnlock(reason: string): Promise<boolean> {
  if (!isMobileNative()) return false;
  try {
    const b = await import('@tauri-apps/plugin-biometric');
    if (!(await b.checkStatus()).isAvailable) return false;
    await b.authenticate(reason, { allowDeviceCredential: true });
    return true;
  } catch {
    return false;
  }
}

export async function biometricAvailable(): Promise<boolean> {
  if (!isMobileNative()) return false;
  try {
    return (await (await import('@tauri-apps/plugin-biometric')).checkStatus()).isAvailable;
  } catch {
    return false;
  }
}
