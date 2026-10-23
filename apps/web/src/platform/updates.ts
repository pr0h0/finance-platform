// Native app updates. Desktop: tauri-plugin-updater reads plugins.updater.endpoints (tauri.conf.json),
// downloads the bundle and installs it only if its signature matches the built-in public key.
// Android cannot replace itself: android.json next to latest.json names the newest signed APK, which
// the system browser downloads and the package installer installs over the old one (same signing key).
// Published by scripts/release.sh into the gateway's /downloads/.
import { appFetch, isMobileNative, isNative, openExternal } from './native.ts';

const ANDROID_FEED = 'https://fin.pr0h0.me/downloads/android.json'; // same host as the desktop feed

export interface AppUpdate {
  version: string;
  notes?: string;
  /** desktop: download, install and restart; Android: open the APK download */
  install: () => Promise<void>;
}

/** "1.10.0" > "1.9.2"; pre-release suffixes are ignored. */
export function newer(a: string, b: string): boolean {
  const n = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((x) => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export async function checkForUpdate(): Promise<AppUpdate | null> {
  if (!isNative) return null;
  const { platform } = await import('@tauri-apps/plugin-os');
  if (platform() === 'android') {
    const res = await appFetch(ANDROID_FEED, { cache: 'no-store' });
    if (!res.ok) return null; // nothing published yet
    const feed = (await res.json()) as { version: string; url: string; notes?: string };
    const { getVersion } = await import('@tauri-apps/api/app');
    if (!newer(feed.version, await getVersion())) return null;
    return { version: feed.version, notes: feed.notes, install: () => openExternal(feed.url) };
  }
  if (isMobileNative()) return null; // iOS: the App Store / TestFlight updates the app
  const { check } = await import('@tauri-apps/plugin-updater');
  const u = await check();
  if (!u) return null;
  return {
    version: u.version,
    notes: u.body,
    install: async () => {
      await u.downloadAndInstall();
      await (await import('@tauri-apps/plugin-process')).relaunch();
    },
  };
}
