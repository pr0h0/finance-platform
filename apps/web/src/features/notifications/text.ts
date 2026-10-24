// Server notifications carry a stable code + params (apps/api/internal/notifications Generate); they are
// rendered here in the UI language. Unknown codes and local notifications keep their stored title/body.
import type * as D from '@finplat/domain';
import type { TFn } from '../../lib/i18n.ts';

type Vars = Record<string, string | number>;
type Fmt = { money: (m: D.Money) => string; date: (d: string) => string };

const unusual = (t: TFn, p: Vars) =>
  t('notification.unusual_expense.title', 'Unusual expense: {{name}}', p);

const TEXT: Record<string, (t: TFn, p: Vars) => { title: string; body: string }> = {
  bill_overdue: (t, p) => ({
    title: t('notification.bill_overdue.title', 'Overdue: {{name}}', p),
    body: t(
      'notification.bill_overdue.body',
      '{{amount}} was due on {{date}}. Match the payment, mark it paid or skip it.',
      p,
    ),
  }),
  bill_due_today: (t, p) => ({
    title: t('notification.bill_due_today.title', '{{name}} due today', p),
    body: t('notification.bill_due_today.body', '{{amount}} is scheduled today.', p),
  }),
  bill_due_tomorrow: (t, p) => ({
    title: t('notification.bill_due_tomorrow.title', '{{name}} due tomorrow', p),
    body: t('notification.bill_due_tomorrow.body', '{{amount}} is scheduled tomorrow.', p),
  }),
  bill_due: (t, p) => ({
    title: t('notification.bill_due.title', '{{name}} due on {{date}}', p),
    body: t('notification.bill_due.body', '{{amount}} is scheduled on {{date}}.', p),
  }),
  budget_threshold: (t, p) => ({
    title: t('notification.budget_threshold.title', '{{budget}}: budget threshold reached', p),
    body: t(
      'notification.budget_threshold.body',
      'Spent {{actual}} of {{limit}} ({{utilization}}% used, alert at {{threshold}}%).',
      p,
    ),
  }),
  low_balance: (t, p) => ({
    title: t('notification.low_balance.title', 'Balance projected below zero on {{date}}', p),
    body: t(
      'notification.low_balance.body',
      'An account is expected to reach {{amount}} on {{date}} based on planned payments.',
      p,
    ),
  }),
  trial_ending: (t, p) => ({
    title: t('notification.trial_ending.title', '{{name}} trial ends {{date}}', p),
    body: t(
      'notification.trial_ending.body',
      'Cancel before then if you do not want to be charged.',
      p,
    ),
  }),
  'unusual_expense.large_for_category': (t, p) => ({
    title: unusual(t, p),
    body: t(
      'notification.unusual_expense.large_for_category.body',
      '{{amount}} is more than 3x the typical amount (median {{baseline}}) for this category over the previous 180 days ({{count}} expenses).',
      p,
    ),
  }),
  'unusual_expense.new_merchant_large': (t, p) => ({
    title: unusual(t, p),
    body: t(
      'notification.unusual_expense.new_merchant_large.body',
      'First payment to this merchant in a year, and {{amount}} is more than 2x your typical expense (median {{baseline}}).',
      p,
    ),
  }),
  sync_conflict: (t, p) => ({
    title: t('notification.sync_conflict.title', 'Sync conflicts need your decision: {{count}}', p),
    body: t(
      'notification.sync_conflict.body',
      'Changes from different devices touched the same records. Review them on the Sync page.',
      p,
    ),
  }),
};

/** title/body of a notification in the UI language (money and YYYY-MM-DD params formatted). */
export function notificationText<
  N extends Pick<D.Notification, 'title' | 'body' | 'code' | 'params'>,
>(n: N, t: TFn, fmt: Fmt): N {
  const text = n.code ? TEXT[n.code] : undefined;
  if (!text) return n;
  const vars: Vars = {};
  for (const [k, v] of Object.entries(n.params ?? {}))
    vars[k] =
      typeof v === 'object'
        ? fmt.money(v)
        : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
          ? fmt.date(v)
          : v;
  return { ...n, ...text(t, vars) };
}
