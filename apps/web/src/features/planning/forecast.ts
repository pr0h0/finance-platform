// Forecast input from a Snapshot: today's balances, already-booked future transactions (certain)
// and plan occurrences (eventsFromPlans: matched/skipped/paid excluded, overdue moved to today).
import type * as D from '@finplat/domain';
import {
  accountBalances,
  addDays,
  fromMinor,
  type Money,
  type Notice,
  toMinor,
} from '@finplat/finance-engine';
import {
  eventsFromPlans,
  type Forecast,
  type ForecastEvent,
  type ForecastInput,
  forecast,
  type ScenarioAdjustment,
  whatIf,
} from '@finplat/forecasting';
import type { Snapshot } from '../analytics/snapshot.ts';

export function forecastInput(
  s: Snapshot,
  to: string,
  accountIds?: readonly string[],
): ForecastInput & { planWarnings: Notice[] } {
  const from = s.today;
  const wanted = (a: D.Account) => !a.isArchived && (accountIds ? accountIds.includes(a.id) : true);
  const accs = s.accounts.filter(wanted);
  const ids = new Set(accs.map((a) => a.id));
  const opening = accountBalances(s.ledger, addDays(from, -1));
  const accounts = accs.map((a) => {
    const b = opening.find((x) => x.accountId === a.id && x.currency === a.currency);
    return {
      id: a.id,
      name: a.name,
      currency: a.currency,
      balance: fromMinor(b ? toMinor(b) : 0n, a.currency),
      accountType: a.accountType,
      creditLimit: a.creditLimit,
      includeInSafeToSpend: a.includeInSafeToSpend,
    };
  });
  const events: ForecastEvent[] = [];
  for (const t of s.ledger) {
    if (t.bookingDate < from || t.bookingDate > to || t.status === 'void') continue;
    for (const p of t.postings)
      if (ids.has(p.accountId))
        events.push({
          date: t.bookingDate,
          accountId: p.accountId,
          amount: p.amount,
          confidence: 'certain',
          source: t.kind === 'transfer' || t.kind === 'fx' ? 'transfer' : 'planned',
          sourceId: t.id,
          description: t.description || t.payee || 'Booked transaction',
        });
  }
  const planned = eventsFromPlans(
    s.plans.filter((p) => !p.accountId || ids.has(p.accountId)),
    s.schedules,
    s.storedOccurrences,
    from,
    to,
  );
  events.push(...planned.events.filter((e) => ids.has(e.accountId)));
  // One notice per plan (eventsFromPlans repeats it for every occurrence).
  const planWarnings = [
    ...new Map(planned.warnings.map((w) => [`${w.key}|${JSON.stringify(w.vars)}`, w])).values(),
  ];
  const reserve = s.settings['forecast.minimumReserve'] as Money | undefined;
  return {
    from,
    to,
    currency: s.currency,
    accounts,
    events,
    convert: s.convert,
    reserve: reserve ?? null,
    planWarnings,
  };
}

// Plan problems (no account, transfer without destination) make the forecast incomplete.
const withPlanWarnings = (f: Forecast, w: readonly Notice[]): Forecast =>
  w.length ? { ...f, warnings: [...w, ...f.warnings], complete: false } : f;

export function buildForecast(s: Snapshot, to: string, accountIds?: readonly string[]): Forecast {
  const { planWarnings, ...input } = forecastInput(s, to, accountIds);
  return withPlanWarnings(forecast(input), planWarnings);
}

/** Simulation only: returns new forecasts, never writes (applyScenario copies the input). */
export function simulate(s: Snapshot, to: string, adjustments: readonly ScenarioAdjustment[]) {
  const { planWarnings, ...input } = forecastInput(s, to);
  const r = whatIf(input, adjustments);
  return {
    ...r,
    baseline: withPlanWarnings(r.baseline, planWarnings),
    scenario: withPlanWarnings(r.scenario, planWarnings),
  };
}
