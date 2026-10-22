// App lock (feature 91) and, in connected mode, the server account: password, recovery codes,
// sessions, sign-out (sign-out never deletes local data).
import type { Schemas } from '@finplat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Notice,
  Select,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { useFormat } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { hashSecret } from '../shell/AppLock.tsx';

/** PIN: 4–12 digits. Password: at least 8 characters. Returns an error message or null. */
export function validateLockSecret(kind: 'pin' | 'password', a: string, b: string): string | null {
  if (kind === 'pin' && !/^\d{4,12}$/.test(a)) return 'The PIN must be 4–12 digits.';
  if (kind === 'password' && a.length < 8) return 'The password must have at least 8 characters.';
  if (a !== b) return 'The two entries do not match.';
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
