// PLAN §46 critical financial test cases 1–11 and 13 at the engine level (12 lives in
// packages/forecasting/src/forecast.test.ts).
import { describe, expect, test } from 'bun:test';
import {
  accountBalances,
  allocate,
  budgetStatus,
  byCategory,
  cashflow,
  convert,
  convertInverse,
  createRateBook,
  expandRecurrence,
  type LedgerTransaction,
  type Money,
  matchPlanned,
  money,
  type PlanLike,
  planOccurrences,
  reportingConverter,
  sameCurrencyOnly,
  splitsBalance,
} from './index.ts';

const M = (amount: string, currency = 'BAM'): Money => ({ amount, currency });
let n = 0;
function tx(
  kind: LedgerTransaction['kind'],
  date: string,
  postings: [string, string, string?][],
  splits: [string | null, string, string?][] = [],
  extra: Partial<LedgerTransaction> = {},
): LedgerTransaction {
  return {
    id: `t${++n}`,
    kind,
    bookingDate: date,
    postings: postings.map(([accountId, a, c]) => ({ accountId, amount: M(a, c) })),
    splits: splits.map(([categoryId, a, c]) => ({ categoryId, amount: M(a, c) })),
    ...extra,
  };
}
const opts = {
  from: '2026-10-01',
  to: '2026-10-31',
  currency: 'BAM',
  convert: sameCurrencyOnly('BAM'),
};
const bal = (txs: LedgerTransaction[], id: string) =>
  accountBalances(txs).find((b) => b.accountId === id)?.amount;

const opening = tx('opening_balance', '2026-10-01', [['chk', '1000.00']]);

describe('PLAN §46 critical cases', () => {
  test('1. expense creation updates the balance', () => {
    const e = tx('expense', '2026-10-02', [['chk', '-150.00']], [['food', '150.00']]);
    expect(bal([opening], 'chk')).toBe('1000.00');
    expect(bal([opening, e], 'chk')).toBe('850.00');
  });

  test('2. income creation updates the balance', () => {
    const i = tx('income', '2026-10-02', [['chk', '2000.55']], [['salary', '2000.55']]);
    expect(bal([opening, i], 'chk')).toBe('3000.55');
  });

  test('3 + 4. transfers inflate neither income nor expenses', () => {
    const base = [
      opening,
      tx('income', '2026-10-01', [['chk', '2000.00']], [['salary', '2000.00']]),
      tx('expense', '2026-10-02', [['chk', '-300.00']], [['food', '300.00']]),
    ];
    const transfer = tx('transfer', '2026-10-03', [
      ['chk', '-500.00'],
      ['sav', '500.00'],
    ]);
    const a = cashflow(base, { ...opts, granularity: 'month' }).totals;
    const b = cashflow([...base, transfer], { ...opts, granularity: 'month' }).totals;
    expect(b).toEqual(a);
    expect(b.income.amount).toBe('2000.00');
    expect(b.expense.amount).toBe('300.00');
    expect(bal([...base, transfer], 'sav')).toBe('500.00');
    expect(bal([...base, transfer], 'chk')).toBe('2200.00');
  });

  test('5. split totals remain exact', () => {
    const total = M('-150.00');
    const splits = [M('95.40'), M('32.50'), M('22.10')];
    expect(splitsBalance(total, splits)).toBe(true);
    expect(splitsBalance(total, [M('95.40'), M('32.50'), M('22.11')])).toBe(false);
    expect(splitsBalance(total, [M('172.50'), M('-22.50')])).toBe(false); // negative split rejected
    const t = tx(
      'expense',
      '2026-10-05',
      [['chk', '-150.00']],
      [
        ['groceries', '95.40'],
        ['household', '32.50'],
        ['leisure', '22.10'],
      ],
    );
    const r = byCategory([t], opts);
    expect(r.total.amount).toBe('150.00');
    expect(r.rows.map((x) => [x.key, x.amount.amount])).toEqual([
      ['groceries', '95.40'],
      ['household', '32.50'],
      ['leisure', '22.10'],
    ]);
    // even allocation keeps the sum
    expect(allocate(M('100.00'), ['1', '1', '1']).map((m) => m.amount)).toEqual([
      '33.34',
      '33.33',
      '33.33',
    ]);
  });

  test('6. refunds reduce spending in the refunded category and are not income', () => {
    const buy = tx(
      'expense',
      '2026-10-05',
      [['chk', '-80.00']],
      [
        ['clothes', '60.00'],
        ['shoes', '20.00'],
      ],
    );
    const refund = tx('refund', '2026-10-09', [['chk', '20.00']], [['shoes', '20.00']], {
      relatedTransactionId: buy.id,
    });
    const cf = cashflow([buy, refund], { ...opts, granularity: 'month' }).totals;
    expect(cf.income.amount).toBe('0.00');
    expect(cf.expense.amount).toBe('60.00');
    const rows = byCategory([buy, refund], opts).rows;
    expect(rows.find((r) => r.key === 'shoes')?.amount.amount).toBe('0.00');
    expect(bal([buy, refund], 'chk')).toBe('-60.00');
  });

  test('7. credit-card payments are not double-counted', () => {
    const purchase = tx('expense', '2026-10-05', [['card', '-250.00']], [['travel', '250.00']]);
    const payment = tx('transfer', '2026-10-25', [
      ['chk', '-250.00'],
      ['card', '250.00'],
    ]);
    const r = cashflow([opening, purchase, payment], { ...opts, granularity: 'month' }).totals;
    expect(r.expense.amount).toBe('250.00');
    expect(bal([opening, purchase, payment], 'card')).toBe('0.00');
    expect(bal([opening, purchase, payment], 'chk')).toBe('750.00');
  });

  test('8. FX calculations follow the rounding rules', () => {
    expect(convert(money('50.00', 'EUR'), 'BAM', '1.95583', 'half_up').amount).toBe('97.79');
    expect(convert(money('50.00', 'EUR'), 'BAM', '1.95583', 'up').amount).toBe('97.80');
    expect(convert(money('10.00', 'USD'), 'KWD', '0.30745', 'half_even').amount).toBe('3.074');
    expect(convert(money('10.00', 'USD'), 'KWD', '0.30745', 'half_up').amount).toBe('3.075');
    expect(convertInverse(money('100.00', 'BAM'), 'EUR', '1.95583').amount).toBe('51.13');
    // rounded once: converting the sum is not the sum of rounded parts
    const book = createRateBook([]);
    const toEur = reportingConverter(book, 'EUR');
    expect(toEur(M('0.01'), '2026-10-01')?.amount).toBe('0.01');
    expect(toEur(M('0.03'), '2026-10-01')?.amount).toBe('0.02');
  });

  test('9. historical conversion rates are preserved', () => {
    const rates = [
      {
        baseCurrency: 'USD',
        quoteCurrency: 'BAM',
        rate: '1.80',
        rateDate: '2026-01-10',
        source: 'provider' as const,
      },
    ];
    const t = tx(
      'expense',
      '2026-01-15',
      [['usd', '-100.00', 'USD']],
      [['travel', '100.00', 'USD']],
    );
    const o = { from: '2026-01-01', to: '2026-12-31', currency: 'BAM' };
    const before = byCategory([t], {
      ...o,
      convert: reportingConverter(createRateBook(rates), 'BAM'),
    });
    const later = [
      ...rates,
      { ...rates[0], rate: '1.60', rateDate: '2026-06-01' } as (typeof rates)[number],
    ];
    const after = byCategory([t], {
      ...o,
      convert: reportingConverter(createRateBook(later), 'BAM'),
    });
    expect(before.total.amount).toBe('180.00');
    expect(after.total.amount).toBe('180.00');
    // and a missing historical rate is reported, never guessed
    const early = tx(
      'expense',
      '2025-12-31',
      [['usd', '-1.00', 'USD']],
      [['travel', '1.00', 'USD']],
    );
    const r = byCategory([early], {
      from: '2025-01-01',
      to: '2026-12-31',
      currency: 'BAM',
      convert: reportingConverter(createRateBook(later), 'BAM'),
    });
    expect(r.complete).toBe(false);
    expect(r.missingRates).toEqual([{ from: 'USD', to: 'BAM', date: '2025-12-31' }]);
  });

  test('10. budgets calculate actual and planned spending separately', () => {
    const s = budgetStatus({
      budget: {
        id: 'b',
        periodType: 'monthly',
        periodAnchorDay: 1,
        startDate: '2026-10-01',
        endDate: null,
        currency: 'BAM',
        rolloverPolicy: 'none',
        includePlanned: true,
        alertThresholds: ['0.9'],
      },
      allocations: [{ categoryId: 'food', amount: M('500.00') }],
      transactions: [tx('expense', '2026-10-03', [['chk', '-320.00']], [['food', '320.00']])],
      categories: [{ id: 'food', parentId: null, name: 'Food' }],
      planned: [{ date: '2026-10-20', categoryId: 'food', amount: M('150.00') }],
      date: '2026-10-10',
      convert: sameCurrencyOnly('BAM'),
    });
    const l = s.lines[0];
    expect(l?.actual.amount).toBe('320.00');
    expect(l?.planned.amount).toBe('150.00');
    expect(l?.remaining.amount).toBe('30.00');
    expect(l?.utilization).toBe('0.9400');
    expect(l?.alert).toBe('0.9');
  });

  test('11. recurring schedules handle month boundaries', () => {
    const occ = expandRecurrence(
      { rrule: 'FREQ=MONTHLY', startDate: '2026-01-31' },
      '2026-01-01',
      '2026-12-31',
    ).map((o) => o.date);
    expect(occ).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
    ]);
  });

  test('13. planned expenses are not double-counted after matching', () => {
    const plan: PlanLike = {
      id: 'p-rent',
      kind: 'expense',
      accountId: 'chk',
      toAccountId: null,
      categoryId: 'housing',
      description: 'Rent',
      amount: M('700.00'),
      dueDate: '2026-10-01',
      recurrenceId: 'r',
      confidence: 'certain',
      status: 'active',
    };
    const sched = { id: 'r', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', startDate: '2026-10-01' };
    const occ = planOccurrences([plan], [sched], [], '2026-10-01', '2026-10-31');
    expect(occ.map((o) => o.date)).toEqual(['2026-10-01']);
    const paid = tx('expense', '2026-10-02', [['chk', '-700.00']], [['housing', '700.00']], {
      payee: 'Rent',
    });
    const other = tx('expense', '2026-10-02', [['chk', '-700.00']], [['travel', '700.00']], {
      payee: 'Airline',
    });
    const m = matchPlanned(occ, [plan], [other, paid]);
    expect(m).toHaveLength(1);
    expect(m[0]?.transactionId).toBe(paid.id);
    expect(m[0]?.reasons).toContain('same merchant');
    // once stored as matched the occurrence disappears from planned spending and forecasts
    const after = planOccurrences(
      [plan],
      [sched],
      [
        {
          plannedTransactionId: 'p-rent',
          occurrenceDate: '2026-10-01',
          status: 'matched',
          matchedTransactionId: paid.id,
        },
      ],
      '2026-10-01',
      '2026-10-31',
    );
    expect(after).toEqual([]);
  });
});
