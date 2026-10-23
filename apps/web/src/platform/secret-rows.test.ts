import { expect, test } from 'bun:test';
import {
  getMeta,
  MemoryStore,
  type StoreCommit,
  type StorePersistence,
  type StoreSnapshot,
  setMeta,
} from '@finplat/storage';
import { type Secrets, withSecretRows } from './secret-rows.ts';

/** SQLite stand-in: applies commits to a JSON snapshot. */
function fakeDb() {
  let snap: StoreSnapshot | null = null;
  const p: StorePersistence & { snap: () => StoreSnapshot | null } = {
    snap: () => snap,
    async load() {
      return snap && structuredClone(snap);
    },
    async commit(c: StoreCommit) {
      snap ??= { version: c.version, seq: {}, tables: {} };
      snap.version = c.version;
      snap.seq = { ...c.seq };
      for (const ch of c.changes) {
        snap.tables[ch.table] ??= [];
        const rows = snap.tables[ch.table] ?? [];
        const i = rows.findIndex((r) => r.id === ch.key);
        if (i >= 0) rows.splice(i, 1);
        if (ch.row) rows.push(structuredClone(ch.row));
      }
    },
    async destroy() {
      snap = null;
    },
  };
  return p;
}
const fakeKeychain = () => {
  const m = new Map<string, string>();
  const s: Secrets & { m: Map<string, string> } = {
    m,
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
  return s;
};
const metaRow = (db: ReturnType<typeof fakeDb>, id: string) =>
  db.snap()?.tables.meta?.find((r) => r.id === id)?.value;
const open = async (db: StorePersistence, k: Secrets | null) => {
  const s = new MemoryStore(undefined, withSecretRows(db, k, 'finplat'));
  await s.open();
  return s;
};

test('e2ee meta rows live in the credential store, SQLite keeps a marker', async () => {
  const db = fakeDb();
  const k = fakeKeychain();
  const s = await open(db, k);
  await setMeta(s, 'e2ee:device-key', { publicKey: 'pub', privateKey: 'secret' });
  await setMeta(s, 'device-id', 'd1');
  expect(metaRow(db, 'e2ee:device-key')).toEqual({ $keychain: 1 });
  expect(metaRow(db, 'device-id')).toBe('d1');
  expect(JSON.parse(k.m.get('finplat/e2ee:device-key') ?? '')).toEqual({
    publicKey: 'pub',
    privateKey: 'secret',
  });
  const again = await open(db, k);
  expect(await getMeta(again, 'e2ee:device-key')).toEqual({
    publicKey: 'pub',
    privateKey: 'secret',
  });

  await again.destroy();
  expect(k.m.size).toBe(0);
});

test('keys written before the credential store was used move there on the next start', async () => {
  const db = fakeDb();
  const plain = await open(db, null);
  await setMeta(plain, 'e2ee:keyring:p1', { keys: { a: 'k' } });
  expect(metaRow(db, 'e2ee:keyring:p1')).toEqual({ keys: { a: 'k' } });
  const k = fakeKeychain();
  const s = await open(db, k);
  expect(await getMeta(s, 'e2ee:keyring:p1')).toEqual({ keys: { a: 'k' } });
  expect(metaRow(db, 'e2ee:keyring:p1')).toEqual({ $keychain: 1 });
  expect(k.m.has('finplat/e2ee:keyring:p1')).toBe(true);
});

test('a marker without its credential (store gone) reads as no key: the profile is locked', async () => {
  const db = fakeDb();
  await setMeta(await open(db, fakeKeychain()), 'e2ee:keyring:p1', { keys: {} });
  expect(await getMeta(await open(db, null), 'e2ee:keyring:p1')).toBeUndefined();
  expect(await getMeta(await open(db, fakeKeychain()), 'e2ee:keyring:p1')).toBeUndefined();
});
