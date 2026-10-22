import { runQuery } from './query.ts';
import { LATEST_VERSION, MIGRATIONS, tablesAt } from './schema.ts';
import type { LocalStore, Migration, Query, Row, StoreTx, TableDef } from './types.ts';

type Key = string | number;
const DELETED = Symbol('deleted');

/** Everything a persistent backend holds: the schema version, autoIncrement counters, all rows. */
export interface StoreSnapshot {
  version: number;
  seq: Record<string, number>;
  tables: Record<string, Row[]>;
}

/** One committed write transaction (row null = deleted). */
export interface StoreCommit {
  version: number;
  seq: Record<string, number>;
  changes: { table: string; key: Key; row: Row | null }[];
}

/** Durable backend behind a MemoryStore (desktop/mobile: SQLite in the Tauri shell). commit() must
 * be atomic; it runs before the change becomes visible, so a failed commit changes nothing. */
export interface StorePersistence {
  load(): Promise<StoreSnapshot | null>;
  commit(c: StoreCommit): Promise<void>;
  destroy(): Promise<void>;
}

/** In-memory LocalStore with the same semantics as IndexedDB (atomic run(), structured clone,
 * serialized writers). For tests and for environments without IndexedDB. With a StorePersistence
 * it is the persistent store of the native apps: reads are served from memory, every write
 * transaction is committed to the backend first.
 * ponytail: the whole database lives in memory (fine for a personal ledger of tens of thousands of
 * rows); page rows from SQLite on demand if that ever matters. */
export class MemoryStore implements LocalStore {
  readonly schemaVersion: number;
  private data = new Map<string, Map<Key, Row>>();
  private seq = new Map<string, number>();
  private defs: Record<string, TableDef> = {};
  private lock: Promise<unknown> = Promise.resolve();
  private opened = false;
  private version = 0;

  constructor(
    private migrations: Migration[] = MIGRATIONS,
    private persist?: StorePersistence,
  ) {
    this.schemaVersion = migrations[migrations.length - 1]?.version ?? LATEST_VERSION;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const snap = this.persist && !this.version ? await this.persist.load() : null;
    if (snap) {
      this.version = snap.version;
      this.seq = new Map(Object.entries(snap.seq));
      this.defs = tablesAt(this.migrations, snap.version);
      for (const [t, rows] of Object.entries(snap.tables)) {
        const key = this.defs[t]?.key;
        if (key) this.data.set(t, new Map(rows.map((r) => [r[key] as Key, r])));
      }
      for (const t of Object.keys(this.defs)) if (!this.data.has(t)) this.data.set(t, new Map());
    }
    for (const m of this.migrations) {
      if (m.version <= this.version) continue;
      this.defs = tablesAt(this.migrations, m.version);
      for (const name of Object.keys(m.tables))
        if (!this.data.has(name)) this.data.set(name, new Map());
      if (m.migrate) await this.exec(Object.keys(this.defs), m.migrate);
      this.version = m.version;
      await this.persist?.commit({
        version: m.version,
        seq: Object.fromEntries(this.seq),
        changes: [],
      });
    }
    this.opened = true;
  }

  /** Simulates closing the app and opening it again with a newer schema (tests). */
  reopenWith(migrations: Migration[]): MemoryStore {
    const s = new MemoryStore(migrations);
    s.data = this.data;
    s.seq = this.seq;
    s.version = this.version;
    return s;
  }

  run<T>(mode: 'readonly' | 'readwrite', tables: string[], fn: (tx: StoreTx) => Promise<T>) {
    if (!this.opened) return Promise.reject(new Error('store not open'));
    if (mode === 'readonly') return this.exec(tables, fn, true);
    const p = this.lock.then(() => this.exec(tables, fn));
    this.lock = p.catch(() => undefined);
    return p;
  }

  private async exec<T>(tables: string[], fn: (tx: StoreTx) => Promise<T>, readonly = false) {
    const scope = new Set([...tables, ...(readonly ? [] : ['outbox'])]);
    const staged = new Map<string, Map<Key, Row | typeof DELETED>>();
    const seq = new Map(this.seq);
    const table = (t: string) => {
      if (!scope.has(t)) throw new Error(`table ${t} not in transaction scope`);
      const d = this.defs[t];
      const rows = this.data.get(t);
      if (!d || !rows) throw new Error(`unknown table ${t}`);
      return { d, rows };
    };
    const ro = () => {
      if (readonly) throw new Error('readonly transaction');
    };
    const view = (t: string) => {
      const { rows } = table(t);
      const s = staged.get(t);
      if (!s) return rows.values();
      const merged = new Map<Key, Row>(rows);
      for (const [k, v] of s) v === DELETED ? merged.delete(k) : merged.set(k, v);
      return merged.values();
    };
    const tx: StoreTx = {
      get: async <R>(t: string, key: Key) => {
        const { rows } = table(t);
        const s = staged.get(t)?.get(key);
        const v = s === undefined ? rows.get(key) : s === DELETED ? undefined : s;
        return v === undefined ? undefined : (structuredClone(v) as R);
      },
      put: async (t, value) => {
        ro();
        const { d } = table(t);
        const row = structuredClone(value) as Row;
        if (d.autoIncrement && row[d.key] === undefined) {
          const n = (seq.get(t) ?? 0) + 1;
          seq.set(t, n);
          row[d.key] = n;
        }
        const k = row[d.key] as Key;
        if (k === undefined) throw new Error(`missing key ${d.key} for ${t}`);
        if (!staged.has(t)) staged.set(t, new Map());
        staged.get(t)?.set(k, row);
      },
      delete: async (t, key) => {
        ro();
        table(t);
        if (!staged.has(t)) staged.set(t, new Map());
        staged.get(t)?.set(key, DELETED);
      },
      query: async <R>(t: string, q: Query<R>) =>
        runQuery<R>(view(t), table(t).d, q).map((r) => structuredClone(r)),
      enqueue: async (op) => tx.put('outbox', { ...op, status: 'pending' }),
    };
    const result = await fn(tx);
    if (this.persist && staged.size) {
      const changes: StoreCommit['changes'] = [];
      for (const [t, s] of staged)
        for (const [key, v] of s) changes.push({ table: t, key, row: v === DELETED ? null : v });
      await this.persist.commit({ version: this.version, seq: Object.fromEntries(seq), changes });
    }
    for (const [t, s] of staged) {
      const rows = this.data.get(t) as Map<Key, Row>;
      for (const [k, v] of s) v === DELETED ? rows.delete(k) : rows.set(k, v);
    }
    this.seq = seq;
    return result;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async destroy(): Promise<void> {
    await this.persist?.destroy();
    this.data.clear();
    this.seq.clear();
    this.version = 0;
    this.opened = false;
  }
}
