import { expect, test } from 'bun:test';
import { m, seed } from '../analytics/fixture.test-util.ts';
import { annualPlan, commitments, occurrenceRows } from './occurrences.ts';

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
});
