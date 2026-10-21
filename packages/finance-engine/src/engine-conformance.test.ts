// Runner for the shared engine fixtures (Go runner: apps/api/internal/conformance_test).
import { describe, expect, test } from 'bun:test';
import { loadConformance } from '@finplat/test-fixtures';
import {
  type AllocationLike,
  accountBalances,
  annualize,
  type BudgetLike,
  budgetPeriods,
  budgetStatus,
  byCategory,
  byMerchant,
  type CategoryLike,
  cashflow,
  convertResolved,
  createRateBook,
  expandRecurrence,
  type Granularity,
  type LedgerTransaction,
  type Money,
  netWorth,
  type PlannedSpend,
  type RateSnapshot,
  reportingConverter,
  savingsRate,
} from './index.ts';

interface RecurrenceFixture {
  cases: {
    name: string;
    input: {
      rrule: string;
      startDate: string;
      endDate?: string;
      occurrenceCount?: number;
      businessDayAdjustment?: 'none' | 'previous' | 'next';
      from: string;
      to: string;
    };
    expected?: { date: string; dueDate: string }[];
    error?: string;
  }[];
}

describe('conformance: recurrence', () => {
  for (const c of loadConformance<RecurrenceFixture>('recurrence').cases) {
    test(c.name, () => {
      const run = () => expandRecurrence(c.input, c.input.from, c.input.to);
      if (c.error) expect(run).toThrow();
      else expect(run()).toEqual(c.expected ?? []);
    });
  }
});

describe('conformance: subscriptions (annualization)', () => {
  const cases =
    loadConformance<
      { rrule: string; amount: Money; perYear: [number, number]; annual: string; monthly: string }[]
    >('subscriptions');
  for (const c of cases) {
    test(`${c.rrule} ${c.amount.amount} ${c.amount.currency}`, () => {
      const a = annualize(c.amount, c.rrule);
      expect([a.perYear.num, a.perYear.den]).toEqual(c.perYear);
      expect(a.annual.amount).toBe(c.annual);
      expect(a.monthly.amount).toBe(c.monthly);
    });
  }
});

describe('conformance: fx_lookup', () => {
  const fx = loadConformance<{
    rates: RateSnapshot[];
    cases: {
      name: string;
      from: string;
      to: string;
      date: string;
      amount: Money;
      expected: {
        amount: Money;
        rate: string;
        rateDate: string;
        source: string;
        inverse: boolean;
      } | null;
    }[];
  }>('fx_lookup');
  const book = createRateBook(fx.rates);
  for (const c of fx.cases) {
    test(c.name, () => {
      const r = book.resolve(c.from, c.to, c.date);
      if (c.expected === null) {
        expect(r).toBeNull();
        return;
      }
      expect(r).not.toBeNull();
      if (!r) return;
      expect({
        amount: convertResolved(c.amount, r),
        rate: r.rate,
        rateDate: r.rateDate,
        source: r.source,
        inverse: r.inverse,
      }).toEqual(c.expected as never);
    });
  }
});

describe('conformance: aggregation', () => {
  const fx = loadConformance<{
    categories: CategoryLike[];
    accounts: { id: string; accountType: string }[];
    merchants: { id: string; name: string }[];
    rates: RateSnapshot[];
    transactions: LedgerTransaction[];
    cases: { name: string; op: string; params: Record<string, unknown>; expected: unknown }[];
  }>('aggregation');
  const book = createRateBook(fx.rates);
  for (const c of fx.cases) {
    test(c.name, () => {
      const p = c.params as {
        from: string;
        to: string;
        currency: string;
        kind?: 'spending' | 'income';
        rollup?: 'none' | 'parent';
        accountIds?: string[];
        granularity?: Granularity;
        extraTransactions?: LedgerTransaction[];
        asOf?: string;
        income?: Money;
        expense?: Money;
      };
      const txs = [...fx.transactions, ...(p.extraTransactions ?? [])];
      const base = {
        from: p.from,
        to: p.to,
        currency: p.currency,
        convert: reportingConverter(book, p.currency ?? 'BAM'),
        ...(p.accountIds ? { accountIds: p.accountIds } : {}),
      };
      const strip = ({
        warnings: _w,
        currency: _c,
        from: _f,
        to: _t,
        ...r
      }: Record<string, unknown>) => r;
      switch (c.op) {
        case 'byCategory':
          return expect(
            strip({
              ...byCategory(txs, {
                ...base,
                categories: fx.categories,
                kind: p.kind,
                rollup: p.rollup,
              }),
            }),
          ).toEqual(c.expected as never);
        case 'byMerchant':
          return expect(
            strip({ ...byMerchant(txs, { ...base, merchants: fx.merchants }) }),
          ).toEqual(c.expected as never);
        case 'cashflow':
          return expect(
            strip({ ...cashflow(txs, { ...base, granularity: p.granularity ?? 'month' }) }),
          ).toEqual(c.expected as never);
        case 'balances':
          return expect(accountBalances(txs, p.asOf)).toEqual(c.expected as never);
        case 'netWorth':
          return expect(
            netWorth(
              txs,
              fx.accounts,
              p.asOf ?? '',
              p.currency,
              reportingConverter(book, p.currency),
            ),
          ).toEqual(c.expected as never);
        case 'savingsRate':
          return expect(savingsRate(p.income as Money, p.expense as Money)).toEqual(
            c.expected as never,
          );
        default:
          throw new Error(`unknown op ${c.op}`);
      }
    });
  }
});

describe('conformance: budgets', () => {
  const fx = loadConformance<{
    categories: CategoryLike[];
    transactions: LedgerTransaction[];
    planned: PlannedSpend[];
    rates: RateSnapshot[];
    cases: {
      name: string;
      op: 'periods' | 'status';
      budget: BudgetLike;
      allocations?: AllocationLike[];
      until?: string;
      date?: string;
      expected: unknown;
    }[];
  }>('budgets');
  const book = createRateBook(fx.rates);
  for (const c of fx.cases) {
    test(c.name, () => {
      if (c.op === 'periods') {
        expect(budgetPeriods(c.budget, c.until ?? '')).toEqual(c.expected as never);
        return;
      }
      const { complete, warnings, ...s } = budgetStatus({
        budget: c.budget,
        allocations: c.allocations ?? [],
        transactions: fx.transactions,
        categories: fx.categories,
        planned: fx.planned,
        date: c.date ?? '',
        convert: reportingConverter(book, c.budget.currency),
      });
      expect(complete).toBe(true);
      expect(warnings).toEqual([]);
      expect(s).toEqual(c.expected as never);
    });
  }
});
