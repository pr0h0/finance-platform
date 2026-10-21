// Feature 91: application lock. The PIN/password is kept only as an Argon2id verifier
// (hashLockSecret from @finplat/sync-client). It gates the UI; it does not encrypt the local
// database (browser limitation, see docs/known-issues.md). Locks on reload and after
// `autoLockMinutes` without interaction.
import { Lock } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useApp } from '../app/store.ts';
import { Button, Field, Input } from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';

export const useLockState = create<{ locked: boolean }>(() => ({
  locked: !!useApp.getState().lock,
}));

export const lockNow = () => useLockState.setState({ locked: true });

export async function hashSecret(secret: string) {
  const { hashLockSecret } = await import('@finplat/sync-client');
  return hashLockSecret(secret);
}

async function verify(hash: string, secret: string) {
  const { verifyLockSecret } = await import('@finplat/sync-client');
  return verifyLockSecret(hash, secret);
}

/** Wait before the next attempt: none for the first 3, then doubling up to 5 minutes. */
export function lockDelayMs(failures: number): number {
  return failures < 3 ? 0 : Math.min(300_000, 1000 * 2 ** (failures - 3));
}

export function AppLock({ children }: { children: ReactNode }) {
  const lock = useApp((s) => s.lock);
  const locked = useLockState((s) => s.locked) && !!lock;
  const last = useRef(Date.now());

  useEffect(() => {
    if (!lock?.autoLockMinutes) return;
    const touch = () => {
      last.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const t = setInterval(() => {
      if (Date.now() - last.current > lock.autoLockMinutes * 60_000) lockNow();
    }, 15_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      clearInterval(t);
    };
  }, [lock?.autoLockMinutes]);

  if (!locked || !lock) return <>{children}</>;
  return <LockScreen hash={lock.hash} kind={lock.kind} />;
}

function LockScreen({ hash, kind }: { hash: string; kind: 'pin' | 'password' }) {
  const t = useT();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failures = useRef(0);
  const until = useRef(0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const wait = until.current - Date.now();
    if (wait > 0) {
      setError(
        t('lock.wait', 'Too many attempts. Try again in {{s}} s.', { s: Math.ceil(wait / 1000) }),
      );
      return;
    }
    setBusy(true);
    const ok = await verify(hash, secret);
    setBusy(false);
    if (ok) {
      failures.current = 0;
      useLockState.setState({ locked: false });
      return;
    }
    failures.current++;
    until.current = Date.now() + lockDelayMs(failures.current);
    setSecret('');
    setError(t('lock.wrong', 'Wrong PIN or password.'));
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-xs rounded-lg border border-line bg-surface p-6"
      >
        <div className="mb-4 flex items-center gap-2">
          <Lock className="size-5" aria-hidden />
          <h1 className="text-lg font-semibold">{t('lock.title', 'App locked')}</h1>
        </div>
        <Field
          label={kind === 'pin' ? t('lock.pin', 'PIN') : t('lock.password', 'Password')}
          error={error}
        >
          <Input
            type="password"
            inputMode={kind === 'pin' ? 'numeric' : undefined}
            autoComplete="current-password"
            autoFocus
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          className="mt-4 w-full"
          busy={busy}
          disabled={!secret}
        >
          {t('lock.unlock', 'Unlock')}
        </Button>
        <p className="mt-3 text-xs text-muted">
          {t(
            'lock.forgot',
            'Forgot it? Clearing this site’s data removes the lock and all local data; restore from a backup or sync again afterwards.',
          )}
        </p>
      </form>
    </main>
  );
}
