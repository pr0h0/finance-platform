import { expect, test } from 'bun:test';
import { m, seed } from '../analytics/fixture.test-util.ts';
import { annualPlan, commitments, occurrenceRows, planBudget } from './occurrences.ts';

test('occurrence rows include resolved ones; commitments count pending only', async () => {
  const f = await seed();
  const rent = await f.ops.create('planned_transactions', {
    kind: 'expense',
    accountId: f.checking.id,
    description: 'Rent',
    amount: m('900.00'),
    dueDate: '2026-04-01',
    recurrence: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' },
  });
  await f.ops.create('planned_transactions', {
    kind: 'expense',
    accountId: f.checking.id,
    description: 'Insurance',
    amount: m('600.00'),
    dueDate: '2026-06-15',
    recurrence: { rrule: 'FREQ=YEARLY' },
  });
  await f.ops.setOccurrence(rent.id, '2026-05-01', { status: 'paid_manual' });
  const s = await f.snap('2026-03-31');
  const rows = occurrenceRows(s, '2026-04-01', '2026-05-31');
  expect(rows.map((r) => [r.date, r.plan.description, r.status])).toEqual([
    ['2026-04-01', 'Rent', 'pending'],
    ['2026-05-01', 'Rent', 'paid_manual'],
  ]);
  expect(commitments(s, rows).expense.amount).toBe('900.00');

  const a = annualPlan(s);
  expect(a.months).toHaveLength(12);
  expect(a.items.map((i) => i.plan.description)).toEqual(['Insurance']);
  expect(a.months[0]?.smoothed.amount).toBe('50.00');
  expect(a.months.find((x) => x.month === '2026-06')?.expense.amount).toBe('1500.00');

  // Rent and Insurance have no category: left out of the budget from plans.
  expect(planBudget(s)).toEqual({ allocations: [], skipped: 2 });
});

test('budget from plans: monthly equivalent per category, one-offs spread over 12 months', async () => {
  const f = await seed();
  const plan = (description: string, amount: string, dueDate: string, rrule?: string) =>
    f.ops.create('planned_transactions', {
      kind: 'expense',
      accountId: f.checking.id,
      categoryId: f.food.id,
      description,
      amount: m(amount),
      dueDate,
      ...(rrule ? { recurrence: { rrule } } : {}),
    });
  await plan('Groceries', '100.00', '2026-04-05', 'FREQ=MONTHLY');
  await plan('Wine club', '1200.00', '2026-09-01', 'FREQ=YEARLY');
  await plan('Party', '60.00', '2026-12-20');
  await plan('Long ago', '999.00', '2025-01-01');
  const b = planBudget(await f.snap('2026-03-31'));
  expect(b).toEqual({ allocations: [{ categoryId: f.food.id, amount: m('205.00') }], skipped: 0 });
});
