// The ledger pages' data flows against the real LocalFinanceService (MemoryStore) and the real
// bank importers: what the UI calls, with the arguments the UI builds. No mocks.
import { expect, test } from 'bun:test';
import { createRegistry } from '@finplat/bank-importers';
import type * as D from '@finplat/domain';
import { balanceHistory, type LedgerTransaction } from '@finplat/finance-engine';
import {
  type ImportTemplateInput,
  inputFromBytes,
  merchantMatcher,
  validateTemplate,
} from '@finplat/importer-sdk';
import { LocalDataSource, MemoryStore } from '@finplat/storage';
import { duplicateInput, filterTransactions, totalsByCurrency } from '../transactions/model.ts';
import { balanceStatus } from './checks.ts';

const m = (amount: string, currency = 'BAM') => ({ amount, currency });

async function setup() {
  const store = new MemoryStore();
  await store.open();
  const ds = new LocalDataSource(store);
  const p = await ds.createProfile({ name: 'Home', baseCurrency: 'BAM' });
  const ops = ds.profile(p.id);
  const acc = await ops.create('accounts', {
    name: 'Checking',
    accountType: 'checking',
    currency: 'BAM',
    openingBalance: m('100.00'),
    openingDate: '2026-01-01',
  });
  return { ops, acc };
}

const template: ImportTemplateInput = {
  schemaVersion: 1,
  id: 'test-bank',
  name: 'Test bank',
  format: 'csv',
  delimiter: ';',
  columns: { postingDate: 'Datum', description: 'Opis', amount: 'Iznos' },
  dateFormat: 'DD.MM.YYYY',
  number: { decimalSeparator: ',', thousandsSeparator: '.' },
  currency: 'BAM',
};
const csv =
  'Datum;Opis;Iznos\n02.01.2026;KONZUM 123;-12,50\n03.01.2026;Plata;1.000,00\n04.01.2026;KONZUM 123;-7,25\n';

test('mapping template → worker-equivalent parse → stage → commit → re-import flags duplicates → rollback', async () => {
  const { ops, acc } = await setup();
  expect(validateTemplate(template).ok).toBe(true);
  const imp = createRegistry().require('generic-csv');
  const result = await imp.parse(inputFromBytes('jan.csv', new TextEncoder().encode(csv)), {
    template,
    accountCurrency: 'BAM',
  });
  expect(result.records.length).toBe(3);
  expect(balanceStatus(result)).toBe('unverifiable');

  const stage = () =>
    ops.stageImport({
      accountId: acc.id,
      importerId: 'generic-csv',
      importerVersion: result.importerVersion,
      fileName: 'jan.csv',
      fileSha256: 'ab',
      fileSize: csv.length,
      records: result.records.map((r) => ({
        ...r,
        warnings: r.warnings.map((w) => ({ message: w.message })),
      })),
    });
  const p1 = await stage();
  expect(p1.totals).toMatchObject({
    count: 3,
    duplicates: 0,
    income: m('1000.00'),
    expenses: m('19.75'),
  });
  const food = await ops.create('categories', { name: 'Food' });
  const first = p1.rows[0]?.record.id as string;
  const batch = await ops.commitImport(p1.batch.id, [
    ...p1.rows.map((r) => ({ rawRecordId: r.record.id, selected: true, categoryId: null })),
    { rawRecordId: first, selected: true, categoryId: food.id, description: 'Konzum groceries' },
  ]);
  expect(batch.status).toBe('committed');
  let txs = (await ops.ledger()) as unknown as D.Transaction[];
  const konzum = txs.find((t) => t.description === 'Konzum groceries');
  expect(konzum?.splits[0]?.categoryId).toBe(food.id);
  expect(konzum?.importRecordId).toBe(first);
  // filters the table offers
  const lk = { merchantName: () => '' };
  expect(filterTransactions(txs, { source: 'import' }, lk).length).toBe(3);
  expect(filterTransactions(txs, { categoryId: '__none' }, lk).length).toBe(2);

  const p2 = await stage();
  expect(p2.totals.duplicates).toBe(3);

  await ops.rollbackImport(batch.id);
  txs = (await ops.ledger()) as unknown as D.Transaction[];
  expect(txs.filter((t) => t.source === 'import').length).toBe(0);
});

test('duplicate, partial refund, bulk edit keeps totals, reconciliation adjustment', async () => {
  const { ops, acc } = await setup();
  const food = await ops.create('categories', { name: 'Food' });
  const t = await ops.createTransaction({
    kind: 'expense',
    accountId: acc.id,
    amount: m('30.00'),
    bookingDate: '2026-02-01',
    categoryId: food.id,
    description: 'Dinner',
  });

  const copy = await ops.createTransaction(duplicateInput(t, '2026-02-02'));
  expect(copy.postings[0]?.amount).toEqual(m('-30.00'));
  expect(copy.splits[0]?.categoryId).toBe(food.id);

  const r = await ops.createRefund(t.id, { amount: m('10.00'), bookingDate: '2026-02-03' });
  expect(r.relatedTransactionId).toBe(t.id);
  await expect(
    ops.createRefund(t.id, { amount: m('20.01'), bookingDate: '2026-02-03' }),
  ).rejects.toBeTruthy();

  let all = (await ops.ledger()) as unknown as D.Transaction[];
  const before = totalsByCurrency(all);
  const res = await ops.bulkEdit({
    transactionIds: all.map((x) => x.id),
    set: { clearCategory: true },
  });
  expect(res.updated).toBeGreaterThan(0); // opening balance is skipped (not categorized)
  all = (await ops.ledger()) as unknown as D.Transaction[];
  expect(totalsByCurrency(all)).toEqual(before);

  // Reconcile: ledger 100 - 30 - 30 + 10 = 50.00 on 2026-02-28; statement says 48.20.
  const bal = balanceHistory(
    all as unknown as LedgerTransaction[],
    acc.id,
    'BAM',
    '2026-02-28',
    '2026-02-28',
  )[0]?.balance;
  expect(bal).toEqual(m('50.00'));
  await ops.createAdjustment(r.id, {
    amount: m('-1.80'),
    bookingDate: '2026-02-28',
    reason: 'Reconciliation',
    accountId: acc.id,
  });
  expect((await ops.get('accounts', acc.id)).balances).toEqual([m('48.20')]);
});

test('merchant template: matched on staging, split template + merchant applied in the commit', async () => {
  const { ops, acc } = await setup();
  const food = await ops.create('categories', { name: 'Food' });
  const home = await ops.create('categories', { name: 'Household' });
  const konzum = await ops.create('merchants', { name: 'Konzum', defaultCategoryId: food.id });
  const tpl = await ops.create('split_templates', {
    name: 'Konzum mix',
    merchantId: konzum.id,
    lines: [
      { categoryId: food.id, weight: '3', description: 'food' },
      { categoryId: home.id, weight: '1', description: 'home' },
    ],
  });
  const result = await createRegistry()
    .require('generic-csv')
    .parse(inputFromBytes('jan.csv', new TextEncoder().encode(csv)), {
      template,
      accountCurrency: 'BAM',
    });
  const p = await ops.stageImport({
    accountId: acc.id,
    importerId: 'generic-csv',
    importerVersion: result.importerVersion,
    fileName: 'jan.csv',
    fileSha256: 'ab',
    fileSize: csv.length,
    records: result.records.map((r) => ({ ...r, warnings: [] })),
  });
  const match = merchantMatcher(await ops.list('merchants'), await ops.list('split_templates'));
  const rows = p.rows.map((r) => ({ id: r.record.id, m: match(r.record.sourceDescription) }));
  expect(rows.map((r) => r.m?.splitTemplateId ?? null)).toEqual([tpl.id, null, tpl.id]);
  // The user unticked the split on the second Konzum row: it keeps the default category only.
  const choice = (i: number, split: boolean) => {
    const r = rows[i] as (typeof rows)[number];
    return {
      rawRecordId: r.id,
      selected: true,
      categoryId: r.m?.categoryId ?? null,
      merchantId: r.m?.merchantId ?? null,
      splitTemplateId: split ? (r.m?.splitTemplateId ?? null) : null,
    };
  };
  await ops.commitImport(p.batch.id, [choice(0, true), choice(1, true), choice(2, false)]);
  const txs = (await ops.ledger()) as unknown as D.Transaction[];
  const byRaw = (id: string | undefined) => txs.find((t) => t.importRecordId === id);
  const split = byRaw(rows[0]?.id);
  expect(split?.merchantId).toBe(konzum.id);
  expect(split?.splits.map((s) => [s.categoryId, s.amount.amount])).toEqual([
    [food.id, '9.38'],
    [home.id, '3.12'],
  ]);
  const plain = byRaw(rows[2]?.id);
  expect(plain?.merchantId).toBe(konzum.id);
  expect(plain?.splits.map((s) => s.categoryId)).toEqual([food.id]);
  expect(byRaw(rows[1]?.id)?.merchantId ?? null).toBeNull();
});
