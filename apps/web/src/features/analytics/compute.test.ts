import { expect, test } from 'bun:test';
import { createRateBook, reportingConverter } from '@finplat/finance-engine';
import {
  comparisonRange,
  conversionFees,
  currencyDistribution,
  type Filters,
  netWorthHistory,
  periodComparison,
  spendingByCategory,
} from './compute.ts';
import { m, seed } from './fixture.test-util.ts';

const filters = (
  s: { currency: string; convert: Filters['convert'] },
  from: string,
  to: string,
): Filters => ({
  from,
  to,
  currency: s.currency,
  convert: s.convert,
  granularity: 'month',
});

test('comparison ranges', () => {
  expect(comparisonRange('2026-03-01', '2026-03-31', 'previous')).toEqual({
    from: '2026-01-29',
    to: '2026-02-28',
  });
  expect(comparisonRange('2026-03-01', '2026-03-31', 'year_ago')).toEqual({
    from: '2025-03-01',
    to: '2025-03-31',
  });
});

test('category, comparison, net worth history and fees', async () => {
  const f = await seed();
  const eur = await f.ops.create('accounts', {
    name: 'EUR',
    accountType: 'checking',
    currency: 'EUR',
  });
  await f.ops.createTransaction({
    kind: 'fx',
    accountId: f.checking.id,
    toAccountId: eur.id,
    amount: m('195.58'),
    toAmount: m('100.00', 'EUR'),
    bookingDate: '2026-03-10',
    fee: m('2.00'),
  });
  const s = await f.snap('2026-03-31');
  const fl = filters(s, '2026-03-01', '2026-03-31');
  expect(spendingByCategory(s, fl).rows.map((r) => r.amount.amount)).toEqual(['150.00', '52.00']);
  const c = periodComparison(s, fl, 'previous');
  expect(c.total.previous.amount).toBe('0.00');
  expect(c.rows[0]?.change.amount).toBe('150.00');
  expect(conversionFees(s, fl).total.amount).toBe('2.00');
  const nw = netWorthHistory(s, filters(s, '2026-02-01', '2026-03-31'));
  expect(nw.points.map((p) => p.netWorth.amount)).toEqual(['1000.00', '2798.00']);
  // EUR/BAM is a fixed rate in the engine, so the EUR balance converts
  expect(nw.complete).toBe(true);
  const usd = reportingConverter(createRateBook([]), 'USD');
  const dist = currencyDistribution(s, { ...fl, currency: 'USD', convert: usd });
  expect(dist.missing.sort()).toEqual(['BAM', 'EUR']);
});
