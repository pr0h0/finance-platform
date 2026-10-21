// Feature 108 synchronization dashboard: connection, last sync, pending/refused changes,
// errors, conflicts with explicit resolution, devices, storage. Also unlocks end-to-end
// encrypted profiles on this device.
import { storageEstimate } from '@finplat/storage';
import type { LocalConflict } from '@finplat/sync-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useData, useProfile } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { formatBytes, useFormat } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { useOnline } from '../shell/useOnline.ts';

/** Merged entity for a conflict: server data, with `pick[field] === 'client'` fields from the client. */
export function mergeConflict(
  c: Pick<LocalConflict, 'serverData' | 'clientData' | 'fields'>,
  pick: Record<string, 'server' | 'client'>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(c.serverData ?? {}) };
  for (const f of c.fields) if (pick[f] === 'client') out[f] = c.clientData?.[f];
  return out;
}

const show = (v: unknown) =>
  v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

function ConflictDialog({ c, onClose }: { c: LocalConflict; onClose: () => void }) {
  const t = useT();
  const { engine } = useData();
  const qc = useQueryClient();
  const [pick, setPick] = useState<Record<string, 'server' | 'client'>>({});
  const resolve = useMutation({
    mutationFn: async (choice: 'server' | 'client' | 'merged') =>
      engine()?.resolve(c.id, choice, choice === 'merged' ? mergeConflict(c, pick) : undefined),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['profile'] });
      toast(t('sync.resolved', 'Conflict resolved'));
      onClose();
    },
  });
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={t('sync.conflictTitle', 'Conflict in {{type}}', { type: c.entityType })}
      description={t('sync.conflict.fields', 'Changed on both devices: {{fields}}', {
        fields: c.fields.join(', '),
      })}
    >
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{t('sync.field', 'Field')}</th>
              <th>{t('sync.server', 'Server')}</th>
              <th>{t('sync.mine', 'This device')}</th>
              <th>{t('sync.keep', 'Keep')}</th>
            </tr>
          </thead>
          <tbody>
            {c.fields.map((f) => (
              <tr key={f}>
                <td className="font-medium">{f}</td>
                <td className="max-w-48 break-words">{show(c.serverData?.[f])}</td>
                <td className="max-w-48 break-words">{show(c.clientData?.[f])}</td>
                <td>
                  <Select
                    aria-label={t('sync.keepField', 'Keep value of {{f}}', { f })}
                    value={pick[f] ?? 'server'}
                    onChange={(e) =>
                      setPick({ ...pick, [f]: e.target.value as 'server' | 'client' })
                    }
                  >
                    <option value="server">{t('sync.server', 'Server')}</option>
                    <option value="client">{t('sync.mine', 'This device')}</option>
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        {t(
          'sync.conflictNote',
          'Amounts and splits are never merged automatically. The server checks the result like any other change (split totals must still match).',
        )}
      </p>
      <ErrorBox error={resolve.error} />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button busy={resolve.isPending} onClick={() => resolve.mutate('server')}>
          {t('sync.conflict.keepServer', 'Keep server version')}
        </Button>
        <Button busy={resolve.isPending} onClick={() => resolve.mutate('client')}>
          {t('sync.conflict.keepMine', 'Keep my version')}
        </Button>
        <Button variant="primary" busy={resolve.isPending} onClick={() => resolve.mutate('merged')}>
          {t('sync.conflict.merge', 'Merge')}
        </Button>
      </div>
    </Dialog>
  );
}

function Unlock() {
  const t = useT();
  const { api, store, reload } = useData();
  const profile = useProfile();
  const deviceId = useApp((s) => s.connection?.deviceId ?? '');
  const [how, setHow] = useState<'passphrase' | 'recoveryCode'>('passphrase');
  const [secret, setSecret] = useState('');
  const run = useMutation({
    mutationFn: async () => {
      if (!api) return;
      const sc = await import('@finplat/sync-client');
      const device = await sc.deviceKeyPair(store);
      let ring: Awaited<ReturnType<typeof sc.unlock>>;
      try {
        ring = await sc.unlock(api.sync, profile.id, { deviceId, device });
      } catch {
        ring = await sc.unlock(
          api.sync,
          profile.id,
          how === 'passphrase' ? { passphrase: secret } : { recoveryCode: secret },
        );
        // enroll this browser so it unlocks by itself next time
        await sc.enrollDevice(api.sync, profile.id, ring, {
          deviceId,
          publicKey: device.publicKey,
        });
      }
      await sc.saveKeyring(store, profile.id, ring);
    },
    onSuccess: () => {
      toast(t('e2ee.unlocked', 'Profile unlocked on this device'));
      reload();
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    run.mutate();
  }
  return (
    <Card title={t('e2ee.unlockTitle', 'Unlock “{{name}}”', { name: profile.name })}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'e2ee.unlockText',
          'This profile is end-to-end encrypted. Enter its passphrase or recovery code to decrypt it on this device. Nothing is synchronized until then.',
        )}
      </p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
        <Field label={t('e2ee.with', 'Unlock with')}>
          <Select
            value={how}
            onChange={(e) => setHow(e.target.value as 'passphrase' | 'recoveryCode')}
          >
            <option value="passphrase">{t('e2ee.passphrase', 'Encryption passphrase')}</option>
            <option value="recoveryCode">{t('e2ee.recoveryCode', 'Recovery code')}</option>
          </Select>
        </Field>
        <Field label={t('e2ee.secret', 'Secret')}>
          <Input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" busy={run.isPending}>
          {t('e2ee.unlock', 'Unlock')}
        </Button>
      </form>
      <div className="mt-2">
        <ErrorBox
          error={
            run.error
              ? new Error(t('e2ee.wrongSecret', 'Wrong passphrase or recovery code.'))
              : null
          }
        />
      </div>
    </Card>
  );
}

export default function SyncPage() {
  const t = useT();
  const fmt = useFormat();
  const online = useOnline();
  const { mode, api, engine, syncNow, session, locked } = useData();
  const profile = useProfile();
  const qc = useQueryClient();
  const [open, setOpen] = useState<LocalConflict | null>(null);
  const isLocked = locked.has(profile.id);

  const status = useQuery({
    queryKey: ['profile', profile.id, 'sync-status'],
    queryFn: () => engine()?.status() ?? null,
    enabled: mode === 'remote',
    refetchInterval: 5000,
  });
  const server = useQuery({
    queryKey: ['server', 'sync-status', profile.id],
    queryFn: () => api?.sync.status(profile.id) ?? null,
    enabled: !!api && online,
  });
  const devices = useQuery({
    queryKey: ['server', 'devices'],
    queryFn: () => api?.devices() ?? [],
    enabled: !!api && online,
  });
  const est = useQuery({ queryKey: ['storage-estimate'], queryFn: storageEstimate });
  const sync = useMutation({
    mutationFn: async () => {
      await syncNow();
      await engine()?.refreshConflicts();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['profile', profile.id] }),
  });
  const discard = useMutation({
    mutationFn: (opId: string) => engine()?.discardRejected(opId) ?? Promise.resolve(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile', profile.id, 'sync-status'] }),
  });

  if (mode === 'local')
    return (
      <>
        <PageHeader title={t('nav.sync', 'Sync status')} />
        <EmptyState
          title={t('sync.localOnly', 'Local-only mode')}
          action={
            <Link className="text-sm text-accent underline" to="/settings?tab=connection">
              {t('settings.connect', 'Connect to server')}
            </Link>
          }
        >
          {t(
            'sync.localText',
            'Nothing is synchronized. Your data is stored only in this browser; keep encrypted backups.',
          )}{' '}
          {t('storage.usage', '{{used}} of {{quota}} used', {
            used: formatBytes(est.data?.usage),
            quota: formatBytes(est.data?.quota),
          })}
        </EmptyState>
      </>
    );

  const s = status.data;
  const deviceName = new Map((devices.data ?? []).map((d) => [d.id, d.name]));
  const openConflicts = (s?.conflicts ?? []).filter((c) => c.status === 'open');
  const connLabel = !online
    ? t('sync.offline', 'Offline')
    : session === 'expired'
      ? t('sync.signedOut', 'Signed out')
      : t('sync.connected', 'Connected');

  return (
    <>
      <PageHeader
        title={t('nav.sync', 'Sync status')}
        description={profile.name}
        actions={
          <Button
            variant="primary"
            busy={sync.isPending}
            disabled={!online || isLocked}
            onClick={() => sync.mutate()}
          >
            {t('sync.syncNow', 'Sync now')}
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {isLocked && (
          <div className="lg:col-span-2">
            <Unlock />
          </div>
        )}
        <Card title={t('sync.status', 'Status')}>
          <DefinitionList
            items={[
              [
                t('sync.connection', 'Connection'),
                <Badge key="c" tone={online && session !== 'expired' ? 'pos' : 'warn'}>
                  {connLabel}
                </Badge>,
              ],
              [
                t('sync.last', 'Last successful sync'),
                s?.lastSyncAt ? fmt.dateTime(s.lastSyncAt) : t('sync.never', 'Never synchronized'),
              ],
              [t('sync.pendingLabel', 'Waiting to upload'), String(s?.pending ?? 0)],
              [
                t('sync.checkpoint', 'Local / server version'),
                `${s?.checkpoint ?? 0} / ${server.data?.serverVersion ?? s?.serverVersion ?? '—'}`,
              ],
              [
                t('sync.privacy', 'Privacy'),
                profile.privacyMode === 'e2ee' ? (
                  <Badge key="p" tone="accent">
                    E2EE
                  </Badge>
                ) : (
                  t('e2ee.serverReadableShort', 'Server-readable')
                ),
              ],
              [
                t('sync.serverStorage', 'Server storage'),
                formatBytes(server.data?.storageBytes ?? null),
              ],
              [
                t('storage.used', 'Used'),
                `${formatBytes(est.data?.usage)} / ${formatBytes(est.data?.quota)}`,
              ],
            ]}
          />
          {s?.lastError && (
            <div className="mt-3">
              <Notice
                tone="neg"
                role="alert"
                title={t('sync.lastError', 'Last error ({{code}})', { code: s.lastError.code })}
              >
                {s.lastError.message} · {fmt.dateTime(s.lastError.at)}
              </Notice>
            </div>
          )}
          <ErrorBox error={sync.error} />
        </Card>

        <Card title={t('sync.devices', 'Connected devices')}>
          <table className={tableClass}>
            <thead>
              <tr>
                <th>{t('devices.name', 'Device')}</th>
                <th>{t('sync.lastPush', 'Last upload')}</th>
                <th>{t('sync.pulled', 'Pulled to')}</th>
              </tr>
            </thead>
            <tbody>
              {(server.data?.devices ?? []).map((d) => (
                <tr key={d.deviceId}>
                  <td>{(d.deviceId && deviceName.get(d.deviceId)) ?? d.deviceId}</td>
                  <td>{d.lastPushedAt ? fmt.dateTime(d.lastPushedAt) : '—'}</td>
                  <td>{d.lastPulledVersion ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Link to="/devices" className="mt-2 inline-block text-sm text-accent">
            {t('sync.manageDevices', 'Manage devices')}
          </Link>
        </Card>

        <Card
          title={`${t('sync.conflicts', 'Conflicts')} (${openConflicts.length})`}
          className="lg:col-span-2"
        >
          {openConflicts.length === 0 ? (
            <p className="text-sm text-muted">{t('sync.noConflicts', 'No open conflicts.')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {openConflicts.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span>
                    <span className="font-medium">{c.entityType}</span>{' '}
                    <span className="text-muted">
                      {t('sync.conflict.fields', 'Changed on both devices: {{fields}}', {
                        fields: c.fields.join(', '),
                      })}{' '}
                      · {fmt.dateTime(c.createdAt)}
                    </span>
                  </span>
                  <Button size="sm" onClick={() => setOpen(c)}>
                    {t('sync.resolve', 'Resolve')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={`${t('sync.rejected', 'Changes the server refused')} (${s?.rejected.length ?? 0})`}
          className="lg:col-span-2"
        >
          {(s?.rejected.length ?? 0) === 0 ? (
            <p className="text-sm text-muted">{t('sync.noRejected', 'Nothing was refused.')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th>{t('sync.what', 'Record')}</th>
                    <th>{t('sync.reason', 'Reason')}</th>
                    <th>{t('sync.when', 'Changed')}</th>
                    <th>
                      <span className="sr-only">{t('common.actions', 'Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s?.rejected.map((op) => (
                    <tr key={op.opId}>
                      <td>
                        {op.entityType} · {op.op}
                      </td>
                      <td>
                        <code className="text-xs">{op.error?.code}</code> {op.error?.message}
                      </td>
                      <td>{fmt.dateTime(op.clientTime)}</td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={discard.isPending}
                          onClick={() => discard.mutate(op.opId)}
                        >
                          {t('sync.discard', 'Dismiss')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                {t(
                  'sync.discardNote',
                  'Dismissing removes the entry from this list; the local record keeps your edit until it changes again.',
                )}
              </p>
            </div>
          )}
        </Card>
      </div>
      {open && <ConflictDialog c={open} onClose={() => setOpen(null)} />}
    </>
  );
}
