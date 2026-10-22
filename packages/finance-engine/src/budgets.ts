// Budget periods, utilization and rollover. Mirrored by the Go budgets module:
// packages/test-fixtures/conformance/budgets.json.
//
// Periods: the first period starts at budget.startDate. Later periods start at each anchor date
// after it: weekly = startDate + 7k; monthly/quarterly/yearly = day `periodAnchorDay`
// (0 -> startDate's day, clamped to month end) of startDate's month + k*1/3/12 months.
// A period ends the day before the next one starts (capped at endDate). custom = [startDate, endDate].
//
// Per line (allocation): category lines cover the category and all its descendants; a null category
// line covers all spending. actual = net spending (expenses - refunds, analytics rules) booked in the
// period. planned = pending, unmatched planned expenses dated in the period (caller passes them;
// matched/skipped occurrences must not be passed — invariant 19). Actual and planned stay separate.
//   limit     = allocation + rolloverIn
//   remaining = limit - actual - (includePlanned ? planned : 0)
//   utilization = (actual + (includePlanned ? planned : 0)) / limit, 4 decimals half_up; null if limit <= 0
//   alert = highest alert threshold <= utilization, else null
// Rollover (per line, chained from the first period, actual only): leftover = prev limit - prev actual;
//   none -> 0, carry_surplus -> max(leftover, 0), carry_deficit -> min(leftover, 0), carry_both -> leftover.
//   A period with a stored period allocation (server period close; matched by `periodStart`, or by
//   `budgetPeriodId` through `periodIds`) uses that row's amount and its frozen rolloverAmount instead.
//   Policy = the period row's, else the default allocation's, else the budget's.
// Totals = the null-category line when present, else the sum of category lines.
import {
  type AggregateOptions,
  type CategoryLike,
  flows,
  type LedgerTransaction,
} from './analytics.ts';
import { addDays, clampedDate, parseDate } from './dates.ts';
import { compareDecimal, divRound, formatDecimal, pow10 } from './decimal.ts';
import type { ToReporting } from './fx.ts';
import { fromMinor, type Money, toMinor } from './money.ts';

export type RolloverPolicy = 'none' | 'carry_surplus' | 'carry_deficit' | 'carry_both';

export interface BudgetLike {
  id: string;
  periodType: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';
  periodAnchorDay: number;
  startDate: string;
  endDate: string | null;
  currency: string;
  rolloverPolicy: RolloverPolicy;
  includePlanned: boolean;
  alertThresholds: readonly string[];
}

export interface AllocationLike {
  budgetPeriodId?: string | null;
  periodStart?: string | null; // start date of budgetPeriodId (sent by the server)
  categoryId: string | null;
  amount: Money;
  rolloverAmount?: Money | null; // frozen carry of a stored period row
  rolloverPolicy?: RolloverPolicy | null;
}

export interface PlannedSpend {
  date: string;
  categoryId: string | null;
  amount: Money; // positive magnitude
}

export interface Period {
  start: string;
  end: string;
}

/** Periods from the budget start through the one containing `until` (or the budget end). */
export function budgetPeriods(b: BudgetLike, until: string): Period[] {
  if (b.periodType === 'custom') {
    if (!b.endDate) throw new Error('custom budget needs endDate');
    return [{ start: b.startDate, end: b.endDate }];
  }
  const s = parseDate(b.startDate);
  const anchor = b.periodAnchorDay > 0 ? b.periodAnchorDay : s.d;
  const step = { weekly: 0, monthly: 1, quarterly: 3, yearly: 12 }[b.periodType];
  const starts: string[] = [b.startDate];
  const last = b.endDate && b.endDate < until ? b.endDate : until;
  for (let j = 0; ; j++) {
    const a =
      step === 0 ? addDays(b.startDate, 7 * (j + 1)) : clampedDate(s.y, s.m, anchor, j * step);
    if (a <= b.startDate) continue;
    starts.push(a);
    if (a > last) break;
  }
  const out: Period[] = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const start = starts[i] as string;
    if (start > last) break;
    let end = addDays(starts[i + 1] as string, -1);
    if (b.endDate && end > b.endDate) end = b.endDate;
    out.push({ start, end });
  }
  return out;
}

export interface BudgetLine {
  categoryId: string | null;
  limit: Money;
  rolloverIn: Money;
  actual: Money;
  planned: Money;
  remaining: Money;
  utilization: string | null;
  alert: string | null;
}

export interface BudgetStatus {
  budgetId: string;
  periodStart: string;
  periodEnd: string;
  lines: BudgetLine[];
  totals: { limit: Money; actual: Money; planned: Money; remaining: Money };
  complete: boolean;
  warnings: string[];
}

export function rolloverAmount(policy: RolloverPolicy, leftover: bigint): bigint {
  switch (policy) {
    case 'none':
      return 0n;
    case 'carry_surplus':
      return leftover > 0n ? leftover : 0n;
    case 'carry_deficit':
      return leftover < 0n ? leftover : 0n;
    case 'carry_both':
      return leftover;
  }
}

export function utilization(spent: bigint, limit: bigint): string | null {
  if (limit <= 0n) return null;
  return formatDecimal({ units: divRound(spent * pow10(4), limit, 'half_up'), scale: 4 });
}

export function alertLevel(util: string | null, thresholds: readonly string[]): string | null {
  if (util === null) return null;
  let best: string | null = null;
  for (const t of thresholds)
    if (compareDecimal(util, t) >= 0 && (best === null || compareDecimal(t, best) > 0)) best = t;
  return best;
}

export interface BudgetStatusInput {
  budget: BudgetLike;
  allocations: readonly AllocationLike[];
  transactions: readonly LedgerTransaction[];
  categories: readonly CategoryLike[];
  planned?: readonly PlannedSpend[];
  date: string; // any date inside the wanted period
  convert: ToReporting;
  periodIds?: readonly { id: string; startDate: string }[]; // stored BudgetPeriod rows
}

/** Ancestors (self included) per category id. */
function ancestry(categories: readonly CategoryLike[]): (id: string | null) => Set<string | null> {
  const parent = new Map(categories.map((c) => [c.id, c.parentId]));
  const cache = new Map<string | null, Set<string | null>>();
  return (id) => {
    const hit = cache.get(id);
    if (hit) return hit;
    const set = new Set<string | null>([null]); // everything is under the overall line
    for (let cur = id; cur && !set.has(cur); cur = parent.get(cur) ?? null) set.add(cur);
    cache.set(id, set);
    return set;
  };
}

/** Status of the period containing `date`, with rollover chained from the first period. */
export function budgetStatus(input: BudgetStatusInput): BudgetStatus {
  const { budget: b } = input;
  const periods = budgetPeriods(b, input.date);
  const target = periods.find((p) => p.start <= input.date && input.date <= p.end);
  if (!target) throw new Error(`date ${input.date} is outside budget ${b.id}`);
  const cur = b.currency;
  const opts: AggregateOptions = {
    from: (periods[0] as Period).start,
    to: target.end,
    currency: cur,
    convert: input.convert,
  };
  const { flows: fs, missingRates } = flows(input.transactions, opts);
  const under = ancestry(input.categories);
  const startById = new Map((input.periodIds ?? []).map((p) => [p.id, p.startDate]));
  // period rows by "start|category"; rows of unknown periods are ignored
  const periodRows = new Map<string, AllocationLike>();
  for (const a of input.allocations) {
    if (!a.budgetPeriodId) continue;
    const start = a.periodStart ?? startById.get(a.budgetPeriodId);
    if (start && start <= target.start) periodRows.set(`${start}|${a.categoryId}`, a);
  }
  const defaults = input.allocations.filter((a) => !a.budgetPeriodId);
  const lineKeys = [...new Set([...defaults, ...periodRows.values()].map((a) => a.categoryId))];

  // actual[periodIndex][lineKey]
  const actual = periods.map(() => new Map<string | null, bigint>());
  let pi = 0;
  const sorted = fs.filter((f) => f.kind === 'spending').sort((x, y) => (x.date < y.date ? -1 : 1));
  for (const f of sorted) {
    while (pi < periods.length && (periods[pi] as Period).end < f.date) pi++;
    if (pi >= periods.length) break;
    const m = actual[pi] as Map<string | null, bigint>;
    const anc = under(f.categoryId);
    for (const k of lineKeys) if (anc.has(k)) m.set(k, (m.get(k) ?? 0n) + toMinor(f.amount));
  }

  const warnings: string[] = [];
  const planned = new Map<string | null, bigint>();
  for (const p of input.planned ?? []) {
    if (p.date < target.start || p.date > target.end) continue;
    const v = input.convert(p.amount, p.date);
    if (!v) {
      warnings.push(`planned ${p.amount.currency} on ${p.date} skipped: missing exchange rate`);
      continue;
    }
    const anc = under(p.categoryId);
    for (const k of lineKeys) if (anc.has(k)) planned.set(k, (planned.get(k) ?? 0n) + toMinor(v));
  }
  if (missingRates.length)
    warnings.unshift(`${missingRates.length} date(s) missing exchange rates`);

  const lines: BudgetLine[] = lineKeys.map((k) => {
    let carry = 0n;
    let limit = 0n;
    let act = 0n;
    const def = defaults.find((a) => a.categoryId === k);
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i] as Period;
      const stored = periodRows.get(`${p.start}|${k}`);
      const a = stored ?? def;
      if (stored) carry = stored.rolloverAmount ? toMinor(stored.rolloverAmount) : 0n;
      limit = (a ? toMinor(a.amount) : 0n) + carry;
      act = (actual[i] as Map<string | null, bigint>).get(k) ?? 0n;
      if (p === target) break;
      carry = rolloverAmount(
        stored?.rolloverPolicy ?? def?.rolloverPolicy ?? b.rolloverPolicy,
        limit - act,
      );
    }
    const plan = planned.get(k) ?? 0n;
    const spent = act + (b.includePlanned ? plan : 0n);
    const util = utilization(spent, limit);
    return {
      categoryId: k,
      limit: fromMinor(limit, cur),
      rolloverIn: fromMinor(carry, cur),
      actual: fromMinor(act, cur),
      planned: fromMinor(plan, cur),
      remaining: fromMinor(limit - spent, cur),
      utilization: util,
      alert: alertLevel(util, b.alertThresholds),
    };
  });

  const overall = lines.find((l) => l.categoryId === null);
  const pick = overall ? [overall] : lines;
  const tot = (f: (l: BudgetLine) => Money) =>
    fromMinor(
      pick.reduce((s, l) => s + toMinor(f(l)), 0n),
      cur,
    );
  return {
    budgetId: b.id,
    periodStart: target.start,
    periodEnd: target.end,
    lines,
    totals: {
      limit: tot((l) => l.limit),
      actual: tot((l) => l.actual),
      planned: tot((l) => l.planned),
      remaining: tot((l) => l.remaining),
    },
    complete: missingRates.length === 0 && warnings.length === 0,
    warnings,
  };
}
