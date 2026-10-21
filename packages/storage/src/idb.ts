import { deleteDB, type IDBPDatabase, type IDBPTransaction, openDB } from 'idb';
import { MIGRATIONS, tablesAt } from './schema.ts';
import {
  type LocalStore,
  type Migration,
  type OutboxOp,
  type Query,
  type Row,
  StorageQuotaError,
  StorageUnavailableError,
  type StoreTx,
  type TableDef,
} from './types.ts';

type AnyTx = IDBPTransaction<unknown, string[], 'readonly' | 'readwrite' | 'versionchange'>;

function wrapError(e: unknown): unknown {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError')
    return new StorageQuotaError('browser storage quota exceeded; free space or export a backup');
  return e;
}

/** IndexedDB LocalStore (ADR 0006): one object store per table, [profileId, field] indexes,
 * versioned forward-only migrations in onupgradeneeded. */
export class IdbStore implements LocalStore {
  readonly schemaVersion: number;
  private db: IDBPDatabase | null = null;
  private defs: Record<string, TableDef>;

  constructor(
    readonly name = 'finplat',
    private migrations: Migration[] = MIGRATIONS,
    private factory?: IDBFactory, // fake-indexeddb in tests; defaults to globalThis.indexedDB
  ) {
    this.schemaVersion = migrations[migrations.length - 1]?.version ?? 1;
    this.defs = tablesAt(migrations, this.schemaVersion);
  }

  async open(): Promise<void> {
    if (this.db) return;
    const factory = this.factory ?? globalThis.indexedDB;
    if (!factory) throw new StorageUnavailableError('IndexedDB is not available in this browser');
    const prev = globalThis.indexedDB;
    // idb uses the global factory; swap in the injected one for the duration of the open call.
    if (this.factory)
      (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB = this.factory;
    const migrations = this.migrations;
    const pendingData: Promise<void>[] = [];
    try {
      this.db = await openDB(this.name, this.schemaVersion, {
        upgrade(db, oldVersion, _newVersion, tx) {
          for (const m of migrations) {
            if (m.version <= oldVersion) continue;
            for (const [name, def] of Object.entries(m.tables)) {
              const store = db.objectStoreNames.contains(name)
                ? tx.objectStore(name)
                : db.createObjectStore(name, {
                    keyPath: def.key,
                    autoIncrement: def.autoIncrement,
                  });
              if (!store.indexNames.contains('profileId'))
                store.createIndex('profileId', 'profileId');
              for (const f of def.indexes ?? [])
                if (!store.indexNames.contains(f)) store.createIndex(f, ['profileId', f]);
            }
            if (m.migrate)
              pendingData.push(m.migrate(makeTx(tx as AnyTx, tablesAt(migrations, m.version))));
          }
        },
        blocking: () => {
          // another tab wants a newer schema: let it upgrade
          this.db?.close();
          this.db = null;
        },
      });
      await Promise.all(pendingData);
    } catch (e) {
      throw wrapError(e);
    } finally {
      if (this.factory) (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB = prev;
    }
  }

  async run<T>(
    mode: 'readonly' | 'readwrite',
    tables: string[],
    fn: (tx: StoreTx) => Promise<T>,
  ): Promise<T> {
    if (!this.db) await this.open();
    const db = this.db as IDBPDatabase;
    const scope = [...new Set([...tables, ...(mode === 'readwrite' ? ['outbox'] : [])])];
    const tx = db.transaction(scope, mode) as unknown as AnyTx;
    try {
      const result = await fn(makeTx(tx, this.defs));
      await tx.done;
      return result;
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      await tx.done.catch(() => undefined);
      throw wrapError(e);
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async destroy(): Promise<void> {
    await this.close();
    const prev = globalThis.indexedDB;
    if (this.factory)
      (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB = this.factory;
    try {
      await deleteDB(this.name);
    } finally {
      if (this.factory) (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB = prev;
    }
  }
}

function makeTx(tx: AnyTx, defs: Record<string, TableDef>): StoreTx {
  const s: StoreTx = {
    get: async <T>(table: string, key: string | number) =>
      (await tx.objectStore(table).get(key)) as T | undefined,
    put: async (table, value) => {
      await (tx.objectStore(table) as unknown as { put(v: unknown): Promise<unknown> }).put(value);
    },
    delete: async (table, key) => {
      await (tx.objectStore(table) as unknown as { delete(k: unknown): Promise<void> }).delete(key);
    },
    query: async <T>(table: string, q: Query<T>) => {
      const def = defs[table];
      if (!def) throw new Error(`unknown table ${table}`);
      const store = tx.objectStore(table);
      let source: { openCursor(r?: IDBKeyRange | null, d?: IDBCursorDirection): Promise<unknown> } =
        store;
      let range: IDBKeyRange | null = null;
      if (q.index) {
        if (!def.indexes?.includes(q.index)) throw new Error(`no index ${q.index}`);
        if (q.profileId === undefined) throw new Error('indexed queries need profileId');
        source = store.index(q.index);
        // [] sorts after every string/number, so [pid, []] is the upper bound of the profile.
        range = IDBKeyRange.bound(
          q.from === undefined ? [q.profileId] : [q.profileId, q.from],
          q.to === undefined ? [q.profileId, []] : [q.profileId, q.to],
        );
      } else if (q.profileId !== undefined) {
        source = store.index('profileId');
        range = IDBKeyRange.only(q.profileId);
      }
      const out: T[] = [];
      type Cur = { value: Row; continue(): Promise<Cur | null> } | null;
      let cur = (await source.openCursor(range, q.reverse ? 'prev' : 'next')) as Cur;
      while (cur) {
        const v = cur.value;
        if ((q.includeDeleted || !v.deletedAt) && (!q.filter || q.filter(v as T))) {
          out.push(v as T);
          if (q.limit !== undefined && out.length >= q.limit) break;
        }
        cur = await cur.continue();
      }
      return out;
    },
    enqueue: async (op) => s.put<OutboxOp>('outbox', { ...op, status: 'pending' }),
  };
  return s;
}
