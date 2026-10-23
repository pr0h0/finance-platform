// Smart notifications (features 31, 43, 81), generated on the device from the same data the pages
// show: bill reminders + overdue bills, budget thresholds, projected shortfall, trial endings,
// unusual expenses. Deduplicated by key, so running it repeatedly creates each one once.
import type * as D from '@finplat/domain';
import { addDays, detectAnomalies, startOfMonth } from '@finplat/finance-engine';
import { formatMoney, formatPercent } from '@finplat/localization';
import type { FinanceOps } from '@finplat/storage';
import { tNow } from '../../lib/i18n.ts';
import type { Snapshot } from '../analytics/snapshot.ts';
import { insightText } from '../dashboard/compute.ts';
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
        title: tNow('notify.billOverdue.title', 'Overdue: {{name}}', { name: r.plan.description }),
        body: tNow(
          'notify.billOverdue.body',
          '{{amount}} was due on {{date}} and is not marked paid or matched.',
          { amount: money(r.amount), date: r.occurrenceDate },
        ),
        data: { planId: r.plan.id, occurrenceDate: r.occurrenceDate, link: '/planning' },
        dedupeKey: `bill_overdue:${r.plan.id}:${r.occurrenceDate}`,
      });
    else if (r.date <= addDays(s.today, days))
      out.push({
        kind: 'bill_reminder',
        severity: 'info',
        title:
          r.date === s.today
            ? tNow('notify.billReminder.titleToday', '{{name}} due today', {
                name: r.plan.description,
              })
            : tNow('notify.billReminder.titleOn', '{{name}} due on {{date}}', {
                name: r.plan.description,
                date: r.date,
              }),
        body: r.plan.accountId
          ? tNow('notify.billReminder.bodyFrom', '{{amount}} is scheduled from {{account}}.', {
              amount: money(r.amount),
              account:
                s.accounts.find((a) => a.id === r.plan.accountId)?.name ??
                tNow('notify.anAccount', 'an account'),
            })
          : tNow('notify.billReminder.body', '{{amount}} is scheduled.', {
              amount: money(r.amount),
            }),
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
        title: tNow('notify.budget.title', '{{budget}}: {{scope}} at {{pct}}%', {
          budget: b.name,
          scope: l.categoryId
            ? (cat.get(l.categoryId) ?? tNow('notify.budget.category', 'category'))
            : tNow('notify.budget.overall', 'overall'),
          pct,
        }),
        body: b.includePlanned
          ? tNow(
              'notify.budget.bodyPlanned',
              '{{actual}} spent + {{planned}} committed of {{limit}}; {{remaining}} remaining until {{end}}.',
              {
                actual: money(l.actual),
                planned: money(l.planned),
                limit: money(l.limit),
                remaining: money(l.remaining),
                end: st.periodEnd,
              },
            )
          : tNow(
              'notify.budget.body',
              '{{actual}} spent of {{limit}}; {{remaining}} remaining until {{end}}.',
              {
                actual: money(l.actual),
                limit: money(l.limit),
                remaining: money(l.remaining),
                end: st.periodEnd,
              },
            ),
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
      title: tNow('notify.shortfall.title', '{{account}} may go below zero', {
        account:
          s.accounts.find((a) => a.id === sf.accountId)?.name ??
          tNow('common.anAccount', 'An account'),
      }),
      body: tNow(
        'notify.shortfall.body',
        'Expected to drop to {{amount}} from {{date}} with the current plans. This is a forecast, not a certainty.',
        { amount: money(sf.amount), date: sf.date },
      ),
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
        title: tNow('notify.trial.title', 'Trial of {{name}} ends {{date}}', {
          name: sub.name,
          date: sub.trialEndsAt,
        }),
        body: tNow('notify.trial.body', 'Cancel before then if you do not want to be charged.'),
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
      ...insightText(tNow, { money, percent: (f) => formatPercent(f, locale) }, a),
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
