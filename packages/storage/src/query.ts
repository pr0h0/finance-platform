import type { Query, Row, TableDef } from './types.ts';

type Key = string | number;

export function compareKeys(a: unknown, b: unknown): number {
  // IndexedDB key order: numbers < strings.
  if (typeof a === typeof b) return (a as Key) < (b as Key) ? -1 : (a as Key) > (b as Key) ? 1 : 0;
  return typeof a === 'number' ? -1 : 1;
}

const validKey = (v: unknown) => typeof v === 'string' || typeof v === 'number';

/** Reference query semantics (memory store; IndexedDB matches them natively). */
export function runQuery<T>(rows: Iterable<Row>, def: TableDef, q: Query<T>): T[] {
  const field = q.index;
  if (field && !def.indexes?.includes(field)) throw new Error(`no index ${field}`);
  if (field && q.profileId === undefined) throw new Error('indexed queries need profileId'); // as idb.ts
  let list = [...rows].filter((r) => {
    if (q.profileId !== undefined && r.profileId !== q.profileId) return false;
    if (field) {
      const v = r[field];
      if (!validKey(v)) return false; // IndexedDB skips non-key values (null/undefined)
      if (q.from !== undefined && compareKeys(v, q.from) < 0) return false;
      if (q.to !== undefined && compareKeys(v, q.to) > 0) return false;
    }
    return true;
  });
  list.sort(
    (a, b) => (field ? compareKeys(a[field], b[field]) : 0) || compareKeys(a[def.key], b[def.key]),
  );
  if (q.reverse) list.reverse();
  list = list.filter((r) => (q.includeDeleted || !r.deletedAt) && (!q.filter || q.filter(r as T)));
  return (q.limit !== undefined ? list.slice(0, q.limit) : list) as T[];
}
