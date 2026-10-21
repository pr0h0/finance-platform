import { expect, test } from 'bun:test';
import { niceTicks, topSlices, toSeries } from './index.ts';

const M = (amount: string) => ({ amount, currency: 'BAM' });

test('top slices keep an exact Other bucket', () => {
  const s = topSlices(
    [
      { key: 'a', label: 'A', amount: M('0.10') },
      { key: 'b', label: 'B', amount: M('0.20') },
      { key: 'c', label: 'C', amount: M('500.00') },
      { key: 'd', label: 'D', amount: M('-3.00') },
    ],
    1,
  );
  expect(s.map((x) => [x.key, x.money.amount])).toEqual([
    ['c', '500.00'],
    ['__other__', '0.30'],
  ]);
});

test('series and ticks', () => {
  const r = toSeries([{ period: '2026-10', income: M('10.50'), expense: M('3.25') }], 'period', [
    'income',
    'expense',
  ]);
  expect(r[0]).toEqual({
    x: '2026-10',
    values: { income: 10.5, expense: 3.25 },
    money: { income: M('10.50'), expense: M('3.25') },
  });
  expect(niceTicks(0, 95, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  expect(niceTicks(-1234, 0, 4)).toEqual([-1500, -1000, -500, 0]);
});
