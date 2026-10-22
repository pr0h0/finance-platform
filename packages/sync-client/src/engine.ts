// Client sync engine (docs/architecture/sync-protocol.md): push the outbox in ordered,
// idempotent batches with retry/backoff, pull by cursor and apply remote changes atomically with
// the checkpoint, keep tombstones, store conflicts and rejected ops for explicit resolution.
// Never last-write-wins: a local row with unpushed ops is never overwritten by a pull.
import { type ApiClient, ApiError, checkCompatibility } from '@finplat/api-client';
import type { ImportedRawRecord, OperationResult, SyncChange, SyncConflict } from '@finplat/domain';
import { SYNC_PROTOCOL_VERSION } from '@finplat/domain';
import {
  ackOps,
  allOps,
  getCheckpoint,
  getMeta,
  importSourceKey,
  type LocalStore,
  type OutboxOp,
  pendingOps,
  rejectOp,
  type StoreTx,
  SYNCED_TABLES,
  setMeta,
} from '@finplat/storage';
import { type Envelope, isEnvelope, type Keyring } from './crypto.ts';

export type SyncApi = Pick<ApiClient, 'getMeta' | 'sync'> & Partial<Pick<ApiClient, 'send'>>;

/** Entities uploaded over REST instead of /sync/push: attachment content, and new import batches
 * (original file + raw records). Later import_batches status changes go through /sync/push. */
const isUpload = (o: OutboxOp) =>
  o.entityType === 'attachments' ||
  (o.entityType === 'import_batches' && o.op === 'upsert' && o.baseVersion === null);

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface SyncEngineOptions {
  store: LocalStore;
  api: SyncApi;
  /** Profile id in the local store and on the server (they differ after activating a
   * local-only profile into an existing server profile). */
  localProfileId: string;
  remoteProfileId: string;
  deviceId: string;
  /** Present for e2ee profiles: payloads are encrypted before push, decrypted after pull. */
  keyring?: Keyring;
  pushBatch?: number; // ≤ 500 (server limit)
  pullLimit?: number; // ≤ 1000
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface LocalConflict {
  id: string; // server conflict id
  profileId: string;
  opId: string;
  entityType: string;
  entityId: string;
  fields: string[];
  clientData: Record<string, unknown> | null;
  serverData: Record<string, unknown> | null;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: string;
  deletedAt: null;
}

export interface SyncState {
  lastSyncAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  serverVersion: number;
}

export interface SyncStatus extends SyncState {
  checkpoint: number;
  pending: number;
  rejected: OutboxOp[];
  conflicts: LocalConflict[];
}

export class IncompatibleServerError extends Error {
  override name = 'IncompatibleServerError';
}

const SYNCED = new Set<string>(SYNCED_TABLES);
const TABLES = [...SYNCED_TABLES, 'outbox', 'checkpoints', 'conflicts', 'meta'];

export class SyncEngine {
  private o: Required<Omit<SyncEngineOptions, 'keyring'>> & { keyring?: Keyring };
  private running: Promise<SyncStatus> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private compatible = false;

  constructor(opts: SyncEngineOptions) {
    this.o = {
      pushBatch: 200,
      pullLimit: 500,
      retries: 5,
      backoffMs: 500,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
      ...opts,
    };
  }

  get localProfileId() {
    return this.o.localProfileId;
  }

  private stateKey = () => `sync:state:${this.o.localProfileId}`;

  /** Feature 107: refuse to talk to an unknown or incompatible server. */
  async checkServer(): Promise<void> {
    if (this.compatible) return;
    const c = checkCompatibility(await this.retry(() => this.o.api.getMeta()));
    if (!c.ok) throw new IncompatibleServerError(c.reason);
    this.compatible = true;
  }

  /** Retry transient failures (offline, 5xx, 429) with exponential backoff + jitter. */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ApiError) || !e.retryable || attempt >= this.o.retries) throw e;
        const ms = this.o.backoffMs * 2 ** attempt;
        await this.o.sleep(ms / 2 + Math.random() * (ms / 2));
      }
    }
  }

  // ------------------------------------------------------------ push

  private encode(op: OutboxOp): OutboxOp {
    if (!op.data) return op;
    const data = { ...op.data, profileId: this.o.remoteProfileId };
    if (!this.o.keyring) return { ...op, data };
    const env = this.o.keyring.encrypt(
      { profileId: this.o.remoteProfileId, entityType: op.entityType, entityId: op.entityId },
      data,
    );
    // the server cannot merge ciphertext: changedFields would leak metadata, omit them
    const { changedFields: _c, ...rest } = op;
    return { ...rest, data: env as unknown as Record<string, unknown> };
  }

  /** Pushes every pending op in order. Returns how many were sent. Resumable: acknowledged ops
   * leave the outbox; a retry after a crash resends the rest with the same opIds. */
  async push(): Promise<number> {
    let sent = 0;
    for (;;) {
      const pending = await pendingOps(this.o.store, this.o.localProfileId, this.o.pushBatch);
      if (pending.length === 0) return sent;
      // keep outbox order: ops before an upload are pushed first, then the upload runs alone
      const k = pending.findIndex(isUpload);
      if (k === 0) {
        await this.upload(pending[0] as OutboxOp);
        sent++;
        continue;
      }
      const ops = k > 0 ? pending.slice(0, k) : pending;
      const operations = ops.map((op) => {
        const { seq: _s, status: _st, profileId: _p, error: _e, ...wire } = this.encode(op);
        return wire;
      });
      const res = await this.retry(() =>
        this.o.api.sync.push({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          deviceId: this.o.deviceId,
          profileId: this.o.remoteProfileId,
          operations,
        }),
      );
      await this.applyResults(ops, res.results);
      sent += ops.length;
      await this.saveState({ serverVersion: res.serverVersion });
      if (res.results.length < ops.length) return sent; // server stopped early; next sync continues
    }
  }

  /** One REST upload (see isUpload). Acked when done or already on the server; a permanent
   * refusal is kept as a rejected op for the sync dashboard, transient errors are retried. */
  private async upload(op: OutboxOp): Promise<void> {
    const done = () => ackOps(this.o.store, this.o.localProfileId, [op.opId]);
    // e2ee: the server must not see plaintext files or statements; they stay on this device
    if (this.o.keyring) return done();
    const send = this.o.api.send;
    if (!send) throw new Error('this sync api cannot upload files');
    const hdr = { 'X-Profile-ID': this.o.remoteProfileId, 'Idempotency-Key': op.opId };
    try {
      if (op.entityType === 'attachments') {
        if (op.op === 'delete') {
          await this.retry(() =>
            send('DELETE', `/api/v1/attachments/${op.entityId}`, undefined, hdr),
          );
        } else if (op.baseVersion === null) {
          const row = await this.local<{ blob?: Blob }>('blobs', op.entityId);
          if (!row?.blob) return done(); // removed again before it was uploaded
          const a = op.data as {
            transactionId?: string | null;
            purpose?: string;
            fileName?: string;
          };
          const form = () => {
            const f = new FormData();
            f.set('id', op.entityId);
            if (a.transactionId) f.set('transactionId', a.transactionId);
            f.set('purpose', a.purpose ?? 'receipt');
            f.set('file', row.blob as Blob, a.fileName ?? 'attachment');
            return f;
          };
          await this.retry(() => send('POST', '/api/v1/attachments', form(), hdr));
        } // ponytail: attachments are never edited locally; a metadata edit would need PATCH here
        return done();
      }
      const b = op.data as Record<string, unknown>;
      const src = await this.local<{ blob?: Blob; statements?: unknown[] }>(
        'blobs',
        importSourceKey(op.entityId),
      );
      if (!src?.blob) {
        await rejectOp(this.o.store, this.o.localProfileId, op.opId, {
          code: 'source_missing',
          message: 'the original file of this import is not on this device; it stays local',
        });
        return;
      }
      const recs = await this.o.store.run('readonly', ['imported_raw_records'], (tx) =>
        tx.query<ImportedRawRecord>('imported_raw_records', {
          index: 'importBatchId',
          from: op.entityId,
          to: op.entityId,
        }),
      );
      const body = JSON.stringify({
        id: op.entityId,
        importerId: b.importerId,
        importerVersion: b.importerVersion,
        accountId: b.accountId,
        fileName: b.fileName,
        fileSha256: b.fileSha256,
        source: base64(new Uint8Array(await src.blob.arrayBuffer())),
        result: {
          records: recs.map((r) => ({
            id: r.id,
            rowNumber: r.rowNumber,
            postingDate: r.postingDate,
            valueDate: r.valueDate ?? undefined,
            description: r.sourceDescription,
            direction: r.direction,
            amount: r.amount.amount.replace(/^-/, ''),
            currency: r.amount.currency,
            originalAmount: r.originalAmount?.amount,
            originalCurrency: r.originalAmount?.currency,
            exchangeRate: r.exchangeRate ?? undefined,
            runningBalance: r.runningBalance?.amount,
            bankReference: r.bankReference,
            statementRef: r.statementRef,
            accountRef: r.sourceAccount,
            counterparty: r.counterparty,
            raw: Object.fromEntries(Object.entries(r.raw).map(([k, v]) => [k, String(v)])),
            warnings: r.warnings.map((message) => ({ code: 'warning', message })),
          })),
          statements: src.statements ?? [],
          errors: [],
          warnings: [],
        },
      });
      await this.retry(() =>
        send('POST', '/api/v1/imports', body, { ...hdr, 'Content-Type': 'application/json' }),
      );
      return done();
    } catch (e) {
      if (!(e instanceof ApiError) || e.retryable) throw e;
      // already there (a retry after a lost response) or already gone
      if (e.status === 409 || (op.op === 'delete' && e.status === 404)) return done();
      await rejectOp(this.o.store, this.o.localProfileId, op.opId, {
        code: e.code,
        message: e.message,
      });
    }
  }

  private local<T>(table: string, id: string) {
    return this.o.store.run('readonly', [table], (tx) => tx.get<T>(table, id));
  }

  private async applyResults(ops: OutboxOp[], results: OperationResult[]) {
    const byId = new Map(ops.map((o) => [o.opId, o]));
    const acked: string[] = [];
    for (const r of results) {
      const op = byId.get(r.opId);
      if (!op) continue;
      if (r.status === 'rejected') {
        await rejectOp(this.o.store, this.o.localProfileId, r.opId, {
          code: r.code,
          message: r.message,
        });
        continue;
      }
      acked.push(r.opId);
      await this.o.store.run('readwrite', [op.entityType, 'conflicts'], async (tx) => {
        if (r.status === 'applied') {
          const row = await tx.get<Record<string, unknown>>(op.entityType, op.entityId);
          // stamp only if the row is still the version we pushed (a newer local edit is pending)
          if (row && row.version === r.version)
            await tx.put(op.entityType, { ...row, serverVersion: r.serverVersion });
        } else {
          const c: LocalConflict = {
            id: r.conflictId,
            profileId: this.o.localProfileId,
            opId: r.opId,
            entityType: op.entityType,
            entityId: op.entityId,
            fields: r.fields,
            clientData: op.data,
            serverData: null,
            status: 'open',
            createdAt: this.o.now().toISOString(),
            deletedAt: null,
          };
          await tx.put('conflicts', c);
        }
      });
    }
    await ackOps(this.o.store, this.o.localProfileId, acked);
  }

  // ------------------------------------------------------------ pull

  private decode(c: SyncChange): Record<string, unknown> | null {
    if (!c.data) return null;
    if (!this.o.keyring) return c.data;
    if (!isEnvelope(c.data))
      throw new Error(`expected an encrypted envelope for ${c.entityType}/${c.entityId}`);
    const plain = this.o.keyring.decrypt(
      { profileId: this.o.remoteProfileId, entityType: c.entityType, entityId: c.entityId },
      c.data as unknown as Envelope,
    );
    // the server's per-entity version travels next to the envelope
    return { ...plain, version: (c.data as { version?: number }).version ?? plain.version };
  }

  /** Applies one remote change. Idempotent (full snapshots keyed by id + serverVersion). */
  private async applyChange(tx: StoreTx, c: SyncChange, pendingIds: Set<string>) {
    if (!SYNCED.has(c.entityType)) return; // entity unknown to this client version: skip safely
    if (pendingIds.has(`${c.entityType}:${c.entityId}`)) return; // local unpushed edit wins until pushed/conflicted
    const cur = await tx.get<Record<string, unknown>>(c.entityType, c.entityId);
    if (cur && typeof cur.serverVersion === 'number' && cur.serverVersion > c.serverVersion) return;
    if (c.op === 'delete') {
      if (cur && !cur.deletedAt)
        await tx.put(c.entityType, {
          ...cur,
          deletedAt: c.changedAt,
          serverVersion: c.serverVersion,
        });
      else if (cur) await tx.put(c.entityType, { ...cur, serverVersion: c.serverVersion });
      return;
    }
    const data = this.decode(c);
    if (!data) return;
    await tx.put(c.entityType, {
      ...data,
      id: c.entityId,
      profileId: this.o.localProfileId,
      serverVersion: c.serverVersion,
      deletedAt: data.deletedAt ?? null,
    });
  }

  private async pendingEntityIds(): Promise<Set<string>> {
    const ops = await allOps(this.o.store, this.o.localProfileId);
    return new Set(
      ops.filter((o) => o.status === 'pending').map((o) => `${o.entityType}:${o.entityId}`),
    );
  }

  /** Pulls until caught up. Each page and its checkpoint commit in one store transaction, so an
   * interruption re-pulls at most one page. */
  async pull(): Promise<number> {
    let applied = 0;
    for (;;) {
      const since = await getCheckpoint(this.o.store, this.o.localProfileId);
      const page = await this.retry(() =>
        this.o.api.sync.pull(this.o.remoteProfileId, since, this.o.pullLimit, this.o.deviceId),
      );
      const pending = await this.pendingEntityIds();
      await this.o.store.run('readwrite', TABLES, async (tx) => {
        for (const c of page.changes) await this.applyChange(tx, c, pending);
        await tx.put('checkpoints', { id: this.o.localProfileId, serverVersion: page.nextSince });
      });
      applied += page.changes.length;
      await this.saveState({ serverVersion: page.serverVersion });
      if (!page.hasMore || page.changes.length === 0) return applied;
    }
  }

  /** Initial download of current state (not history), then pull continues from its head. */
  async downloadSnapshot(): Promise<number> {
    let cursor: string | undefined;
    let n = 0;
    let head = 0;
    const pending = await this.pendingEntityIds();
    do {
      const page = await this.retry(() => this.o.api.sync.snapshot(this.o.remoteProfileId, cursor));
      await this.o.store.run('readwrite', TABLES, async (tx) => {
        for (const c of page.changes) await this.applyChange(tx, c, pending);
      });
      n += page.changes.length;
      head = page.serverVersion;
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor);
    await this.o.store.run('readwrite', ['checkpoints'], (tx) =>
      tx.put('checkpoints', { id: this.o.localProfileId, serverVersion: head }),
    );
    return n;
  }

  // ------------------------------------------------------------ orchestration

  /** push → pull. Concurrent calls share one run. Errors are recorded in the state and thrown. */
  sync(): Promise<SyncStatus> {
    this.running ??= (async () => {
      try {
        await this.checkServer();
        await this.push();
        await this.pull();
        await this.saveState({ lastSyncAt: this.o.now().toISOString(), lastError: null });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        await this.saveState({
          lastError: {
            code: err.code ?? (e as Error).name,
            message: err.message ?? String(e),
            at: this.o.now().toISOString(),
          },
        });
        throw e;
      } finally {
        this.running = null;
      }
      return this.status();
    })();
    return this.running;
  }

  /** Debounced background sync after local writes; failures stay in the status. */
  schedule(delayMs = 1000): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sync().catch(() => undefined);
    }, delayMs);
  }

  private async saveState(patch: Partial<SyncState>) {
    const cur = (await getMeta<SyncState>(this.o.store, this.stateKey())) ?? {
      lastSyncAt: null,
      lastError: null,
      serverVersion: 0,
    };
    await setMeta(this.o.store, this.stateKey(), { ...cur, ...patch });
  }

  /** Data for the sync dashboard (feature 108). */
  async status(): Promise<SyncStatus> {
    const state = (await getMeta<SyncState>(this.o.store, this.stateKey())) ?? {
      lastSyncAt: null,
      lastError: null,
      serverVersion: 0,
    };
    const ops = await allOps(this.o.store, this.o.localProfileId);
    const conflicts = await this.conflicts();
    return {
      ...state,
      checkpoint: await getCheckpoint(this.o.store, this.o.localProfileId),
      pending: ops.filter((o) => o.status === 'pending').length,
      rejected: ops.filter((o) => o.status === 'rejected'),
      conflicts,
    };
  }

  // ------------------------------------------------------------ conflicts

  async conflicts(): Promise<LocalConflict[]> {
    return this.o.store.run('readonly', ['conflicts'], (tx) =>
      tx.query<LocalConflict>('conflicts', {
        profileId: this.o.localProfileId,
        filter: (c) => c.status === 'open',
      }),
    );
  }

  /** Fetch both sides of open conflicts from the server for the resolution UI. */
  async refreshConflicts(): Promise<LocalConflict[]> {
    const remote = (await this.retry(() =>
      this.o.api.sync.conflicts(this.o.remoteProfileId),
    )) as SyncConflict[];
    await this.o.store.run('readwrite', ['conflicts'], async (tx) => {
      for (const r of remote) {
        const cur = await tx.get<LocalConflict>('conflicts', r.id);
        const ctx = {
          profileId: this.o.remoteProfileId,
          entityType: r.entityType,
          entityId: r.entityId,
        };
        const open = (d: Record<string, unknown> | null) => {
          if (!d || !this.o.keyring) return d;
          const env = (d as { envelope?: unknown }).envelope ?? d;
          return isEnvelope(env) ? this.o.keyring.decrypt(ctx, env) : d;
        };
        await tx.put('conflicts', {
          ...(cur ?? { profileId: this.o.localProfileId, createdAt: r.createdAt, deletedAt: null }),
          id: r.id,
          opId: r.opId,
          entityType: r.entityType,
          entityId: r.entityId,
          fields: r.fields,
          status: r.status,
          serverData: open(r.serverData),
          clientData: open(r.clientData) ?? cur?.clientData ?? null,
        });
      }
    });
    return this.conflicts();
  }

  /** Explicit resolution: keep the server's state, re-apply ours, or a merged entity. The
   * server validates it like any other mutation; the result arrives with the next pull. */
  async resolve(
    conflictId: string,
    choice: 'server' | 'client' | 'merged',
    merged?: Record<string, unknown>,
  ) {
    const c = await this.o.store.run('readonly', ['conflicts'], (tx) =>
      tx.get<LocalConflict>('conflicts', conflictId),
    );
    if (!c) throw new Error('unknown conflict');
    let data = merged;
    if (data && this.o.keyring)
      data = this.o.keyring.encrypt(
        { profileId: this.o.remoteProfileId, entityType: c.entityType, entityId: c.entityId },
        { ...data, profileId: this.o.remoteProfileId },
      ) as unknown as Record<string, unknown>;
    await this.retry(() =>
      this.o.api.sync.resolve(
        this.o.remoteProfileId,
        conflictId,
        data ? { choice, data } : { choice },
      ),
    );
    await this.o.store.run('readwrite', ['conflicts'], (tx) =>
      tx.put('conflicts', { ...c, status: 'resolved' }),
    );
    await this.pull(); // the resolved state is a new server change after our checkpoint
  }

  /** Drop a server-rejected op from the dashboard. The local row keeps the rejected edit until
   * the entity changes on the server again or the user edits it. */
  async discardRejected(opId: string): Promise<void> {
    await ackOps(this.o.store, this.o.localProfileId, [opId]);
  }
}
