// Local persistence abstraction (ADR 0006). Web implements it on IndexedDB (idb.ts), tests use
// memory.ts; desktop/mobile (DEFERRED_TO_PHASE 3/4) implement the same interface on SQLite.
// Business code depends only on these types.
import type { SyncOperation } from '@finplat/domain';

/** Any stored row. Entity tables use the API wire shapes from @finplat/domain. */
export type Row = Record<string, unknown>;

export interface Query<T = Row> {
  /** Required for every profile-scoped table. */
  profileId?: string;
  /** A field declared in the table's `indexes`; range-scan on it within the profile. */
  index?: string;
  from?: string | number;
  to?: string | number; // inclusive
  limit?: number;
  reverse?: boolean;
  /** Tombstoned rows (deletedAt != null) are skipped unless set. */
  includeDeleted?: boolean;
  /** Extra in-process predicate, applied before `limit`. */
  filter?: (row: T) => boolean;
}

/** A queued client mutation (outbox / op log). `seq` orders ops; push sends them in order. */
export interface OutboxOp extends SyncOperation {
  seq?: number;
  profileId: string;
  status: 'pending' | 'rejected';
  error?: { code: string; message: string };
}

/** All writes inside run() commit atomically or not at all. fn must only await store calls:
 * IndexedDB commits a transaction as soon as it has no pending request. */
export interface StoreTx {
  get<T = Row>(table: string, key: string | number): Promise<T | undefined>;
  put<T extends object>(table: string, value: T): Promise<void>;
  /** Hard delete. Only for local bookkeeping tables (outbox, staging, blobs); synced entities are
   * tombstoned with deletedAt instead. */
  delete(table: string, key: string | number): Promise<void>;
  query<T = Row>(table: string, q: Query<T>): Promise<T[]>;
  /** Append to the outbox of operations awaiting push. */
  enqueue(op: Omit<OutboxOp, 'seq' | 'status'>): Promise<void>;
}

export interface TableDef {
  key: string; // keyPath
  autoIncrement?: boolean;
  /** Fields indexed as [profileId, field]; 'profileId' alone is always indexed. */
  indexes?: string[];
}

export interface Migration {
  version: number;
  /** Tables created in this version (new tables or new indexes on existing ones). */
  tables: Record<string, TableDef>;
  /** Optional data migration, runs inside the upgrade transaction. */
  migrate?: (tx: StoreTx) => Promise<void>;
}

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

export interface LocalStore {
  readonly schemaVersion: number;
  /** Opens and runs pending local schema migrations. */
  open(): Promise<void>;
  run<T>(
    mode: 'readonly' | 'readwrite',
    tables: string[],
    fn: (tx: StoreTx) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
  /** Deletes the whole local database (explicit user action only). */
  destroy(): Promise<void>;
}

export class StorageQuotaError extends Error {
  override name = 'StorageQuotaError';
}

export class StorageUnavailableError extends Error {
  override name = 'StorageUnavailableError';
}
