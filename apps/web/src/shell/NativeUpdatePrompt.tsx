// Native app: a bar above the page when a newer signed version is published (platform/updates.ts).
// Checked at start and every 6 hours; "Later" hides it until the next start.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorBox } from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';
import { checkForUpdate } from '../platform/updates.ts';

export function NativeUpdatePrompt() {
  const t = useT();
  const [hidden, setHidden] = useState(false);
  const update = useQuery({
    queryKey: ['native', 'update'],
    queryFn: checkForUpdate,
    refetchInterval: 6 * 60 * 60_000,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const install = useMutation({ mutationFn: () => update.data?.install() ?? Promise.resolve() });
  const u = update.data;
  if (!u || hidden) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2 text-sm"
    >
      <span className="flex-1">
        {t('update.available', 'Finance Platform {{v}} is available.', { v: u.version })}
      </span>
      <Button size="sm" variant="primary" busy={install.isPending} onClick={() => install.mutate()}>
        {t('update.install', 'Update')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
        {t('update.later', 'Later')}
      </Button>
      {install.error && (
        <div className="basis-full">
          <ErrorBox error={install.error} />
        </div>
      )}
    </div>
  );
}
