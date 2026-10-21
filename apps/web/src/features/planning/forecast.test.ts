import { expect, test } from 'bun:test';
import { m, seed } from '../analytics/fixture.test-util.ts';
import { buildForecast, simulate } from './forecast.ts';

test('forecast uses balances and recurring plans; what-if never writes', async () => {
  const f = await seed();
  await f.ops.create('planned_transactions', {
    kind: 'expense',
    accountId: f.checking.id,
    description: 'Rent',
    amount: m('900.00'),
    dueDate: '2026-04-01',
    confidence: 'certain',
    priority: 'essential',
    recurrence: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' },
  });
  const s = await f.snap('2026-03-31');
  const fc = buildForecast(s, '2026-05-31');
  expect(fc.days[0]?.expected.amount).toBe('2800.00');
  expect(fc.days.find((d) => d.date === '2026-04-01')?.expected.amount).toBe('1900.00');
  expect(fc.days.at(-1)?.expected.amount).toBe('1000.00');
  expect(fc.lowest.amount.amount).toBe('1000.00');

  const before = await f.ops.ledger();
  const w = simulate(s, '2026-05-31', [
    { description: 'Laptop', amount: m('-1500.00'), date: '2026-04-10', accountId: f.checking.id },
  ]);
  expect(w.scenario.lowest.amount.amount).toBe('-500.00');
  expect(w.scenario.shortfalls.length).toBe(1);
  expect(w.delta.end.amount).toBe('-1500.00');
  expect(await f.ops.ledger()).toEqual(before);
  expect((await f.ops.list('planned_transactions')).length).toBe(1);
});

test('skipped occurrence is excluded from the forecast', async () => {
  const f = await seed();
  const plan = await f.ops.create('planned_transactions', {
    kind: 'expense',
    accountId: f.checking.id,
    description: 'Gym',
    amount: m('40.00'),
    dueDate: '2026-04-05',
    confidence: 'certain',
    recurrence: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=5' },
  });
  await f.ops.setOccurrence(plan.id, '2026-04-05', { status: 'skipped' });
  const fc = buildForecast(await f.snap('2026-03-31'), '2026-05-31');
  expect(fc.days.at(-1)?.expected.amount).toBe('2760.00');
});
