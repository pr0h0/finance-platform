// Persistent warnings under the top bar: offline, expired session (re-login keeps local data),
// backup due / browser storage not protected (local mode), low storage.
import { isLowOnSpace, storageEstimate } from '@finplat/storage';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import { Button, Dialog, ErrorBox, Field, Input } from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';
import { PasskeySignIn } from '../onboarding/connect.tsx';
import { useOnline } from './useOnline.ts';

export function backupDue(
  lastBackupAt: string | null,
  intervalDays: number,
  now = Date.now(),
): boolean {
  if (intervalDays <= 0) return false;
  if (!lastBackupAt) return true;
  return now - Date.parse(lastBackupAt) > intervalDays * 86_400_000;
}

function Bar({ tone, children }: { tone: 'warn' | 'neg' | 'neutral'; children: React.ReactNode }) {
  const c =
    tone === 'neg'
      ? 'border-neg/40 text-neg'
      : tone === 'warn'
        ? 'border-warn/40 text-warn'
        : 'border-line text-muted';
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-2 border-b bg-surface px-4 py-1.5 text-sm ${c}`}
    >
      {children}
    </div>
  );
}

export function Banners() {
  const t = useT();
  const { mode, session } = useData();
  const online = useOnline();
  const backup = useApp((s) => s.backup);
  const [relogin, setRelogin] = useState(false);
  const est = useQuery({
    queryKey: ['storage-estimate'],
    queryFn: storageEstimate,
    staleTime: 300_000,
  });

  const out: React.ReactNode[] = [];
  if (!online)
    out.push(
      <Bar key="off" tone="neutral">
        {t(
          'banner.offline',
          'You are offline. Changes are saved on this device and synchronized later.',
        )}
      </Bar>,
    );
  if (mode === 'remote' && session === 'expired')
    out.push(
      <Bar key="sess" tone="warn">
        {t(
          'banner.session',
          'Your server session ended. Local data is kept; sign in again to resume syncing.',
        )}
        <Button size="sm" onClick={() => setRelogin(true)}>
          {t('auth.signInAgain', 'Sign in again')}
        </Button>
      </Bar>,
    );
  if (mode === 'local' && backupDue(backup.lastBackupAt, backup.intervalDays))
    out.push(
      <Bar key="bk" tone="warn">
        {backup.lastBackupAt
          ? t('banner.backupDue', 'Your last backup is older than {{days}} days.', {
              days: backup.intervalDays,
            })
          : t(
              'banner.backupNever',
              'No backup yet. Browser data can be deleted by clearing site data or by storage eviction.',
            )}
        <Link to="/settings?tab=backups" className="font-medium underline">
          {t('banner.backupNow', 'Back up now')}
        </Link>
      </Bar>,
    );
  if (est.data && isLowOnSpace(est.data))
    out.push(
      <Bar key="space" tone="neg">
        {t('storage.low', 'Browser storage is almost full. Export a backup and free some space.')}
      </Bar>,
    );
  return (
    <>
      {out}
      {relogin && <ReLogin onClose={() => setRelogin(false)} />}
    </>
  );
}

function ReLogin({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { api, reload } = useData();
  const email = useApp((s) => s.connection?.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.login({ email, password });
      reload();
      onClose();
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('auth.signInAgain', 'Sign in again')}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t('auth.email', 'Email')}>
          <Input value={email} readOnly />
        </Field>
        <Field label={t('auth.password', 'Password')}>
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" busy={busy} disabled={!password}>
          {t('auth.signIn', 'Sign in')}
        </Button>
        {api && (
          <PasskeySignIn
            api={() => api}
            email={email}
            onSignedIn={() => {
              reload();
              onClose();
            }}
          />
        )}
      </form>
    </Dialog>
  );
}
