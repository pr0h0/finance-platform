// Savings goals: progress + completion estimate (forecasting.projectGoal) and emergency fund
// coverage (months of essential expenses the reserve covers).
import type * as D from '@finplat/domain';
import { fromMinor, type Money, toMinor } from '@finplat/finance-engine';
import {
  averageMonthlySpending,
  emergencyFundMonths,
  essentialMonthlyFromPlans,
  projectGoal,
} from '@finplat/forecasting';
import type { Snapshot } from '../analytics/snapshot.ts';

/** A recurring transfer plan into the goal's account = its planned contribution schedule. */
export function contributionPlan(s: Snapshot, g: D.SavingsGoal) {
  if (!g.accountId) return null;
  const p = s.plans.find(
    (x) =>
      x.status === 'active' &&
      x.kind === 'transfer' &&
      x.toAccountId === g.accountId &&
      x.recurrenceId,
  );
  const sc = p && s.schedules.find((x) => x.id === p.recurrenceId);
  return p && sc ? { plan: p, amount: p.amount, rrule: sc.rrule, startDate: sc.startDate } : null;
}

export function goalRows(s: Snapshot) {
  return s.goals.map((g) => {
    const contributions = s.contributions
      .filter((c) => c.goalId === g.id)
      .sort((a, b) => b.contributionDate.localeCompare(a.contributionDate));
    const plan = contributionPlan(s, g);
    return {
      goal: g,
      contributions,
      plan,
      projection: projectGoal(g, contributions, s.today, plan),
    };
  });
}

/**
 * Emergency fund: reserve = saved amount of emergency_fund goals (in the reporting currency);
 * monthly essentials = active recurring essential expense plans, else 6-month average spending.
 */
export function emergencyFund(s: Snapshot) {
  let reserve = 0n;
  let complete = true;
  for (const r of goalRows(s)) {
    if (r.goal.kind !== 'emergency_fund' || r.goal.status === 'cancelled') continue;
    const v = s.convert(r.projection.saved, s.today);
    if (v) reserve += toMinor(v);
    else complete = false;
  }
  const reserveMoney = fromMinor(reserve, s.currency);
  const ess = essentialMonthlyFromPlans(s.plans, s.schedules, s.currency, s.convert, s.today);
  let monthly: Money = ess.monthly;
  let basis: 'essential_plans' | 'average_spending' = 'essential_plans';
  if (toMinor(monthly) === 0n) {
    const avg = averageMonthlySpending(s.ledger, {
      asOf: s.today,
      months: 6,
      currency: s.currency,
      convert: s.convert,
    });
    monthly = avg.monthly;
    basis = 'average_spending';
    complete &&= avg.complete;
  } else complete &&= ess.complete;
  const target = s.goals.find((g) => g.kind === 'emergency_fund')?.emergencyMonths ?? null;
  return {
    reserve: reserveMoney,
    monthly,
    basis,
    months: emergencyFundMonths(reserveMoney, monthly),
    target,
    complete,
  };
}
