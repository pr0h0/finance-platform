// Sync against a REAL API. Skipped unless FINPLAT_API_URL is set, e.g.
//   sg docker -c "docker compose -f docker-compose.dev.yml up -d"        # api on 127.0.0.1:3811
//   FINPLAT_API_URL=http://127.0.0.1:3811 scripts/bun.sh test packages/sync-client/src/real-server.test.ts
// (scripts/bun.sh joins the dev network when it is up; use http://api:8080 from inside it.)
import { expect, test } from 'bun:test';
import { type ApiClient, createApiClient } from '@finplat/api-client';
import { MemoryStore } from '@finplat/storage';
import { SyncEngine } from './engine.ts';
import { RemoteDataSource } from './remote.ts';

const URL_ = process.env.FINPLAT_API_URL;

async function login(email: string, password: string, name: string) {
  let token: string | undefined;
  const api = createApiClient({ baseUrl: URL_ as string, token: () => token });
  const r = (await api.request('POST', '/api/v1/auth/login', {
    email,
    password,
    device: { name, platform: 'cli', clientVersion: 'sync-client-test' },
  })) as { token: string; deviceId: string };
  token = r.token;
  return { api, deviceId: r.deviceId };
}

async function device(api: ApiClient, deviceId: string, profileId: string) {
  const store = new MemoryStore();
  await store.open();
  const ds = new RemoteDataSource({ store, api, deviceId, syncDelayMs: 60_000 });
  const engine = new SyncEngine({
    store,
    api,
    localProfileId: profileId,
    remoteProfileId: profileId,
    deviceId,
  });
  return { svc: ds.profile(profileId), engine };
}

test.skipIf(!URL_)('real server: two devices converge, tombstones travel', async () => {
  const email = `sync-${Date.now()}@example.test`;
  const password = 'correct horse battery staple';
  const anon = createApiClient({ baseUrl: URL_ as string });
  await anon.request('POST', '/api/v1/auth/register', {
    email,
    password,
    displayName: 'Sync test',
  });
  const a = await login(email, password, 'device A');
  const b = await login(email, password, 'device B');
  const profile = (await a.api.createProfile({ name: 'Sync test', baseCurrency: 'BAM' })) as {
    id: string;
  };

  const da = await device(a.api, a.deviceId, profile.id);
  const db = await device(b.api, b.deviceId, profile.id);
  const tag = await da.svc.create('tags', { name: 'trip' });
  const acc = await da.svc.create('accounts', {
    name: 'Cash',
    accountType: 'cash',
    currency: 'BAM',
  });
  await da.svc.createTransaction({
    kind: 'expense',
    accountId: acc.id,
    amount: { amount: '12.30', currency: 'BAM' },
    bookingDate: '2026-04-01',
    tagIds: [tag.id],
  });
  const st = await da.engine.sync();
  expect(st.rejected.map((r) => `${r.entityType}: ${r.error?.code} ${r.error?.message}`)).toEqual(
    [],
  );
  expect(st.pending).toBe(0);

  await db.engine.sync();
  expect((await db.svc.get('accounts', acc.id)).balances).toEqual([
    { amount: '-12.30', currency: 'BAM' },
  ]);
  await db.svc.remove('tags', tag.id);
  await db.engine.sync();
  await da.engine.sync();
  expect(await da.svc.list('tags')).toEqual([]);
});

test.skipIf(!URL_)('real server: every synced entity type round-trips', async () => {
  const email = `sync-all-${Date.now()}@example.test`;
  const password = 'correct horse battery staple';
  await createApiClient({ baseUrl: URL_ as string }).request('POST', '/api/v1/auth/register', {
    email,
    password,
    displayName: 'Sync all',
  });
  const a = await login(email, password, 'device A');
  const b = await login(email, password, 'device B');
  const profile = (await a.api.createProfile({ name: 'All', baseCurrency: 'BAM' })) as {
    id: string;
  };
  const da = await device(a.api, a.deviceId, profile.id);
  const db = await device(b.api, b.deviceId, profile.id);
  const s = da.svc;
  const m = (amount: string) => ({ amount, currency: 'BAM' });

  const acc = await s.create('accounts', {
    name: 'Bank',
    accountType: 'checking',
    currency: 'BAM',
    openingBalance: m('1000.00'),
  });
  const food = await s.create('categories', { name: 'Food', kind: 'expense' });
  const home = await s.create('categories', { name: 'Home', kind: 'expense' });
  const shop = await s.create('merchants', { name: 'Konzum' });
  const tx = await s.createTransaction({
    kind: 'expense',
    accountId: acc.id,
    amount: m('100.00'),
    bookingDate: '2026-05-02',
    merchantId: shop.id,
    categoryId: food.id,
  });
  await s.replaceSplits(tx.id, {
    version: tx.version,
    splits: [
      { categoryId: food.id, amount: m('60.00') },
      { categoryId: home.id, amount: m('40.00') },
    ],
  } as never);
  await s.create('budgets', {
    name: 'Monthly',
    periodType: 'monthly',
    startDate: '2026-05-01',
    currency: 'BAM',
    allocations: [{ categoryId: food.id, amount: m('300.00') }],
  });
  const rent = await s.create('planned_transactions', {
    kind: 'expense',
    accountId: acc.id,
    categoryId: home.id,
    description: 'Rent',
    amount: m('500.00'),
    dueDate: '2026-06-01',
    recurrence: { rrule: 'FREQ=MONTHLY' },
  });
  await s.setOccurrence(rent.id, '2026-07-01', { status: 'skipped' });
  const goal = await s.create('savings_goals', { name: 'Car', targetAmount: m('5000.00') });
  await s.create('savings_contributions', {
    goalId: goal.id,
    amount: m('250.00'),
    contributionDate: '2026-05-03',
  });
  await s.create('categorization_rules', {
    name: 'Konzum is food',
    conditions: [{ field: 'description', op: 'contains', value: 'konzum' }],
    actions: [{ type: 'set_category', categoryId: food.id }],
  });
  await s.create('tags', { name: 'x' });
  await s.create('transaction_templates', { name: 'Coffee', kind: 'expense', amount: m('3.00') });

  const st = await da.engine.sync();
  expect(st.rejected.map((r) => `${r.entityType}: ${r.error?.code} ${r.error?.message}`)).toEqual(
    [],
  );
  expect(st.pending).toBe(0);

  await db.engine.sync();
  const bal = (await db.svc.get('accounts', acc.id)).balances;
  expect(bal).toEqual([m('900.00')]);
  const plans = await db.svc.list('planned_transactions');
  expect(plans.length).toBe(1);
  expect((await db.svc.list('recurrence_schedules')).length).toBe(1);
  expect((await db.svc.list('budget_allocations' as never)).length).toBe(1);
  expect((await db.svc.list('savings_contributions')).length).toBe(1);
  expect((await db.svc.list('categorization_rules')).length).toBe(1);
  expect((await db.svc.list('planned_occurrences' as never)).length).toBe(1);

  // B edits metadata, A then edits it again from the merged state
  const tb = await db.svc.getTransaction(tx.id);
  await db.svc.updateTransaction(tx.id, {
    version: tb.version,
    description: 'Weekly shop',
  } as never);
  const sb = await db.engine.sync();
  expect(sb.rejected).toEqual([]);
  await da.engine.sync();
  expect((await s.getTransaction(tx.id)).description).toBe('Weekly shop');
});
