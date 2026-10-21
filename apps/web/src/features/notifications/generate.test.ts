import { expect, test } from 'bun:test';
import { m, seed } from '../analytics/fixture.test-util.ts';
import { generate } from './generate.ts';

test('generates bill reminders and budget alerts once', async () => {
  const f = await seed();
  await f.ops.create('planned_transactions', {
    kind: 'expense',
    accountId: f.checking.id,
    description: 'Internet',
    amount: m('40.00'),
    dueDate: '2026-04-02',
    reminderDaysBefore: 5,
  });
  await f.ops.create('budgets', {
    name: 'Food',
    periodType: 'monthly',
    startDate: '2026-03-01',
    currency: 'BAM',
    allocations: [{ categoryId: f.food.id, amount: m('160.00') }],
  });
  const s = await f.snap('2026-03-31');
  const first = await generate(f.ops, s);
  expect(first.map((n) => n.kind).sort()).toEqual(['bill_reminder', 'budget_threshold']);
  const budget = first.find((n) => n.kind === 'budget_threshold');
  expect(budget?.title).toBe('Food: Food at 80%');
  expect(await generate(f.ops, s)).toEqual([]);
  expect((await f.ops.listNotifications()).length).toBe(2);
});
