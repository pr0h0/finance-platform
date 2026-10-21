import { describe, expect, test } from 'bun:test';
import {
  addDays,
  addMonths,
  balanceHistory,
  buildCategoryHistory,
  byCategory,
  cashflow,
  detectAnomalies,
  detectRecurring,
  evaluateRules,
  findDuplicates,
  installmentProgress,
  isoWeekday,
  type LedgerTransaction,
  type Money,
  monthlyInsights,
  nextOccurrence,
  normalizeMerchantName,
  parseRRule,
  periodKey,
  type RuleLike,
  sameCurrencyOnly,
  spreadAnnual,
  suggestCategory,
} from './index.ts';

const M = (amount: string, currency = 'BAM'): Money => ({ amount, currency });
const conv = sameCurrencyOnly('BAM');
let n = 0;
function exp(
  date: string,
  amount: string,
  cat: string | null,
  extra: Partial<LedgerTransaction> = {},
) {
  return {
    id: `x${String(++n).padStart(5, '0')}`,
    kind: 'expense' as const,
    bookingDate: date,
    postings: [{ accountId: 'chk', amount: M(`-${amount}`) }],
    splits: cat ? [{ categoryId: cat, amount: M(amount) }] : [],
    categorizationSource: 'user',
    ...extra,
  } satisfies LedgerTransaction;
}

describe('dates', () => {
  test('weekday, month arithmetic and period keys', () => {
    expect(isoWeekday('2026-10-22')).toBe(4);
    expect(isoWeekday('1970-01-01')).toBe(4);
    expect(isoWeekday('2026-10-25')).toBe(7);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 2)).toBe('2027-02-15');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(periodKey('2026-10-22', 'week')).toBe('2026-10-19');
    expect(periodKey('2026-10-22', 'quarter')).toBe('2026-Q4');
  });
  test('next occurrence and parse errors', () => {
    expect(nextOccurrence({ rrule: 'FREQ=YEARLY', startDate: '2020-02-29' }, '2026-10-22')).toEqual(
      {
        date: '2027-02-28',
        dueDate: '2027-02-28',
      },
    );
    expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=0')).toThrow();
    expect(() => parseRRule('FREQ=MONTHLY;WKST=SU')).toThrow();
  });
});

describe('analytics extras', () => {
  test('balance history is end-of-day and includes earlier postings', () => {
    const txs: LedgerTransaction[] = [
      {
        id: 'o',
        kind: 'opening_balance',
        bookingDate: '2026-09-01',
        postings: [{ accountId: 'chk', amount: M('100.00') }],
      },
      exp('2026-10-02', '30.00', 'food'),
      exp('2026-10-02', '5.00', 'food', { status: 'void' }),
    ];
    expect(
      balanceHistory(txs, 'chk', 'BAM', '2026-10-01', '2026-10-03').map((p) => p.balance.amount),
    ).toEqual(['100.00', '70.00', '70.00']);
  });
  test('weekly and yearly cash flow buckets', () => {
    const txs = [
      exp('2026-10-19', '1.00', 'a'),
      exp('2026-10-25', '2.00', 'a'),
      exp('2026-10-26', '4.00', 'a'),
    ];
    const w = cashflow(txs, {
      from: '2026-01-01',
      to: '2026-12-31',
      currency: 'BAM',
      convert: conv,
      granularity: 'week',
    });
    expect(w.periods.map((p) => [p.period, p.expense.amount])).toEqual([
      ['2026-10-19', '3.00'],
      ['2026-10-26', '4.00'],
    ]);
  });
  test('merchant normalization', () => {
    expect(normalizeMerchantName('KONZUM 1234 SARAJEVO')).toBe('konzum sarajevo');
    expect(normalizeMerchantName('Bingo d.o.o. #0042  Tuzla')).toBe('bingo d o o tuzla');
    expect(normalizeMerchantName('ŠKOLSKA KNJIGA')).toBe('školska knjiga');
  });
});

describe('categorization rules', () => {
  const rules: RuleLike[] = [
    {
      id: 'r2',
      priority: 20,
      enabled: true,
      stopProcessing: false,
      conditions: [{ field: 'description', op: 'contains', value: 'konzum' }],
      actions: [
        { type: 'set_category', categoryId: 'household' },
        { type: 'add_tag', tagId: 'shop' },
      ],
    },
    {
      id: 'r1',
      priority: 10,
      enabled: true,
      stopProcessing: false,
      conditions: [
        { field: 'description', op: 'regex', value: '^KONZUM\\s+\\d+', caseSensitive: true },
        { field: 'amount', op: 'lte', value: '200' },
        { field: 'direction', op: 'equals', value: 'debit' },
      ],
      actions: [
        { type: 'set_category', categoryId: 'groceries' },
        { type: 'add_tag', tagId: 'food' },
      ],
    },
    {
      id: 'r3',
      priority: 30,
      enabled: true,
      stopProcessing: true,
      conditions: [{ field: 'accountId', op: 'equals', value: 'chk' }],
      actions: [{ type: 'add_tag', tagId: 'chk' }],
    },
    {
      id: 'r4',
      priority: 40,
      enabled: true,
      stopProcessing: false,
      conditions: [{ field: 'accountId', op: 'equals', value: 'chk' }],
      actions: [{ type: 'exclude_from_reports' }],
    },
    {
      id: 'r0',
      priority: 0,
      enabled: false,
      stopProcessing: false,
      conditions: [{ field: 'payee', op: 'equals', value: '' }],
      actions: [{ type: 'set_category', categoryId: 'never' }],
    },
  ];
  test('priority order, first set_* wins, tags accumulate, stopProcessing', () => {
    const r = evaluateRules(rules, {
      description: 'KONZUM 123 SARAJEVO',
      amount: M('-150.00'),
      accountId: 'chk',
    });
    expect(r.categoryId).toBe('groceries');
    expect(r.tagIds).toEqual(['food', 'shop', 'chk']);
    expect(r.matchedRuleIds).toEqual(['r1', 'r2', 'r3']);
    expect(r.excludeFromReports).toBe(false);
  });
  test('amount uses magnitude; direction distinguishes credits; bad regex never matches', () => {
    const r = evaluateRules(rules, {
      description: 'KONZUM 123',
      amount: M('250.00'),
      accountId: 'sav',
    });
    expect(r.categoryId).toBe('household');
    expect(r.matchedRuleIds).toEqual(['r2']);
    const bad = evaluateRules(
      [
        {
          id: 'b',
          priority: 1,
          enabled: true,
          stopProcessing: false,
          conditions: [{ field: 'description', op: 'regex', value: '([' }],
          actions: [{ type: 'set_category', categoryId: 'x' }],
        },
      ],
      { description: '([', amount: M('1.00') },
    );
    expect(bad.matchedRuleIds).toEqual([]);
  });
});

describe('suggestions from history', () => {
  test('most frequent past category for the merchant, ignoring earlier suggestions', () => {
    const hist = [
      exp('2026-01-01', '10.00', 'groceries', { payee: 'LIDL 001' }),
      exp('2026-02-01', '10.00', 'groceries', { payee: 'Lidl 002' }),
      exp('2026-03-01', '10.00', 'household', { payee: 'LIDL' }),
      exp('2026-04-01', '10.00', 'fun', { payee: 'LIDL', categorizationSource: 'suggestion' }),
    ];
    const h = buildCategoryHistory(hist);
    const s = suggestCategory(h, exp('2026-05-01', '5.00', null, { payee: 'LIDL 9' }));
    expect(s).toMatchObject({ field: 'category', value: 'groceries', confidence: '0.66' });
    expect(
      suggestCategory(h, exp('2026-05-01', '5.00', null, { payee: 'Unknown shop' })),
    ).toBeNull();
  });
});

describe('duplicate detection', () => {
  test('manual entry vs import is flagged; two imported rows are not; groups merge', () => {
    const a = exp('2026-10-01', '25.00', 'food', { payee: 'Cafe Roma' });
    const b = exp('2026-10-02', '25.00', 'food', { payee: 'CAFE ROMA 77', importRecordId: 'r1' });
    const c = exp('2026-10-02', '25.00', 'food', { payee: 'Cafe Roma', importRecordId: 'r2' });
    const d = exp('2026-10-10', '25.00', 'food', { payee: 'Cafe Roma' });
    const e = exp('2026-10-01', '26.00', 'food', { payee: 'Cafe Roma' });
    const g = findDuplicates([a, b, c, d, e]);
    expect(g).toHaveLength(1);
    expect(g[0]?.transactionIds).toEqual([a.id, b.id, c.id].sort());
    expect(g[0]?.score).toBe('0.80');
    expect(findDuplicates([b, c])).toEqual([]);
  });
});

describe('recurring detection', () => {
  test('monthly subscription with a small price change', () => {
    const txs = [
      '2026-05-03',
      '2026-06-03',
      '2026-07-03',
      '2026-08-04',
      '2026-09-03',
      '2026-10-03',
    ].map((d, i) => exp(d, i < 4 ? '15.99' : '16.99', 'subs', { payee: 'NETFLIX.COM 1234' }));
    const noise = [
      exp('2026-06-11', '40.00', 'food', { payee: 'Pizzeria' }),
      exp('2026-09-30', '12.00', 'food', { payee: 'Pizzeria' }),
      exp('2026-10-01', '90.00', 'food', { payee: 'Pizzeria' }),
    ];
    const r = detectRecurring([...txs, ...noise], '2026-10-22');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      cadence: 'monthly',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=3',
      amount: M('16.99'),
      confidence: '1.00',
      kind: 'expense',
    });
    expect(detectRecurring(txs, '2027-03-01')).toEqual([]); // stale
  });
  test('weekly income', () => {
    const txs = [0, 7, 14, 21].map((d) => ({
      ...exp(addDays('2026-09-04', d), '100.00', 'pay', { payee: 'Side gig' }),
      kind: 'income' as const,
      postings: [{ accountId: 'chk', amount: M('100.00') }],
    }));
    expect(detectRecurring(txs, '2026-10-01')[0]).toMatchObject({
      cadence: 'weekly',
      rrule: 'FREQ=WEEKLY',
      kind: 'income',
    });
  });
});

describe('insights and anomalies', () => {
  const hist = [
    '2026-04-02',
    '2026-05-02',
    '2026-06-02',
    '2026-07-02',
    '2026-08-02',
    '2026-09-02',
  ].map((d) => exp(d, '50.00', 'groceries', { payee: 'Lidl' }));
  test('large expense vs category median is flagged with an explanation and can be dismissed', () => {
    const big = exp('2026-10-05', '180.00', 'groceries', { payee: 'Lidl' });
    const small = exp('2026-10-06', '60.00', 'groceries', { payee: 'Lidl' });
    const o = { from: '2026-10-01', to: '2026-10-31', currency: 'BAM', convert: conv };
    const r = detectAnomalies([...hist, big, small], o);
    expect(r.map((i) => i.id)).toEqual([`anomaly:${big.id}:large_vs_category`]);
    expect(r[0]?.body).toContain('3.60x');
    expect(
      detectAnomalies([...hist, big], {
        ...o,
        dismissed: new Set([`anomaly:${big.id}:large_vs_category`]),
      }),
    ).toEqual([]);
  });
  test('monthly insights: category spike, spending change, savings rate', () => {
    const oct = [
      exp('2026-10-05', '200.00', 'groceries'),
      {
        id: 'inc',
        kind: 'income' as const,
        bookingDate: '2026-10-01',
        postings: [{ accountId: 'chk', amount: M('1000.00') }],
        splits: [{ categoryId: 'salary', amount: M('1000.00') }],
      },
    ];
    const r = monthlyInsights([...hist, ...oct], {
      month: '2026-10-15',
      currency: 'BAM',
      convert: conv,
    });
    expect(r.map((i) => i.kind)).toEqual(['category_spike', 'spending_change', 'savings_rate']);
    expect(r[2]?.data.savingsRate).toBe('0.8000');
    expect(r[1]?.body).toContain('+300.00%');
  });
});

describe('plans extras', () => {
  test('installments: paid, remaining, outstanding', () => {
    const plan = {
      id: 'tv',
      kind: 'expense' as const,
      accountId: 'chk',
      toAccountId: null,
      categoryId: null,
      description: 'TV',
      amount: M('100.00'),
      dueDate: '2026-08-15',
      recurrenceId: 'r',
      confidence: 'certain' as const,
      status: 'active' as const,
      installmentTotal: 12,
      installmentStart: 3,
    };
    const p = installmentProgress(
      plan,
      { id: 'r', rrule: 'FREQ=MONTHLY', startDate: '2026-08-15' },
      [
        { plannedTransactionId: 'tv', occurrenceDate: '2026-08-15', status: 'matched' },
        { plannedTransactionId: 'tv', occurrenceDate: '2026-09-15', status: 'paid_manual' },
      ],
    );
    expect(p).toEqual({
      total: 12,
      paid: 4,
      remaining: 8,
      paidAmount: M('400.00'),
      outstanding: M('800.00'),
      nextDueDate: '2026-10-15',
    });
  });
  test('annual expenses spread across months exactly', () => {
    const parts = spreadAnnual(M('1000.00'));
    expect(parts).toHaveLength(12);
    expect(parts[0]?.amount).toBe('83.34');
    expect(parts[11]?.amount).toBe('83.33');
  });
});

describe('performance', () => {
  test('50k transactions: aggregation, rules and detection stay fast', () => {
    const cats = ['groceries', 'rent', 'fun', 'transport', 'health', 'utilities'];
    const txs: LedgerTransaction[] = [];
    for (let i = 0; i < 50_000; i++) {
      const date = addDays('2022-01-01', i % 1460);
      const amt = `${(i % 500) + 1}.${String(i % 100).padStart(2, '0')}`;
      txs.push(
        i % 10 === 0
          ? {
              id: `p${i}`,
              kind: 'transfer',
              bookingDate: date,
              postings: [
                { accountId: 'chk', amount: M(`-${amt}`) },
                { accountId: 'sav', amount: M(amt) },
              ],
            }
          : exp(date, amt, cats[i % cats.length] as string, {
              payee: `Shop ${i % 300} Sarajevo`,
              merchantId: i % 3 ? null : `m${i % 50}`,
            }),
      );
    }
    const t0 = performance.now();
    const o = { from: '2022-01-01', to: '2025-12-31', currency: 'BAM', convert: conv };
    const r = byCategory(txs, o);
    cashflow(txs, { ...o, granularity: 'month' });
    const h = buildCategoryHistory(txs);
    for (let i = 0; i < 1000; i++) suggestCategory(h, txs[i * 7] as LedgerTransaction);
    findDuplicates(txs);
    detectRecurring(txs, '2025-12-31');
    const ms = performance.now() - t0;
    expect(r.rows).toHaveLength(6);
    expect(r.complete).toBe(true);
    expect(ms).toBeLessThan(5000);
  });
});
