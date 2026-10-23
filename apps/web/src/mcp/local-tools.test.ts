import { expect, test } from 'bun:test';
import { READ_TOOLS, TOOLS } from '@finplat/mcp-contracts';
import { m, seed } from '../features/analytics/fixture.test-util.ts';
import { callReadTool, FileResult, type ToolContext, type ToolError } from './local-tools.ts';

// seed(): BAM checking (opening 1000), Salary 2000 income (03-01), Food 150 (03-05),
// uncategorized Bakery 50 (03-20). Today = 2026-03-31.
async function setup() {
  const f = await seed();
  const usd = await f.ops.create('accounts', {
    name: 'Dollars',
    accountType: 'savings',
    currency: 'USD',
    openingBalance: m('100.00', 'USD'),
    openingDate: '2026-01-01',
  });
  await f.ops.addExchangeRate({
    baseCurrency: 'USD',
    quoteCurrency: 'BAM',
    rate: '1.8',
    rateDate: '2026-01-01',
  });
  await f.ops.createTransaction({
    kind: 'expense',
    accountId: usd.id,
    amount: m('10.00', 'USD'),
    bookingDate: '2026-03-10',
    description: 'Books',
    categoryId: f.food.id,
  });
  const budget = await f.ops.create('budgets', {
    name: 'Monthly',
    periodType: 'monthly',
    startDate: '2026-01-01',
    currency: 'BAM',
    allocations: [{ categoryId: f.food.id, amount: m('300.00') }],
  });
  await f.ops.create('planned_transactions', {
    kind: 'expense',
    accountId: f.checking.id,
    description: 'Rent',
    amount: m('900.00'),
    dueDate: '2026-04-01',
    recurrence: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' },
  });
  const goal = await f.ops.create('savings_goals', { name: 'Car', targetAmount: m('5000.00') });
  await f.ops.create('savings_contributions', {
    goalId: goal.id,
    amount: m('500.00'),
    contributionDate: '2026-03-02',
  });
  const tx = (await f.ops.searchTransactions({})).items[0];
  const att = await f.ops.addAttachment({
    file: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    fileName: 'r.png',
    contentType: 'image/png',
    transactionId: tx?.id ?? null,
  });
  const ctx: ToolContext = { ds: f.ds, profile: f.profile, today: '2026-03-31' };
  return { ...f, usd, budget, goal, att, tx, ctx };
}

test('every read tool returns output matching its contract', async () => {
  const f = await setup();
  const args: Record<string, unknown> = {
    get_account_balance: { accountId: f.usd.id },
    get_transaction: { transactionId: f.tx?.id },
    get_attachments: { attachmentId: f.att.id, includeContent: true },
    compare_periods: {
      a: { dateFrom: '2026-02-01', dateTo: '2026-02-28' },
      b: { dateFrom: '2026-03-01', dateTo: '2026-03-31' },
    },
    simulate_expense: { amount: m('3000.00'), date: '2026-04-10' },
  };
  const names = READ_TOOLS.filter((n) => n !== 'preview_changes');
  expect(names).toHaveLength(19);
  for (const name of names) {
    let r = await callReadTool(f.ctx, name, args[name] ?? {});
    if (r instanceof FileResult) {
      expect(r.mime).toBe('image/png');
      expect(r.data).toBe('iVBORw==');
      r = r.result;
    }
    const p = TOOLS[name].output.safeParse(r);
    if (!p.success) throw new Error(`${name}: ${p.error.message}`);
  }
});

test('values: spending, income, overview, budgets, exposure, forecast', async () => {
  const f = await setup();
  const call = (n: string, a: unknown = {}) =>
    callReadTool(f.ctx, n, a) as Promise<Record<string, unknown>>;

  const cat = await call('get_spending_by_category');
  // 150 + 10 USD * 1.8 = 168 food, 50 uncategorized
  expect(cat.total).toEqual(m('218.00'));
  expect(cat.rows).toEqual([
    { key: f.food.id, label: 'Food', amount: m('168.00'), count: 2 },
    { key: 'uncategorized', label: 'Uncategorized', amount: m('50.00'), count: 1 },
  ]);
  const inc = await call('get_income_summary');
  expect(inc.rows).toHaveLength(12);
  expect(inc.total).toEqual(m('2000.00'));

  const ov = await call('get_financial_overview');
  expect(ov.netWorth).toEqual(m('2962.00')); // 2800 BAM + 90 USD * 1.8
  expect(ov.monthExpenses).toEqual(m('218.00'));
  expect(ov.upcoming).toEqual([{ date: '2026-04-01', description: 'Rent', amount: m('-900.00') }]);

  const bs = await call('get_budget_status');
  expect((bs.budgets as unknown[])[0]).toMatchObject({
    actual: m('168.00'),
    remaining: m('132.00'),
  });

  const ex = await call('get_currency_exposure');
  expect(ex.rows).toEqual([
    { currency: 'BAM', amount: m('2800.00'), converted: m('2800.00'), rate: '1' },
    { currency: 'USD', amount: m('90.00', 'USD'), converted: m('162.00'), rate: '1.8' },
  ]);

  const rec = await call('list_recurring_expenses');
  expect(rec.annualTotal).toEqual(m('10800.00'));
  const fc = await call('get_cash_flow_forecast', { days: 10 });
  expect(fc.days).toHaveLength(11);
  const sim = await call('simulate_expense', { amount: m('3000.00'), date: '2026-04-10' });
  expect(sim.firstShortfallDate).toBe('2026-04-10');
  const goals = await call('get_savings_goals');
  expect((goals.goals as unknown[])[0]).toMatchObject({ saved: m('500.00'), progress: '0.1000' });
});

test('paging, uncategorized, validation and unknown tools', async () => {
  const f = await setup();
  const p1 = (await callReadTool(f.ctx, 'list_transactions', { limit: 2 })) as {
    transactions: { id: string }[];
    meta: { nextCursor?: string; complete: boolean };
  };
  expect(p1.transactions).toHaveLength(2);
  expect(p1.meta.complete).toBe(false);
  const p2 = (await callReadTool(f.ctx, 'list_transactions', {
    limit: 100,
    cursor: p1.meta.nextCursor,
  })) as typeof p1;
  // 4 seeded/added transactions + 2 opening balances
  expect(p2.transactions).toHaveLength(4);
  expect(p2.meta.nextCursor).toBeUndefined();
  expect(new Set([...p1.transactions, ...p2.transactions].map((t) => t.id)).size).toBe(6);

  const unc = (await callReadTool(f.ctx, 'get_uncategorized_transactions', {})) as {
    transactions: { description: string; uncategorizedAmount: unknown }[];
  };
  expect(unc.transactions.map((t) => t.description)).toEqual(['Bakery']);
  expect(unc.transactions[0]?.uncategorizedAmount).toEqual(m('50.00'));

  const err = (n: string, a: unknown) => callReadTool(f.ctx, n, a).catch((e: ToolError) => e);
  expect(((await err('list_transactions', { limit: 0 })) as ToolError).code).toBe(
    'validation_failed',
  );
  expect(((await err('list_accounts', { bogus: 1 })) as ToolError).code).toBe('validation_failed');
  expect(((await err('nope', {})) as ToolError).code).toBe('unknown_tool');
  expect(((await err('create_budget', {})) as ToolError).code).toBe('unknown_tool');
  expect(((await err('preview_changes', {})) as ToolError).code).toBe('unknown_tool');
  expect(
    (
      (await err('list_accounts', {
        profileId: '00000000-0000-4000-8000-000000000000',
      })) as ToolError
    ).code,
  ).toBe('not_found');
});
