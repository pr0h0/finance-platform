import 'fake-indexeddb/auto';
import { beforeEach, expect, test } from 'bun:test';
import type * as D from '@finplat/domain';
import { LocalDataSource } from '../datasource.ts';
import { IdbStore } from '../idb.ts';
import { MemoryStore } from '../memory.ts';
import { allOps } from '../schema.ts';
import type { LocalStore } from '../types.ts';
import type { ServiceError } from './errors.ts';
import type { LocalFinanceService } from './service.ts';

const m = (amount: string, currency = 'BAM') => ({ amount, currency });
let store: LocalStore;
let svc: LocalFinanceService;
let pid: string;

beforeEach(async () => {
  store = new MemoryStore();
  await store.open();
  const ds = new LocalDataSource(store);
  pid = (await ds.createProfile({ name: 'Home', baseCurrency: 'BAM' })).id;
  svc = ds.profile(pid);
});

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: ServiceError) => e,
  );
const bal = async (accountId: string) =>
  (await svc.get('accounts', accountId)).balances.map((b) => `${b.amount} ${b.currency}`);

async function setup() {
  const checking = await svc.create('accounts', {
    name: 'Checking',
    accountType: 'checking',
    currency: 'BAM',
    openingBalance: m('1000.00'),
    openingDate: '2026-01-01',
  });
  const savings = await svc.create('accounts', {
    name: 'Savings',
    accountType: 'savings',
    currency: 'BAM',
  });
  const card = await svc.create('accounts', {
    name: 'Card',
    accountType: 'credit_card',
    currency: 'BAM',
  });
  const eur = await svc.create('accounts', {
    name: 'EUR',
    accountType: 'checking',
    currency: 'EUR',
  });
  const food = await svc.create('categories', { name: 'Food' });
  const home = await svc.create('categories', { name: 'Home' });
  return { checking, savings, card, eur, food, home };
}

test('expense and income update balances (§46 cases 1-2); opening balance counted', async () => {
  const { checking, food } = await setup();
  expect(await bal(checking.id)).toEqual(['1000.00 BAM']);
  await svc.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('150.00'),
    bookingDate: '2026-01-05',
    categoryId: food.id,
  });
  await svc.createTransaction({
    kind: 'income',
    accountId: checking.id,
    amount: m('2000.50'),
    bookingDate: '2026-01-10',
  });
  expect(await bal(checking.id)).toEqual(['2850.50 BAM']);
  expect((await svc.get('accounts', checking.id)).classification).toBe('asset');
});

test('transfers and card payments move money without income/expense (§46 cases 3,4,7)', async () => {
  const { checking, savings, card } = await setup();
  await svc.createTransaction({
    kind: 'expense',
    accountId: card.id,
    amount: m('200.00'),
    bookingDate: '2026-01-03',
  });
  const t = await svc.createTransaction({
    kind: 'transfer',
    accountId: checking.id,
    toAccountId: card.id,
    amount: m('200.00'),
    bookingDate: '2026-01-04',
  });
  expect(t.kind).toBe('transfer');
  expect(t.splits).toEqual([]);
  await svc.createTransaction({
    kind: 'transfer',
    accountId: checking.id,
    toAccountId: savings.id,
    amount: m('300.00'),
    bookingDate: '2026-01-04',
  });
  expect(await bal(checking.id)).toEqual(['500.00 BAM']);
  expect(await bal(savings.id)).toEqual(['300.00 BAM']);
  expect(await bal(card.id)).toEqual(['0.00 BAM']);
});

test('fx: bank actual amount, market rate from local snapshot, fee as linked expense', async () => {
  const { checking, eur } = await setup();
  const fx = await svc.createTransaction({
    kind: 'fx',
    accountId: checking.id,
    toAccountId: eur.id,
    amount: m('195.58'),
    toAmount: m('100.00', 'EUR'),
    fee: m('2.00'),
    bookingDate: '2026-01-05',
  });
  expect(fx.conversion?.method).toBe('bank_actual');
  expect(fx.conversion?.rate).toBe('0.511299723898149095');
  expect(fx.conversion?.fee).toEqual(m('2.00'));
  expect(await bal(checking.id)).toEqual(['802.42 BAM']);
  expect(await bal(eur.id)).toEqual(['100.00 EUR']);

  // EUR/BAM is the fixed currency-board rate, always available
  const fixed = await svc.createTransaction({
    kind: 'transfer',
    accountId: checking.id,
    toAccountId: eur.id,
    amount: m('10.00'),
    bookingDate: '2026-01-06',
  });
  expect(fixed.kind).toBe('fx');
  expect(fixed.postings[1]?.amount).toEqual(m('5.11', 'EUR'));
  expect(fixed.conversion?.method).toBe('fixed');

  const usd = await svc.create('accounts', {
    name: 'USD',
    accountType: 'checking',
    currency: 'USD',
  });
  const toUsd = {
    kind: 'transfer' as const,
    accountId: checking.id,
    toAccountId: usd.id,
    amount: m('10.00'),
    bookingDate: '2026-01-06',
  };
  expect((await err(svc.createTransaction(toUsd)))?.code).toBe('rate_unavailable');
  await svc.addExchangeRate({
    baseCurrency: 'USD',
    quoteCurrency: 'BAM',
    rate: '1.8',
    rateDate: '2026-01-01',
  });
  const mk = await svc.createTransaction(toUsd);
  expect(mk.postings[1]?.amount).toEqual(m('5.56', 'USD'));
  expect(mk.conversion?.method).toBe('manual');
});

test('splits stay exact; refunds allocate pro rata and never exceed the original (§46 cases 5-6)', async () => {
  const { checking, food, home } = await setup();
  expect(
    (
      await err(
        svc.createTransaction({
          kind: 'expense',
          accountId: checking.id,
          amount: m('100.00'),
          bookingDate: '2026-01-05',
          splits: [
            { categoryId: food.id, amount: m('60.00') },
            { categoryId: home.id, amount: m('30.00') },
          ],
        }),
      )
    )?.code,
  ).toBe('validation_failed');
  const t = await svc.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('100.00'),
    bookingDate: '2026-01-05',
    splits: [
      { categoryId: food.id, amount: m('66.67') },
      { categoryId: home.id, amount: m('33.33') },
    ],
  });
  const r = await svc.createRefund(t.id, { amount: m('10.00'), bookingDate: '2026-01-07' });
  expect(r.kind).toBe('refund');
  expect(r.relatedTransactionId).toBe(t.id);
  expect(r.splits.map((s) => [s.categoryId, s.amount.amount])).toEqual([
    [food.id, '6.67'],
    [home.id, '3.33'],
  ]);
  expect(
    (await err(svc.createRefund(t.id, { amount: m('90.01'), bookingDate: '2026-01-08' })))?.code,
  ).toBe('invariant_violation');
  expect(await bal(checking.id)).toEqual(['910.00 BAM']);
});

test('split replace and split templates', async () => {
  const { checking, food, home } = await setup();
  const t = await svc.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('10.00'),
    bookingDate: '2026-01-05',
  });
  const tpl = await svc.create('split_templates', {
    name: 'thirds',
    lines: [
      { categoryId: food.id, weight: '1' },
      { categoryId: home.id, weight: '2' },
      { categoryId: null, amount: m('1.00') },
    ],
  });
  const s = await svc.replaceSplits(t.id, { version: t.version, splitTemplateId: tpl.id });
  expect(s.splits.map((x) => x.amount.amount)).toEqual(['3.00', '6.00', '1.00']);
  expect((await err(svc.replaceSplits(t.id, { version: t.version, splits: [] })))?.code).toBe(
    'conflict',
  );
});

test('edit amount re-derives postings; imported evidence is protected', async () => {
  const { checking, food } = await setup();
  const t = await svc.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('10.00'),
    bookingDate: '2026-01-05',
    categoryId: food.id,
  });
  const u = await svc.updateTransaction(t.id, {
    version: 1,
    amount: m('12.50'),
    description: 'lunch',
  });
  expect(u.version).toBe(2);
  expect(u.postings[0]?.amount).toEqual(m('-12.50'));
  expect(u.postings[0]?.id).not.toBe(t.postings[0]?.id);
  expect(u.splits[0]).toMatchObject({ categoryId: food.id, amount: m('12.50') });
  expect((await err(svc.updateTransaction(t.id, { version: 1, notes: 'x' })))?.status).toBe(409);
});

test('import: stage keeps raw evidence, commit applies rules, duplicates recognised, rollback is scoped (§46 14-17)', async () => {
  const { checking, food } = await setup();
  await svc.create('categorization_rules', {
    name: 'market',
    conditions: [{ field: 'description', op: 'contains', value: 'bingo' }],
    actions: [{ type: 'set_category', categoryId: food.id }],
  });
  const manual = await svc.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('5.00'),
    bookingDate: '2026-02-01',
  });
  const rec = (
    rowNumber: number,
    description: string,
    amount: string,
    direction: 'debit' | 'credit',
    fp: string,
  ) => ({
    rowNumber,
    postingDate: `2026-02-0${rowNumber}`,
    description,
    direction,
    amount,
    currency: 'BAM',
    raw: { line: `${rowNumber};${description};${amount}` },
    fingerprint: fp,
  });
  const input = {
    accountId: checking.id,
    importerId: 'csv',
    importerVersion: '1.0.0',
    fileName: 's.csv',
    fileSha256: 'ab',
    fileSize: 10,
    records: [
      rec(1, 'BINGO market', '20.00', 'debit', 'fp1'),
      rec(2, 'Salary', '100.00', 'credit', 'fp2'),
    ],
  };
  const p1 = await svc.stageImport(input);
  expect(p1.totals).toMatchObject({
    count: 2,
    duplicates: 0,
    income: m('100.00'),
    expenses: m('20.00'),
  });
  const b1 = await svc.commitImport(p1.batch.id);
  expect(b1.status).toBe('committed');
  const imported = (await svc.searchTransactions({ q: 'bingo' })).items[0] as D.Transaction;
  expect(imported.splits[0]?.categoryId).toBe(food.id);
  expect(imported.categorizationSource).toBe('rule');
  expect(
    (
      await err(
        svc.updateTransaction(imported.id, { version: imported.version, amount: m('1.00') }),
      )
    )?.code,
  ).toBe('imported_evidence');

  const p2 = await svc.stageImport({ ...input, fileName: 's2.csv' });
  expect(p2.rows.map((r) => r.outcome)).toEqual(['duplicate', 'duplicate']);
  expect(p2.rows[0]?.record.raw).toEqual({ line: '1;BINGO market;20.00' });

  await svc.rollbackImport(b1.id);
  const left = (await svc.searchTransactions({})).items.map((t) => t.id);
  expect(left).toContain(manual.id);
  expect(left).not.toContain(imported.id);
  // after rollback the rows are no longer duplicates of committed transactions
  expect((await svc.importPreview(p2.batch.id)).rows.map((r) => r.outcome)).toEqual(['new', 'new']);
});

test('search: keyset pagination by date desc, filters', async () => {
  const { checking, food } = await setup();
  for (let d = 1; d <= 5; d++)
    await svc.createTransaction({
      kind: 'expense',
      accountId: checking.id,
      amount: m(`${d}.00`),
      bookingDate: `2026-03-0${d}`,
      ...(d % 2 ? { categoryId: food.id } : {}),
    });
  const p1 = await svc.searchTransactions({ limit: 2, kind: 'expense' });
  const p2 = await svc.searchTransactions({ limit: 2, kind: 'expense', cursor: p1.nextCursor });
  const p3 = await svc.searchTransactions({ limit: 2, kind: 'expense', cursor: p2.nextCursor });
  expect([...p1.items, ...p2.items, ...p3.items].map((t) => t.bookingDate)).toEqual([
    '2026-03-05',
    '2026-03-04',
    '2026-03-03',
    '2026-03-02',
    '2026-03-01',
  ]);
  expect(p3.nextCursor).toBeUndefined();
  expect((await svc.searchTransactions({ categoryId: food.id })).items).toHaveLength(3);
  expect((await svc.searchTransactions({ uncategorized: true })).items).toHaveLength(2);
  expect((await svc.searchTransactions({ minAmount: '2.5', maxAmount: '4' })).items).toHaveLength(
    2,
  );
});

test('budgets: actual vs planned separately (§46 case 10)', async () => {
  const { checking, food } = await setup();
  const b = await svc.create('budgets', {
    name: 'Monthly',
    periodType: 'monthly',
    startDate: '2026-01-01',
    currency: 'BAM',
    allocations: [{ categoryId: food.id, amount: m('300.00') }],
  });
  await svc.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('120.00'),
    bookingDate: '2026-01-10',
    categoryId: food.id,
  });
  await svc.create('planned_transactions', {
    kind: 'expense',
    accountId: checking.id,
    categoryId: food.id,
    amount: m('50.00'),
    dueDate: '2026-01-20',
  });
  const st = await svc.budgetStatus(b.id, '2026-01-15');
  expect(st.lines[0]).toMatchObject({
    actual: m('120.00'),
    planned: m('50.00'),
    remaining: m('130.00'),
  });
});

test('plans with recurrence, occurrence skip; goals; templates; tags; merchants', async () => {
  const { checking } = await setup();
  const plan = await svc.create('planned_transactions', {
    kind: 'expense',
    accountId: checking.id,
    amount: m('9.99'),
    dueDate: '2026-01-31',
    recurrence: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=31' },
  });
  expect(plan.recurrenceId).not.toBeNull();
  const occ = await svc.planOccurrences('2026-01-01', '2026-03-31');
  expect(occ.map((o) => o.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  await svc.setOccurrence(plan.id, '2026-02-28', { status: 'skipped' });
  expect((await svc.planOccurrences('2026-01-01', '2026-03-31')).map((o) => o.date)).toEqual([
    '2026-01-31',
    '2026-03-31',
  ]);

  const g = await svc.create('savings_goals', { name: 'Car', targetAmount: m('5000.00') });
  await svc.create('savings_contributions', {
    goalId: g.id,
    amount: m('700.00'),
    contributionDate: '2026-01-02',
  });
  await svc.create('savings_contributions', {
    goalId: g.id,
    amount: m('-200.00'),
    contributionDate: '2026-01-03',
  });
  expect(await svc.goalProgress(g.id)).toEqual({
    saved: m('500.00'),
    target: m('5000.00'),
    remaining: m('4500.00'),
  });

  const tag = await svc.create('tags', { name: 'trip' });
  const merch = await svc.create('merchants', { name: '  Bingo   Market ' });
  expect(merch.normalizedName).toBe('bingo market');
  const tt = await svc.create('transaction_templates', {
    name: 'Coffee',
    kind: 'expense',
    accountId: checking.id,
    amount: m('3.00'),
    tagIds: [tag.id],
  });
  expect(tt.amount).toEqual(m('3.00'));
  const renamed = await svc.update('tags', tag.id, { name: 'travel', version: 1 });
  expect(renamed).toMatchObject({ name: 'travel', version: 2 });
  await svc.remove('tags', tag.id);
  expect(await svc.list('tags')).toEqual([]);
  expect((await svc.list('tags', { includeDeleted: true }))[0]?.deletedAt).not.toBeNull();
});

test('every mutation is in the outbox with versions for sync', async () => {
  const { checking } = await setup();
  const t = await svc.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('1.00'),
    bookingDate: '2026-01-05',
  });
  await svc.updateTransaction(t.id, { version: 1, description: 'x' });
  await svc.deleteTransaction(t.id);
  const ops = (await allOps(store, pid)).filter((o) => o.entityId === t.id);
  expect(ops.map((o) => [o.op, o.baseVersion])).toEqual([
    ['upsert', null],
    ['upsert', 1],
    ['delete', 2],
  ]);
  expect(ops[1]?.changedFields).toEqual(['description']);
  expect(ops[0]?.data).toMatchObject({ id: t.id, version: 1, postings: [{ amount: m('-1.00') }] });
  // failed writes leave no op
  const before = (await allOps(store, pid)).length;
  await err(
    svc.createTransaction({
      kind: 'expense',
      accountId: checking.id,
      amount: m('-1.00'),
      bookingDate: '2026-01-05',
    }),
  );
  expect((await allOps(store, pid)).length).toBe(before);
});

test('attachments as Blobs, settings, dashboard layout, notifications', async () => {
  const { checking } = await setup();
  const t = await svc.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('1.00'),
    bookingDate: '2026-01-05',
  });
  const a = await svc.addAttachment({
    file: new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
    fileName: 'r.pdf',
    transactionId: t.id,
  });
  expect(a.sha256).toHaveLength(64);
  expect(await (await svc.attachmentContent(a.id)).text()).toBe('%PDF-1.4');
  expect((await svc.getTransaction(t.id)).attachmentIds).toEqual([a.id]);
  await svc.removeAttachment(a.id);
  expect((await svc.getTransaction(t.id)).attachmentIds).toEqual([]);

  await svc.setDashboardLayout([{ widget: 'balance', x: 0 }]);
  expect(await svc.getDashboardLayout()).toEqual([{ widget: 'balance', x: 0 }]);
  await svc.notify({
    kind: 'budget',
    severity: 'warning',
    title: 'Food 80%',
    body: '',
    dedupeKey: 'b1',
  });
  await svc.notify({
    kind: 'budget',
    severity: 'warning',
    title: 'Food 80%',
    body: '',
    dedupeKey: 'b1',
  });
  expect(await svc.listNotifications(true)).toHaveLength(1);
  await svc.markNotificationRead();
  expect(await svc.listNotifications(true)).toHaveLength(0);
});

test('works on IndexedDB too (offline edits survive a reopen)', async () => {
  const name = `svc-${Math.random()}`;
  const s1 = new IdbStore(name);
  const ds = new LocalDataSource(s1);
  const p = await ds.createProfile({ name: 'P', baseCurrency: 'EUR' });
  const a = await ds.profile(p.id).create('accounts', {
    name: 'A',
    accountType: 'cash',
    currency: 'EUR',
    openingBalance: m('10.00', 'EUR'),
  });
  await s1.close();
  const s2 = new IdbStore(name);
  const ds2 = new LocalDataSource(s2);
  expect((await ds2.listProfiles()).map((x) => x.name)).toEqual(['P']);
  expect((await ds2.profile(p.id).get('accounts', a.id)).balances).toEqual([m('10.00', 'EUR')]);
  await s2.destroy();
});
