// The 10 MCP write tools on the desktop app's LOCAL data (local MCP server, opt-in in Settings).
// Same contracts and checks as the Go server (apps/api/internal/mcp/write.go prep* functions), but
// instead of server proposals every call waits for the user to approve it in the app; approved
// changes go through FinanceOps like any edit (outbox/sync, version checks against stale edits).
import type * as D from '@finplat/domain';
import { currencyScale, fromMinor, type Money, parseRRule, toMinor } from '@finplat/finance-engine';
import { TOOLS, type ToolName } from '@finplat/mcp-contracts';
import type { EntityName, FinanceOps } from '@finplat/storage';
import type { z } from '@finplat/validation';
import {
  type Env,
  env,
  invalid,
  owner,
  parseArgs,
  type ToolContext,
  ToolError,
  toToolError,
} from './local-tools.ts';

export const LOCAL_WRITE_TOOLS = [
  'update_transaction_category',
  'split_transaction',
  'bulk_categorize_transactions',
  'update_transaction_metadata',
  'create_planned_expense',
  'update_planned_expense',
  'create_budget',
  'update_budget',
  'create_savings_goal',
  'create_categorization_rule',
] as const satisfies readonly ToolName[];
export type WriteName = (typeof LOCAL_WRITE_TOOLS)[number];
type In<N extends WriteName> = z.output<(typeof TOOLS)[N]['input']>;

/** A value shown in the approval dialog (names resolved; money formatted by the UI). */
export type Val = string | Money | null | { label: string | null; amount: Money }[];
export interface Row {
  field: string; // localMcp.field.<field>
  before?: Val; // absent: nothing to compare (created entity, context row)
  after: Val;
}
export interface ChangeRequest {
  tool: WriteName;
  profile: string;
  rows: Row[];
  preview: { summary: Record<string, unknown>; targets: Target[] };
}
export type Verdict = 'approved' | 'rejected' | 'timeout';
/** Asks the user; resolves 'timeout' when nobody answered in time. */
export type Approve = (r: ChangeRequest) => Promise<Verdict>;

interface Target {
  table: string;
  id: string;
  version: number;
}
interface Prepared {
  e: Env;
  rows: Row[];
  summary: Record<string, unknown>;
  targets: Target[];
  apply: () => Promise<unknown>;
}

const SPLIT_KINDS = new Set(['expense', 'income', 'refund']); // ledger.SplitKinds
const PLAN_NOTE = 'Created by an AI agent (MCP)'; // stored like the server's
const tgt = (table: string, x: { id: string; version: number }): Target => ({
  table,
  id: x.id,
  version: x.version,
});

function writable(e: Env) {
  if (e.profile.role !== 'owner' && e.profile.role !== 'editor')
    throw new ToolError('read_only_profile', 'you have read-only access to this profile');
}

/** Name of an entity the change refers to; unknown ids are validation errors (Go CheckOwned). */
async function nameOf(
  ops: FinanceOps,
  entity: 'categories' | 'merchants' | 'tags' | 'accounts',
  id: string | null | undefined,
  field: string,
): Promise<string | null> {
  if (!id) return null;
  const row = await ops.get(entity, id).catch(() => null);
  if (!row) throw invalid(field, 'unknown id');
  return row.name;
}

async function categoryNames(ops: FinanceOps) {
  return new Map((await ops.list('categories')).map((c) => [c.id, c.name]));
}

const txAmount = (t: D.Transaction) => (t.postings[0] as D.Posting).amount;
const absAmount = (t: D.Transaction) => {
  const a = txAmount(t);
  const v = toMinor(a);
  return fromMinor(v < 0n ? -v : v, a.currency);
};
const txLabel = (t: D.Transaction) =>
  [t.bookingDate, t.description || t.payee].filter(Boolean).join(' · ');
const splitsOf = (t: D.Transaction) =>
  t.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount }));
const splitsVal = (
  sp: { categoryId: string | null; amount: Money }[],
  names: Map<string, string>,
) =>
  sp.map((s) => ({ label: (s.categoryId && names.get(s.categoryId)) || null, amount: s.amount }));

/** A categorizable transaction (Go loadTx). */
async function loadTx(ctx: ToolContext, id: string, categorized = true) {
  let t: D.Transaction | undefined;
  const e = await owner(ctx, 'transaction', async (ops) => {
    t = await ops.getTransaction(id);
    return t;
  });
  const tx = t as D.Transaction;
  if (categorized && !SPLIT_KINDS.has(tx.kind))
    throw invalid('transactionId', `${tx.kind} transactions are not categorized`);
  return { e, t: tx };
}

const severalSplits = (what = 'transaction') =>
  new ToolError('splits_mismatch', `${what} has several splits; use split_transaction`);

type Alloc = { categoryId: string | null; amount: Money };
/** Go budgets.validate for allocations: non-negative, budget currency, no duplicate, known category. */
async function checkAllocations(ops: FinanceOps, allocs: Alloc[], currency: string) {
  const seen = new Set<string>();
  const names = await categoryNames(ops);
  allocs.forEach((a, i) => {
    const f = `allocations[${i}]`;
    if (toMinor(a.amount) < 0n) throw invalid(`${f}.amount`, 'must not be negative');
    if (a.amount.currency !== currency)
      throw invalid(`${f}.amount`, 'must use the budget currency');
    const k = a.categoryId ?? '-';
    if (seen.has(k)) throw invalid(`${f}.categoryId`, 'duplicate category');
    seen.add(k);
    if (a.categoryId && !names.has(a.categoryId)) throw invalid(`${f}.categoryId`, 'unknown id');
  });
  return names;
}

async function budgetAllocations(ops: FinanceOps, budgetId: string): Promise<Alloc[]> {
  // ponytail: budget_allocations is a profile table outside the typed EntityName list.
  const rows = (await ops.list(
    'budget_allocations' as EntityName,
  )) as unknown as D.BudgetAllocation[];
  return rows
    .filter((a) => a.budgetId === budgetId && !a.budgetPeriodId)
    .map((a) => ({ categoryId: a.categoryId, amount: a.amount }));
}

const prep: { [N in WriteName]: (ctx: ToolContext, a: In<N>) => Promise<Prepared> } = {
  async update_transaction_category(ctx, a) {
    const { e, t } = await loadTx(ctx, a.transactionId);
    if (t.splits.length > 1) throw severalSplits();
    const names = await categoryNames(e.ops);
    const after = await nameOf(e.ops, 'categories', a.categoryId, 'categoryId');
    return {
      e,
      rows: [
        { field: 'transaction', after: txLabel(t) },
        { field: 'amount', after: txAmount(t) },
        {
          field: 'category',
          before: (t.splits[0]?.categoryId && names.get(t.splits[0].categoryId)) || null,
          after,
        },
      ],
      summary: {
        transactionId: t.id,
        description: t.description,
        bookingDate: t.bookingDate,
        amount: txAmount(t),
        before: splitsOf(t),
        categoryId: a.categoryId,
      },
      targets: [tgt('transactions', t)],
      apply: () => e.ops.updateTransaction(t.id, { version: t.version, categoryId: a.categoryId }),
    };
  },

  async split_transaction(ctx, a) {
    const { e, t } = await loadTx(ctx, a.transactionId);
    const total = absAmount(t);
    const sameCurrency = a.splits.every((s) => s.amount.currency === total.currency);
    const sum = a.splits.reduce((x, s) => x + toMinor(s.amount), 0n);
    if (!sameCurrency || sum !== toMinor(total))
      throw invalid(
        'splits',
        `split amounts must be in ${total.currency} and sum exactly to ${total.amount}`,
      );
    const names = await categoryNames(e.ops);
    a.splits.forEach((s, i) => {
      if (s.categoryId && !names.has(s.categoryId))
        throw invalid(`splits[${i}].categoryId`, 'unknown id');
    });
    return {
      e,
      rows: [
        { field: 'transaction', after: txLabel(t) },
        { field: 'amount', after: txAmount(t) },
        { field: 'splits', before: splitsVal(t.splits, names), after: splitsVal(a.splits, names) },
      ],
      summary: {
        transactionId: t.id,
        description: t.description,
        amount: txAmount(t),
        before: splitsOf(t),
        after: a.splits,
      },
      targets: [tgt('transactions', t)],
      apply: () => e.ops.replaceSplits(t.id, { version: t.version, splits: a.splits }),
    };
  },

  async bulk_categorize_transactions(ctx, a) {
    const txs: D.Transaction[] = [];
    let e: Env | undefined;
    for (const id of a.transactionIds) {
      if (txs.some((x) => x.id === id)) throw invalid('transactionIds', `duplicate id ${id}`);
      const r = await loadTx(ctx, id);
      if (e && r.e.profile.id !== e.profile.id)
        throw invalid('transactionIds', 'all transactions must belong to one profile');
      if (r.t.splits.length > 1) throw severalSplits(`transaction ${id}`);
      e = r.e;
      txs.push(r.t);
    }
    const env_ = e as Env;
    const after = await nameOf(env_.ops, 'categories', a.categoryId, 'categoryId');
    return {
      e: env_,
      rows: [
        { field: 'count', after: String(txs.length) },
        { field: 'transactions', after: txs.map(txLabel).join('\n') },
        { field: 'category', after },
      ],
      summary: { count: txs.length, categoryId: a.categoryId },
      targets: txs.map((t) => tgt('transactions', t)),
      // ponytail: one write per transaction (not one atomic tx like the server); all were
      // validated above and each carries its version, so only a concurrent edit can stop midway.
      apply: async () => {
        const updated: string[] = [];
        for (const t of txs) {
          await env_.ops.updateTransaction(t.id, { version: t.version, categoryId: a.categoryId });
          updated.push(t.id);
        }
        return { updated };
      },
    };
  },

  async update_transaction_metadata(ctx, a) {
    const { e, t } = await loadTx(ctx, a.transactionId, false);
    if (
      a.description === undefined &&
      a.notes === undefined &&
      a.tagIds === undefined &&
      a.merchantId === undefined
    )
      throw invalid('arguments', 'nothing to change');
    const tagNames = async (ids: string[], field: string) =>
      (await Promise.all(ids.map((id) => nameOf(e.ops, 'tags', id, field)))).join(', ');
    const rows: Row[] = [{ field: 'transaction', after: txLabel(t) }];
    if (a.description !== undefined)
      rows.push({ field: 'description', before: t.description, after: a.description.trim() });
    if (a.notes !== undefined) rows.push({ field: 'notes', before: t.notes, after: a.notes });
    if (a.tagIds !== undefined)
      rows.push({
        field: 'tags',
        before: await tagNames(t.tagIds, 'tagIds').catch(() => t.tagIds.join(', ')),
        after: await tagNames(a.tagIds, 'tagIds'),
      });
    if (a.merchantId !== undefined)
      rows.push({
        field: 'merchant',
        before: await nameOf(e.ops, 'merchants', t.merchantId, 'merchantId').catch(() => null),
        after: await nameOf(e.ops, 'merchants', a.merchantId, 'merchantId'),
      });
    return {
      e,
      rows,
      summary: {
        transactionId: t.id,
        before: {
          description: t.description,
          notes: t.notes,
          tagIds: t.tagIds,
          merchantId: t.merchantId,
        },
        after: {
          description: a.description ?? null,
          notes: a.notes ?? null,
          tagIds: a.tagIds ?? null,
          merchantId: a.merchantId ?? null,
        },
      },
      targets: [tgt('transactions', t)],
      apply: () =>
        e.ops.updateTransaction(t.id, {
          version: t.version,
          ...(a.description !== undefined ? { description: a.description.trim() } : {}),
          ...(a.notes !== undefined ? { notes: a.notes } : {}),
          ...(a.tagIds !== undefined ? { tagIds: a.tagIds } : {}),
          ...(a.merchantId !== undefined ? { merchantId: a.merchantId } : {}),
        }),
    };
  },

  async create_planned_expense(ctx, a) {
    const e = await env(ctx, a.profileId);
    if (a.rrule) {
      try {
        parseRRule(a.rrule);
      } catch {
        throw invalid('recurrence.rrule', 'invalid recurrence rule');
      }
    }
    const account = await nameOf(e.ops, 'accounts', a.accountId, 'accountId');
    const category = await nameOf(e.ops, 'categories', a.categoryId, 'categoryId');
    return {
      e,
      rows: [
        { field: 'description', after: a.description },
        { field: 'amount', after: a.amount },
        { field: 'dueDate', after: a.dueDate },
        { field: 'rrule', after: a.rrule || null },
        { field: 'account', after: account },
        { field: 'category', after: category },
        { field: 'priority', after: a.priority },
        { field: 'confidence', after: a.confidence },
      ],
      summary: {
        create: 'planned expense',
        description: a.description,
        amount: a.amount,
        dueDate: a.dueDate,
        rrule: a.rrule ?? null,
      },
      targets: [],
      apply: () =>
        e.ops.create('planned_transactions', {
          kind: 'expense',
          description: a.description,
          amount: a.amount,
          dueDate: a.dueDate,
          accountId: a.accountId ?? null,
          categoryId: a.categoryId ?? null,
          priority: a.priority,
          confidence: a.confidence,
          notes: PLAN_NOTE,
          recurrence: a.rrule ? { rrule: a.rrule } : null,
        }),
    };
  },

  async update_planned_expense(ctx, a) {
    let p: D.PlannedTransaction | undefined;
    const e = await owner(ctx, 'planned transaction', async (ops) => {
      p = await ops.get('planned_transactions', a.plannedTransactionId);
      return p;
    });
    const cur = p as D.PlannedTransaction;
    const patch = {
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.amount !== undefined ? { amount: a.amount } : {}),
      ...(a.dueDate !== undefined ? { dueDate: a.dueDate } : {}),
      ...(a.status !== undefined ? { status: a.status } : {}),
    };
    const rows: Row[] = [{ field: 'plan', after: cur.description }];
    if (a.description !== undefined)
      rows.push({ field: 'description', before: cur.description, after: a.description });
    if (a.amount) rows.push({ field: 'amount', before: cur.amount, after: a.amount });
    if (a.dueDate) rows.push({ field: 'dueDate', before: cur.dueDate, after: a.dueDate });
    if (a.status) rows.push({ field: 'status', before: cur.status, after: a.status });
    return {
      e,
      rows,
      summary: {
        plannedTransactionId: cur.id,
        before: {
          description: cur.description,
          amount: cur.amount,
          dueDate: cur.dueDate,
          status: cur.status,
        },
        after: {
          description: a.description ?? null,
          amount: a.amount ?? null,
          dueDate: a.dueDate ?? null,
          status: a.status ?? null,
        },
      },
      targets: [tgt('planned_transactions', cur)],
      apply: () =>
        e.ops.update('planned_transactions', cur.id, { version: cur.version, ...patch } as never),
    };
  },

  async create_budget(ctx, a) {
    const e = await env(ctx, a.profileId);
    const currency = a.currency.toUpperCase();
    if (currencyScale(currency) === undefined) throw invalid('currency', 'unknown currency');
    const names = await checkAllocations(e.ops, a.allocations, currency);
    return {
      e,
      rows: [
        { field: 'name', after: a.name },
        { field: 'periodType', after: a.periodType },
        { field: 'startDate', after: a.startDate },
        { field: 'allocations', after: splitsVal(a.allocations, names) },
      ],
      summary: {
        create: 'budget',
        name: a.name,
        periodType: a.periodType,
        allocations: a.allocations,
      },
      targets: [],
      apply: () =>
        e.ops.create('budgets', {
          name: a.name,
          periodType: a.periodType,
          startDate: a.startDate,
          currency,
          rolloverPolicy: 'none',
          allocations: a.allocations,
        }),
    };
  },

  async update_budget(ctx, a) {
    let b: D.Budget | undefined;
    const e = await owner(ctx, 'budget', async (ops) => {
      b = await ops.get('budgets', a.budgetId);
      return b;
    });
    const cur = b as D.Budget;
    const before = await budgetAllocations(e.ops, cur.id);
    const names = await checkAllocations(e.ops, a.allocations ?? [], cur.currency);
    const rows: Row[] = [{ field: 'budget', after: cur.name }];
    if (a.name !== undefined) rows.push({ field: 'name', before: cur.name, after: a.name });
    if (a.allocations)
      rows.push({
        field: 'allocations',
        before: splitsVal(before, names),
        after: splitsVal(a.allocations, names),
      });
    return {
      e,
      rows,
      summary: {
        budgetId: cur.id,
        before: { name: cur.name, allocations: before },
        after: { name: a.name ?? null, allocations: a.allocations ?? null },
      },
      targets: [tgt('budgets', cur)],
      apply: () =>
        e.ops.update('budgets', cur.id, {
          version: cur.version,
          ...(a.name !== undefined ? { name: a.name } : {}),
          // 'allocations' in the patch replaces them all, so only send it when given
          ...(a.allocations ? { allocations: a.allocations } : {}),
        }),
    };
  },

  async create_savings_goal(ctx, a) {
    const e = await env(ctx, a.profileId);
    return {
      e,
      rows: [
        { field: 'name', after: a.name },
        { field: 'targetAmount', after: a.targetAmount },
        { field: 'targetDate', after: a.targetDate ?? null },
      ],
      summary: {
        create: 'savings goal',
        name: a.name,
        targetAmount: a.targetAmount,
        targetDate: a.targetDate ?? null,
      },
      targets: [],
      apply: () =>
        e.ops.create('savings_goals', {
          name: a.name,
          targetAmount: a.targetAmount,
          targetDate: a.targetDate ?? null,
        }),
    };
  },

  async create_categorization_rule(ctx, a) {
    const e = await env(ctx, a.profileId);
    const category = await nameOf(e.ops, 'categories', a.categoryId, 'categoryId');
    const conditions = [{ field: a.match.field, op: a.match.op, value: a.match.value }];
    const actions = [{ type: 'set_category' as const, categoryId: a.categoryId }];
    return {
      e,
      rows: [
        { field: 'name', after: a.name },
        { field: 'match', after: `${a.match.field} ${a.match.op} "${a.match.value}"` },
        { field: 'category', after: category },
      ],
      summary: { create: 'categorization rule', name: a.name, conditions, actions },
      targets: [],
      apply: () => e.ops.create('categorization_rules', { name: a.name, conditions, actions }),
    };
  },
};

// idempotencyKey → the applied change, for retries within this app session (server: stored proposals)
const applied = new Map<string, { args: string; out: unknown }>();

/** Validate, ask the user, apply. Result shape = the server's applied proposal. */
export async function callWriteTool(
  ctx: ToolContext,
  name: WriteName,
  args: unknown,
  approve: Approve,
): Promise<unknown> {
  const a = parseArgs(TOOLS[name].input, args) as In<WriteName> & { idempotencyKey?: string };
  const key = a.idempotencyKey ? `${ctx.profile.id}|${name}|${a.idempotencyKey}` : '';
  const prev = key ? applied.get(key) : undefined;
  if (prev) {
    if (prev.args !== JSON.stringify(args))
      throw new ToolError(
        'idempotency_key_reused',
        'idempotencyKey was used with a different change',
      );
    return prev.out;
  }
  try {
    const p = await (prep[name] as (c: ToolContext, a: unknown) => Promise<Prepared>)(ctx, a);
    writable(p.e);
    const preview = { summary: p.summary, targets: p.targets };
    const v = await approve({ tool: name, profile: p.e.profile.name, rows: p.rows, preview });
    if (v === 'timeout')
      throw new ToolError('approval_timeout', 'the user did not answer in time; nothing changed');
    if (v !== 'approved') throw new ToolError('rejected', 'the user rejected this change');
    const result = await p.apply();
    const out = {
      proposalId: crypto.randomUUID(),
      status: 'applied',
      preview,
      result,
      meta: { complete: true, warnings: [], missingRates: [] },
    };
    if (key) applied.set(key, { args: JSON.stringify(args), out });
    return out;
  } catch (err) {
    throw toToolError(err);
  }
}
