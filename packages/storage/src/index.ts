// Local persistence abstraction (ADR 0006). Web implements it on IndexedDB; desktop/mobile
// (DEFERRED_TO_PHASE 3/4) implement it on SQLite. Business code depends only on this interface.
import type { SyncOperation } from '@finplat/domain';

export interface StoredRecord {
  id: string;
  profileId: string;
  version: number;
  serverVersion: number;
  deletedAt: string | null;
  [k: string]: unknown;
}

export interface Query {
  profileId: string;
  index?: string; // e.g. 'bookingDate'
  from?: string | number;
  to?: string | number;
  limit?: number;
  reverse?: boolean;
  includeDeleted?: boolean;
}

/** All writes inside run() commit atomically or not at all. */
export interface StoreTx {
  get<T extends StoredRecord>(table: string, id: string): Promise<T | undefined>;
  put<T extends StoredRecord>(table: string, value: T): Promise<void>;
  query<T extends StoredRecord>(table: string, q: Query): Promise<T[]>;
  /** Append to the outbox of operations awaiting push. */
  enqueue(op: SyncOperation & { profileId: string }): Promise<void>;
}

export interface LocalStore {
  readonly schemaVersion: number;
  open(): Promise<void>; // runs local schema migrations
  run<T>(
    mode: 'readonly' | 'readwrite',
    tables: string[],
    fn: (tx: StoreTx) => Promise<T>,
  ): Promise<T>;
  outbox(profileId: string, limit: number): Promise<(SyncOperation & { profileId: string })[]>;
  ackOutbox(opIds: string[]): Promise<void>;
  getCheckpoint(profileId: string): Promise<number>; // last pulled serverVersion
  setCheckpoint(profileId: string, serverVersion: number): Promise<void>;
  close(): Promise<void>;
}
