// Sync against a REAL API. Skipped unless FINPLAT_API_URL is set, e.g.
//   sg docker -c "docker compose -f docker-compose.dev.yml up -d"        # api on 127.0.0.1:3811
//   FINPLAT_API_URL=http://127.0.0.1:3811 scripts/bun.sh test packages/sync-client/src/real-server.test.ts
// (scripts/bun.sh joins the dev network when it is up; use http://api:8080 from inside it.)
import { expect, test } from 'bun:test';
import { type ApiClient, createApiClient } from '@finplat/api-client';
import { byMerchant, createRateBook, netWorth, reportingConverter } from '@finplat/finance-engine';
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

test.skipIf(!URL_)('real server: attachments and imports reach the server', async () => {
  const email = `sync-up-${Date.now()}@example.test`;
  const password = 'correct horse battery staple';
  await createApiClient({ baseUrl: URL_ as string }).request('POST', '/api/v1/auth/register', {
    email,
    password,
  });
  const a = await login(email, password, 'device A');
  const b = await login(email, password, 'device B');
  const profile = (await a.api.createProfile({ name: 'Up', baseCurrency: 'BAM' })) as {
    id: string;
  };
  const da = await device(a.api, a.deviceId, profile.id);
  const db = await device(b.api, b.deviceId, profile.id);
  const hdr = { 'X-Profile-ID': profile.id };
  const acc = await da.svc.create('accounts', {
    name: 'Bank',
    accountType: 'checking',
    currency: 'BAM',
  });
  const t = await da.svc.createTransaction({
    kind: 'expense',
    accountId: acc.id,
    amount: { amount: '7.50', currency: 'BAM' },
    bookingDate: '2026-05-02',
  });
  const att = await da.svc.addAttachment({
    file: new Blob(['receipt text'], { type: 'text/plain' }),
    fileName: 'r.txt',
    transactionId: t.id,
  });

  const src = new Blob(['date;amount\n2026-05-03;-12.00\n']);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await src.arrayBuffer()))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  const rec = {
    rowNumber: 1,
    postingDate: '2026-05-03',
    description: 'Shop',
    direction: 'debit' as const,
    amount: '12.00',
    currency: 'BAM',
    raw: { date: '2026-05-03', amount: '-12.00' },
    fingerprint: 'fp1:test',
  };
  const preview = await da.svc.stageImport({
    accountId: acc.id,
    importerId: 'generic-csv',
    importerVersion: '1.0.0',
    fileName: 's.csv',
    fileSha256: sha,
    fileSize: src.size,
    records: [rec],
    source: src,
  });
  await da.svc.commitImport(preview.batch.id);

  const st = await da.engine.sync();
  expect(st.rejected.map((r) => `${r.entityType}: ${r.error?.code} ${r.error?.message}`)).toEqual(
    [],
  );
  expect(st.pending).toBe(0);

  const files = await a.api.request<{ items: { id: string }[] }>(
    'GET',
    '/api/v1/attachments',
    undefined,
    hdr,
  );
  expect(files.items.map((x) => x.id)).toEqual([att.id]);
  const batch = await a.api.request<{ status: string }>(
    'GET',
    `/api/v1/imports/${preview.batch.id}`,
    undefined,
    hdr,
  );
  expect(batch.status).toBe('committed');
  const original = await a.api.send(
    'GET',
    `/api/v1/imports/${preview.batch.id}/source`,
    undefined,
    hdr,
  );
  expect(await original.text()).toBe(await src.text());
  const txs = await a.api.request<{ items: { importRecordId: string | null }[] }>(
    'GET',
    '/api/v1/transactions?limit=50',
    undefined,
    hdr,
  );
  expect(txs.items.map((x) => x.importRecordId).filter(Boolean)).toEqual([
    preview.rows[0]?.record.id ?? 'missing',
  ]);

  // the other device gets the metadata and downloads the content on demand
  await db.engine.sync();
  const [att2] = await db.svc.listAttachments(t.id);
  expect(await (await db.svc.attachmentContent(att2?.id as string)).text()).toBe('receipt text');
  expect((await db.svc.listImports()).map((x) => x.status)).toEqual(['committed']);

  // server-side rollback works for a batch imported on the device
  await a.api.request('POST', `/api/v1/imports/${preview.batch.id}/rollback`, undefined, hdr);
  await da.engine.sync();
  expect((await da.svc.searchTransactions({})).items.map((x) => x.id)).toEqual([t.id]);
});

// Web (TS engine on synced data) vs REST/MCP (Go) for data created through REST: budgets with
// allocations, a manual FX rate, a profile setting, a split expense with a refund.
test.skipIf(!URL_)(
  'real server: REST-made data shows the same numbers on a synced device',
  async () => {
    const email = `parity-${Date.now()}@example.test`;
    const password = 'correct horse battery staple';
    await createApiClient({ baseUrl: URL_ as string }).request('POST', '/api/v1/auth/register', {
      email,
      password,
      displayName: 'Parity',
    });
    const a = await login(email, password, 'rest client');
    const profile = (await a.api.createProfile({ name: 'Parity', baseCurrency: 'BAM' })) as {
      id: string;
    };
    const hdr = { 'X-Profile-ID': profile.id };
    const post = <T>(path: string, body: unknown) =>
      a.api.request<T>('POST', `/api/v1${path}`, body, hdr);
    const bam = (amount: string) => ({ amount, currency: 'BAM' });
    const chk = await post<{ id: string }>('/accounts', {
      name: 'Checking',
      accountType: 'checking',
      currency: 'BAM',
      openingBalance: bam('1000.00'),
    });
    const usd = await post<{ id: string }>('/accounts', {
      name: 'USD',
      accountType: 'checking',
      currency: 'USD',
    });
    const food = await post<{ id: string }>('/categories', { name: 'Food' });
    const fun = await post<{ id: string }>('/categories', { name: 'Fun' });
    await post('/exchange-rates', {
      baseCurrency: 'USD',
      quoteCurrency: 'BAM',
      rate: '1.70',
      rateDate: '2026-10-01',
    });
    await post('/transactions', {
      kind: 'income',
      accountId: usd.id,
      amount: { amount: '100.00', currency: 'USD' },
      bookingDate: '2026-10-02',
    });
    const exp = await post<{ id: string }>('/transactions', {
      kind: 'expense',
      accountId: chk.id,
      amount: bam('33.33'),
      bookingDate: '2026-10-05',
      payee: 'Corner shop',
      splits: [
        { categoryId: food.id, amount: bam('20.00') },
        { categoryId: fun.id, amount: bam('13.33') },
      ],
    });
    await post(`/transactions/${exp.id}/refunds`, {
      amount: bam('10.00'),
      bookingDate: '2026-10-06',
    });
    const budget = await post<{ id: string }>('/budgets', {
      name: 'Oct',
      periodType: 'monthly',
      startDate: '2026-10-01',
      currency: 'BAM',
      allocations: [
        { categoryId: null, amount: bam('500.00') },
        { categoryId: food.id, amount: bam('100.00') },
      ],
    });
    await a.api.request('PATCH', `/api/v1/profiles/${profile.id}/settings`, {
      'forecast.minimumReserve': bam('250.00'),
    });

    const d = await device(a.api, a.deviceId, profile.id);
    await d.engine.sync();

    const rest = await a.api.request<{
      totals: { limit: { amount: string }; actual: { amount: string } };
    }>('GET', `/api/v1/budgets/${budget.id}/status?date=2026-10-15`, undefined, hdr);
    const web = await d.svc.budgetStatus(budget.id, '2026-10-15');
    expect(web.totals.limit.amount).toBe(rest.totals.limit.amount);
    expect(web.totals.actual.amount).toBe(rest.totals.actual.amount);
    expect(web.totals.limit.amount).toBe('500.00');

    const convert = reportingConverter(createRateBook(await d.svc.rateSnapshots()), 'BAM');
    const ledger = await d.svc.ledger();
    const bal = await a.api.request<{ netWorth: { amount: string }; missingRates: string[] }>(
      'GET',
      '/api/v1/balances?asOf=2026-10-31',
      undefined,
      hdr,
    );
    const nw = netWorth(ledger, await d.svc.list('accounts'), '2026-10-31', 'BAM', convert);
    expect(nw.complete).toBe(true);
    expect(nw.netWorth.amount).toBe(bal.netWorth.amount);

    const merchants = await a.api.request<{
      rows: { label: string; amount: { amount: string }; count: number }[];
    }>(
      'GET',
      '/api/v1/analytics/spending-by-merchant?from=2026-10-01&to=2026-10-31',
      undefined,
      hdr,
    );
    const mine = byMerchant(ledger, {
      from: '2026-10-01',
      to: '2026-10-31',
      currency: 'BAM',
      convert,
    });
    const shape = (rows: { label: string; amount: { amount: string }; count: number }[]) =>
      rows.map((r) => `${r.label}:${r.amount.amount}:${r.count}`);
    expect(shape(mine.rows)).toEqual(shape(merchants.rows));
    expect(shape(mine.rows)).toEqual(['corner shop:23.33:2']); // the refund nets, no "Refund:" row

    expect((await d.svc.getSettings())['forecast.minimumReserve']).toEqual(bam('250.00'));
  },
);
