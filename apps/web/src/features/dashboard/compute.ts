// Dashboard figures from a Snapshot (all exact money via the engine).
import {
  addDays,
  addMonths,
  annualize,
  byCategory,
  cashflow,
  compare,
  countsInReports,
  endOfMonth,
  fromMinor,
  type Money,
  monthlyInsights,
  netWorth,
  planOccurrences,
  startOfMonth,
  toMinor,
} from '@finplat/finance-engine';
import { projectGoal } from '@finplat/forecasting';
import type { Snapshot } from '../analytics/snapshot.ts';
import { buildForecast } from '../planning/forecast.ts';

export function accountBreakdown(s: Snapshot) {
  const nw = netWorth(s.ledger, s.accounts, s.today, s.currency, s.convert);
  const assets = toMinor(nw.assets);
  const rows = s.accounts
    .filter((a) => !a.isArchived)
    .map((a) => {
      let converted = 0n;
      let missing = false;
      for (const b of a.balances) {
        const v = s.convert(b, s.today);
        if (v) converted += toMinor(v);
        else missing = true;
      }
      const share =
        a.classification === 'asset' && assets > 0n && converted > 0n
          ? Number((converted * 10000n) / assets) / 10000
          : null;
      return { account: a, converted: fromMinor(converted, s.currency), missing, share };
    })
    .sort((x, y) => compare(y.converted, x.converted));
  return { netWorth: nw, rows };
}

export function monthSummary(s: Snapshot) {
  const from = startOfMonth(s.today);
  const to = endOfMonth(s.today);
  const cf = cashflow(s.ledger, {
    from,
    to,
    currency: s.currency,
    convert: s.convert,
    granularity: 'month',
  });
  return { ...cf.totals, complete: cf.complete, missingRates: cf.missingRates };
}

export function monthEndProjection(s: Snapshot) {
  const f = buildForecast(s, endOfMonth(s.today));
  return { amount: f.monthEnd, complete: f.complete, lowest: f.lowest };
}

export function upcomingBills(s: Snapshot, days = 30) {
  const plans = new Map(s.plans.map((p) => [p.id, p]));
  return planOccurrences(
    s.plans,
    s.schedules,
    s.storedOccurrences,
    s.today,
    addDays(s.today, days),
    {
      includeOverdue: true,
    },
  )
    .filter((o) => plans.get(o.planId)?.kind === 'expense')
    .map((o) => ({ ...o, plan: plans.get(o.planId) as (typeof s.plans)[number] }));
}

export function categoryDistribution(s: Snapshot) {
  return byCategory(s.ledger, {
    from: startOfMonth(s.today),
    to: s.today,
    currency: s.currency,
    convert: s.convert,
    categories: s.categories,
    rollup: 'parent',
  });
}

export function spendingTrend(s: Snapshot, months = 6) {
  const from = startOfMonth(addMonths(s.today, -(months - 1)));
  const cf = cashflow(s.ledger, {
    from,
    to: s.today,
    currency: s.currency,
    convert: s.convert,
    granularity: 'month',
  });
  const byPeriod = new Map(cf.periods.map((p) => [p.period, p]));
  const zero = fromMinor(0n, s.currency);
  const out = [];
  for (let i = 0; i < months; i++) {
    const k = addMonths(from, i).slice(0, 7);
    const p = byPeriod.get(k);
    out.push({
      period: k,
      income: p?.income ?? zero,
      expense: p?.expense ?? zero,
      net: p?.net ?? zero,
    });
  }
  return { periods: out, complete: cf.complete };
}

export function recentTransactions(s: Snapshot, n = 8) {
  return [...s.transactions]
    .sort((a, b) =>
      a.bookingDate === b.bookingDate
        ? b.createdAt.localeCompare(a.createdAt)
        : b.bookingDate.localeCompare(a.bookingDate),
    )
    .slice(0, n);
}

export function largestExpenses(s: Snapshot, n = 5) {
  const from = startOfMonth(s.today);
  return s.transactions
    .filter(
      (t) =>
        t.kind === 'expense' &&
        countsInReports(t) &&
        t.bookingDate >= from &&
        t.bookingDate <= s.today,
    )
    .map((t) => {
      const total = t.postings.reduce((a, p) => a - toMinor(p.amount), 0n);
      const native = fromMinor(total, t.postings[0]?.amount.currency ?? s.currency);
      return { t, native, converted: s.convert(native, t.bookingDate) };
    })
    .sort((a, b) => {
      const x = a.converted ? toMinor(a.converted) : 0n;
      const y = b.converted ? toMinor(b.converted) : 0n;
      return x === y ? 0 : x < y ? 1 : -1;
    })
    .slice(0, n);
}

/** Subscriptions with their billing plan, monthly/annual equivalent and next payment date. */
export function subscriptionCosts(s: Snapshot) {
  const plans = new Map(s.plans.map((p) => [p.id, p]));
  const sched = new Map(s.schedules.map((x) => [x.id, x]));
  const rows = s.subscriptions.map((sub) => {
    const plan = sub.plannedTransactionId ? plans.get(sub.plannedTransactionId) : undefined;
    const schedule = plan?.recurrenceId ? sched.get(plan.recurrenceId) : undefined;
    const cost = plan && schedule ? annualize(plan.amount, schedule.rrule) : null;
    const next =
      plan && sub.status !== 'cancelled' && sub.status !== 'paused'
        ? (planOccurrences(
            [plan],
            schedule ? [schedule] : [],
            s.storedOccurrences,
            s.today,
            addMonths(s.today, 24),
          )[0] ?? null)
        : null;
    return { sub, plan, schedule, cost, next };
  });
  let monthly = 0n;
  let annual = 0n;
  let complete = true;
  for (const r of rows) {
    if (!r.cost || r.sub.status === 'cancelled' || r.sub.status === 'paused') continue;
    const mo = s.convert(r.cost.monthly, s.today);
    const yr = s.convert(r.cost.annual, s.today);
    if (!mo || !yr) complete = false;
    else {
      monthly += toMinor(mo);
      annual += toMinor(yr);
    }
  }
  return {
    rows,
    monthly: fromMinor(monthly, s.currency),
    annual: fromMinor(annual, s.currency),
    complete,
  };
}

export function goalProgress(s: Snapshot) {
  return s.goals
    .filter((g) => g.status === 'active' || g.status === 'completed')
    .map((g) => ({
      goal: g,
      projection: projectGoal(
        g,
        s.contributions.filter((c) => c.goalId === g.id),
        s.today,
      ),
    }));
}

export function insights(s: Snapshot) {
  const dismissed = new Set((s.settings['insights.dismissed'] as string[] | undefined) ?? []);
  return monthlyInsights(s.ledger, {
    month: s.today,
    currency: s.currency,
    convert: s.convert,
    dismissed,
  });
}

/** Months of the last 12 with at least one imported transaction, per account. */
export function importCoverage(s: Snapshot) {
  const from = startOfMonth(addMonths(s.today, -11));
  const months = Array.from({ length: 12 }, (_, i) => addMonths(from, i).slice(0, 7));
  return s.accounts
    .filter((a) => !a.isArchived)
    .map((a) => {
      const seen = new Set<string>();
      let manual = 0;
      for (const t of s.transactions)
        if (t.bookingDate >= from && t.postings.some((p) => p.accountId === a.id)) {
          if (t.importRecordId) seen.add(t.bookingDate.slice(0, 7));
          else manual++;
        }
      return {
        account: a,
        months: months.map((k) => ({ month: k, imported: seen.has(k) })),
        manual,
      };
    });
}

export const sumMoney = (xs: Money[], cur: string) =>
  fromMinor(
    xs.reduce((a, m) => a + toMinor(m), 0n),
    cur,
  );
