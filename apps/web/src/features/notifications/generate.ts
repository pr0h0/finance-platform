// Smart notifications (features 31, 43, 81), generated on the device from the same data the pages
// show: bill reminders + overdue bills, budget thresholds, projected shortfall, trial endings,
// unusual expenses. Deduplicated by key, so running it repeatedly creates each one once.
import type * as D from '@finplat/domain';
import { addDays, detectAnomalies, startOfMonth } from '@finplat/finance-engine';
import { formatMoney } from '@finplat/localization';
import type { FinanceOps } from '@finplat/storage';
import type { Snapshot } from '../analytics/snapshot.ts';
import { buildForecast } from '../planning/forecast.ts';
import { occurrenceRows } from '../planning/occurrences.ts';

type NotifyInput = Parameters<FinanceOps['notify']>[0];

const DEFAULT_REMINDER_DAYS = 3;

export async function candidates(
  ops: FinanceOps,
  s: Snapshot,
  locale = 'en',
): Promise<NotifyInput[]> {
  const out: NotifyInput[] = [];
  const money = (m: D.Money) => formatMoney(m, locale);

  // bills: reminder window per plan, overdue (stored pending occurrence in the past)
  for (const r of occurrenceRows(s, s.today, addDays(s.today, 60))) {
    if (r.status !== 'pending' || r.plan.kind === 'income') continue;
    const days = r.plan.reminderDaysBefore ?? DEFAULT_REMINDER_DAYS;
    if (r.overdue)
      out.push({
        kind: 'bill_overdue',
        severity: 'warning',
        title: `Overdue: ${r.plan.description}`,
        body: `${money(r.amount)} was due on ${r.occurrenceDate} and is not marked paid or matched.`,
        data: { planId: r.plan.id, occurrenceDate: r.occurrenceDate, link: '/planning' },
        dedupeKey: `bill_overdue:${r.plan.id}:${r.occurrenceDate}`,
      });
    else if (r.date <= addDays(s.today, days))
      out.push({
        kind: 'bill_reminder',
        severity: 'info',
        title: `${r.plan.description} due ${r.date === s.today ? 'today' : `on ${r.date}`}`,
        body: `${money(r.amount)} is scheduled${r.plan.accountId ? ` from ${s.accounts.find((a) => a.id === r.plan.accountId)?.name ?? 'an account'}` : ''}.`,
        data: { planId: r.plan.id, occurrenceDate: r.occurrenceDate, link: '/planning' },
        dedupeKey: `bill_reminder:${r.plan.id}:${r.occurrenceDate}`,
      });
  }

  // budget thresholds in the current period
  const cat = new Map(s.categories.map((c) => [c.id, c.name]));
  for (const b of s.budgets) {
    if (b.isTemplate || b.isArchived || b.startDate > s.today || (b.endDate && b.endDate < s.today))
      continue;
    const st = await ops.budgetStatus(b.id, s.today).catch(() => null);
    for (const l of st?.lines ?? []) {
      if (!l.alert || !st) continue;
      const pct = Math.round(Number(l.alert) * 100);
      out.push({
        kind: 'budget_threshold',
        severity: Number(l.alert) >= 1 ? 'critical' : 'warning',
        title: `${b.name}: ${l.categoryId ? (cat.get(l.categoryId) ?? 'category') : 'overall'} at ${pct}%`,
        body: `${money(l.actual)} spent${b.includePlanned ? ` + ${money(l.planned)} committed` : ''} of ${money(l.limit)}; ${money(l.remaining)} remaining until ${st.periodEnd}.`,
        data: { budgetId: b.id, link: '/budgets' },
        dedupeKey: `budget:${b.id}:${st.periodStart}:${l.categoryId ?? 'all'}:${l.alert}`,
      });
    }
  }

  // projected shortfall in the next 30 days
  const fc = buildForecast(s, addDays(s.today, 30));
  for (const sf of fc.shortfalls)
    out.push({
      kind: 'projected_shortfall',
      severity: 'critical',
      title: `${s.accounts.find((a) => a.id === sf.accountId)?.name ?? 'An account'} may go below zero`,
      body: `Expected to drop to ${money(sf.amount)} from ${sf.date} with the current plans. This is a forecast, not a certainty.`,
      data: { accountId: sf.accountId, link: '/planning' },
      dedupeKey: `shortfall:${sf.accountId}:${sf.date}`,
    });

  // trials ending within 3 days
  for (const sub of s.subscriptions)
    if (
      sub.status === 'trial' &&
      sub.trialEndsAt &&
      sub.trialEndsAt >= s.today &&
      sub.trialEndsAt <= addDays(s.today, 3)
    )
      out.push({
        kind: 'trial_ending',
        severity: 'warning',
        title: `Trial of ${sub.name} ends ${sub.trialEndsAt}`,
        body: 'Cancel before then if you do not want to be charged.',
        data: { subscriptionId: sub.id, link: '/subscriptions' },
        dedupeKey: `trial:${sub.id}:${sub.trialEndsAt}`,
      });

  // unusual expenses this month (not dismissed)
  const dismissed = new Set(
    (s.settings['analytics.dismissedAnomalies'] as string[] | undefined) ?? [],
  );
  for (const a of detectAnomalies(s.ledger, {
    from: startOfMonth(s.today),
    to: s.today,
    currency: s.currency,
    convert: s.convert,
    dismissed,
  }))
    out.push({
      kind: 'unusual_expense',
      severity: 'warning',
      title: a.title,
      body: a.body,
      data: { ...a.data, link: '/analytics' },
      dedupeKey: a.id,
    });

  return out;
}

/** Create the missing notifications; returns the ones that are new. */
export async function generate(
  ops: FinanceOps,
  s: Snapshot,
  locale = 'en',
): Promise<D.Notification[]> {
  const existing = new Set(
    (await ops.listNotifications()).map(
      (n) => (n as D.Notification & { dedupeKey?: string }).dedupeKey,
    ),
  );
  const fresh: D.Notification[] = [];
  for (const c of await candidates(ops, s, locale)) {
    if (c.dedupeKey && existing.has(c.dedupeKey)) continue;
    fresh.push(await ops.notify(c));
  }
  return fresh;
}
