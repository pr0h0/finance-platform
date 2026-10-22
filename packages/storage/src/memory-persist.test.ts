import { expect, test } from 'bun:test';
import { LocalDataSource } from './datasource.ts';
import {
  MemoryStore,
  type StoreCommit,
  type StorePersistence,
  type StoreSnapshot,
} from './memory.ts';
import { allOps } from './schema.ts';

/** A JSON "disk" like the native SQLite backend: commits are applied to a snapshot. */
function disk() {
  let snap: StoreSnapshot | null = null;
  let failNext = false;
  const p: StorePersistence = {
    load: async () => (snap ? structuredClone(snap) : null),
    commit: async (c: StoreCommit) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      const next: StoreSnapshot = snap
        ? structuredClone(snap)
        : { version: 0, seq: {}, tables: {} };
      next.version = c.version;
      next.seq = c.seq;
      for (const ch of c.changes) {
        next.tables[ch.table] ??= [];
        const rows = next.tables[ch.table] as Record<string, unknown>[];
        const i = rows.findIndex((r) => keyOf(ch.table, r) === ch.key);
        if (i >= 0) rows.splice(i, 1);
        if (ch.row) rows.push(JSON.parse(JSON.stringify(ch.row)));
      }
      snap = next;
    },
    destroy: async () => {
      snap = null;
    },
  };
  const keyOf = (table: string, r: Record<string, unknown>) =>
    (table === 'outbox' ? r.seq : r.id) as string | number;
  return { p, fail: () => (failNext = true), snap: () => snap };
}

test('a persistent MemoryStore survives a restart and a failed commit changes nothing', async () => {
  const d = disk();
  const s1 = new MemoryStore(undefined, d.p);
  await s1.open();
  const ds1 = new LocalDataSource(s1);
  const pid = (await ds1.createProfile({ name: 'Home', baseCurrency: 'BAM' })).id;
  const acc = await ds1.profile(pid).create('accounts', {
    name: 'Cash',
    accountType: 'cash',
    currency: 'BAM',
  });
  expect(d.snap()?.version).toBe(s1.schemaVersion);

  d.fail();
  await expect(
    ds1.profile(pid).create('accounts', { name: 'Lost', accountType: 'cash', currency: 'BAM' }),
  ).rejects.toThrow('disk full');
  expect((await ds1.profile(pid).list('accounts')).map((a) => a.name)).toEqual(['Cash']);

  // "restart the app": a new store on the same disk
  const s2 = new MemoryStore(undefined, d.p);
  await s2.open();
  const ds2 = new LocalDataSource(s2);
  expect((await ds2.listProfiles()).map((p) => p.id)).toEqual([pid]);
  expect((await ds2.profile(pid).list('accounts')).map((a) => a.id)).toEqual([acc.id]);
  // autoIncrement counters survive too: new outbox ops do not reuse sequence numbers
  const before = (await allOps(s2, pid)).map((o) => o.seq);
  await ds2
    .profile(pid)
    .create('accounts', { name: 'Bank', accountType: 'checking', currency: 'BAM' });
  const after = (await allOps(s2, pid)).map((o) => o.seq);
  expect(after.length).toBe(before.length + 1);
  expect(new Set(after).size).toBe(after.length);

  await s2.destroy();
  expect(d.snap()).toBeNull();
});
