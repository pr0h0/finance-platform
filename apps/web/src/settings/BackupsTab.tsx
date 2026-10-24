// Features 89, 90, 94 (+ storage quota): encrypted local backups (export, scheduled reminder,
// restore), open JSON export, server backups in connected mode, browser storage usage.
import type { Schemas } from '@finplat/api-client';
import {
  fromStored,
  requestPersistence,
  type StoredBlob,
  SYNCED_TABLES,
  storageEstimate,
} from '@finplat/storage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useData, useProfile } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DefinitionList,
  ErrorBox,
  Field,
  Input,
  Notice,
  Select,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { downloadBlob, formatBytes, todayIso, useFormat } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import {
  backupFolder,
  backupPassphrase,
  clearBackupFolder,
  isDesktopNative,
  isNative,
  keychainInUse,
  pickBackupFolder,
  setBackupPassphrase,
} from '../platform/native.ts';
import { runAutoBackup } from '../shell/AutoBackup.tsx';

const EXTRA_TABLES = ['exchange_rates', 'imported_raw_records', 'notifications', 'settings'];

function ExportBackup() {
  const t = useT();
  const fmt = useFormat();
  const { store, profile } = useData();
  const backup = useApp((s) => s.backup);
  const setApp = useApp((s) => s.set);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [all, setAll] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      const { exportBackup } = await import('@finplat/sync-client');
      const bytes = await exportBackup(
        store,
        a,
        all || !profile ? {} : { profileIds: [profile.id] },
      );
      downloadBlob(bytes, `finplat-backup-${todayIso()}.finplat`);
    },
    onSuccess: () => {
      setApp({ backup: { ...backup, lastBackupAt: new Date().toISOString() } });
      setA('');
      setB('');
      toast(t('backup.done', 'Backup downloaded'));
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (a.length < 10)
      return setError(t('backup.short', 'Use a passphrase of at least 10 characters.'));
    if (a !== b) return setError(t('backup.mismatch', 'The passphrases do not match.'));
    setError(null);
    run.mutate();
  }
  return (
    <Card title={t('backup.export', 'Export encrypted backup')}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'backup.exportText',
          'One file with every record and attachment, encrypted on this device with your passphrase (Argon2id + XChaCha20-Poly1305). Without the passphrase it cannot be restored.',
        )}
      </p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('backup.passphrase', 'Backup passphrase')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={a}
            onChange={(e) => setA(e.target.value)}
          />
        </Field>
        <Field label={t('lock.repeat', 'Repeat')} error={error}>
          <Input
            type="password"
            autoComplete="new-password"
            value={b}
            onChange={(e) => setB(e.target.value)}
          />
        </Field>
        <Checkbox
          className="sm:col-span-2"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          label={t('backup.allProfiles', 'All profiles on this device')}
          hint={
            !all && profile
              ? t('backup.onlyActive', 'Only “{{name}}”', { name: profile.name })
              : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="primary" busy={run.isPending}>
            {t('backup.download', 'Create and download')}
          </Button>
          <span className="text-xs text-muted">
            {backup.lastBackupAt
              ? t('backup.last', 'Last backup: {{when}}', {
                  when: fmt.dateTime(backup.lastBackupAt),
                })
              : t('backup.never', 'No backup made on this device yet')}
          </span>
        </div>
      </form>
      <div className="mt-2">
        <ErrorBox error={run.error} />
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <Field
          label={t('backup.schedule', 'Backup schedule')}
          hint={
            isDesktopNative()
              ? t(
                  'backup.scheduleHintDesktop',
                  'Automatic backups (above) run on this schedule; without them the app shows a reminder when a backup is due.',
                )
              : t(
                  'backup.scheduleHint',
                  'Browsers cannot save files silently. When a backup is due the app shows a reminder; one click creates the file.',
                )
          }
          className="max-w-xs"
        >
          <Select
            value={backup.intervalDays}
            onChange={(e) =>
              setApp({ backup: { ...backup, intervalDays: Number(e.target.value) } })
            }
          >
            <option value={1}>{t('backup.daily', 'Daily')}</option>
            <option value={7}>{t('backup.weekly', 'Weekly')}</option>
            <option value={14}>{t('backup.biweekly', 'Every 2 weeks')}</option>
            <option value={30}>{t('backup.monthly', 'Monthly')}</option>
            <option value={0}>{t('backup.off', 'No reminders')}</option>
          </Select>
        </Field>
      </div>
    </Card>
  );
}

function RestoreBackup() {
  const t = useT();
  const fmt = useFormat();
  const { store, mode, reload } = useData();
  const [file, setFile] = useState<Uint8Array | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const run = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('choose a file');
      const { importBackup } = await import('@finplat/sync-client');
      return importBackup(store, file, pass, { overwrite });
    },
    onSuccess: (r) => {
      toast(
        t('backup.restored', 'Backup restored: {{p}} profiles, {{n}} records', {
          p: r.profiles.length,
          n: r.rows,
        }),
      );
      setPass('');
      reload();
    },
  });
  async function pick(f: File | undefined) {
    setFile(null);
    setCreated(null);
    setFileErr(null);
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    try {
      const { readBackupHeader } = await import('@finplat/sync-client');
      setCreated(readBackupHeader(bytes).header.created_at);
      setFile(bytes);
    } catch (e) {
      setFileErr((e as Error).message);
    }
  }
  if (mode === 'remote')
    return (
      <Card title={t('backup.import', 'Restore from backup')}>
        <p className="text-sm text-muted">
          {t(
            'backup.restoreRemote',
            'Encrypted device backups are restored in local mode (Settings → Connection → Disconnect), then synchronized by connecting again. Server-side backups below can be restored on the server directly.',
          )}
        </p>
      </Card>
    );
  return (
    <Card title={t('backup.import', 'Restore from backup')}>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <Field
          label={t('backup.file', 'Backup file')}
          error={fileErr}
          hint={
            created
              ? t('backup.created', 'Created {{when}}', { when: fmt.dateTime(created) })
              : undefined
          }
        >
          <Input
            type="file"
            accept=".finplat,application/octet-stream"
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </Field>
        <Field label={t('backup.passphrase', 'Backup passphrase')}>
          <Input
            type="password"
            autoComplete="off"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </Field>
        <Checkbox
          className="sm:col-span-2"
          checked={overwrite}
          onChange={(e) => setOverwrite(e.target.checked)}
          label={t('backup.overwrite', 'Replace profiles that already exist on this device')}
          hint={t(
            'backup.overwriteHint',
            'Otherwise the restore stops if a profile from the backup is already here.',
          )}
        />
        <Button
          type="submit"
          variant="primary"
          busy={run.isPending}
          disabled={!file || !pass}
          className="self-start justify-self-start"
        >
          {t('backup.restore', 'Restore')}
        </Button>
      </form>
      <div className="mt-2">
        <ErrorBox error={run.error} />
      </div>
    </Card>
  );
}

function DataExport() {
  const t = useT();
  const { store, api } = useData();
  const profile = useProfile();
  const local = useMutation({
    mutationFn: async () => {
      const tables: Record<string, unknown[]> = {};
      const blobs = new Map<string, Blob | StoredBlob>();
      await store.run('readonly', [...SYNCED_TABLES, ...EXTRA_TABLES, 'blobs'], async (tx) => {
        for (const name of [...SYNCED_TABLES, ...EXTRA_TABLES])
          tables[name] = await tx.query(name, { profileId: profile.id, includeDeleted: true });
        for (const b of await tx.query<{ id: string; blob: Blob | StoredBlob }>('blobs', {
          profileId: profile.id,
        }))
          blobs.set(b.id, b.blob);
      });
      // Attachment contents present on this device, as in GET /export (docs/api/export-format.md).
      const { ready, toBase64 } = await import('@finplat/sync-client');
      await ready();
      const files = [];
      for (const a of (tables.attachments ?? []) as {
        id: string;
        contentType: string;
        sha256: string;
        deletedAt?: string | null;
      }[]) {
        const b = blobs.get(a.id);
        if (!b || a.deletedAt) continue;
        const bytes = new Uint8Array(await fromStored(b).arrayBuffer());
        files.push({
          attachmentId: a.id,
          mimeType: a.contentType,
          sha256: a.sha256,
          data: toBase64(bytes),
        });
      }
      const doc = {
        format: 'finplat-export',
        formatVersion: 2,
        source: 'device',
        exportedAt: new Date().toISOString(),
        profile,
        tables,
        files,
      };
      downloadBlob(
        JSON.stringify(doc, null, 2),
        `finplat-export-${todayIso()}.json`,
        'application/json',
      );
    },
  });
  const server = useMutation({
    mutationFn: async () => {
      const doc = await api?.request<unknown>('GET', '/api/v1/export', undefined, {
        'X-Profile-ID': profile.id,
      });
      downloadBlob(
        JSON.stringify(doc, null, 2),
        `finplat-server-export-${todayIso()}.json`,
        'application/json',
      );
    },
  });
  return (
    <Card title={t('export.title', 'Data export (open format)')}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'export.text',
          'Unencrypted JSON with every record of “{{name}}” for use in other tools or migration (format: docs/api/export-format.md). Keep the file private. Attachment contents are included (base64).',
          { name: profile.name },
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button busy={local.isPending} onClick={() => local.mutate()}>
          {t('export.device', 'Export from this device')}
        </Button>
        {api && (
          <Button busy={server.isPending} onClick={() => server.mutate()}>
            {t('export.server', 'Export from the server')}
          </Button>
        )}
      </div>
      <ErrorBox error={local.error ?? server.error} />
    </Card>
  );
}

function ServerBackups() {
  const t = useT();
  const fmt = useFormat();
  const { api } = useData();
  const profile = useProfile();
  const qc = useQueryClient();
  const serverUrl = useApp((s) => s.connection?.serverUrl ?? '');
  const list = useQuery({
    queryKey: ['server', 'backups'],
    queryFn: () =>
      api?.request<{ items: Schemas['Backup'][] }>('GET', '/api/v1/backups').then((r) => r.items) ??
      [],
    enabled: !!api,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['server', 'backups'] });
  const create = useMutation({
    mutationFn: () =>
      api?.request('POST', '/api/v1/backups', { profileId: profile.id }) ?? Promise.resolve(),
    onSuccess: refresh,
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      api?.request('DELETE', `/api/v1/backups/${id}`) ?? Promise.resolve(),
    onSuccess: refresh,
  });
  const download = useMutation({
    mutationFn: async (b: Schemas['Backup']) => {
      const res = await fetch(`${serverUrl}/api/v1/backups/${b.id}/download`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      downloadBlob(
        await res.blob(),
        `finplat-server-backup-${(b.createdAt ?? '').slice(0, 10)}.json.gz`,
      );
    },
  });
  const [file, setFile] = useState<File | null>(null);
  const restore = useMutation({
    mutationFn: async () => {
      if (!api || !file) return null;
      const { csrfToken } = await api.session();
      const fd = new FormData();
      fd.set('file', file);
      const res = await fetch(`${serverUrl}/api/v1/backups/restore`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrfToken ?? '', 'Idempotency-Key': crypto.randomUUID() },
        body: fd,
      });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body as { profileId: string };
    },
    onSuccess: () => {
      toast(t('backup.serverRestored', 'Restored on the server as a new profile'));
      refresh();
    },
  });
  if (!api) return null;
  return (
    <Card
      title={t('backup.server', 'Server backups')}
      actions={
        <Button size="sm" busy={create.isPending} onClick={() => create.mutate()}>
          {t('backup.serverNow', 'Back up “{{name}}” now', { name: profile.name })}
        </Button>
      }
    >
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{t('backup.date', 'Created')}</th>
              <th>{t('backup.kind', 'Kind')}</th>
              <th>{t('backup.size', 'Size')}</th>
              <th>{t('backup.encryption', 'At rest')}</th>
              <th>
                <span className="sr-only">{t('common.actions', 'Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((b) => {
              const alg = (b.encryption as { alg?: string } | undefined)?.alg;
              return (
                <tr key={b.id}>
                  <td>{b.createdAt ? fmt.dateTime(b.createdAt) : '—'}</td>
                  <td>{b.kind && t(`backup.kind.${b.kind}`, b.kind)}</td>
                  <td>{formatBytes(b.sizeBytes)}</td>
                  <td>
                    {alg && alg !== 'none' ? (
                      <Badge tone="pos">{alg}</Badge>
                    ) : (
                      <Badge tone="warn">{t('backup.unencrypted', 'unencrypted')}</Badge>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => download.mutate(b)}>
                      {t('backup.downloadOne', 'Download')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-neg"
                      onClick={() => b.id && del.mutate(b.id)}
                    >
                      {t('common.delete', 'Delete')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.data?.length === 0 && (
          <p className="py-2 text-sm text-muted">
            {t('backup.noneServer', 'No server backups yet.')}
          </p>
        )}
      </div>
      <form
        className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          restore.mutate();
        }}
      >
        <Field
          label={t(
            'backup.serverRestore',
            'Restore a server backup or export file into a new profile',
          )}
          className="flex-1"
        >
          <Input
            type="file"
            accept=".gz,.json,application/gzip,application/json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Button type="submit" busy={restore.isPending} disabled={!file}>
          {t('backup.restore', 'Restore')}
        </Button>
      </form>
      <ErrorBox
        error={list.error ?? create.error ?? del.error ?? download.error ?? restore.error}
      />
    </Card>
  );
}

function Storage() {
  const t = useT();
  const { storeName } = useApp.getState();
  const est = useQuery({ queryKey: ['storage-estimate'], queryFn: storageEstimate });
  const qc = useQueryClient();
  const persist = useMutation({
    mutationFn: requestPersistence,
    onSuccess: (ok) => {
      toast(
        ok
          ? t('storage.persisted', 'Protected from automatic browser cleanup')
          : t('storage.refused', 'The browser declined; backups are your safety net.'),
      );
      qc.invalidateQueries({ queryKey: ['storage-estimate'] });
    },
  });
  const e = est.data;
  const pct = e?.usage != null && e.quota ? Math.min(100, (e.usage / e.quota) * 100) : null;
  return (
    <Card title={t('storage.title', 'Browser storage')}>
      <DefinitionList
        items={[
          [t('storage.used', 'Used'), `${formatBytes(e?.usage)} / ${formatBytes(e?.quota)}`],
          [
            t('storage.protection', 'Protection'),
            e?.persisted ? (
              <Badge key="p" tone="pos">
                {t('storage.persisted', 'Protected from automatic browser cleanup')}
              </Badge>
            ) : (
              <span key="p" className="flex flex-wrap items-center gap-2">
                <Badge tone="warn">
                  {t('storage.notPersisted', 'The browser may clear this data when space runs low')}
                </Badge>
                <Button size="sm" busy={persist.isPending} onClick={() => persist.mutate()}>
                  {t('storage.request', 'Ask the browser to keep this data')}
                </Button>
              </span>
            ),
          ],
          [t('storage.db', 'Local database'), <code key="db">{storeName}</code>],
        ]}
      />
      {pct !== null && (
        <meter
          className="mt-3 h-2 w-full"
          min={0}
          max={100}
          high={90}
          value={pct}
          aria-label={t('storage.used', 'Used')}
        />
      )}
      <div className="mt-3">
        <Notice tone="neutral">
          {isNative
            ? t(
                'storage.noteNative',
                'Data is stored in a database on this device. Keep encrypted backups: a lost or reset device loses it.',
              )
            : t(
                'storage.note',
                'Browser storage is less durable than a desktop database: clearing site data, private windows and storage eviction delete it. Keep encrypted backups.',
              )}
        </Notice>
      </div>
    </Card>
  );
}

/** Desktop app: encrypted backups written by themselves into a folder (shell/AutoBackup.tsx). */
function AutoBackupCard() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const { store } = useData();
  const backup = useApp((s) => s.backup);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const state = useQuery({
    queryKey: ['native', 'auto-backup'],
    queryFn: async () => ({ folder: await backupFolder(), pass: !!(await backupPassphrase()) }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['native', 'auto-backup'] });
  const pick = useMutation({ mutationFn: pickBackupFolder, onSuccess: refresh });
  const off = useMutation({
    mutationFn: async () => {
      await clearBackupFolder();
      await setBackupPassphrase(null);
    },
    onSuccess: refresh,
  });
  const savePass = useMutation({
    mutationFn: () => setBackupPassphrase(a),
    onSuccess: () => {
      setA('');
      setB('');
      setChanging(false);
      void refresh();
    },
  });
  const now = useMutation({
    mutationFn: () => runAutoBackup(store),
    onSuccess: (path) => path && toast(t('autoBackup.saved', 'Backup saved: {{path}}', { path })),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (a.length < 10)
      return setError(t('backup.short', 'Use a passphrase of at least 10 characters.'));
    if (a !== b) return setError(t('backup.mismatch', 'The passphrases do not match.'));
    setError(null);
    savePass.mutate();
  }
  const folder = state.data?.folder;
  const ready = !!folder && !!state.data?.pass;
  return (
    <Card title={t('autoBackup.title', 'Automatic backups')}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'autoBackup.text',
          'The app writes an encrypted backup of every profile into a folder you choose (for example one your cloud drive syncs), on the schedule below, and keeps the newest 10.',
        )}
      </p>
      {!keychainInUse() ? (
        <Notice tone="warn">
          {t(
            'autoBackup.noKeychain',
            'Needs the system keychain to keep the backup passphrase, and this computer has none available (on Linux: GNOME Keyring or KWallet).',
          )}
        </Notice>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 break-all">
              {folder ?? t('autoBackup.noFolder', 'No folder chosen.')}
            </span>
            <Button size="sm" busy={pick.isPending} onClick={() => pick.mutate()}>
              {folder
                ? t('autoBackup.changeFolder', 'Change folder')
                : t('autoBackup.chooseFolder', 'Choose folder')}
            </Button>
          </div>
          {state.data?.pass && !changing ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="pos">
                {t('autoBackup.passSaved', 'Passphrase kept in the system keychain')}
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
                {t('autoBackup.changePass', 'Change passphrase')}
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
              <Field label={t('backup.passphrase', 'Backup passphrase')}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={a}
                  onChange={(e) => setA(e.target.value)}
                />
              </Field>
              <Field label={t('lock.repeat', 'Repeat')} error={error}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={b}
                  onChange={(e) => setB(e.target.value)}
                />
              </Field>
              <div className="sm:col-span-2">
                <Button type="submit" busy={savePass.isPending}>
                  {t('autoBackup.savePass', 'Save passphrase')}
                </Button>
              </div>
            </form>
          )}
          {ready && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" busy={now.isPending} onClick={() => now.mutate()}>
                {t('autoBackup.now', 'Back up now')}
              </Button>
              <Button variant="ghost" busy={off.isPending} onClick={() => off.mutate()}>
                {t('autoBackup.off', 'Turn off')}
              </Button>
              <span className="text-xs text-muted">
                {backup.intervalDays <= 0
                  ? t('autoBackup.paused', 'Schedule is off (Backup schedule below).')
                  : backup.lastBackupAt
                    ? t('backup.last', 'Last backup: {{when}}', {
                        when: fmt.dateTime(backup.lastBackupAt),
                      })
                    : t('backup.never', 'No backup made on this device yet')}
              </span>
            </div>
          )}
          <ErrorBox error={state.error ?? pick.error ?? off.error ?? savePass.error ?? now.error} />
        </div>
      )}
    </Card>
  );
}

export function BackupsTab() {
  return (
    <div className="flex flex-col gap-4">
      {isDesktopNative() && <AutoBackupCard />}
      <ExportBackup />
      <RestoreBackup />
      <DataExport />
      <ServerBackups />
      <Storage />
    </div>
  );
}
