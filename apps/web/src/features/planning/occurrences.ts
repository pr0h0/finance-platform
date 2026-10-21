// Occurrence rows for the planning views (calendar, list, timeline) incl. resolved ones.
import type * as D from '@finplat/domain';
import {
  addDays,
  addMonths,
  annualize,
  expandRecurrence,
  fromMinor,
  installmentProgress,
  type Money,
  matchPlanned,
  maxDate,
  planOccurrences,
  spreadAnnual,
  startOfMonth,
  sum,
  toMinor,
} from '@finplat/finance-engine';
import type { Snapshot } from '../analytics/snapshot.ts';

export interface OccRow {
  plan: D.PlannedTransaction;
  occurrenceDate: string; // identity
  date: string; // effective
  amount: Money;
  status: D.OccurrenceStatus;
  overdue: boolean;
  installmentNo: number | null;
  stored?: D.PlannedOccurrence;
}

/** Pending occurrences (engine rules) plus resolved ones (matched/paid/skipped) in [from, to]. */
export function occurrenceRows(s: Snapshot, from: string, to: string): OccRow[] {
  const plans = new Map(s.plans.map((p) => [p.id, p]));
  const stored = new Map(
    s.storedOccurrences.map((o) => [`${o.plannedTransactionId}|${o.occurrenceDate}`, o]),
  );
  const rows: OccRow[] = planOccurrences(s.plans, s.schedules, s.storedOccurrences, from, to, {
    includeOverdue: from <= s.today && to >= s.today,
  }).map((o) => ({
    plan: plans.get(o.planId) as D.PlannedTransaction,
    occurrenceDate: o.occurrenceDate,
    date: o.date,
    amount: o.amount,
    status: 'pending',
    overdue: o.overdue,
    installmentNo: o.installmentNo,
    stored: stored.get(`${o.planId}|${o.occurrenceDate}`),
  }));
  for (const o of s.storedOccurrences) {
    if (o.status === 'pending') continue;
    const date = o.dateOverride ?? o.occurrenceDate;
    const plan = plans.get(o.plannedTransactionId);
    if (!plan || date < from || date > to) continue;
    rows.push({
      plan,
      occurrenceDate: o.occurrenceDate,
      date,
      amount: o.amountOverride ?? plan.amount,
      status: o.status,
      overdue: false,
      installmentNo: null,
      stored: o,
    });
  }
  return rows.sort(
    (a, b) => a.date.localeCompare(b.date) || a.plan.description.localeCompare(b.plan.description),
  );
}

/** Total committed (pending) expenses and expected income in the rows, in the reporting currency. */
export function commitments(s: Snapshot, rows: readonly OccRow[]) {
  let expense = 0n;
  let income = 0n;
  let complete = true;
  for (const r of rows) {
    if (r.status !== 'pending' || r.plan.kind === 'transfer') continue;
    const v = s.convert(r.amount, maxDate(r.date, s.today));
    if (!v) {
      complete = false;
      continue;
    }
    if (r.plan.kind === 'expense') expense += toMinor(v);
    else income += toMinor(v);
  }
  return {
    expense: fromMinor(expense, s.currency),
    income: fromMinor(income, s.currency),
    complete,
  };
}

/** Match suggestions for pending occurrences of the last 30 days. */
export function matchSuggestions(s: Snapshot) {
  const occ = planOccurrences(
    s.plans,
    s.schedules,
    s.storedOccurrences,
    addDays(s.today, -30),
    addDays(s.today, 5),
  );
  return matchPlanned(occ, s.plans, s.ledger);
}

export function installments(s: Snapshot) {
  const sched = new Map(s.schedules.map((x) => [x.id, x]));
  return s.plans
    .filter((p) => p.installmentTotal)
    .map((p) => ({
      plan: p,
      progress: installmentProgress(
        p,
        p.recurrenceId ? (sched.get(p.recurrenceId) ?? null) : null,
        s.storedOccurrences,
      ),
    }));
}

/**
 * Annual plan for the 12 months starting this month: scheduled income/expense per month and a
 * smoothed monthly allocation of non-monthly expenses (annual equivalent / 12, parts sum exactly).
 */
export function annualPlan(s: Snapshot) {
  const start = startOfMonth(s.today);
  const end = addDays(addMonths(start, 12), -1);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(start, i).slice(0, 7));
  const per = new Map(months.map((m) => [m, { income: 0n, expense: 0n }]));
  let complete = true;
  for (const o of planOccurrences(s.plans, s.schedules, s.storedOccurrences, start, end)) {
    const p = s.plans.find((x) => x.id === o.planId);
    if (!p || p.kind === 'transfer') continue;
    const v = s.convert(o.amount, o.date);
    if (!v) {
      complete = false;
      continue;
    }
    const e = per.get(o.date.slice(0, 7));
    if (!e) continue;
    if (p.kind === 'income') e.income += toMinor(v);
    else e.expense += toMinor(v);
  }
  const sched = new Map(s.schedules.map((x) => [x.id, x]));
  const smoothItems: { plan: D.PlannedTransaction; annual: Money; monthly: Money[] }[] = [];
  for (const p of s.plans) {
    if (p.kind !== 'expense' || p.status !== 'active') continue;
    const sc = p.recurrenceId ? sched.get(p.recurrenceId) : undefined;
    const monthlyRule =
      sc && /FREQ=(MONTHLY|WEEKLY|DAILY)/.test(sc.rrule) && !/INTERVAL=(?!1\b)\d+/.test(sc.rrule);
    if (monthlyRule) continue;
    // one-off in the window or a less-than-monthly rule (yearly, quarterly, every N months)
    const dates = sc
      ? expandRecurrence(sc, start, end).map((x) => x.dueDate)
      : p.dueDate >= start && p.dueDate <= end
        ? [p.dueDate]
        : [];
    if (!dates.length) continue;
    const yearly = sc ? annualize(p.amount, sc.rrule).annual : p.amount;
    const conv = s.convert(yearly, s.today);
    if (!conv) {
      complete = false;
      continue;
    }
    smoothItems.push({ plan: p, annual: conv, monthly: spreadAnnual(conv) });
  }
  const smoothed = months.map((_, i) =>
    sum(
      smoothItems.map((x) => x.monthly[i] as Money),
      s.currency,
    ),
  );
  return {
    months: months.map((m, i) => ({
      month: m,
      income: fromMinor(per.get(m)?.income ?? 0n, s.currency),
      expense: fromMinor(per.get(m)?.expense ?? 0n, s.currency),
      smoothed: smoothed[i] as Money,
    })),
    items: smoothItems,
    complete,
  };
}
