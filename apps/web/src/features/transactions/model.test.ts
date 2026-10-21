import { describe, expect, test } from 'bun:test';
import type * as D from '@finplat/domain';
import {
  exportRows,
  filterTransactions,
  splitRemainder,
  toCsv,
  totalsByCurrency,
} from './model.ts';

const tx = (over: Partial<D.Transaction>): D.Transaction =>
  ({
    id: 't',
    profileId: 'p',
    version: 1,
    serverVersion: 0,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
    kind: 'expense',
    status: 'cleared',
    bookingDate: '2026-01-10',
    valueDate: null,
    occurredAt: null,
    description: '',
    notes: '',
    merchantId: null,
    payee: '',
    reference: '',
    excludeFromReports: false,
    source: 'manual',
    importRecordId: null,
    relatedTransactionId: null,
    correctsTransactionId: null,
    categorizationSource: 'none',
    postings: [],
    splits: [],
    tagIds: [],
    attachmentIds: [],
    conversion: null,
    ...over,
  }) as D.Transaction;

const post = (accountId: string, amount: string, currency = 'BAM'): D.Posting => ({
  id: `${accountId}${amount}`,
  accountId,
  amount: { amount, currency },
  originalAmount: null,
  exchangeRateId: null,
  lineNo: 0,
  memo: '',
});

const rows = [
  tx({
    id: 'a',
    description: 'Konzum market',
    postings: [post('acc1', '-12.50')],
    splits: [
      {
        id: 's',
        categoryId: null,
        amount: { amount: '12.50', currency: 'BAM' },
        description: '',
        notes: '',
        sortOrder: 0,
      },
    ],
  }),
  tx({ id: 'b', kind: 'income', bookingDate: '2026-02-01', postings: [post('acc2', '1000.00')] }),
  tx({ id: 'c', postings: [post('acc1', '-5.00', 'EUR')], tagIds: ['tg'] }),
];
const lk = { merchantName: () => '' };

describe('filterTransactions', () => {
  test('filters by date, account, text, amount, currency, tag, uncategorized', () => {
    const ids = (f: Parameters<typeof filterTransactions>[1]) =>
      filterTransactions(rows, f, lk).map((t) => t.id);
    expect(ids({ from: '2026-01-15' })).toEqual(['b']);
    expect(ids({ accountIds: ['acc1'] })).toEqual(['a', 'c']);
    expect(ids({ q: 'konzum' })).toEqual(['a']);
    expect(ids({ minAmount: '10' })).toEqual(['a', 'b']);
    expect(ids({ maxAmount: '12.49' })).toEqual(['c']);
    expect(ids({ currency: 'EUR' })).toEqual(['c']);
    expect(ids({ tagId: 'tg' })).toEqual(['c']);
    expect(ids({ categoryId: '__none' })).toEqual(['a']);
  });
});

test('totalsByCurrency sums exactly per currency', () => {
  expect(totalsByCurrency(rows)).toEqual([
    { amount: '987.50', currency: 'BAM' },
    { amount: '-5.00', currency: 'EUR' },
  ]);
});

test('splitRemainder works in minor units and rejects bad lines', () => {
  const total = { amount: '-10.00', currency: 'BAM' };
  const l = (amount: string) => ({ key: amount, categoryId: null, amount, description: '' });
  expect(splitRemainder(total, [l('3.33'), l('3.33')])).toEqual({
    amount: '3.34',
    currency: 'BAM',
  });
  expect(splitRemainder(total, [l('3.333')])).toBeNull();
  expect(splitRemainder(total, [l('0')])).toBeNull();
  expect(splitRemainder(total, [l('10.01')])).toEqual({ amount: '-0.01', currency: 'BAM' });
});

test('export has one row per posting and neutralizes formulas', () => {
  const t = tx({
    id: 'x',
    description: '=HYPERLINK("x")',
    postings: [post('a1', '-1.00'), post('a2', '1.00')],
  });
  const out = exportRows([t], {
    account: (id) => id,
    category: () => '',
    merchant: () => '',
    tag: () => '',
  });
  expect(out.length).toBe(2);
  const csv = toCsv(['d'], [[out[0]?.[7] ?? ''], ['-1.00']]);
  expect(csv).toBe('d\r\n"\'=HYPERLINK(""x"")"\r\n-1.00');
});
