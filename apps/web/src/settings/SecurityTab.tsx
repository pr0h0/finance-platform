// App lock (feature 91) and, in connected mode, the server account: password, recovery codes,
// passkeys, sessions, sign-out (sign-out never deletes local data).
import type { Schemas } from '@finplat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorBox,
  Field,
  Input,
  Notice,
  Select,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { useFormat } from '../lib/format.ts';
import { tNow, useT } from '../lib/i18n.ts';
import { addPasskey, passkeysSupported } from '../lib/passkeys.ts';
import { deviceName } from '../onboarding/connect.tsx';
import { hashSecret } from '../shell/AppLock.tsx';

/** PIN: 4–12 digits. Password: at least 8 characters. Returns an error message or null. */
export function validateLockSecret(kind: 'pin' | 'password', a: string, b: string): string | null {
  if (kind === 'pin' && !/^\d{4,12}$/.test(a))
    return tNow('security.lock.pinInvalid', 'The PIN must be 4–12 digits.');
  if (kind === 'password' && a.length < 8)
    return tNow('security.lock.passwordShort', 'The password must have at least 8 characters.');
  if (a !== b) return tNow('security.lock.mismatch', 'The two entries do not match.');
  return null;
}

function LockCard() {
  const t = useT();
  const lock = useApp((s) => s.lock);
  const setApp = useApp((s) => s.set);
  const [kind, setKind] = useState<'pin' | 'password'>(lock?.kind ?? 'pin');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [minutes, setMinutes] = useState(lock?.autoLockMinutes ?? 5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const v = validateLockSecret(kind, a, b);
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    try {
      const hash = await hashSecret(a);
      setApp({ lock: { hash, kind, autoLockMinutes: minutes } });
      setA('');
      setB('');
      setError(null);
      toast(t('lock.enabled', 'App lock enabled'));
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('lock.settings', 'App lock')}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'lock.explain',
          'Requires a PIN or password when the app is opened and after inactivity. It hides the interface; it does not encrypt data stored in the browser. Biometric unlock is available in the desktop and mobile apps.',
        )}
      </p>
      {lock && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone="pos">{t('lock.on', 'Enabled ({{kind}})', { kind: lock.kind })}</Badge>
          <Field label={t('lock.auto', 'Lock after inactivity')} className="w-48">
            <Select
              value={lock.autoLockMinutes}
              onChange={(e) =>
                setApp({ lock: { ...lock, autoLockMinutes: Number(e.target.value) } })
              }
            >
              {[1, 5, 15, 30, 60, 0].map((m) => (
                <option key={m} value={m}>
                  {m
                    ? t('lock.minutes', '{{m}} minutes', { m })
                    : t('lock.onReload', 'Only when reopened')}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="ghost" className="text-neg" onClick={() => setApp({ lock: null })}>
            {t('lock.remove', 'Turn off')}
          </Button>
        </div>
      )}
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('lock.kind', 'Type')}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'pin' | 'password')}>
            <option value="pin">{t('lock.pin', 'PIN')}</option>
            <option value="password">{t('lock.password', 'Password')}</option>
          </Select>
        </Field>
        {!lock && (
          <Field label={t('lock.auto', 'Lock after inactivity')}>
            <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {[1, 5, 15, 30, 60, 0].map((m) => (
                <option key={m} value={m}>
                  {m
                    ? t('lock.minutes', '{{m}} minutes', { m })
                    : t('lock.onReload', 'Only when reopened')}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          label={lock ? t('lock.new', 'New PIN or password') : t('lock.secret', 'PIN or password')}
        >
          <Input
            type="password"
            autoComplete="new-password"
            inputMode={kind === 'pin' ? 'numeric' : undefined}
            value={a}
            onChange={(e) => setA(e.target.value)}
          />
        </Field>
        <Field label={t('lock.repeat', 'Repeat')} error={error}>
          <Input
            type="password"
            autoComplete="new-password"
            inputMode={kind === 'pin' ? 'numeric' : undefined}
            value={b}
            onChange={(e) => setB(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          className="self-start justify-self-start"
        >
          {lock ? t('lock.change', 'Change') : t('lock.enable', 'Enable lock')}
        </Button>
      </form>
    </Card>
  );
}

function PasskeysCard() {
  const t = useT();
  const fmt = useFormat();
  const { api } = useData();
  const qc = useQueryClient();
  const [name, setName] = useState(() => deviceName());
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<Schemas['Passkey'] | null>(null);
  const key = ['server', 'passkeys'];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      api
        ?.request<{ items: Schemas['Passkey'][] }>('GET', '/api/v1/auth/passkeys')
        .then((r) => r.items) ?? [],
    enabled: !!api,
  });
  const done = () => qc.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: () =>
      api ? addPasskey(api, name.trim(), password || undefined) : Promise.reject(),
    onSuccess: () => {
      setPassword('');
      toast(t('passkey.added', 'Passkey added'));
      done();
    },
  });
  const rename = useMutation({
    mutationFn: (p: { id: string; name: string }) =>
      api?.request('PATCH', `/api/v1/auth/passkeys/${p.id}`, { name: p.name }) ?? Promise.resolve(),
    onSuccess: () => {
      setEditing(null);
      done();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api?.request('DELETE', `/api/v1/auth/passkeys/${id}`) ?? Promise.resolve(),
    onSuccess: () => {
      setRemoving(null);
      toast(t('passkey.removed', 'Passkey removed'));
      done();
    },
  });
  const items = list.data ?? [];
  return (
    <Card title={t('passkey.title', 'Passkeys')}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'passkey.explain',
          'Sign in with your fingerprint, face, screen lock or a security key instead of typing your password. Your password keeps working.',
        )}
      </p>
      {items.length > 0 && (
        <div className="mb-3 overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th>{t('passkey.name', 'Passkey name')}</th>
                <th>{t('passkey.created', 'Added')}</th>
                <th>{t('passkey.lastUsed', 'Last used')}</th>
                <th>
                  <span className="sr-only">{t('common.actions', 'Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((k) => (
                <tr key={k.id}>
                  <td>
                    {editing?.id === k.id ? (
                      <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          rename.mutate(editing);
                        }}
                      >
                        <Input
                          aria-label={t('passkey.name', 'Passkey name')}
                          autoFocus
                          required
                          maxLength={100}
                          value={editing.name}
                          onChange={(e) => setEditing({ id: k.id, name: e.target.value })}
                        />
                        <Button type="submit" size="sm" busy={rename.isPending}>
                          {t('common.save', 'Save')}
                        </Button>
                      </form>
                    ) : (
                      <>
                        {k.name}{' '}
                        {k.backupEligible && <Badge>{t('passkey.synced', 'synced')}</Badge>}
                      </>
                    )}
                  </td>
                  <td>{fmt.dateTime(k.createdAt)}</td>
                  <td>{k.lastUsedAt ? fmt.dateTime(k.lastUsedAt) : t('passkey.never', 'Never')}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('passkey.renameNamed', 'Rename {{name}}', { name: k.name })}
                      onClick={() => setEditing({ id: k.id, name: k.name })}
                    >
                      {t('passkey.rename', 'Rename')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-neg"
                      aria-label={t('passkey.removeNamed', 'Remove {{name}}', { name: k.name })}
                      onClick={() => setRemoving(k)}
                    >
                      {t('passkey.remove', 'Remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {passkeysSupported() ? (
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label={t('passkey.newName', 'Name for the new passkey')}>
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label={t('passkey.password', 'Current password')}
            hint={t('passkey.passwordHint', 'Needed if you signed in more than 10 minutes ago.')}
          >
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" busy={add.isPending}>
            {t('passkey.add', 'Add passkey')}
          </Button>
        </form>
      ) : (
        <Notice tone="warn" title={t('passkey.unsupportedTitle', 'Passkeys are not available')}>
          {t(
            'passkey.unsupportedHere',
            'This browser does not support passkeys (WebAuthn). Use a current browser to add one.',
          )}
        </Notice>
      )}
      <div className="mt-2">
        <ErrorBox error={list.error ?? add.error ?? rename.error ?? remove.error} />
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('passkey.removeTitle', 'Remove passkey?')}
        confirmLabel={t('passkey.remove', 'Remove')}
        danger
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      >
        {t(
          'passkey.removeText',
          '“{{name}}” will no longer sign you in. Also delete it from your device or password manager.',
          { name: removing?.name ?? '' },
        )}
      </ConfirmDialog>
    </Card>
  );
}

function AccountCard() {
  const t = useT();
  const fmt = useFormat();
  const { api, user, reload } = useData();
  const qc = useQueryClient();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const sessions = useQuery({
    queryKey: ['server', 'sessions'],
    queryFn: () =>
      api
        ?.request<{ items: Schemas['Session'][] }>('GET', '/api/v1/sessions')
        .then((r) => r.items) ?? [],
    enabled: !!api,
  });
  const pw = useMutation({
    mutationFn: () =>
      api?.request('POST', '/api/v1/auth/password', { currentPassword: cur, newPassword: next }) ??
      Promise.resolve(),
    onSuccess: () => {
      setCur('');
      setNext('');
      toast(t('auth.pwChanged', 'Password changed'));
    },
  });
  const rc = useMutation({
    mutationFn: () =>
      api?.request<{ codes: string[] }>('POST', '/api/v1/auth/recovery-codes') ??
      Promise.resolve({ codes: [] }),
    onSuccess: (r) => setCodes(r.codes),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api?.request('DELETE', `/api/v1/sessions/${id}`) ?? Promise.resolve(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['server', 'sessions'] }),
  });
  const logout = useMutation({
    mutationFn: () => api?.logout() ?? Promise.resolve(),
    onSuccess: () => reload(),
  });
  if (!api) return null;
  return (
    <>
      <Card
        title={t('auth.account', 'Server account')}
        actions={
          <Button size="sm" busy={logout.isPending} onClick={() => logout.mutate()}>
            {t('auth.signOut', 'Sign out')}
          </Button>
        }
      >
        <p className="text-sm">
          {user?.email}{' '}
          {user?.isAdmin && <Badge tone="accent">{t('settings.securityTab.admin', 'admin')}</Badge>}
        </p>
        <p className="mt-1 text-xs text-muted">
          {t(
            'auth.signOutNote',
            'Signing out keeps all data on this device. Sign in again to resume syncing.',
          )}
        </p>
        <ErrorBox error={logout.error} />
      </Card>
      <Card title={t('auth.changePw', 'Change password')}>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            pw.mutate();
          }}
        >
          <Field label={t('auth.currentPw', 'Current password')}>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={cur}
              onChange={(e) => setCur(e.target.value)}
            />
          </Field>
          <Field label={t('auth.newPw', 'New password (12+ characters)')}>
            <Input
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Button type="submit" busy={pw.isPending}>
            {t('common.save', 'Save')}
          </Button>
        </form>
        <div className="mt-2">
          <ErrorBox error={pw.error} />
        </div>
      </Card>
      <PasskeysCard />
      <Card title={t('auth.recovery', 'Account recovery codes')}>
        <p className="text-sm text-muted">
          {t(
            'auth.recoveryText',
            'One-time codes to reset your password without email. Generating new codes invalidates the old ones.',
          )}
        </p>
        {codes ? (
          <Notice
            tone="warn"
            title={t('auth.recoveryOnce', 'Shown only once. Store them somewhere safe.')}
          >
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-fg">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Notice>
        ) : (
          <Button className="mt-2" busy={rc.isPending} onClick={() => rc.mutate()}>
            {t('auth.generate', 'Generate new codes')}
          </Button>
        )}
        <ErrorBox error={rc.error} />
      </Card>
      <Card title={t('auth.sessions', 'Active sessions')}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th>{t('auth.client', 'Client')}</th>
                <th>{t('auth.lastSeen', 'Last seen')}</th>
                <th>{t('auth.expires', 'Expires')}</th>
                <th>
                  <span className="sr-only">{t('common.actions', 'Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(sessions.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="max-w-64 truncate" title={s.userAgent}>
                    {s.userAgent || '—'}{' '}
                    {s.current && (
                      <Badge tone="accent">{t('auth.thisSession', 'this session')}</Badge>
                    )}
                  </td>
                  <td>{s.lastSeenAt ? fmt.dateTime(s.lastSeenAt) : '—'}</td>
                  <td>{s.expiresAt ? fmt.dateTime(s.expiresAt) : '—'}</td>
                  <td className="text-right">
                    {!s.current && s.id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => revoke.mutate(s.id as string)}
                      >
                        {t('auth.revoke', 'Revoke')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorBox error={sessions.error ?? revoke.error} />
      </Card>
    </>
  );
}

export function SecurityTab() {
  return (
    <div className="flex flex-col gap-4">
      <LockCard />
      <AccountCard />
    </div>
  );
}
