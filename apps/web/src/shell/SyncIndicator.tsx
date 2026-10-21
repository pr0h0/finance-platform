import { useQuery } from '@tanstack/react-query';
import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { useData } from '../app/data.tsx';
import { useT } from '../lib/i18n.ts';
import { useOnline } from './useOnline.ts';

/** Connected mode only: offline / pending / error / conflicts at a glance; links to /sync. */
export function SyncIndicator() {
  const t = useT();
  const { mode, engine, profile } = useData();
  const online = useOnline();
  const status = useQuery({
    queryKey: ['profile', profile?.id, 'sync-status'],
    queryFn: () => engine()?.status() ?? null,
    enabled: mode === 'remote',
    refetchInterval: 5000,
  });
  if (mode !== 'remote') return null;
  const s = status.data;
  const problem =
    s && (s.lastError || s.rejected.length || s.conflicts.some((c) => c.status === 'open'));
  const label = !online
    ? t('sync.offline', 'Offline')
    : problem
      ? t('sync.attention', 'Sync needs attention')
      : s?.pending
        ? t('sync.pending', '{{count}} changes waiting to upload', { count: s.pending })
        : t('sync.upToDate', 'Synchronized');
  const Icon = !online ? CloudOff : problem ? TriangleAlert : RefreshCw;
  return (
    <Link
      to="/sync"
      aria-label={label}
      title={label}
      className={`relative inline-flex size-9 items-center justify-center rounded-md hover:bg-surface-2 ${problem ? 'text-warn' : 'text-muted'}`}
    >
      <Icon className="size-4" aria-hidden />
      {!!s?.pending && online && (
        <span className="absolute top-1 right-1 rounded-full bg-accent px-1 text-[10px] leading-4 text-accent-fg">
          {s.pending}
        </span>
      )}
    </Link>
  );
}
