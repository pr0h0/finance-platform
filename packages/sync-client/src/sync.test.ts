import { expect, test } from 'bun:test';
import { createApiClient } from '@finplat/api-client';
import { allOps, LocalDataSource, type LocalFinanceService, MemoryStore } from '@finplat/storage';
import {
  activate,
  disconnect,
  disconnectPreview,
  getSyncConfig,
  previewActivation,
} from './activation.ts';
import { SyncEngine } from './engine.ts';
import { FakeSyncServer } from './fake-server.test-util.ts';
import { RemoteDataSource } from './remote.ts';

const m = (amount: string, currency = 'BAM') => ({ amount, currency });
const PID = '0190a000-0000-7000-8000-000000000001';
const noSleep = async () => undefined;

async function device(server: FakeSyncServer, deviceId: string) {
  const store = new MemoryStore();
  await store.open();
  const api = createApiClient({ baseUrl: 'https://fin.test', fetch: server.fetch as typeof fetch });
  const ds = new RemoteDataSource({ store, api, deviceId, syncDelayMs: 60_000 });
  const svc = ds.profile(PID);
  const engine = new SyncEngine({
    store,
    api,
    localProfileId: PID,
    remoteProfileId: PID,
    deviceId,
    sleep: noSleep,
    pushBatch: 3,
  });
  return { store, api, ds, svc, engine };
}

const balance = async (svc: LocalFinanceService, id: string) =>
  (await svc.get('accounts', id)).balances[0]?.amount;

test('two devices converge through push/pull (feature 100)', async () => {
  const server = new FakeSyncServer();
  const a = await device(server, 'dev-a');
  const b = await device(server, 'dev-b');
  const acc = await a.svc.create('accounts', {
    name: 'Checking',
    accountType: 'checking',
    currency: 'BAM',
    openingBalance: m('100.00'),
  });
  const food = await a.svc.create('categories', { name: 'Food' });
  await a.svc.createTransaction({
    kind: 'expense',
    accountId: acc.id,
    amount: m('30.00'),
    bookingDate: '2026-02-01',
    categoryId: food.id,
  });
  const st = await a.engine.sync();
  expect(st.pending).toBe(0);
  expect(server.pushCalls).toBe(2); // 5 ops in batches of 3

  await b.engine.sync();
  expect(await balance(b.svc, acc.id)).toBe('70.00');
  const tx = (await b.svc.searchTransactions({ kind: 'expense' })).items[0];
  expect(tx?.splits[0]?.categoryId).toBe(food.id);
  expect(tx?.serverVersion).toBeGreaterThan(0);

  // tombstones travel
  await b.svc.remove('categories', (await b.svc.create('categories', { name: 'Tmp' })).id);
  await b.engine.sync();
  await a.engine.sync();
  expect((await a.svc.list('categories')).map((c) => c.name)).toEqual(['Food']);
  expect((await a.svc.list('categories', { includeDeleted: true })).length).toBe(2);
});

test('concurrent edits: metadata merges, money edits conflict and totals stay intact (§46 case 20)', async () => {
  const server = new FakeSyncServer();
  const a = await device(server, 'dev-a');
  const b = await device(server, 'dev-b');
  const acc = await a.svc.create('accounts', {
    name: 'C',
    accountType: 'checking',
    currency: 'BAM',
  });
  const t = await a.svc.createTransaction({
    kind: 'expense',
    accountId: acc.id,
    amount: m('10.00'),
    bookingDate: '2026-02-01',
  });
  await a.engine.sync();
  await b.engine.sync();

  // disjoint metadata edits offline on both devices -> field merge
  await a.svc.updateTransaction(t.id, { version: 1, description: 'Lunch' });
  await b.svc.updateTransaction(t.id, { version: 1, notes: 'with team' });
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  const sa = await a.svc.getTransaction(t.id);
  const sb = await b.svc.getTransaction(t.id);
  expect([sa.description, sa.notes]).toEqual(['Lunch', 'with team']);
  expect([sb.description, sb.notes]).toEqual(['Lunch', 'with team']);

  // both change the amount offline -> explicit conflict, nothing silently overwritten
  await a.svc.updateTransaction(t.id, { version: sa.version, amount: m('12.00') });
  await b.svc.updateTransaction(t.id, { version: sb.version, amount: m('15.00') });
  await a.engine.sync();
  const st = await b.engine.sync();
  expect(st.conflicts).toHaveLength(1);
  expect(st.conflicts[0]?.fields).toContain('postings');
  expect(
    (server.get(PID, 'transactions', t.id) as { postings: { amount: { amount: string } }[] })
      .postings[0]?.amount.amount,
  ).toBe('-12.00');

  const [c] = await b.engine.refreshConflicts();
  if (!c) throw new Error('expected a conflict');
  expect(
    (c.serverData as { postings: { amount: { amount: string } }[] }).postings[0]?.amount.amount,
  ).toBe('-12.00');
  await b.engine.resolve(c.id, 'client');
  await a.engine.sync();
  expect(await balance(a.svc, acc.id)).toBe('-15.00');
  expect(await balance(b.svc, acc.id)).toBe('-15.00');
  expect((await b.engine.status()).conflicts).toHaveLength(0);
});

test('interrupted push and pull recover without duplicates (§46 case 21)', async () => {
  const server = new FakeSyncServer();
  const a = await device(server, 'dev-a');
  const acc = await a.svc.create('accounts', { name: 'C', accountType: 'cash', currency: 'BAM' });
  for (let i = 1; i <= 7; i++)
    await a.svc.createTransaction({
      kind: 'income',
      accountId: acc.id,
      amount: m(`${i}.00`),
      bookingDate: `2026-02-0${i}`,
    });

  // server applies the batch but the response is lost; retry resends the same opIds
  server.loseResponses = 1;
  server.failNext = 2;
  const st = await a.engine.sync();
  expect(st.pending).toBe(0);
  expect(server.changes.filter((c) => c.entityType === 'transactions')).toHaveLength(7);

  // a crash after a pull page leaves the checkpoint consistent; re-running converges
  const b = await device(server, 'dev-b');
  const small = new SyncEngine({
    store: b.store,
    api: b.api,
    localProfileId: PID,
    remoteProfileId: PID,
    deviceId: 'dev-b',
    pullLimit: 3,
    sleep: noSleep,
  });
  server.failNext = 0;
  const realPull = b.api.sync.pull;
  let calls = 0;
  b.api.sync.pull = async (...args) => {
    if (++calls === 2) throw new Error('app killed');
    return realPull(...args);
  };
  await expect(small.pull()).rejects.toThrow('app killed');
  b.api.sync.pull = realPull;
  await small.pull();
  expect(await balance(b.svc, acc.id)).toBe('28.00');

  // giving up after retries keeps everything queued
  await a.svc.createTransaction({
    kind: 'income',
    accountId: acc.id,
    amount: m('1.00'),
    bookingDate: '2026-02-09',
  });
  server.failNext = 100;
  await expect(a.engine.sync()).rejects.toThrow();
  const s = await a.engine.status();
  expect(s.pending).toBe(1);
  expect(s.lastError?.code).toBe('network_error');
  server.failNext = 0;
  expect((await a.engine.sync()).pending).toBe(0);
});

test('rejected ops stay visible and are not resent', async () => {
  const server = new FakeSyncServer();
  const a = await device(server, 'dev-a');
  const acc = await a.svc.create('accounts', { name: 'C', accountType: 'cash', currency: 'BAM' });
  await a.engine.sync();
  // a server whose validation disagrees (e.g. a newer rule) rejects the op
  const orig = server.push.bind(server);
  server.push = (body) => {
    const r = orig(body);
    r.results = r.results.map((x) => ({
      opId: x.opId,
      status: 'rejected' as const,
      code: 'validation_failed',
      message: 'nope',
    }));
    return r;
  };
  await a.svc.update('accounts', acc.id, { name: 'Renamed' });
  const st = await a.engine.sync();
  expect(st.pending).toBe(0);
  expect(st.rejected.map((r) => r.error?.code)).toEqual(['validation_failed']);
  const calls = server.pushCalls;
  await a.engine.sync();
  expect(server.pushCalls).toBe(calls);
  await a.engine.discardRejected(st.rejected[0]?.opId as string);
  expect((await a.engine.status()).rejected).toEqual([]);
});

test('activation: preview duplicates, merge, batched upload, verify, then active; disconnect keeps data', async () => {
  const server = new FakeSyncServer();
  // the server profile already has an account "Cash BAM" from another device
  const other = await device(server, 'dev-x');
  const remoteCash = await other.svc.create('accounts', {
    name: 'Cash',
    accountType: 'cash',
    currency: 'BAM',
  });
  await other.engine.sync();

  const store = new MemoryStore();
  await store.open();
  const local = new LocalDataSource(store);
  const prof = await local.createProfile({ name: 'Mine', baseCurrency: 'BAM' });
  const svc = local.profile(prof.id);
  const cash = await svc.create('accounts', {
    name: ' cash ',
    accountType: 'cash',
    currency: 'BAM',
    openingBalance: m('50.00'),
  });
  const bank = await svc.create('accounts', {
    name: 'Bank',
    accountType: 'checking',
    currency: 'BAM',
  });
  await svc.createTransaction({
    kind: 'transfer',
    accountId: cash.id,
    toAccountId: bank.id,
    amount: m('20.00'),
    bookingDate: '2026-03-01',
  });
  await svc.update('accounts', bank.id, { name: 'Bank 2' });
  expect((await allOps(store, prof.id)).length).toBeGreaterThan(4); // local-mode history

  const api = createApiClient({ baseUrl: 'https://fin.test', fetch: server.fetch as typeof fetch });
  const preview = await previewActivation(store, api, prof.id, PID);
  expect(preview.duplicates).toEqual([
    { entityType: 'accounts', localId: cash.id, remoteId: remoteCash.id, label: 'cash' },
  ]);
  expect(preview.upload.accounts).toBe(2);

  server.loseResponses = 1; // interrupted upload
  const engine = new SyncEngine({
    store,
    api,
    localProfileId: prof.id,
    remoteProfileId: PID,
    deviceId: 'dev-local',
    pushBatch: 2,
    retries: 0,
    sleep: noSleep,
  });
  const opts = {
    store,
    api,
    serverUrl: 'https://fin.test',
    localProfileId: prof.id,
    remoteProfileId: PID,
    deviceId: 'dev-local',
    merge: { [cash.id]: remoteCash.id },
    engine,
  };
  await expect(activate(opts)).rejects.toThrow();
  expect((await getSyncConfig(store, prof.id))?.active).toBeUndefined();
  const report = await activate(opts); // resumes
  expect(report).toMatchObject({ ok: true, missing: [], balanceMismatches: [] });
  expect((await getSyncConfig(store, prof.id))?.active).toBe(true);
  // history was compacted to one create per row, and the merged account now holds the money
  expect(server.changes.filter((c) => c.entityType === 'accounts')).toHaveLength(2);
  expect((await svc.get('accounts', remoteCash.id)).balances).toEqual([m('30.00')]);
  expect((await svc.list('accounts')).map((a) => a.name).sort()).toEqual(['Bank 2', 'Cash']);

  await other.engine.sync();
  expect(await balance(other.svc, remoteCash.id)).toBe('30.00');

  await svc.createTransaction({
    kind: 'income',
    accountId: bank.id,
    amount: m('1.00'),
    bookingDate: '2026-03-02',
  });
  expect(await disconnectPreview(store, prof.id)).toEqual({ pending: 1, rejected: 0 });
  await disconnect(store, prof.id);
  expect((await getSyncConfig(store, prof.id))?.active).toBe(false);
  expect((await svc.list('accounts')).length).toBe(2); // local data retained
});

test('incompatible server is refused before any data is sent (feature 107)', async () => {
  const server = new FakeSyncServer();
  const f = server.fetch;
  server.fetch = async (r) =>
    new URL(r.url).pathname === '/api/v1/meta'
      ? Response.json({ name: 'evil', apiVersion: '1.0.0', syncProtocolVersion: 1 })
      : f(r);
  const a = await device(server, 'dev-a');
  await a.svc.create('tags', { name: 'x' });
  await expect(a.engine.sync()).rejects.toThrow('not a finance-platform server');
  expect(server.pushCalls).toBe(0);
});

test('profile settings and exchange rates reach other devices (REST side data)', async () => {
  const server = new FakeSyncServer();
  server.rates.push({
    id: '0190a000-0000-7000-8000-0000000000aa',
    providerCode: 'frankfurter',
    profileId: null,
    baseCurrency: 'USD',
    quoteCurrency: 'BAM',
    rate: '1.8',
    rateDate: '2026-10-01',
    source: 'provider',
    fetchedAt: '2026-10-01T10:00:00Z',
  });
  const a = await device(server, 'dev-a');
  const b = await device(server, 'dev-b');
  await a.svc.setSetting('forecast.minimumReserve', m('300.00'));
  await a.svc.setSetting('notifications.browser', true); // device setting: stays local
  await a.svc.addExchangeRate({
    baseCurrency: 'CHF',
    quoteCurrency: 'BAM',
    rate: '2.1',
    rateDate: '2026-10-20',
  });
  await a.engine.sync();
  expect(server.settings.get(PID)).toEqual({ 'forecast.minimumReserve': m('300.00') });
  expect(server.rates.map((r) => r.baseCurrency).sort()).toEqual(['CHF', 'USD']);

  await b.svc.setSetting('import.templates', [{ id: 't1' }]);
  await b.engine.sync();
  expect(await b.svc.getSettings()).toEqual({
    'forecast.minimumReserve': m('300.00'),
    'import.templates': [{ id: 't1' }],
  });
  const rates = await b.svc.rateSnapshots();
  expect(rates.map((r) => `${r.baseCurrency}:${r.rate}:${r.source}`).sort()).toEqual([
    'CHF:2.1:manual',
    'USD:1.8:provider',
  ]);

  // a key removed elsewhere (null) and a rate deleted on the server disappear here too
  await b.svc.setSetting('forecast.minimumReserve', null);
  await b.engine.sync();
  server.rates = server.rates.filter((r) => r.baseCurrency !== 'CHF');
  await a.engine.sync();
  expect(await a.svc.getSettings()).toEqual({
    'notifications.browser': true,
    'import.templates': [{ id: 't1' }],
  });
  expect((await a.svc.rateSnapshots()).map((r) => r.baseCurrency)).toEqual(['USD']);
});
