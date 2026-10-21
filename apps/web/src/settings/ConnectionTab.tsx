// Mode switching (features 106, 107, 109). Local → connected runs the activation flow.
// Disconnecting keeps every local record and the unsent changes; deleting server data is a
// separate action (Profiles tab). Moving to another server = disconnect, then connect again.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import {
  Button,
  Card,
  ConfirmDialog,
  DefinitionList,
  ErrorBox,
  Notice,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { useT } from '../lib/i18n.ts';
import { ActivateFlow } from '../sync/ActivateFlow.tsx';

export function ConnectionTab() {
  const t = useT();
  const { mode, store, profiles, user, reload } = useData();
  const connection = useApp((s) => s.connection);
  const storeName = useApp((s) => s.storeName);
  const setApp = useApp((s) => s.set);
  const [connecting, setConnecting] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const pending = useQuery({
    queryKey: ['disconnect-preview', profiles.map((p) => p.id).join()],
    enabled: confirm,
    queryFn: async () => {
      const { disconnectPreview } = await import('@finplat/sync-client');
      let p = 0;
      let r = 0;
      for (const prof of profiles) {
        const x = await disconnectPreview(store, prof.id);
        p += x.pending;
        r += x.rejected;
      }
      return { pending: p, rejected: r };
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const { disconnect: off } = await import('@finplat/sync-client');
      for (const p of profiles) await off(store, p.id);
    },
    onSuccess: () => {
      setApp({ mode: 'local', connection: null });
      setConfirm(false);
      reload();
      toast(t('conn.disconnected', 'Disconnected. All data stays on this device.'));
    },
  });

  if (mode === 'local')
    return (
      <Card title={t('conn.localTitle', 'This device works in local-only mode')}>
        {connecting ? (
          <ActivateFlow onCancel={() => setConnecting(false)} />
        ) : (
          <>
            <p className="text-sm text-muted">
              {t(
                'conn.localText',
                'Connect to a compatible server to synchronize these profiles between devices, share them in a household and use server backups. Your data is uploaded only after a preview and verified afterwards; nothing is deleted locally.',
              )}
            </p>
            <Notice tone="neutral">
              {t('conn.backupFirst', 'Tip: export an encrypted backup first.')}{' '}
              <Link className="underline" to="/settings?tab=backups">
                {t('settings.backups', 'Backups & data')}
              </Link>
            </Notice>
            <Button variant="primary" className="mt-3" onClick={() => setConnecting(true)}>
              {t('settings.connect', 'Connect to server')}
            </Button>
          </>
        )}
      </Card>
    );

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('conn.connected', 'Connected mode')}>
        <DefinitionList
          items={[
            [t('server.address', 'Address'), connection?.serverUrl || location.origin],
            [t('auth.email', 'Email'), user?.email ?? connection?.email ?? '—'],
            [t('conn.device', 'This device'), <code key="d">{connection?.deviceId}</code>],
            [t('storage.db', 'Local database'), <code key="s">{storeName}</code>],
          ]}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => setConfirm(true)}>{t('sync.disconnect', 'Disconnect')}</Button>
          <Link to="/sync" className="inline-flex h-9 items-center px-3 text-sm text-accent">
            {t('nav.sync', 'Sync status')}
          </Link>
        </div>
      </Card>
      <Card title={t('conn.migrate', 'Move to another server')}>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>{t('conn.m1', 'Export an encrypted backup (Backups & data).')}</li>
          <li>{t('conn.m2', 'Disconnect here. Every profile stays on this device.')}</li>
          <li>
            {t(
              'conn.m3',
              'Choose “Connect to server” and enter the new server. The profiles are uploaded and verified there.',
            )}
          </li>
          <li>
            {t(
              'conn.m4',
              'When everything is verified, delete the profiles on the old server if you no longer need them.',
            )}
          </li>
        </ol>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('conn.disconnectTitle', 'Disconnect from the server?')}
        confirmLabel={t('sync.disconnect', 'Disconnect')}
        busy={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      >
        <p>
          {t(
            'sync.disconnect.keepsData',
            'Disconnecting keeps all data on this device. Deleting server data is a separate action.',
          )}
        </p>
        {pending.data && pending.data.pending + pending.data.rejected > 0 && (
          <p className="mt-2 text-warn">
            {t(
              'sync.disconnect.pending',
              '{{count}} changes have not been uploaded yet. They stay on this device and are uploaded if you reconnect.',
              {
                count: pending.data.pending + pending.data.rejected,
              },
            )}
          </p>
        )}
        <ErrorBox error={disconnect.error ?? pending.error} />
      </ConfirmDialog>
    </div>
  );
}
