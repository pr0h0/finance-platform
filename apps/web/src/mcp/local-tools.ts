// The 19 read-only MCP tools answered from the desktop app's LOCAL data (local MCP server). Same
// contracts (packages/mcp-contracts) and semantics as the Go server (apps/api/internal/mcp/read.go);
// numbers come from the same engines the web pages use (finance-engine, forecasting, snapshot).
// Local mode has no client grants, so the server's account/period restrictions never apply.
import type * as D from '@finplat/domain';
import {
  accountBalances,
  addDays,
  addMonths,
  annualize,
  buildCategoryHistory,
  byCategory,
  byMerchant,
  cashflow,
  compareDecimal,
  createRateBook,
  currencyScale,
  diffDays,
  divRound,
  flows,
  formatDecimal,
  fromMinor,
  type LedgerTransaction,
  type MissingRate,
  type Money,
  type Notice,
  netWorth,
  planOccurrences,
  pow10,
  reportingConverter,
  startOfMonth,
  suggestCategory,
  toMinor,
} from '@finplat/finance-engine';
import { whatIf } from '@finplat/forecasting';
import { computeCoverage, monthlyCoverage } from '@finplat/importer-sdk';
import { TOOLS, type ToolName } from '@finplat/mcp-contracts';
import type { DataSource, EntityName, FinanceOps } from '@finplat/storage';
import { z } from '@finplat/validation';
import { converterFor, loadSnapshot, type Snapshot } from '../features/analytics/snapshot.ts';
import { goalRows } from '../features/goals/compute.ts';
import { buildForecast, forecastInput } from '../features/planning/forecast.ts';

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** A result that also carries a file (Go fileResult): sent as MCP image / embedded resource. */
export class FileResult {
  constructor(
    readonly result: unknown,
    readonly mime: string,
    readonly data: string, // base64
    readonly uri: string,
  ) {}
}

export interface ToolContext {
  ds: DataSource;
  profile: D.Profile; // active profile = default
  today: string; // YYYY-MM-DD
}

const MAX_RESULT_BYTES = 512 << 10;
const SIMULATION = 'What-if expense (MCP simulation)'; // agent-facing, like the server's
const MAX_ROWS = 500;
const MAX_ATTACHMENT_CONTENT = 4 << 20;
const CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];

class Meta {
  complete = true;
  warnings: string[] = [];
  missingRates: MissingRate[] = [];
  nextCursor?: string;
  warn(s: string) {
    this.warnings.push(s);
  }
  merge(
    complete: boolean,
    warnings: readonly (string | Notice)[] = [],
    missing: MissingRate[] = [],
  ) {
    this.complete &&= complete;
    this.warnings.push(...warnings.map((w) => (typeof w === 'string' ? w : w.en)));
    for (const x of missing)
      if (!this.missingRates.some((y) => y.from === x.from && y.to === x.to && y.date === x.date))
        this.missingRates.push(x);
  }
}

const invalid = (field: string, msg: string) =>
  new ToolError('validation_failed', 'request validation failed', { fields: { [field]: msg } });
const zero = (cur: string) => fromMinor(0n, cur);

type ReadName = Exclude<
  { [K in ToolName]: (typeof TOOLS)[K]['readOnly'] extends true ? K : never }[ToolName],
  'preview_changes'
>;
type In<N extends ReadName> = z.output<(typeof TOOLS)[N]['input']>;

interface Env {
  ctx: ToolContext;
  profile: D.Profile;
  ops: FinanceOps;
  today: string;
}

async function env(ctx: ToolContext, profileId?: string): Promise<Env> {
  let profile = ctx.profile;
  if (profileId && profileId !== ctx.profile.id) {
    const p = (await ctx.ds.listProfiles()).find((x) => x.id === profileId);
    if (!p) throw new ToolError('not_found', 'profile not found');
    profile = p;
  }
  return { ctx, profile, ops: ctx.ds.profile(profile.id), today: ctx.today };
}

/** The profile owning an entity (Go entityProfile): every local profile is "granted". */
async function owner(ctx: ToolContext, what: string, find: (ops: FinanceOps) => Promise<unknown>) {
  const profiles = await ctx.ds.listProfiles();
  for (const p of [ctx.profile, ...profiles.filter((x) => x.id !== ctx.profile.id)]) {
    const e = await env(ctx, p.id);
    if (await find(e.ops).catch(() => null)) return e;
  }
  throw new ToolError('not_found', `${what} not found`);
}

function reportCurrency(cur: string | undefined, p: D.Profile): string {
  if (!cur) return p.baseCurrency;
  const c = cur.toUpperCase();
  if (currencyScale(c) === undefined) throw invalid('currency', 'unknown currency');
  return c;
}

/** Snapshot valued in `cur` (the MCP reporting currency is the profile base, not the UI setting). */
async function snap(e: Env, cur = e.profile.baseCurrency): Promise<Snapshot> {
  const s = await loadSnapshot(e.ops, cur, e.today);
  return s.currency === cur ? s : { ...s, currency: cur, convert: await converterFor(e.ops, cur) };
}

/** Default period: current month to date; at most 20 years. */
function period(e: Env, from?: string, to?: string) {
  const f = from ?? startOfMonth(e.today);
  const t = to ?? e.today;
  if (t < f)
    throw invalid('dateTo', 'must not be before dateFrom (after applying the granted period)');
  if (diffDays(t, f) > 20 * 366) throw invalid('dateFrom', 'range longer than 20 years');
  return { from: f, to: t };
}

const ids = (a?: string[]) => (a?.length ? a : undefined);
const aggOpts = (s: Snapshot, from: string, to: string, accountIds?: string[]) => ({
  from,
  to,
  currency: s.currency,
  convert: s.convert,
  ...(accountIds ? { accountIds } : {}),
});
const amountRows = (rows: { key: string; label: string; amount: Money; count: number }[]) =>
  rows.map(({ key, label, amount, count }) => ({ key, label, amount, count }));

function decodeCursor(c: string): [string, string] {
  const [d, i] = c.split('|');
  if (!d || !i) throw invalid('cursor', 'invalid cursor');
  return [d, i];
}

/** Keyset page over transactions sorted (bookingDate desc, id desc). */
function pageTx<T extends { bookingDate: string; id: string }>(
  rows: T[],
  limit: number,
  cursor: string | undefined,
  m: Meta,
  moreWarning?: string,
): T[] {
  const after = cursor ? decodeCursor(cursor) : null;
  const sorted = rows
    .filter(
      (t) => !after || t.bookingDate < after[0] || (t.bookingDate === after[0] && t.id < after[1]),
    )
    .sort((a, b) =>
      a.bookingDate === b.bookingDate
        ? a.id < b.id
          ? 1
          : -1
        : a.bookingDate < b.bookingDate
          ? 1
          : -1,
    );
  const n = Math.min(limit, MAX_ROWS);
  if (sorted.length <= n) return sorted;
  const out = sorted.slice(0, n);
  const last = out[n - 1] as T;
  m.nextCursor = `${last.bookingDate}|${last.id}`;
  m.complete = false;
  if (moreWarning) m.warn(moreWarning);
  return out;
}

const UNCATEGORIZED_KINDS = new Set(['income', 'expense', 'refund']);
const needsCategory = (t: D.Transaction) =>
  UNCATEGORIZED_KINDS.has(t.kind) &&
  (t.splits.length === 0 || t.splits.some((s) => s.categoryId === null));

/** Spending rows of one period (compare_periods groupBy). */
function groupRows(s: Snapshot, groupBy: string, from: string, to: string, accountIds?: string[]) {
  const o = aggOpts(s, from, to, accountIds);
  if (groupBy === 'merchant') return byMerchant(s.ledger, { ...o, merchants: s.merchants });
  if (groupBy === 'account') {
    const rows = [];
    let complete = true;
    const missingRates: MissingRate[] = [];
    for (const a of s.accounts) {
      if (accountIds && !accountIds.includes(a.id)) continue;
      const x = byCategory(s.ledger, { ...o, accountIds: [a.id], categories: s.categories });
      complete &&= x.complete;
      missingRates.push(...x.missingRates);
      rows.push({ key: a.id, label: a.name, amount: x.total, count: 0 });
    }
    return { rows, complete, missingRates };
  }
  const parent = new Map(s.categories.map((c) => [c.id, c.parentId]));
  const r = byCategory(s.ledger, { ...o, categories: s.categories });
  return { ...r, rows: r.rows.filter((x) => !parent.get(x.key)) };
}

const tools: { [N in ReadName]: (ctx: ToolContext, a: In<N>) => Promise<unknown> } = {
  async get_financial_overview(ctx, a) {
    const e = await env(ctx, a.profileId);
    const cur = reportCurrency(a.currency, e.profile);
    const asOf = a.asOf ?? e.today;
    const s = await snap(e, cur);
    const accIds = ids(a.accountIds);
    const m = new Meta();
    const nw = netWorth(
      s.ledger,
      s.accounts.filter((x) => !accIds || accIds.includes(x.id)),
      asOf,
      cur,
      s.convert,
    );
    m.merge(nw.complete, [], nw.missingRates);
    const cf = cashflow(s.ledger, {
      ...aggOpts(s, startOfMonth(asOf), asOf, accIds),
      granularity: 'month',
    });
    m.merge(cf.complete, [], cf.missingRates);
    const plans = new Map(s.plans.map((p) => [p.id, p]));
    const upcoming = [];
    for (const o of planOccurrences(
      s.plans,
      s.schedules,
      s.storedOccurrences,
      e.today,
      addDays(e.today, 30),
    )) {
      const p = plans.get(o.planId);
      if (!p || p.kind === 'transfer') continue;
      if (upcoming.length === 20) {
        m.warn('more than 20 upcoming items in the next 30 days; use list_planned_expenses');
        break;
      }
      const amount =
        p.kind === 'expense' ? fromMinor(-toMinor(o.amount), o.amount.currency) : o.amount;
      upcoming.push({ date: o.date, description: p.description, amount });
    }
    return {
      netWorth: nw.netWorth,
      totalAssets: nw.assets,
      totalLiabilities: nw.liabilities,
      monthIncome: cf.totals.income,
      monthExpenses: cf.totals.expense,
      upcoming,
      meta: m,
    };
  },

  async list_accounts(ctx, a) {
    const e = await env(ctx, a.profileId);
    const [accs, ledger] = await Promise.all([e.ops.list('accounts'), e.ops.ledger()]);
    const bals = accountBalances(ledger, e.today);
    const accIds = ids(a.accountIds);
    const accounts = accs
      .filter((x) => (!accIds || accIds.includes(x.id)) && (!x.isArchived || a.includeArchived))
      .sort(
        (x, y) =>
          x.sortOrder - y.sortOrder || x.name.localeCompare(y.name) || x.id.localeCompare(y.id),
      )
      .map((x) => {
        const b = bals
          .filter((y) => y.accountId === x.id)
          .map((y) => fromMinor(toMinor(y), y.currency));
        return {
          id: x.id,
          name: x.name,
          type: x.accountType,
          currency: x.currency,
          archived: x.isArchived,
          balances: b.length ? b : [zero(x.currency)],
        };
      });
    return { accounts, meta: new Meta() };
  },

  async get_account_balance(ctx, a) {
    let acc: D.Account | undefined;
    const e = await owner(ctx, 'account', async (ops) => {
      acc = await ops.get('accounts', a.accountId);
      return acc;
    });
    const asOf = a.asOf ?? e.today;
    const b = accountBalances(await e.ops.ledger(), asOf)
      .filter((x) => x.accountId === a.accountId)
      .map((x) => fromMinor(toMinor(x), x.currency));
    return {
      accountId: a.accountId,
      asOf,
      balances: b.length ? b : [zero((acc as D.Account).currency)],
      meta: new Meta(),
    };
  },

  async list_transactions(ctx, a) {
    const e = await env(ctx, a.profileId);
    const m = new Meta();
    const from = a.dateFrom ?? '1900-01-01';
    const to = a.dateTo ?? '2999-12-31';
    if (to < from)
      throw invalid('dateTo', 'must not be before dateFrom (after applying the granted period)');
    const accIds = ids(a.accountIds);
    const cats = ids(a.categoryIds);
    const q = a.search?.toLowerCase();
    const txs = ((await e.ops.ledger()) as unknown as D.Transaction[]).filter((t) => {
      if (t.bookingDate < from || t.bookingDate > to) return false;
      if (accIds && !t.postings.some((p) => accIds.includes(p.accountId))) return false;
      if (cats && !t.splits.some((s) => s.categoryId && cats.includes(s.categoryId))) return false;
      if (q && !`${t.description} ${t.notes} ${t.payee}`.toLowerCase().includes(q)) return false;
      const amt = t.postings[0]?.amount.amount.replace('-', '');
      if (amt && a.minAmount && compareDecimal(amt, a.minAmount) < 0) return false;
      if (amt && a.maxAmount && compareDecimal(amt, a.maxAmount) > 0) return false;
      if (a.uncategorizedOnly && !needsCategory(t)) return false;
      return true;
    });
    const transactions = pageTx(
      txs,
      a.limit,
      a.cursor,
      m,
      'more transactions match; pass meta.nextCursor as cursor',
    );
    return { transactions, meta: m };
  },

  async get_transaction(ctx, a) {
    let t: D.Transaction | undefined;
    const e = await owner(ctx, 'transaction', async (ops) => {
      t = await ops.getTransaction(a.transactionId);
      return t;
    });
    const tx = t as D.Transaction;
    const out: Record<string, unknown> = { transaction: tx, meta: new Meta() };
    if (tx.importRecordId) {
      // ponytail: imported_raw_records is not a typed EntityName; generic list() reads it (as snapshot.ts does).
      const recs = (await e.ops.list(
        'imported_raw_records' as EntityName,
      )) as unknown as D.ImportedRawRecord[];
      const r = recs.find((x) => x.id === tx.importRecordId);
      if (r)
        out.sourceRecord = {
          sourceDescription: r.sourceDescription,
          postingDate: r.postingDate,
          amount: r.amount,
          bankReference: r.bankReference,
          counterparty: r.counterparty,
          importerId: r.importerId,
          importBatchId: r.importBatchId,
        };
    }
    return out;
  },

  async get_attachments(ctx, a) {
    if (a.includeContent && !a.attachmentId)
      throw invalid('includeContent', 'requires attachmentId (one file per call)');
    const e =
      !a.profileId && a.attachmentId
        ? await owner(ctx, 'attachment', async (ops) =>
            (await ops.listAttachments()).find((x) => x.id === a.attachmentId),
          )
        : await env(ctx, a.profileId);
    const [atts, ledger] = await Promise.all([
      e.ops.listAttachments(a.transactionId),
      e.ops.ledger(),
    ]);
    const dates = new Map(ledger.map((t) => [t.id, t.bookingDate]));
    let list = atts
      .filter((x) => !a.attachmentId || x.id === a.attachmentId)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id))
      .map((x) => ({
        id: x.id,
        transactionId: x.transactionId,
        transactionDate: (x.transactionId && dates.get(x.transactionId)) || null,
        fileName: x.fileName,
        contentType: x.contentType,
        sizeBytes: x.sizeBytes,
        purpose: x.purpose,
        createdAt: x.createdAt,
        isEncrypted: x.isEncrypted,
      }));
    const m = new Meta();
    if (list.length > a.limit) {
      list = list.slice(0, a.limit);
      m.complete = false;
      m.warn('more attachments exist; filter by transactionId or raise limit');
    }
    if (a.attachmentId && list.length === 0)
      throw new ToolError('not_found', 'attachment not found');
    const attachments = list.map(({ isEncrypted: _, ...x }) => x);
    const out = { attachments, meta: m };
    if (!a.includeContent) return out;
    const att = list[0] as (typeof list)[number];
    const shown = attachments[0] as (typeof attachments)[number] & { contentNote?: string };
    let note = 'included';
    let data: string | null = null;
    if (att.isEncrypted) note = 'end-to-end encrypted: only your devices can decrypt it';
    else if (!CONTENT_TYPES.includes(att.contentType.toLowerCase()))
      note = 'only images and PDFs are returned';
    else if (att.sizeBytes > MAX_ATTACHMENT_CONTENT) note = 'file is larger than 4 MiB';
    else {
      try {
        const bytes = new Uint8Array(await (await e.ops.attachmentContent(att.id)).arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        data = btoa(bin);
      } catch {
        note = 'file content is missing on this device';
      }
    }
    shown.contentNote = note;
    if (data === null) {
      m.complete = false;
      m.warn(`content not included: ${note}`);
      return out;
    }
    return new FileResult(out, att.contentType, data, `attachment://${att.id}/${att.fileName}`);
  },

  async get_spending_by_category(ctx, a) {
    const e = await env(ctx, a.profileId);
    const { from, to } = period(e, a.dateFrom, a.dateTo);
    const s = await snap(e, reportCurrency(a.currency, e.profile));
    const r = byCategory(s.ledger, {
      ...aggOpts(s, from, to, ids(a.accountIds)),
      categories: s.categories,
    });
    const m = new Meta();
    m.merge(r.complete, r.warnings, r.missingRates);
    const parent = new Map(s.categories.map((c) => [c.id, c.parentId]));
    const rows = r.rows.filter((x) => a.includeSubcategories || !parent.get(x.key));
    return { rows: amountRows(rows), total: r.total, from, to, meta: m };
  },

  async get_spending_by_merchant(ctx, a) {
    const e = await env(ctx, a.profileId);
    const { from, to } = period(e, a.dateFrom, a.dateTo);
    const s = await snap(e, reportCurrency(a.currency, e.profile));
    const r = byMerchant(s.ledger, {
      ...aggOpts(s, from, to, ids(a.accountIds)),
      merchants: s.merchants,
    });
    const m = new Meta();
    m.merge(r.complete, r.warnings, r.missingRates);
    let rows = amountRows(r.rows);
    if (rows.length > a.limit) {
      m.warn(`${rows.length} merchants; showing the top ${a.limit} (total covers all)`);
      rows = rows.slice(0, a.limit);
    }
    return { rows, total: r.total, from, to, meta: m };
  },

  async compare_periods(ctx, a) {
    const e = await env(ctx, a.profileId);
    const pa = period(e, a.a.dateFrom, a.a.dateTo);
    const pb = period(e, a.b.dateFrom, a.b.dateTo);
    const s = await snap(e, reportCurrency(a.currency, e.profile));
    const m = new Meta();
    const sum = (p: { from: string; to: string }) => {
      const r = groupRows(s, a.groupBy, p.from, p.to, ids(a.accountIds));
      m.merge(r.complete, [], r.missingRates);
      return new Map(r.rows.map((x) => [x.key, x]));
    };
    const ra = sum(pa);
    const rb = sum(pb);
    const rows = [...new Set([...ra.keys(), ...rb.keys()])].map((k) => {
      const x = ra.get(k);
      const y = rb.get(k);
      const av = x ? toMinor(x.amount) : 0n;
      const bv = y ? toMinor(y.amount) : 0n;
      const ch = bv - av;
      const abs = av < 0n ? -av : av;
      return {
        key: k,
        label: (y ?? x)?.label ?? k,
        a: fromMinor(av, s.currency),
        b: fromMinor(bv, s.currency),
        change: fromMinor(ch, s.currency),
        changePct:
          av === 0n
            ? null
            : formatDecimal({ units: divRound(ch * pow10(4), abs, 'half_up'), scale: 4 }),
      };
    });
    rows.sort((x, y) => (toMinor(y.b) > toMinor(x.b) ? 1 : toMinor(y.b) < toMinor(x.b) ? -1 : 0));
    return { rows, meta: m };
  },

  async get_income_summary(ctx, a) {
    const e = await env(ctx, a.profileId);
    let { from, to } = period(e, a.dateFrom, a.dateTo);
    if (!a.dateFrom) from = startOfMonth(addMonths(to, -11)); // default: last 12 months
    const s = await snap(e, reportCurrency(a.currency, e.profile));
    const o = aggOpts(s, from, to, ids(a.accountIds));
    const m = new Meta();
    // per month, zero-filled like the server's IncomeVsExpenses rows (count is 0 there too)
    const f = flows(s.ledger, o);
    m.merge(f.missingRates.length === 0, [], f.missingRates);
    const per = new Map<string, bigint>();
    for (let d = startOfMonth(from); d <= to; d = addMonths(d, 1)) per.set(d.slice(0, 7), 0n);
    let total = 0n;
    for (const x of f.flows)
      if (x.kind === 'income') {
        const k = x.date.slice(0, 7);
        per.set(k, (per.get(k) ?? 0n) + toMinor(x.amount));
        total += toMinor(x.amount);
      }
    const rows = [...per].map(([k, v]) => ({
      key: k,
      label: k,
      amount: fromMinor(v, s.currency),
      count: 0,
    }));
    const bc = byCategory(s.ledger, {
      ...o,
      kind: 'income',
      categories: s.categories,
      rollup: 'parent',
    });
    m.merge(bc.complete, [], bc.missingRates);
    return {
      rows,
      byCategory: amountRows(bc.rows),
      total: fromMinor(total, s.currency),
      from,
      to,
      meta: m,
    };
  },

  async get_budget_status(ctx, a) {
    const e = await env(ctx, a.profileId);
    const d = a.date ?? e.today;
    const m = new Meta();
    const budgets = [];
    for (const b of await e.ops.list('budgets')) {
      if (b.isTemplate || b.isArchived || (a.budgetId && b.id !== a.budgetId)) continue;
      try {
        const st = await e.ops.budgetStatus(b.id, d);
        m.merge(st.complete);
        budgets.push({
          id: b.id,
          name: b.name,
          periodStart: st.periodStart,
          periodEnd: st.periodEnd,
          ...st.totals,
        });
      } catch {
        m.warn(`budget "${b.name}" has no period on ${d}`);
      }
    }
    if (a.budgetId && budgets.length === 0) throw new ToolError('not_found', 'budget not found');
    return { budgets, meta: m };
  },

  async list_recurring_expenses(ctx, a) {
    const e = await env(ctx, a.profileId);
    const cur = reportCurrency(a.currency, e.profile);
    const s = await snap(e, cur);
    const m = new Meta();
    const sched = new Map(s.schedules.map((x) => [x.id, x]));
    const items = [];
    let total = 0n;
    for (const p of s.plans) {
      const sc = p.recurrenceId ? sched.get(p.recurrenceId) : undefined;
      if (p.kind !== 'expense' || p.status !== 'active' || !sc) continue;
      let annual: Money;
      try {
        annual = annualize(p.amount, sc.rrule).annual;
      } catch (err) {
        m.warn(`cannot annualize ${p.description}: ${(err as Error).message}`);
        continue;
      }
      const c = s.convert(annual, e.today);
      if (c) {
        annual = c;
        total += toMinor(c);
      } else m.merge(false, [], [{ from: annual.currency, to: cur, date: e.today }]);
      const next = planOccurrences(
        [p],
        s.schedules,
        s.storedOccurrences,
        e.today,
        addMonths(addMonths(e.today, 12), 1),
      )[0];
      items.push({
        id: p.id,
        description: p.description,
        amount: p.amount,
        rrule: sc.rrule,
        annualized: annual,
        nextDate: next?.date ?? null,
      });
      if (items.length >= MAX_ROWS) {
        m.complete = false;
        m.warn('result truncated');
        break;
      }
    }
    return { items, annualTotal: fromMinor(total, cur), meta: m };
  },

  async list_planned_expenses(ctx, a) {
    const e = await env(ctx, a.profileId);
    const from = a.dateFrom ?? e.today;
    const to = a.dateTo ?? addDays(e.today, 90);
    if (to < from)
      throw invalid('dateTo', 'must not be before dateFrom (after applying the granted period)');
    if (diffDays(to, from) > 3 * 366)
      throw invalid('dateTo', 'at most 3 years of occurrences per call');
    const offset = a.cursor ? Number(a.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw invalid('cursor', 'invalid cursor');
    const s = await snap(e);
    const plans = new Map(s.plans.map((p) => [p.id, p]));
    // pending occurrences (engine) + resolved ones (matched/skipped/paid) like the server's Expand
    const occ = [
      ...planOccurrences(s.plans, s.schedules, s.storedOccurrences, from, to).map((o) => ({
        planId: o.planId,
        date: o.date,
        amount: o.amount,
        status: 'pending',
      })),
      ...s.storedOccurrences.flatMap((o) => {
        const date = o.dateOverride ?? o.occurrenceDate;
        const p = plans.get(o.plannedTransactionId);
        return o.status !== 'pending' && p && !p.deletedAt && date >= from && date <= to
          ? [
              {
                planId: p.id,
                date,
                amount: o.amountOverride ?? p.amount,
                status: o.status as string,
              },
            ]
          : [];
      }),
    ].sort((x, y) => x.date.localeCompare(y.date) || x.planId.localeCompare(y.planId));
    const all = occ.flatMap((o) => {
      const p = plans.get(o.planId);
      return p?.kind === 'expense'
        ? [
            {
              plannedTransactionId: p.id,
              date: o.date,
              description: p.description,
              amount: o.amount,
              priority: p.priority,
              confidence: p.confidence,
              status: o.status,
            },
          ]
        : [];
    });
    const limit = Math.min(a.limit, MAX_ROWS);
    const m = new Meta();
    if (offset + limit < all.length) {
      m.nextCursor = String(offset + limit);
      m.complete = false;
    }
    return { items: all.slice(offset, offset + limit), meta: m };
  },

  async get_cash_flow_forecast(ctx, a) {
    const e = await env(ctx, a.profileId);
    const s = await snap(e, reportCurrency(a.currency, e.profile));
    const f = buildForecast(s, addDays(e.today, a.days), ids(a.accountIds));
    const m = new Meta();
    m.merge(f.complete, f.warnings);
    let lowestConservative = { date: f.from, amount: zero(s.currency) };
    f.days.forEach((d, i) => {
      if (i === 0 || toMinor(d.conservative) < toMinor(lowestConservative.amount))
        lowestConservative = { date: d.date, amount: d.conservative };
    });
    return {
      days: f.days.map((d) => ({
        date: d.date,
        expected: d.expected,
        conservative: d.conservative,
        optimistic: d.optimistic,
      })),
      lowest: f.lowest,
      lowestConservative,
      shortfalls: f.shortfalls.map((x) => ({ ...x, scenario: 'expected' })),
      safeToSpend: f.safeToSpend,
      safeToSpendUntil: f.safeToSpendUntil,
      assumptions: f.assumptions,
      meta: m,
    };
  },

  async get_savings_goals(ctx, a) {
    const e = await env(ctx, a.profileId);
    const goals = goalRows(await snap(e)).map(({ goal: g, projection: p }) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      status: g.status,
      target: g.targetAmount,
      saved: p.saved,
      progress: p.progress,
      targetDate: g.targetDate,
      estimatedCompletion: p.estimatedCompletionDate,
      // server rule: an estimate exists and is not after targetDate
      onTrack:
        p.estimatedCompletionDate !== null &&
        (!g.targetDate || p.estimatedCompletionDate <= g.targetDate),
    }));
    return { goals, meta: new Meta() };
  },

  async get_currency_exposure(ctx, a) {
    const e = await env(ctx, a.profileId);
    const cur = reportCurrency(a.currency, e.profile);
    const asOf = a.asOf ?? e.today;
    const [accs, ledger, rates] = await Promise.all([
      e.ops.list('accounts'),
      e.ops.ledger(),
      e.ops.rateSnapshots(),
    ]);
    const accIds = ids(a.accountIds);
    const assets = new Set(
      accs
        .filter(
          (x) =>
            x.includeInNetWorth &&
            x.classification === 'asset' &&
            (!accIds || accIds.includes(x.id)),
        )
        .map((x) => x.id),
    );
    const native = new Map<string, bigint>();
    for (const b of accountBalances(ledger, asOf))
      if (assets.has(b.accountId))
        native.set(b.currency, (native.get(b.currency) ?? 0n) + toMinor(b));
    const book = createRateBook(rates);
    const convert = reportingConverter(book, cur);
    const m = new Meta();
    let total = 0n;
    const rows = [...native.keys()].sort().map((c) => {
      const amount = fromMinor(native.get(c) as bigint, c);
      const converted = convert(amount, asOf);
      if (converted) total += toMinor(converted);
      else m.merge(false, [], [{ from: c, to: cur, date: asOf }]);
      const rate = converted ? (book.resolve(c, cur, asOf)?.rate ?? null) : null;
      return { currency: c, amount, converted, rate };
    });
    m.warn('asset accounts included in net worth; liabilities are not part of currency exposure');
    return { rows, total: fromMinor(total, cur), meta: m };
  },

  async get_import_coverage(ctx, a) {
    const e = await env(ctx, a.profileId);
    const [accs, batches, settings] = await Promise.all([
      e.ops.list('accounts'),
      e.ops.listImports(),
      e.ops.getSettings(),
    ]);
    const checks = (settings['import.checks'] ?? {}) as Record<
      string,
      'balanced' | 'mismatch' | 'unverifiable'
    >;
    const accIds = ids(a.accountIds);
    const accounts = accs
      .filter((x) => !accIds || accIds.includes(x.id))
      .sort(
        (x, y) =>
          x.sortOrder - y.sortOrder || x.name.localeCompare(y.name) || x.id.localeCompare(y.id),
      )
      .map((acc) => {
        const src = batches
          .filter(
            (b) =>
              b.status === 'committed' &&
              b.accountId === acc.id &&
              b.coverageStart &&
              b.coverageEnd,
          )
          .map((b) => ({
            start: b.coverageStart as string,
            end: b.coverageEnd as string,
            balance: checks[b.id] ?? 'unverifiable',
          }));
        const start = [acc.openingDate, ...src.map((x) => x.start)]
          .filter((x): x is string => !!x)
          .sort()[0];
        const out = {
          accountId: acc.id,
          name: acc.name,
          from: '',
          to: '',
          segments: [] as unknown[],
          months: [] as unknown[],
          covered: [] as { from: string; to: string }[],
          gaps: [] as { from: string; to: string }[],
        };
        if (!start || start > e.today) return out;
        const segs = computeCoverage(src, start, e.today);
        out.from = start;
        out.to = e.today;
        out.segments = segs.map((x) => ({ from: x.start, to: x.end, status: x.status }));
        out.months = monthlyCoverage(segs).map((x) => ({ month: x.month, status: x.status }));
        for (const x of segs) {
          const last = out.covered[out.covered.length - 1];
          if (x.status === 'missing') out.gaps.push({ from: x.start, to: x.end });
          else if (last && last.to === addDays(x.start, -1)) last.to = x.end;
          else out.covered.push({ from: x.start, to: x.end });
        }
        return out;
      });
    const m = new Meta();
    m.warn(
      'statuses: complete = statement balances reconcile; unverified = no balances to check; conflicting = balances disagree; missing = no import',
    );
    return { accounts, meta: m };
  },

  async get_uncategorized_transactions(ctx, a) {
    const e = await env(ctx, a.profileId);
    const m = new Meta();
    const from = a.dateFrom ?? '1900-01-01';
    const to = a.dateTo ?? '2999-12-31';
    if (to < from)
      throw invalid('dateTo', 'must not be before dateFrom (after applying the granted period)');
    const ledger = await e.ops.ledger();
    const accIds = ids(a.accountIds);
    const txs = (ledger as unknown as D.Transaction[]).filter(
      (t) =>
        needsCategory(t) &&
        t.status !== 'void' &&
        t.postings.length > 0 &&
        t.bookingDate >= from &&
        t.bookingDate <= to &&
        (!accIds || t.postings.some((p) => accIds.includes(p.accountId))),
    );
    const history = buildCategoryHistory(ledger);
    const transactions = pageTx(txs, a.limit, a.cursor, m).map((t) => {
      const p0 = t.postings[0] as D.Transaction['postings'][number];
      const cur = p0.amount.currency;
      const amount = fromMinor(
        t.postings.reduce((x, p) => x + toMinor(p.amount), 0n),
        cur,
      );
      const unc = t.splits.filter((s) => s.categoryId === null);
      const sg = suggestCategory(history, t as unknown as LedgerTransaction);
      return {
        id: t.id,
        bookingDate: t.bookingDate,
        kind: t.kind,
        description: t.description,
        payee: t.payee,
        amount,
        accountId: p0.accountId,
        source: t.source,
        importRecordId: t.importRecordId,
        splitCount: t.splits.length,
        uncategorizedAmount: unc.length
          ? fromMinor(
              unc.reduce((x, s) => x + toMinor(s.amount), 0n),
              cur,
            )
          : fromMinor(toMinor(amount) < 0n ? -toMinor(amount) : toMinor(amount), cur),
        suggestion: sg
          ? { categoryId: sg.value, merchantId: null, splitTemplateId: null, reason: 'history' }
          : null,
      };
    });
    return { transactions, meta: m };
  },

  async simulate_expense(ctx, a) {
    const e = await env(ctx, a.profileId);
    const s = await snap(e);
    const to = addDays(e.today, a.days);
    const { planWarnings, ...input } = forecastInput(
      s,
      to,
      a.accountId ? [a.accountId] : undefined,
    );
    // server rule: no account -> first included safe-to-spend account; amount in its currency
    const acc = a.accountId
      ? input.accounts.find((x) => x.id === a.accountId)
      : input.accounts.find((x) => x.includeInSafeToSpend);
    if (!acc) throw invalid('adjustments[0].accountId', 'account is not part of this forecast');
    let amount: Money = a.amount;
    if (acc.currency !== amount.currency) {
      const c = reportingConverter(createRateBook(await e.ops.rateSnapshots()), acc.currency)(
        amount,
        e.today,
      );
      if (!c) throw invalid('adjustments[0].amount', 'no exchange rate to the account currency');
      amount = c;
    }
    const r = whatIf(input, [
      {
        description: SIMULATION,
        amount: fromMinor(-toMinor(amount), amount.currency),
        date: a.date,
        accountId: acc.id,
        ...(a.recurrence ? { rrule: a.recurrence } : {}),
      },
    ]);
    const m = new Meta();
    m.merge(r.scenario.complete && planWarnings.length === 0, [
      ...planWarnings,
      ...r.scenario.warnings,
    ]);
    return {
      lowestBefore: r.baseline.lowest.amount,
      lowestAfter: r.scenario.lowest.amount,
      lowestAfterDate: r.scenario.lowest.date,
      firstShortfallDate: r.scenario.shortfalls[0]?.date ?? null,
      safeToSpendBefore: r.baseline.safeToSpend,
      safeToSpendAfter: r.scenario.safeToSpend,
      meta: m,
    };
  },
};

/** Run one read tool on local data. Errors are ToolError (code like the server's error codes). */
export async function callReadTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<unknown> {
  const fn = Object.hasOwn(tools, name) ? tools[name as ReadName] : undefined;
  if (!fn) throw new ToolError('unknown_tool', `no such tool: ${name}`);
  const schema = TOOLS[name as ReadName].input;
  // unknown fields are rejected, like the server's DisallowUnknownFields
  const parsed = (schema instanceof z.ZodObject ? schema.strict() : schema).safeParse(args ?? {});
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[i.path.join('.') || 'arguments'] = i.message;
    throw new ToolError('validation_failed', 'request validation failed', { fields });
  }
  let res: unknown;
  try {
    res = await (fn as (c: ToolContext, a: unknown) => Promise<unknown>)(ctx, parsed.data);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    const se = err as { code?: unknown; message?: string; details?: unknown };
    if (typeof se.code === 'string')
      throw new ToolError(se.code, se.message ?? se.code, se.details);
    throw err;
  }
  const payload = res instanceof FileResult ? res.result : res;
  const size = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (size > MAX_RESULT_BYTES)
    throw new ToolError(
      'result_too_large',
      `result is ${size >> 10} KiB (limit ${MAX_RESULT_BYTES >> 10} KiB); narrow the filters or lower limit`,
    );
  return res;
}
