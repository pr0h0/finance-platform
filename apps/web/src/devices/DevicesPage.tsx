// Feature 119: devices authorized for synchronization (rename, revoke). Revoking ends the
// device's sessions and its key envelopes; for end-to-end encrypted profiles rotate the key
// afterwards so new data is unreadable to the revoked device.
import type { Schemas } from '@finplat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useData, useProfile } from '../app/data.tsx';
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
  PageHeader,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { useFormat } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';

type Device = Schemas['Device'];

function RotateKey() {
  const t = useT();
  const { api, store, reload } = useData();
  const profile = useProfile();
  const deviceId = useApp((s) => s.connection?.deviceId ?? '');
  const [pass, setPass] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      if (!api) return;
      const sc = await import('@finplat/sync-client');
      const ring = await sc.loadKeyring(store, profile.id);
      if (!ring)
        throw new Error(
          t('e2ee.notUnlocked', 'Unlock the profile on this device first (Sync status).'),
        );
      const device = await sc.deviceKeyPair(store);
      const r = await sc.rotateKey(api.sync, profile.id, ring, {
        passphrase: pass,
        devices: [{ deviceId, publicKey: device.publicKey }],
      });
      await sc.saveKeyring(store, profile.id, r.keyring);
      setCode(r.recoveryCode);
    },
    onSuccess: () => {
      setPass('');
      reload();
    },
  });
  if (profile.privacyMode !== 'e2ee') return null;
  return (
    <Card title={t('e2ee.rotate', 'Rotate encryption key of “{{name}}”', { name: profile.name })}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'e2ee.rotateText',
          'After revoking a device or member: new data uses a new key that only this device, the new passphrase and the new recovery code can open. Other devices unlock again with the new passphrase. Data a revoked device already downloaded cannot be recalled.',
        )}
      </p>
      {code ? (
        <Notice tone="warn" role="alert" title={t('e2ee.recoveryCode', 'Recovery code')}>
          <p>
            {t(
              'e2ee.recoveryCode.warning',
              'Write this code down and keep it safe. If you lose both the passphrase and this code, your data cannot be recovered.',
            )}
          </p>
          <p className="mt-2 font-mono break-all text-fg">{code}</p>
        </Notice>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          <Field
            label={t('e2ee.newPassphrase', 'New passphrase (10+ characters)')}
            className="min-w-64 flex-1"
          >
            <Input
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
          </Field>
          <Button type="submit" busy={run.isPending}>
            {t('e2ee.rotateBtn', 'Rotate key')}
          </Button>
        </form>
      )}
      <ErrorBox error={run.error} />
    </Card>
  );
}

export default function DevicesPage() {
  const t = useT();
  const fmt = useFormat();
  const { api } = useData();
  const me = useApp((s) => s.connection?.deviceId);
  const qc = useQueryClient();
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [revoke, setRevoke] = useState<Device | null>(null);
  const list = useQuery({
    queryKey: ['server', 'devices'],
    queryFn: () => api?.devices() ?? [],
    enabled: !!api,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['server', 'devices'] });
  const rename = useMutation({
    mutationFn: (d: { id: string; name: string }) =>
      api?.request('PATCH', `/api/v1/devices/${d.id}`, { name: d.name }) ?? Promise.resolve(),
    onSuccess: () => {
      setEdit(null);
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      api?.request('DELETE', `/api/v1/devices/${id}`) ?? Promise.resolve(),
    onSuccess: () => {
      setRevoke(null);
      refresh();
      toast(t('devices.revoked', 'Device revoked'));
    },
  });
  const devices = list.data ?? [];
  return (
    <>
      <PageHeader
        title={t('nav.devices', 'Devices')}
        description={t('devices.text', 'Browsers and apps allowed to synchronize your profiles.')}
      />
      <div className="flex flex-col gap-4">
        <Card>
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>{t('devices.name', 'Device')}</th>
                  <th>{t('devices.platform', 'Platform')}</th>
                  <th>{t('devices.lastSeen', 'Last seen')}</th>
                  <th>{t('devices.lastSync', 'Last sync')}</th>
                  <th>{t('devices.status', 'Status')}</th>
                  <th>
                    <span className="sr-only">{t('common.actions', 'Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {edit && edit.id === d.id ? (
                        <form
                          className="flex gap-1"
                          onSubmit={(e) => {
                            e.preventDefault();
                            rename.mutate(edit);
                          }}
                        >
                          <Input
                            aria-label={t('devices.name', 'Device')}
                            className="h-8"
                            value={edit.name}
                            maxLength={200}
                            onChange={(e) => setEdit({ id: edit.id, name: e.target.value })}
                          />
                          <Button size="sm" type="submit" busy={rename.isPending}>
                            {t('common.save', 'Save')}
                          </Button>
                        </form>
                      ) : (
                        <>
                          {d.name}{' '}
                          {d.id === me && (
                            <Badge tone="accent">{t('devices.this', 'this browser')}</Badge>
                          )}
                        </>
                      )}
                    </td>
                    <td>{d.platform}</td>
                    <td>{d.lastSeenAt ? fmt.dateTime(d.lastSeenAt) : '—'}</td>
                    <td>{d.lastSyncAt ? fmt.dateTime(d.lastSyncAt) : '—'}</td>
                    <td>
                      {d.revokedAt ? (
                        <Badge tone="neg">{t('devices.revokedBadge', 'revoked')}</Badge>
                      ) : (
                        <Badge tone="pos">{t('devices.active', 'active')}</Badge>
                      )}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {!d.revokedAt && d.id && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEdit({ id: d.id as string, name: d.name ?? '' })}
                          >
                            {t('common.rename', 'Rename')}
                          </Button>
                          {d.id !== me && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-neg"
                              onClick={() => setRevoke(d)}
                            >
                              {t('devices.revoke', 'Revoke')}
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBox error={list.error ?? rename.error} />
        </Card>
        <RotateKey />
      </div>
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title={t('devices.revokeTitle', 'Revoke “{{name}}”?', { name: revoke?.name ?? '' })}
        confirmLabel={t('devices.revoke', 'Revoke')}
        danger
        busy={del.isPending}
        onConfirm={() => revoke?.id && del.mutate(revoke.id)}
      >
        {t(
          'devices.revokeText',
          'The device is signed out and can no longer synchronize. Data it already downloaded stays on it. For end-to-end encrypted profiles, rotate the key afterwards.',
        )}
        <ErrorBox error={del.error} />
      </ConfirmDialog>
    </>
  );
}
