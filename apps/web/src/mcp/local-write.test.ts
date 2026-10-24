import { expect, test } from 'bun:test';
import type * as D from '@finplat/domain';
import type { EntityName, OutboxOp } from '@finplat/storage';
import { m, seed } from '../features/analytics/fixture.test-util.ts';
import type { ToolContext, ToolError } from './local-tools.ts';
import { type Approve, type ChangeRequest, callWriteTool, type WriteName } from './local-write.ts';

// seed(): BAM checking, Salary 2000 income, Market 150 (Food), uncategorized Bakery 50.
async function setup() {
  const f = await seed();
  const ctx: ToolContext = { ds: f.ds, profile: f.profile, today: '2026-03-31' };
  const txs = (await f.ops.searchTransactions({})).items;
  const tx = (d: string) => txs.find((t) => t.description === d) as D.Transaction;
  const asked: ChangeRequest[] = [];
  const yes: Approve = async (r) => {
    asked.push(r);
    return 'approved';
  };
  const call = (name: WriteName, args: unknown, approve = yes) =>
    callWriteTool(ctx, name, args, approve) as Promise<{
      status: string;
      result: unknown;
      preview: { summary: Record<string, unknown> };
    }>;
  const fail = (name: WriteName, args: unknown, approve = yes) =>
    call(name, args, approve).then(
      () => {
        throw new Error('expected an error');
      },
      (e: ToolError) => e,
    );
  return { ...f, ctx, tx, asked, call, fail, bakery: tx('Bakery'), market: tx('Market') };
}

test('transaction write tools: approve → applied through FinanceOps', async () => {
  const f = await setup();
  const r = await f.call('update_transaction_category', {
    transactionId: f.bakery.id,
    categoryId: f.food.id,
  });
  expect(r.status).toBe('applied');
  expect(f.asked[0]?.rows.find((x) => x.field === 'category')).toEqual({
    field: 'category',
    before: null,
    after: 'Food',
  });
  expect((await f.ops.getTransaction(f.bakery.id)).splits[0]?.categoryId).toBe(f.food.id);

  const other = await f.ops.create('categories', { name: 'Other' });
  await f.call('split_transaction', {
    transactionId: f.market.id,
    splits: [
      { categoryId: f.food.id, amount: m('100.00') },
      { categoryId: other.id, amount: m('50.00'), description: 'soap' },
    ],
  });
  const split = await f.ops.getTransaction(f.market.id);
  expect(split.splits.map((s) => s.amount.amount)).toEqual(['100.00', '50.00']);

  const bulk = await f.call('bulk_categorize_transactions', {
    transactionIds: [f.bakery.id],
    categoryId: other.id,
  });
  expect(bulk.result).toEqual({ updated: [f.bakery.id] });

  const tag = await f.ops.create('tags', { name: 'Weekly' });
  await f.call('update_transaction_metadata', {
    transactionId: f.bakery.id,
    description: '  Bread ',
    tagIds: [tag.id],
  });
  const meta = await f.ops.getTransaction(f.bakery.id);
  expect(meta.description).toBe('Bread');
  expect(meta.tagIds).toEqual([tag.id]);
  // the edit is queued for sync like any edit
  const outbox = await f.ds.store.run('readonly', ['outbox'], (tx) =>
    tx.query<OutboxOp>('outbox', {}),
  );
  expect(outbox.filter((o) => o.entityId === f.bakery.id).length).toBeGreaterThan(3);
});

test('planning, budget, goal and rule write tools', async () => {
  const f = await setup();
  const plan = (await f.call('create_planned_expense', {
    description: 'Insurance',
    amount: m('120.00'),
    dueDate: '2026-05-01',
    rrule: 'FREQ=YEARLY',
    categoryId: f.food.id,
  })) as { result: D.PlannedTransaction };
  expect(plan.result.recurrenceId).not.toBeNull();
  await f.call('update_planned_expense', {
    plannedTransactionId: plan.result.id,
    amount: m('130.00'),
    status: 'paused',
  });
  const p = await f.ops.get('planned_transactions', plan.result.id);
  expect([p.amount.amount, p.status, p.description]).toEqual(['130.00', 'paused', 'Insurance']);

  const b = (await f.call('create_budget', {
    name: 'Food budget',
    periodType: 'monthly',
    startDate: '2026-01-01',
    currency: 'bam',
    allocations: [{ categoryId: f.food.id, amount: m('300.00') }],
  })) as { result: D.Budget };
  expect(b.result.currency).toBe('BAM');
  await f.call('update_budget', {
    budgetId: b.result.id,
    allocations: [{ categoryId: f.food.id, amount: m('250.00') }],
  });
  const allocs = (
    (await f.ops.list('budget_allocations' as EntityName)) as unknown as D.BudgetAllocation[]
  ).filter((a) => a.budgetId === b.result.id);
  expect(allocs.map((a) => a.amount.amount)).toEqual(['250.00']);
  expect((await f.ops.get('budgets', b.result.id)).name).toBe('Food budget');

  await f.call('create_savings_goal', { name: 'Trip', targetAmount: m('2000.00') });
  expect((await f.ops.list('savings_goals')).map((g) => g.name)).toEqual(['Trip']);

  await f.call('create_categorization_rule', {
    name: 'Bakery is food',
    match: { field: 'description', op: 'contains', value: 'bakery' },
    categoryId: f.food.id,
  });
  const [rule] = await f.ops.list('categorization_rules');
  expect(rule?.actions).toEqual([{ type: 'set_category', categoryId: f.food.id }]);
  expect(f.asked).toHaveLength(6);
});

test('server checks run before asking the user', async () => {
  const f = await setup();
  const unknown = '00000000-0000-4000-8000-000000000000';
  const cases: [WriteName, unknown, string][] = [
    [
      'update_transaction_category',
      { transactionId: f.bakery.id, categoryId: unknown },
      'validation_failed',
    ],
    ['update_transaction_category', { transactionId: unknown, categoryId: null }, 'not_found'],
    [
      'update_transaction_category',
      { transactionId: f.bakery.id, categoryId: null, x: 1 },
      'validation_failed',
    ],
    [
      'split_transaction',
      { transactionId: f.market.id, splits: [{ categoryId: null, amount: m('149.99') }] },
      'validation_failed',
    ],
    [
      'split_transaction',
      { transactionId: f.market.id, splits: [{ categoryId: null, amount: m('150.00', 'EUR') }] },
      'validation_failed',
    ],
    [
      'bulk_categorize_transactions',
      { transactionIds: [f.bakery.id, f.bakery.id], categoryId: f.food.id },
      'validation_failed',
    ],
    ['update_transaction_metadata', { transactionId: f.bakery.id }, 'validation_failed'],
    [
      'create_planned_expense',
      { description: 'X', amount: m('1.00'), dueDate: '2026-05-01', rrule: 'FREQ=HOURLY' },
      'validation_failed',
    ],
    [
      'create_budget',
      {
        name: 'B',
        periodType: 'monthly',
        startDate: '2026-01-01',
        currency: 'BAM',
        allocations: [{ categoryId: f.food.id, amount: m('1.00', 'EUR') }],
      },
      'validation_failed',
    ],
    [
      'create_budget',
      {
        name: 'B',
        periodType: 'monthly',
        startDate: '2026-01-01',
        currency: 'BAM',
        allocations: [
          { categoryId: f.food.id, amount: m('1.00') },
          { categoryId: f.food.id, amount: m('2.00') },
        ],
      },
      'validation_failed',
    ],
    ['create_savings_goal', { name: 'G', targetAmount: m('0.00') }, 'validation_failed'],
  ];
  for (const [name, args, code] of cases)
    expect([name, (await f.fail(name, args)).code]).toEqual([name, code]);

  // several splits: categorize refuses (use split_transaction)
  await f.call('split_transaction', {
    transactionId: f.market.id,
    splits: [
      { categoryId: f.food.id, amount: m('100.00') },
      { categoryId: null, amount: m('50.00') },
    ],
  });
  expect(
    (await f.fail('update_transaction_category', { transactionId: f.market.id, categoryId: null }))
      .code,
  ).toBe('splits_mismatch');
  expect(f.asked).toHaveLength(1); // only the valid split was shown to the user
});

test('rejected, timed out and stale changes leave the data unchanged', async () => {
  const f = await setup();
  const args = { transactionId: f.bakery.id, categoryId: f.food.id };
  const no: Approve = async () => 'rejected';
  const late: Approve = async () => 'timeout';
  expect((await f.fail('update_transaction_category', args, no)).code).toBe('rejected');
  expect((await f.fail('update_transaction_category', args, late)).code).toBe('approval_timeout');
  // edited in the app while the dialog was open → version conflict, like a stale server proposal
  const meanwhile: Approve = async () => {
    await f.ops.updateTransaction(f.bakery.id, { version: f.bakery.version, notes: 'mine' });
    return 'approved';
  };
  expect((await f.fail('update_transaction_category', args, meanwhile)).code).toBe('conflict');
  expect((await f.ops.getTransaction(f.bakery.id)).splits[0]?.categoryId).toBeNull();
});

test('idempotencyKey: a retry returns the applied change without asking again', async () => {
  const f = await setup();
  const args = { name: 'Trip', targetAmount: m('100.00'), idempotencyKey: 'k1' };
  const a = await f.call('create_savings_goal', args);
  const b = await f.call('create_savings_goal', args);
  expect(b).toEqual(a);
  expect(f.asked).toHaveLength(1);
  expect((await f.fail('create_savings_goal', { ...args, name: 'Other' })).code).toBe(
    'idempotency_key_reused',
  );
});
