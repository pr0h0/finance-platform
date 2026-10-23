// Server connection building blocks shared by onboarding and Settings → Connection (feature
// 106/107): validate a server URL (/api/v1/meta + compatibility), show its identity for an
// explicit trust decision, then sign in or register and enroll this browser as a device.
import { type ApiClient, normalizeServerUrl } from '@finplat/api-client';
import type { ServerMeta } from '@finplat/domain';
import { type FormEvent, useEffect, useState } from 'react';
import { makeApi, rememberSignInToken } from '../app/data.tsx';
import {
  Badge,
  Button,
  Checkbox,
  DefinitionList,
  ErrorBox,
  Field,
  Input,
  Notice,
  Tabs,
} from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';
import {
  cancelPasskeyCeremony,
  passkeyAutofillSupported,
  passkeysSupported,
  signInWithPasskey,
} from '../lib/passkeys.ts';
import { fetchServerStatus } from '../lib/server-status.ts';
import { isNative, nativeDevice } from '../platform/native.ts';

export interface VerifiedServer {
  /** '' when the server is this web app's own origin */
  baseUrl: string;
  display: string;
  meta: ServerMeta;
}

/** '' for this origin, otherwise the normalized URL. */
export function toBaseUrl(normalized: string, origin = globalThis.location?.origin ?? ''): string {
  return normalized === origin || normalized === `${origin}/` ? '' : normalized;
}

export function ServerStep({ onVerified }: { onVerified: (s: VerifiedServer) => void }) {
  const t = useT();
  // the native app has no server of its own: the user types one in
  const [url, setUrl] = useState(isNative ? '' : (globalThis.location?.origin ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<VerifiedServer | null>(null);
  const [trust, setTrust] = useState(false);
  const [elsewhere, setElsewhere] = useState<string | null>(null);

  async function check(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setServer(null);
    setTrust(false);
    setElsewhere(null);
    const n = normalizeServerUrl(url);
    if (!n.ok) {
      setError(n.reason);
      return;
    }
    const baseUrl = toBaseUrl(n.url);
    // The browser app talks only to the server that serves it: its CSP (connect-src 'self') and
    // SameSite session cookies rule out another origin. Every server ships this web app.
    // The native app reaches any server (HTTP from Rust, bearer token).
    if (baseUrl && !isNative) {
      setElsewhere(n.url);
      return;
    }
    setBusy(true);
    const st = await fetchServerStatus(baseUrl);
    setBusy(false);
    if (st.state === 'ok') setServer({ baseUrl, display: n.url, meta: st.meta });
    else if (st.state === 'incompatible')
      setError(
        t('server.incompatible', 'This server is not compatible: {{reason}}', {
          reason: st.reason,
        }),
      );
    else if (st.state === 'unreachable')
      setError(
        `${t('server.unreachable', 'The server cannot be reached.')} ${st.reason}${
          baseUrl
            ? ` ${t('server.crossOrigin', 'Servers on another address must allow this web app (CORS/CSP); otherwise open that server’s own web app.')}`
            : ''
        }`,
      );
  }

  const host = server ? new URL(server.display).host : '';
  const publicHost = server?.meta.publicUrl ? safeHost(server.meta.publicUrl) : null;

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={check} className="flex flex-col gap-3">
        <Field
          label={t('server.url', 'Server URL')}
          hint={t(
            'server.urlHint',
            'https only (http is allowed for localhost during development).',
          )}
          error={error}
        >
          <Input
            type="url"
            inputMode="url"
            autoComplete="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Button type="submit" busy={busy} className="self-start justify-self-start">
          {t('server.check', 'Check server')}
        </Button>
      </form>
      {elsewhere && (
        <Notice tone="accent" title={t('server.elsewhereTitle', 'Use that server’s own web app')}>
          <p>
            {t(
              'server.elsewhere',
              'This web app connects to the server it is served from. Every compatible server serves the same app at its own address; open it there. Data on this device stays here (move it with an encrypted backup, or activate sync after signing in there).',
            )}
          </p>
          <a className="font-medium underline" href={elsewhere} rel="noopener">
            {t('server.openThere', 'Open {{url}}', { url: elsewhere })}
          </a>
        </Notice>
      )}
      {server && (
        <div className="flex flex-col gap-3 rounded-md border border-line p-3">
          <p className="text-sm font-medium">
            {t('server.identity', 'Server identity')}{' '}
            <Badge tone="pos">{t('server.compatible', 'compatible')}</Badge>
          </p>
          <DefinitionList
            items={[
              [t('server.address', 'Address'), server.display],
              [
                t('server.software', 'Software'),
                `${server.meta.name} API ${server.meta.apiVersion}`,
              ],
              [
                t('server.schema', 'Schema / sync protocol'),
                `${server.meta.schemaVersion} / v${server.meta.syncProtocolVersion}`,
              ],
              [t('server.public', 'Announced public URL'), server.meta.publicUrl ?? '—'],
              [t('server.registration', 'Registration'), server.meta.registrationPolicy ?? '—'],
            ]}
          />
          {publicHost && publicHost !== host && (
            <Notice tone="warn" title={t('server.mismatch', 'Address mismatch')}>
              {t(
                'server.mismatchText',
                'The server announces {{a}} but you entered {{b}}. Continue only if you expected this.',
                { a: publicHost, b: host },
              )}
            </Notice>
          )}
          <Checkbox
            checked={trust}
            onChange={(e) => setTrust(e.target.checked)}
            label={t('server.trust', 'I trust {{host}} with my financial data', { host })}
            hint={t(
              'server.trustHint',
              'Profiles you synchronize are uploaded to this server. Its operator can read them unless you enable end-to-end encryption.',
            )}
          />
          <Button
            variant="primary"
            className="self-start justify-self-start"
            disabled={!trust}
            onClick={() => onVerified(server)}
          >
            {t('common.continue', 'Continue')}
          </Button>
        </div>
      )}
    </div>
  );
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

export interface SignedIn {
  api: ApiClient;
  deviceId: string;
  email: string;
  isAdmin: boolean;
  /** native app: this device's bearer token */
  token?: string;
  /** the account was created in this step (it holds only the server's default profile) */
  registered?: boolean;
}

export function deviceName(ua = globalThis.navigator?.userAgent ?? ''): string {
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

type LoginResponse = Awaited<ReturnType<ApiClient['login']>>;

/** Browser-side passkey outcomes (dismissed, aborted): not worth an error box for autofill. */
const browserSide = (e: unknown) =>
  /^passkey_(aborted|cancelled)$/.test((e as { code?: string })?.code ?? '');

/** "Sign in with passkey" (or a note when this browser has no WebAuthn). */
export function PasskeySignIn({
  api,
  email,
  onSignedIn,
}: {
  api: () => ApiClient;
  email?: string;
  onSignedIn: (api: ApiClient, res: LoginResponse) => Promise<void> | void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!passkeysSupported())
    return (
      <p className="text-xs text-muted">
        {t(
          'passkey.unsupported',
          'This browser does not support passkeys. Sign in with your password.',
        )}
      </p>
    );
  async function go() {
    setBusy(true);
    setError(null);
    const a = api();
    try {
      await onSignedIn(a, await signInWithPasskey(a, { email: email || undefined }));
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" busy={busy} onClick={go} className="self-start justify-self-start">
        {t('passkey.signIn', 'Sign in with passkey')}
      </Button>
      <ErrorBox error={error} />
    </div>
  );
}

export function AuthStep({
  server,
  onSignedIn,
}: {
  server: VerifiedServer;
  onSignedIn: (s: SignedIn) => void;
}) {
  const t = useT();
  const policy = server.meta.registrationPolicy;
  const canRegister = policy === 'open' || policy === 'first_user';
  const [tab, setTab] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const api = makeApi(server.baseUrl);
    try {
      if (tab === 'register')
        await api.request('POST', '/api/v1/auth/register', {
          email,
          password,
          displayName: displayName || undefined,
          setupToken: setupToken || undefined,
        });
      if (isNative) {
        // a native device is registered with the sign-in and gets a bearer token
        const res = await api.login({ email, password, device: nativeDevice() });
        rememberSignInToken(res.token);
        onSignedIn({
          api,
          deviceId: res.deviceId ?? '',
          email: res.user?.email ?? email,
          isAdmin: !!res.user?.isAdmin,
          ...(res.token ? { token: res.token } : {}),
          registered: tab === 'register',
        });
      } else await enroll(api, await api.login({ email, password }));
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  }

  async function enroll(api: ApiClient, res: LoginResponse) {
    const dev = await api.request<{ id: string }>('POST', '/api/v1/devices', {
      name: deviceName(),
      platform: 'web',
      clientVersion: '0.0.0',
    });
    onSignedIn({
      api,
      deviceId: dev.id,
      email: res.user?.email ?? email,
      isAdmin: !!res.user?.isAdmin,
      registered: tab === 'register',
    });
  }

  // Passkey autofill (conditional mediation) while the sign-in form is shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart only when the form changes
  useEffect(() => {
    if (tab !== 'login' || !passkeysSupported()) return;
    let live = true;
    passkeyAutofillSupported().then((ok) => {
      if (!ok || !live) return;
      const api = makeApi(server.baseUrl);
      signInWithPasskey(api, { autofill: true })
        .then((res) => (live ? enroll(api, res) : undefined))
        .catch((x) => {
          if (live && !browserSide(x)) setError(x);
        });
    });
    return () => {
      live = false;
      cancelPasskeyCeremony();
    };
  }, [tab, server.baseUrl]);

  const form = (register: boolean) => (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label={t('auth.email', 'Email')}>
        <Input
          type="email"
          autoComplete={register ? 'email' : 'username webauthn'}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      {register && server.meta.setupTokenRequired && (
        <Field
          label={t('auth.setupToken', 'Setup token')}
          hint={t(
            'auth.setupTokenHint',
            'Shown in the server log (or SETUP_TOKEN in .env). Needed only for the first account.',
          )}
        >
          <Input
            autoComplete="off"
            required
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
          />
        </Field>
      )}
      {register && (
        <Field label={t('auth.displayName', 'Display name (optional)')}>
          <Input
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
      )}
      <Field
        label={t('auth.password', 'Password')}
        hint={register ? t('auth.passwordHint', 'At least 12 characters.') : undefined}
      >
        <Input
          type="password"
          autoComplete={register ? 'new-password' : 'current-password'}
          required
          minLength={register ? 12 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" busy={busy} className="self-start justify-self-start">
        {register ? t('auth.register', 'Create account') : t('auth.signIn', 'Sign in')}
      </Button>
      {!register && (
        <PasskeySignIn api={() => makeApi(server.baseUrl)} email={email} onSignedIn={enroll} />
      )}
    </form>
  );

  if (!canRegister) return form(false);
  return (
    <Tabs
      label={t('auth.title', 'Account')}
      value={tab}
      onValueChange={setTab}
      tabs={[
        { value: 'login', label: t('auth.signIn', 'Sign in'), content: form(false) },
        {
          value: 'register',
          label: t('auth.register', 'Create account'),
          content: (
            <>
              {policy === 'first_user' && (
                <p className="mb-3 text-sm text-muted">
                  {t(
                    'auth.firstUser',
                    'The first account on this server becomes its administrator.',
                  )}
                </p>
              )}
              {form(true)}
            </>
          ),
        },
      ]}
    />
  );
}
