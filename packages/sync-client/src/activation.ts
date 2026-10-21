// Sync activation / deactivation (PLAN §21, features 87, 106, 109). Activation turns a local
// profile into a synced one: preview duplicates, upload everything as create ops in recoverable
// batches, verify against the server, and only then mark sync active. Disconnecting never
// deletes data. Server migration = disconnect from A, activate on B.
import type { Account, Category, Merchant, Tag, Transaction } from '@finplat/domain';
import { accountBalances, type LedgerTransaction } from '@finplat/finance-engine';
import {
  allOps,
  getMeta,
  type LocalStore,
  type OutboxOp,
  SYNCED_TABLES,
  setMeta,
  uuidv7,
} from '@finplat/storage';
import { type Envelope, isEnvelope, type Keyring } from './crypto.ts';
import { type SyncApi, SyncEngine } from './engine.ts';

/** Local-only evidence that sync does not carry (see docs/architecture/sync-client.md). */
const NOT_UPLOADED = new Set(['import_batches', 'attachments']);

export interface SyncConfig {
  serverUrl: string;
  remoteProfileId: string;
  deviceId: string;
  e2ee: boolean;
  active: boolean;
  activatedAt: string | null;
  disconnectedAt?: string | null;
}

export const configKey = (localProfileId: string) => `sync:config:${localProfileId}`;
const activationKey = (localProfileId: string) => `sync:activation:${localProfileId}`;

export function getSyncConfig(store: LocalStore, localProfileId: string) {
  return getMeta<SyncConfig>(store, configKey(localProfileId));
}

type Row = Record<string, unknown> & { id: string; deletedAt?: string | null };

async function localRows(store: LocalStore, profileId: string): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  await store.run('readonly', [...SYNCED_TABLES], async (tx) => {
    for (const t of SYNCED_TABLES) out.set(t, await tx.query<Row>(t, { profileId }));
  });
  return out;
}

async function remoteRows(api: SyncApi, remoteProfileId: string, keyring?: Keyring) {
  const out = new Map<string, Row[]>();
  let cursor: string | undefined;
  let head = 0;
  do {
    const page = await api.sync.snapshot(remoteProfileId, cursor);
    for (const c of page.changes) {
      if (!c.data) continue;
      let data = c.data;
      if (keyring && isEnvelope(data))
        data = {
          ...keyring.decrypt(
            { profileId: remoteProfileId, entityType: c.entityType, entityId: c.entityId },
            data as unknown as Envelope,
          ),
          version: (data as { version?: number }).version,
        };
      const list = out.get(c.entityType) ?? [];
      list.push({ ...data, id: c.entityId } as Row);
      out.set(c.entityType, list);
    }
    head = page.serverVersion;
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  return { rows: out, head };
}

export interface DuplicateCandidate {
  entityType: string;
  localId: string;
  remoteId: string;
  label: string;
}

export interface ActivationPreview {
  upload: Record<string, number>;
  remote: Record<string, number>;
  duplicates: DuplicateCandidate[];
}

const norm = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
const txKey = (t: Transaction) =>
  `${t.bookingDate}|${t.kind}|${norm(t.description)}|${t.postings.map((p) => `${p.amount.amount}${p.amount.currency}`).join(',')}`;

const KEYS: Record<string, (r: Row) => string> = {
  accounts: (r) => `${norm((r as unknown as Account).name)}|${(r as unknown as Account).currency}`,
  categories: (r) =>
    `${norm((r as unknown as Category).name)}|${(r as unknown as Category).kind}|${(r as unknown as Category).parentId ?? ''}`,
  tags: (r) => norm((r as unknown as Tag).name),
  merchants: (r) => norm((r as unknown as Merchant).name),
  transactions: (r) => txKey(r as unknown as Transaction),
};

/** Step 3–4: what would be uploaded and which local rows look like rows already on the server. */
export async function previewActivation(
  store: LocalStore,
  api: SyncApi,
  localProfileId: string,
  remoteProfileId: string,
  keyring?: Keyring,
): Promise<ActivationPreview> {
  const local = await localRows(store, localProfileId);
  const { rows: remote } = await remoteRows(api, remoteProfileId, keyring);
  const upload: Record<string, number> = {};
  const remoteCounts: Record<string, number> = {};
  const duplicates: DuplicateCandidate[] = [];
  for (const t of SYNCED_TABLES) {
    const live = (local.get(t) ?? []).filter((r) => !r.deletedAt);
    if (!NOT_UPLOADED.has(t)) upload[t] = live.length;
    const rem = (remote.get(t) ?? []).filter((r) => !r.deletedAt);
    remoteCounts[t] = rem.length;
    const key = KEYS[t];
    if (!key) continue;
    const byKey = new Map(rem.map((r) => [key(r), r]));
    for (const r of live) {
      const hit = byKey.get(key(r));
      if (hit && hit.id !== r.id)
        duplicates.push({
          entityType: t,
          localId: r.id,
          remoteId: hit.id,
          label: String(r.name ?? r.description ?? r.id),
        });
    }
  }
  return { upload, remote: remoteCounts, duplicates };
}

/** Deep-replace merged ids (UUIDs are globally unique, so replacing equal strings is safe). */
function remap<T>(v: T, ids: Map<string, string>): T {
  if (ids.size === 0) return v;
  if (typeof v === 'string') return (ids.get(v) ?? v) as T;
  if (Array.isArray(v)) return v.map((x) => remap(x, ids)) as T;
  if (v && typeof v === 'object' && !(v instanceof Blob))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, ids)])) as T;
  return v;
}

/** Parents before children so the server can check category references. */
function topo(rows: Row[]): Row[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Row[] = [];
  const seen = new Set<string>();
  const visit = (r: Row) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const p = byId.get(r.parentId as string);
    if (p) visit(p);
    out.push(r);
  };
  rows.forEach(visit);
  return out;
}

export interface ActivationOptions {
  store: LocalStore;
  api: SyncApi;
  serverUrl: string;
  localProfileId: string;
  remoteProfileId: string;
  deviceId: string;
  keyring?: Keyring;
  /** localId -> remoteId for duplicates the user chose to merge (local row is dropped). */
  merge?: Record<string, string>;
  engine?: SyncEngine;
  now?: () => Date;
}

export interface VerifyReport {
  ok: boolean;
  missing: { entityType: string; id: string }[];
  balanceMismatches: { accountId: string; currency: string; local: string; remote: string }[];
  rejected: OutboxOp[];
}

/**
 * Steps 5–7. Idempotent and resumable: the prepared outbox (stable opIds) survives a crash and
 * calling activate() again continues the upload, then verifies.
 */
export async function activate(o: ActivationOptions): Promise<VerifyReport> {
  const now = o.now ?? (() => new Date());
  const engine =
    o.engine ??
    new SyncEngine({
      store: o.store,
      api: o.api,
      localProfileId: o.localProfileId,
      remoteProfileId: o.remoteProfileId,
      deviceId: o.deviceId,
      keyring: o.keyring,
    });
  await engine.checkServer();
  const state = await getMeta<{ step: string }>(o.store, activationKey(o.localProfileId));
  if (!state) await prepareUpload(o, now);
  await engine.push();
  const report = await verify(o);
  if (!report.ok) return report;
  await engine.downloadSnapshot(); // rows that already existed on the server
  await setMeta<SyncConfig>(o.store, configKey(o.localProfileId), {
    serverUrl: o.serverUrl,
    remoteProfileId: o.remoteProfileId,
    deviceId: o.deviceId,
    e2ee: !!o.keyring,
    active: true,
    activatedAt: now().toISOString(),
    disconnectedAt: null,
  });
  await o.store.run('readwrite', ['meta'], (tx) =>
    tx.delete('meta', activationKey(o.localProfileId)),
  );
  return report;
}

/** One transaction: drop merged duplicates, remap references, reset versions, replace the outbox
 * with one create per live row (history is not replayed). */
async function prepareUpload(o: ActivationOptions, now: () => Date) {
  const ids = new Map(Object.entries(o.merge ?? {}));
  const t = now().toISOString();
  await o.store.run(
    'readwrite',
    [...SYNCED_TABLES, 'outbox', 'meta', 'checkpoints'],
    async (tx) => {
      for (const op of await tx.query<OutboxOp>('outbox', { profileId: o.localProfileId }))
        await tx.delete('outbox', op.seq as number);
      for (const table of SYNCED_TABLES) {
        let rows = await tx.query<Row>(table, {
          profileId: o.localProfileId,
          includeDeleted: true,
        });
        if (table === 'categories') rows = topo(rows);
        for (const r of rows) {
          if (ids.has(r.id)) {
            await tx.delete(table, r.id); // replaced by the server's row on download
            continue;
          }
          const next = { ...remap(r, ids), version: 1, serverVersion: 0 } as Row;
          await tx.put(table, next);
          if (next.deletedAt || NOT_UPLOADED.has(table)) continue;
          const data: Row = { ...next };
          if (table === 'transactions') {
            data.importRecordId = null; // raw import evidence stays on this device
            data.attachmentIds = [];
          }
          await tx.enqueue({
            opId: uuidv7(),
            profileId: o.localProfileId,
            entityType: table,
            entityId: r.id,
            op: 'upsert',
            baseVersion: null,
            data,
            clientTime: t,
          });
        }
      }
      await tx.put('checkpoints', { id: o.localProfileId, serverVersion: 0 });
      await tx.put('meta', {
        id: activationKey(o.localProfileId),
        value: { step: 'uploading', at: t },
      });
    },
  );
}

/** Step 6: every uploaded row exists on the server and per-account balances match exactly. */
export async function verify(
  o: Pick<ActivationOptions, 'store' | 'api' | 'localProfileId' | 'remoteProfileId' | 'keyring'>,
): Promise<VerifyReport> {
  const rejected = (await allOps(o.store, o.localProfileId)).filter((x) => x.status === 'rejected');
  const local = await localRows(o.store, o.localProfileId);
  const { rows: remote } = await remoteRows(o.api, o.remoteProfileId, o.keyring);
  const missing: VerifyReport['missing'] = [];
  for (const t of SYNCED_TABLES) {
    if (NOT_UPLOADED.has(t)) continue;
    const have = new Set((remote.get(t) ?? []).map((r) => r.id));
    for (const r of local.get(t) ?? [])
      if (!r.deletedAt && !have.has(r.id)) missing.push({ entityType: t, id: r.id });
  }
  const lb = accountBalances((local.get('transactions') ?? []) as unknown as LedgerTransaction[]);
  const rb = accountBalances((remote.get('transactions') ?? []) as unknown as LedgerTransaction[]);
  const key = (b: { accountId: string; currency: string }) => `${b.accountId}|${b.currency}`;
  const rmap = new Map(rb.map((b) => [key(b), b.amount]));
  const balanceMismatches: VerifyReport['balanceMismatches'] = [];
  for (const b of lb) {
    const r = rmap.get(key(b)) ?? null;
    if (r !== b.amount)
      balanceMismatches.push({
        accountId: b.accountId,
        currency: b.currency,
        local: b.amount,
        remote: r ?? 'missing',
      });
  }
  return {
    ok: rejected.length === 0 && missing.length === 0 && balanceMismatches.length === 0,
    missing,
    balanceMismatches,
    rejected,
  };
}

/** Step 1–2 of disconnecting: what would stay unsynchronized. */
export async function disconnectPreview(store: LocalStore, localProfileId: string) {
  const ops = await allOps(store, localProfileId);
  return {
    pending: ops.filter((x) => x.status === 'pending').length,
    rejected: ops.filter((x) => x.status === 'rejected').length,
  };
}

/** Steps 3–4: stop remote operations, keep every local record (and the outbox). Remote deletion
 * is a separate explicit action on the server (DELETE /profiles/{id}). */
export async function disconnect(
  store: LocalStore,
  localProfileId: string,
  now = () => new Date(),
) {
  const cfg = await getSyncConfig(store, localProfileId);
  if (cfg)
    await setMeta<SyncConfig>(store, configKey(localProfileId), {
      ...cfg,
      active: false,
      disconnectedAt: now().toISOString(),
    });
}
