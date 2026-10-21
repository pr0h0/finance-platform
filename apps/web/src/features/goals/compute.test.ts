import { expect, test } from 'bun:test';
import { m, seed } from '../analytics/fixture.test-util.ts';
import { emergencyFund, goalRows } from './compute.ts';

test('goal progress, history estimate and emergency fund months', async () => {
  const f = await seed();
  const g = await f.ops.create('savings_goals', {
    name: 'Emergency',
    kind: 'emergency_fund',
    targetAmount: m('3000.00'),
    emergencyMonths: 6,
  });
  await f.ops.create('savings_contributions', {
    goalId: g.id,
    amount: m('300.00'),
    contributionDate: '2026-02-10',
  });
  await f.ops.create('savings_contributions', {
    goalId: g.id,
    amount: m('300.00'),
    contributionDate: '2026-03-10',
  });
  await f.ops.create('planned_transactions', {
    kind: 'expense',
    accountId: f.checking.id,
    description: 'Rent',
    amount: m('400.00'),
    dueDate: '2026-04-01',
    priority: 'essential',
    recurrence: { rrule: 'FREQ=MONTHLY' },
  });
  const s = await f.snap('2026-03-31');
  const [row] = goalRows(s);
  expect(row?.projection.saved.amount).toBe('600.00');
  expect(row?.projection.progress).toBe('0.2000');
  expect(row?.projection.basis).toBe('history');
  const e = emergencyFund(s);
  expect(e.basis).toBe('essential_plans');
  expect(e.monthly.amount).toBe('400.00');
  expect(e.months).toBe('1.5');
  expect(e.target).toBe(6);
});
