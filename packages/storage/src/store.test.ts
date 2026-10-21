import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { IdbStore } from './idb.ts';
import { MemoryStore } from './memory.ts';
import { isLowOnSpace } from './quota.ts';
import {
  ackOps,
  allOps,
  getCheckpoint,
  MIGRATIONS,
  pendingOps,
  rejectOp,
  setCheckpoint,
} from './schema.ts';
import type { LocalStore, Migration } from './types.ts';

let n = 0;
const impls: [string, () => LocalStore][] = [
  ['memory', () => new MemoryStore()],
  ['indexeddb', () => new IdbStore(`test-${++n}-${Math.random()}`)],
];

const P = 'p1';
const tx = (id: string, bookingDate: string, extra = {}) => ({
  id,
  profileId: P,
  bookingDate,
  deletedAt: null,
  version: 1,
  ...extra,
});

for (const [name, make] of impls) {
  describe(name, () => {
    test('indexed range queries within a profile, reverse, limit, tombstones', async () => {
      const s = make();
      await s.open();
      await s.run('readwrite', ['transactions'], async (t) => {
        await t.put('transactions', tx('a', '2026-01-03'));
        await t.put('transactions', tx('b', '2026-01-01'));
        await t.put('transactions', tx('c', '2026-01-02', { deletedAt: '2026-01-05T00:00:00Z' }));
        await t.put('transactions', tx('d', '2026-01-02'));
        await t.put('transactions', { ...tx('x', '2026-01-02'), profileId: 'other' });
      });
      const ids = (q: object) =>
        s
          .run('readonly', ['transactions'], (t) =>
            t.query<{ id: string }>('transactions', { profileId: P, ...q }),
          )
          .then((r) => r.map((x) => x.id));
      expect(await ids({ index: 'bookingDate' })).toEqual(['b', 'd', 'a']);
      expect(await ids({ index: 'bookingDate', reverse: true, limit: 2 })).toEqual(['a', 'd']);
      expect(
        await ids({
          index: 'bookingDate',
          from: '2026-01-02',
          to: '2026-01-02',
          includeDeleted: true,
        }),
      ).toEqual(['c', 'd']);
      expect(await ids({})).toEqual(['a', 'b', 'd']);
      await s.close();
    });

    test('run() is atomic: a throw rolls back every write including the outbox', async () => {
      const s = make();
      await s.open();
      const err = await s
        .run('readwrite', ['accounts'], async (t) => {
          await t.put('accounts', { id: 'a1', profileId: P, deletedAt: null });
          await t.enqueue({
            opId: 'o1',
            profileId: P,
            entityType: 'accounts',
            entityId: 'a1',
            op: 'upsert',
            baseVersion: null,
            data: {},
            clientTime: '2026-01-01T00:00:00Z',
          });
          throw new Error('boom');
        })
        .catch((e: Error) => e.message);
      expect(err).toBe('boom');
      expect(await s.run('readonly', ['accounts'], (t) => t.get('accounts', 'a1'))).toBeUndefined();
      expect(await allOps(s, P)).toEqual([]);
    });

    test('outbox keeps order; ack removes, reject keeps but stops resending', async () => {
      const s = make();
      await s.open();
      for (const id of ['o1', 'o2', 'o3'])
        await s.run('readwrite', [], (t) =>
          t.enqueue({
            opId: id,
            profileId: P,
            entityType: 'tags',
            entityId: id,
            op: 'upsert',
            baseVersion: null,
            data: { id },
            clientTime: '2026-01-01T00:00:00Z',
          }),
        );
      expect((await pendingOps(s, P, 10)).map((o) => o.opId)).toEqual(['o1', 'o2', 'o3']);
      await ackOps(s, P, ['o1']);
      await rejectOp(s, P, 'o2', { code: 'validation_failed', message: 'bad' });
      expect((await pendingOps(s, P, 10)).map((o) => o.opId)).toEqual(['o3']);
      const all = await allOps(s, P);
      expect(all.map((o) => [o.opId, o.status])).toEqual([
        ['o2', 'rejected'],
        ['o3', 'pending'],
      ]);
      await setCheckpoint(s, P, 42);
      expect(await getCheckpoint(s, P)).toBe(42);
    });

    test('stores Blobs (attachments)', async () => {
      const s = make();
      await s.open();
      await s.run('readwrite', ['blobs'], (t) =>
        t.put('blobs', {
          id: 'b1',
          profileId: P,
          blob: new Blob(['receipt'], { type: 'text/plain' }),
        }),
      );
      const r = await s.run('readonly', ['blobs'], (t) => t.get<{ blob: Blob }>('blobs', 'b1'));
      expect(await r?.blob.text()).toBe('receipt');
    });
  });
}

test('IndexedDB: offline edits and the outbox survive a restart (PLAN §46 case 22)', async () => {
  const name = `restart-${Math.random()}`;
  const a = new IdbStore(name);
  await a.open();
  await a.run('readwrite', ['tags'], async (t) => {
    await t.put('tags', { id: 't1', profileId: P, name: 'x', deletedAt: null });
    await t.enqueue({
      opId: 'o1',
      profileId: P,
      entityType: 'tags',
      entityId: 't1',
      op: 'upsert',
      baseVersion: null,
      data: { id: 't1' },
      clientTime: '2026-01-01T00:00:00Z',
    });
  });
  await a.close();
  const b = new IdbStore(name);
  await b.open();
  expect(await b.run('readonly', ['tags'], (t) => t.get('tags', 't1'))).toMatchObject({
    name: 'x',
  });
  expect((await pendingOps(b, P, 10)).map((o) => o.opId)).toEqual(['o1']);
  await b.destroy();
});

const V2: Migration[] = [
  ...MIGRATIONS,
  {
    version: 2,
    tables: { tags: { key: 'id', indexes: ['name'] } },
    migrate: async (t) => {
      for (const tag of await t.query<{ id: string; name: string }>('tags', { profileId: P }))
        await t.put('tags', { ...tag, name: tag.name.toUpperCase() });
    },
  },
];

test('IndexedDB: forward migration keeps data, adds the index and runs the data step', async () => {
  const name = `mig-${Math.random()}`;
  const v1 = new IdbStore(name);
  await v1.open();
  await v1.run('readwrite', ['tags'], async (t) => {
    await t.put('tags', { id: 't1', profileId: P, name: 'food', deletedAt: null });
    await t.put('tags', { id: 't2', profileId: P, name: 'bills', deletedAt: null });
  });
  await v1.close();
  const v2 = new IdbStore(name, V2);
  await v2.open();
  expect(v2.schemaVersion).toBe(2);
  const byName = await v2.run('readonly', ['tags'], (t) =>
    t.query<{ name: string }>('tags', { profileId: P, index: 'name' }),
  );
  expect(byName.map((x) => x.name)).toEqual(['BILLS', 'FOOD']);
  await v2.destroy();
});

test('memory: forward migration on reopen', async () => {
  const v1 = new MemoryStore();
  await v1.open();
  await v1.run('readwrite', ['tags'], (t) =>
    t.put('tags', { id: 't1', profileId: P, name: 'food', deletedAt: null }),
  );
  const v2 = v1.reopenWith(V2);
  await v2.open();
  expect(
    await v2.run('readonly', ['tags'], (t) => t.query('tags', { profileId: P, index: 'name' })),
  ).toMatchObject([{ name: 'FOOD' }]);
});

test('quota helper', () => {
  expect(isLowOnSpace({ usage: 95, quota: 100, persisted: false })).toBe(true);
  expect(isLowOnSpace({ usage: 10, quota: 100, persisted: false })).toBe(false);
  expect(isLowOnSpace({ usage: null, quota: null, persisted: null })).toBe(false);
});
