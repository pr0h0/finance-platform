// Forecasting engine (PLAN §44, §66–75): pure functions over dated events, used by the web app in
// local mode. The Go forecasting module mirrors these rules (conformance/forecast.json).
//
// Scenario rules for a dated event with magnitude a (optional amountMin/amountMax):
//   expected:     included when confidence is certain|expected; amount a.
//   conservative: income only when certain (amountMin ?? a); expenses always (amountMax ?? a).
//   optimistic:   income always (amountMax ?? a); expenses only when certain|expected (amountMin ?? a).
//   transfers (both legs) use the expected rule in every scenario so moving money between included
//   accounts never changes the total.
// Balances: account.balance is the balance before any event on `from`. Each day's value is the
// end-of-day balance. Totals are in the reporting currency at the rate on `from` (constant-rate
// assumption); accounts without a rate are left out and the forecast is marked incomplete.
// lowest = minimum expected total (earliest on ties). Shortfalls = per account, each run of days
// with expected balance below its floor (0, or -creditLimit for liabilities with a limit;
// liabilities without a limit never alert): {first date, lowest balance in the run}.
// monthEnd = expected total on the last day of from's month (or `to` if earlier).
// safeToSpend = max(0, min conservative total over safe-to-spend accounts from `from` through
// safeToSpendUntil - reserve); safeToSpendUntil = the day before the first expected income after
// `from` (positive, certain|expected, not a transfer leg or what-if), capped at from+31 days and `to`.

import type { Confidence } from '@finplat/domain';
import {
  addDays,
  addMonths,
  annualize,
  dateRange,
  diffDays,
  divRound,
  endOfMonth,
  expandRecurrence,
  flows,
  formatDecimal,
  fromMinor,
  type LedgerTransaction,
  LIABILITY_TYPES,
  type Money,
  type Notice,
  type PlanLike,
  parseDate,
  planOccurrences,
  pow10,
  type ScheduleLike,
  type StoredOccurrence,
  startOfMonth,
  type ToReporting,
  toMinor,
} from '@finplat/finance-engine';

export interface ForecastEvent {
  date: string;
  accountId: string;
  amount: Money; // signed, in the account currency
  amountMin?: Money | null; // positive magnitudes
  amountMax?: Money | null;
  confidence: Confidence;
  source: 'planned' | 'recurring' | 'installment' | 'transfer' | 'goal' | 'scenario';
  sourceId: string;
  description: string;
}

export interface ForecastAccount {
  id: string;
  currency: string;
  balance: Money;
  accountType?: string;
  creditLimit?: Money | null;
  includeInSafeToSpend?: boolean;
  /** Shown in warnings instead of the id. */
  name?: string;
}

export interface ForecastInput {
  from: string;
  to: string;
  currency: string;
  accounts: readonly ForecastAccount[];
  events: readonly ForecastEvent[];
  convert: ToReporting;
  reserve?: Money | null;
}

export interface ForecastDay {
  date: string;
  expected: Money;
  conservative: Money;
  optimistic: Money;
  events: { description: string; amount: Money; confidence: Confidence; sourceId: string }[];
}

export interface Forecast {
  currency: string;
  from: string;
  to: string;
  days: ForecastDay[];
  lowest: { date: string; amount: Money };
  shortfalls: { date: string; amount: Money; accountId: string }[];
  monthEnd: Money;
  safeToSpend: Money;
  safeToSpendUntil: string;
  assumptions: string[];
  complete: boolean;
  warnings: Notice[];
}

type Scenario = 'expected' | 'conservative' | 'optimistic';
const SCENARIOS: Scenario[] = ['expected', 'conservative', 'optimistic'];

/** Signed amount of `e` in a scenario, or null when excluded. */
export function scenarioAmount(e: ForecastEvent, s: Scenario): bigint | null {
  const v = toMinor(e.amount);
  const likely = e.confidence === 'certain' || e.confidence === 'expected';
  if (s === 'expected' || e.source === 'transfer') return likely ? v : null;
  const income = v > 0n;
  const pick = (m: Money | null | undefined) => (m ? (income ? 1n : -1n) * toMinor(m) : v);
  if (s === 'conservative') {
    if (income) return e.confidence === 'certain' ? pick(e.amountMin) : null;
    return pick(e.amountMax);
  }
  if (income) return pick(e.amountMax);
  return likely ? pick(e.amountMin) : null;
}

const isIncome = (e: ForecastEvent) =>
  toMinor(e.amount) > 0n &&
  (e.confidence === 'certain' || e.confidence === 'expected') &&
  e.source !== 'transfer' &&
  e.source !== 'scenario';

/** Safe-to-spend horizon: the day before the first expected income after `from`, ≤ from+31, ≤ to. */
export function safeUntil(from: string, to: string, events: readonly ForecastEvent[]): string {
  const cap = addDays(from, 31);
  let until = cap < to ? cap : to;
  for (const e of events)
    if (isIncome(e) && e.date > from && e.date <= to) {
      const d = addDays(e.date, -1);
      if (d < until) until = d;
    }
  return until;
}

export function forecast(input: ForecastInput): Forecast {
  const { from, to, currency } = input;
  if (to < from) throw new Error('forecast: to < from');
  const days = dateRange(from, to);
  const warnings: Notice[] = [];
  const accIndex = new Map(input.accounts.map((a, i) => [a.id, i]));
  // deltas[scenario][account] = Map<date, bigint>
  const deltas = SCENARIOS.map(() => input.accounts.map(() => new Map<string, bigint>()));
  const dayEvents = new Map<string, ForecastDay['events']>();
  for (const e of input.events) {
    if (e.date < from || e.date > to) continue;
    const ai = accIndex.get(e.accountId);
    const acc = ai === undefined ? undefined : input.accounts[ai];
    if (ai === undefined || !acc) {
      warnings.push({
        key: 'engine.forecast.eventNoAccount',
        en: '"{{description}}" on {{date}} is left out: its account is not in the forecast.',
        vars: { description: e.description, date: e.date },
      });
      continue;
    }
    if (e.amount.currency !== acc.currency) {
      warnings.push({
        key: 'engine.forecast.eventCurrency',
        en: '"{{description}}" on {{date}} is left out: its currency differs from the account.',
        vars: { description: e.description, date: e.date },
      });
      continue;
    }
    SCENARIOS.forEach((s, si) => {
      const v = scenarioAmount(e, s);
      if (v === null) return;
      const m = deltas[si]?.[ai] as Map<string, bigint>;
      m.set(e.date, (m.get(e.date) ?? 0n) + v);
    });
    const list = dayEvents.get(e.date) ?? [];
    list.push({
      description: e.description,
      amount: e.amount,
      confidence: e.confidence,
      sourceId: e.sourceId,
    });
    dayEvents.set(e.date, list);
  }

  // Per account, per scenario: end-of-day balances (account currency minor units).
  const series = SCENARIOS.map((_, si) =>
    input.accounts.map((a, ai) => {
      let bal = toMinor(a.balance);
      const m = deltas[si]?.[ai] as Map<string, bigint>;
      return days.map((d) => {
        bal += m.get(d) ?? 0n;
        return bal;
      });
    }),
  );

  // Conversion: one rate per account (at `from`), applied to each day's balance.
  const toRep = input.accounts.map((a) => {
    if (a.currency === currency) return (v: bigint) => v;
    const probe = input.convert(
      { amount: fromMinor(0n, a.currency).amount, currency: a.currency },
      from,
    );
    if (!probe) {
      warnings.push({
        key: 'engine.forecast.accountNoRate',
        en: 'Account "{{name}}" is left out: no {{from}}/{{to}} rate.',
        vars: { name: a.name ?? a.currency, from: a.currency, to: currency },
      });
      return null;
    }
    return (v: bigint) => toMinor(input.convert(fromMinor(v, a.currency), from) as Money);
  });
  const total = (si: number, di: number, only?: (a: ForecastAccount) => boolean) => {
    let t = 0n;
    input.accounts.forEach((a, ai) => {
      const f = toRep[ai];
      if (!f || (only && !only(a))) return;
      t += f(series[si]?.[ai]?.[di] as bigint);
    });
    return t;
  };

  const out: ForecastDay[] = days.map((date, di) => ({
    date,
    expected: fromMinor(total(0, di), currency),
    conservative: fromMinor(total(1, di), currency),
    optimistic: fromMinor(total(2, di), currency),
    events: dayEvents.get(date) ?? [],
  }));

  let lowIdx = 0;
  out.forEach((d, i) => {
    if (toMinor(d.expected) < toMinor((out[lowIdx] as ForecastDay).expected)) lowIdx = i;
  });

  const shortfalls: Forecast['shortfalls'] = [];
  input.accounts.forEach((a, ai) => {
    const liability = LIABILITY_TYPES.includes(a.accountType ?? '');
    if (liability && !a.creditLimit) return;
    const floor = liability && a.creditLimit ? -toMinor(a.creditLimit) : 0n;
    const s = series[0]?.[ai] as bigint[];
    let run: { date: string; min: bigint } | null = null;
    s.forEach((v, di) => {
      if (v < floor) {
        if (!run) run = { date: days[di] as string, min: v };
        else if (v < run.min) run.min = v;
      } else if (run) {
        shortfalls.push({
          date: run.date,
          amount: fromMinor(run.min, a.currency),
          accountId: a.id,
        });
        run = null;
      }
    });
    const r = run as { date: string; min: bigint } | null;
    if (r) shortfalls.push({ date: r.date, amount: fromMinor(r.min, a.currency), accountId: a.id });
  });
  shortfalls.sort((x, y) =>
    x.date < y.date ? -1 : x.date > y.date ? 1 : x.accountId.localeCompare(y.accountId),
  );

  // biome-ignore lint/complexity/useMathMinMax: compares strings (ids/ISO dates), not numbers
  const meDate = endOfMonth(from) < to ? endOfMonth(from) : to;
  const meIdx = diffDays(meDate, from);
  const safe = (a: ForecastAccount) => a.includeInSafeToSpend !== false;
  const until = safeUntil(from, to, input.events);
  let minCons: bigint | null = null;
  for (let di = 0; di < days.length && (days[di] as string) <= until; di++) {
    const v = total(1, di, safe);
    if (minCons === null || v < minCons) minCons = v;
  }
  const reserve = input.reserve
    ? toMinor(reserveIn(input.reserve, currency, input.convert, from, warnings))
    : 0n;
  const sts = (minCons ?? 0n) - reserve;

  return {
    currency,
    from,
    to,
    days: out,
    lowest: {
      date: (out[lowIdx] as ForecastDay).date,
      amount: (out[lowIdx] as ForecastDay).expected,
    },
    shortfalls,
    monthEnd: (out[meIdx] as ForecastDay).expected,
    safeToSpend: fromMinor(sts > 0n ? sts : 0n, currency),
    safeToSpendUntil: until,
    assumptions: [
      'Starting balances are current ledger balances before any event on the start date.',
      'Expected: certain and expected events at their planned amounts.',
      'Conservative: only certain income (at its minimum); every expense, including possible and speculative ones, at its maximum.',
      'Optimistic: all income at its maximum; only certain and expected expenses at their minimum.',
      `Foreign-currency balances are converted to ${currency} at the ${from} rate for the whole period.`,
      'Planned occurrences already matched, skipped or paid are not counted again.',
      `Safe-to-spend = lowest conservative balance of safe-to-spend accounts through ${until} (the day before the next expected income, at most 31 days) minus the reserve.`,
      'Forecasts are estimates, not guaranteed outcomes.',
    ],
    complete: warnings.length === 0,
    warnings,
  };
}

function reserveIn(
  r: Money,
  cur: string,
  convert: ToReporting,
  date: string,
  warnings: Notice[],
): Money {
  if (r.currency === cur) return r;
  const v = convert(r, date);
  if (!v) {
    warnings.push({
      key: 'engine.forecast.reserveNoRate',
      en: 'The minimum reserve is ignored: no {{from}}/{{to}} rate.',
      vars: { from: r.currency, to: cur },
    });
    return fromMinor(0n, cur);
  }
  return v;
}

/**
 * Forecast events from plans: income +amount on accountId, expense -amount, transfer -amount on
 * accountId and +amount on toAccountId. Uses planOccurrences (matched/skipped/paid occurrences are
 * excluded; stored pending occurrences before `from` are moved to `from` as overdue).
 */
export function eventsFromPlans(
  plans: readonly PlanLike[],
  schedules: readonly ScheduleLike[],
  stored: readonly StoredOccurrence[],
  from: string,
  to: string,
): { events: ForecastEvent[]; warnings: Notice[] } {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const events: ForecastEvent[] = [];
  const warnings: Notice[] = [];
  for (const o of planOccurrences(plans, schedules, stored, from, to, { includeOverdue: true })) {
    const p = byId.get(o.planId) as PlanLike;
    if (!p.accountId) {
      warnings.push({
        key: 'engine.forecast.planNoAccount',
        en: 'Plan "{{description}}" has no account and is not forecast.',
        vars: { description: p.description },
      });
      continue;
    }
    const source =
      p.kind === 'transfer'
        ? 'transfer'
        : p.installmentTotal
          ? 'installment'
          : p.recurrenceId
            ? 'recurring'
            : 'planned';
    const base = {
      date: o.date,
      confidence: p.confidence,
      source,
      sourceId: p.id,
      description: o.overdue
        ? `${p.description} (overdue since ${o.occurrenceDate})`
        : p.description,
      amountMin: p.amountMin ?? null,
      amountMax: p.amountMax ?? null,
    } as const;
    const neg = fromMinor(-toMinor(o.amount), o.amount.currency);
    if (p.kind === 'income') events.push({ ...base, accountId: p.accountId, amount: o.amount });
    else events.push({ ...base, accountId: p.accountId, amount: neg });
    if (p.kind === 'transfer') {
      if (p.toAccountId) events.push({ ...base, accountId: p.toAccountId, amount: o.amount });
      else
        warnings.push({
          key: 'engine.forecast.transferNoDestination',
          en: 'Transfer plan "{{description}}" has no destination account.',
          vars: { description: p.description },
        });
    }
  }
  return { events, warnings };
}

// ---------------------------------------------------------------- what-if

export interface ScenarioAdjustment {
  description?: string;
  amount?: Money; // signed
  date?: string;
  rrule?: string;
  accountId?: string;
  removePlannedTransactionId?: string;
}

/**
 * Apply hypothetical changes to a forecast input, returning a NEW input (inputs are never
 * mutated; real records are never touched). Removals drop every event of that plan; additions are
 * one-off at `date` or recurring by `rrule` starting at `date` (certain confidence).
 */
export function applyScenario(
  input: ForecastInput,
  adjustments: readonly ScenarioAdjustment[],
): ForecastInput {
  const removed = new Set(
    adjustments.flatMap((a) =>
      a.removePlannedTransactionId ? [a.removePlannedTransactionId] : [],
    ),
  );
  const events: ForecastEvent[] = input.events.filter((e) => !removed.has(e.sourceId));
  adjustments.forEach((a, i) => {
    if (!a.amount || !a.accountId) return;
    const start = a.date ?? input.from;
    const dates = a.rrule
      ? expandRecurrence({ rrule: a.rrule, startDate: start }, input.from, input.to).map(
          (o) => o.dueDate,
        )
      : [start];
    for (const date of dates)
      events.push({
        date,
        accountId: a.accountId,
        amount: a.amount,
        confidence: 'certain',
        source: 'scenario',
        sourceId: `scenario:${i}`,
        description: a.description ?? 'What-if',
      });
  });
  return { ...input, events };
}

export interface WhatIfResult {
  baseline: Forecast;
  scenario: Forecast;
  delta: { lowest: Money; monthEnd: Money; safeToSpend: Money; end: Money };
}

export function whatIf(
  input: ForecastInput,
  adjustments: readonly ScenarioAdjustment[],
): WhatIfResult {
  const baseline = forecast(input);
  const scenario = forecast(applyScenario(input, adjustments));
  const d = (a: Money, b: Money) => fromMinor(toMinor(b) - toMinor(a), a.currency);
  const last = (f: Forecast) => (f.days[f.days.length - 1] as ForecastDay).expected;
  return {
    baseline,
    scenario,
    delta: {
      lowest: d(baseline.lowest.amount, scenario.lowest.amount),
      monthEnd: d(baseline.monthEnd, scenario.monthEnd),
      safeToSpend: d(baseline.safeToSpend, scenario.safeToSpend),
      end: d(last(baseline), last(scenario)),
    },
  };
}

// ---------------------------------------------------------------- goals

export interface GoalInput {
  targetAmount: Money;
  startingAmount: Money;
  targetDate: string | null;
}

export interface GoalProjection {
  saved: Money;
  remaining: Money;
  progress: string; // saved / target, 4 decimals half_up
  estimatedCompletionDate: string | null;
  basis: 'complete' | 'plan' | 'history' | 'none';
  onTrack: boolean | null;
  requiredMonthly: Money | null;
}

/**
 * Goal progress and completion estimate. saved = startingAmount + contributions dated <= asOf
 * (withdrawals are negative). Estimate: with a planned contribution schedule, the first planned
 * date where the cumulative total reaches the target (searched up to 100 years); otherwise the
 * average of the last 3 months of contributions (asOf-3 months, asOf], projected in whole months.
 * requiredMonthly = remaining / whole months until targetDate (min 1), rounded up.
 */
export function projectGoal(
  goal: GoalInput,
  contributions: readonly { amount: Money; contributionDate: string }[],
  asOf: string,
  plan?: { amount: Money; rrule: string; startDate: string } | null,
): GoalProjection {
  const cur = goal.targetAmount.currency;
  let saved = toMinor(goal.startingAmount);
  let recent = 0n;
  const recentFrom = addMonths(asOf, -3);
  for (const c of contributions) {
    if (c.contributionDate > asOf || c.amount.currency !== cur) continue;
    const v = toMinor(c.amount);
    saved += v;
    if (c.contributionDate > recentFrom) recent += v;
  }
  const target = toMinor(goal.targetAmount);
  const remaining = target - saved > 0n ? target - saved : 0n;
  let est: string | null = null;
  let basis: GoalProjection['basis'] = 'none';
  if (remaining === 0n) {
    est = asOf;
    basis = 'complete';
  } else if (plan && plan.amount.currency === cur && toMinor(plan.amount) > 0n) {
    const per = toMinor(plan.amount);
    const start = plan.startDate > asOf ? plan.startDate : addDays(asOf, 1);
    const p = parseDate(asOf);
    const occ = expandRecurrence(
      { rrule: plan.rrule, startDate: plan.startDate },
      start,
      `${p.y + 100}-12-31`,
      Number((remaining + per - 1n) / per),
    );
    const needed = Number((remaining + per - 1n) / per);
    if (occ.length >= needed) {
      est = (occ[needed - 1] as { dueDate: string }).dueDate;
      basis = 'plan';
    }
  } else if (recent > 0n) {
    const months = divRound(remaining * 3n, recent, 'ceiling');
    est = addMonths(asOf, Number(months));
    basis = 'history';
  }
  let requiredMonthly: Money | null = null;
  if (goal.targetDate && goal.targetDate > asOf) {
    const a = parseDate(asOf);
    const t = parseDate(goal.targetDate);
    const months = Math.max(1, (t.y - a.y) * 12 + (t.m - a.m));
    requiredMonthly = fromMinor(divRound(remaining, BigInt(months), 'ceiling'), cur);
  }
  return {
    saved: fromMinor(saved, cur),
    remaining: fromMinor(remaining, cur),
    progress:
      target > 0n
        ? formatDecimal({ units: divRound(saved * pow10(4), target, 'half_up'), scale: 4 })
        : '1.0000',
    estimatedCompletionDate: est,
    basis,
    onTrack: goal.targetDate && est ? est <= goal.targetDate : goal.targetDate ? false : null,
    requiredMonthly,
  };
}

// ---------------------------------------------------------------- emergency fund

/** Months of essential expenses the reserve covers: 1 decimal, rounded down; null if no expenses. */
export function emergencyFundMonths(reserve: Money, monthlyEssential: Money): string | null {
  if (reserve.currency !== monthlyEssential.currency) throw new Error('currency mismatch');
  const e = toMinor(monthlyEssential);
  if (e <= 0n) return null;
  return formatDecimal({ units: divRound(toMinor(reserve) * 10n, e, 'floor'), scale: 1 });
}

/** Monthly equivalent of active recurring expense plans with priority "essential". */
export function essentialMonthlyFromPlans(
  plans: readonly PlanLike[],
  schedules: readonly ScheduleLike[],
  currency: string,
  convert: ToReporting,
  asOf: string,
): { monthly: Money; complete: boolean } {
  const sched = new Map(schedules.map((s) => [s.id, s]));
  let t = 0n;
  let complete = true;
  for (const p of plans) {
    if (p.status !== 'active' || p.deletedAt || p.kind !== 'expense' || p.priority !== 'essential')
      continue;
    const s = p.recurrenceId ? sched.get(p.recurrenceId) : undefined;
    if (!s) continue;
    const m = convert(annualize(p.amount, s.rrule).monthly, asOf);
    if (!m) complete = false;
    else t += toMinor(m);
  }
  return { monthly: fromMinor(t, currency), complete };
}

/** Average monthly net spending over the `months` full calendar months before asOf's month. */
export function averageMonthlySpending(
  txs: readonly LedgerTransaction[],
  opts: {
    asOf: string;
    months: number;
    currency: string;
    convert: ToReporting;
    categoryIds?: readonly string[];
  },
): { monthly: Money; complete: boolean } {
  const end = addDays(startOfMonth(opts.asOf), -1);
  const from = addMonths(startOfMonth(opts.asOf), -opts.months);
  const cats = opts.categoryIds ? new Set(opts.categoryIds) : null;
  const r = flows(txs, { from, to: end, currency: opts.currency, convert: opts.convert });
  let t = 0n;
  for (const f of r.flows)
    if (f.kind === 'spending' && (!cats || (f.categoryId && cats.has(f.categoryId))))
      t += toMinor(f.amount);
  return {
    monthly: fromMinor(divRound(t, BigInt(opts.months), 'half_up'), opts.currency),
    complete: r.missingRates.length === 0,
  };
}
