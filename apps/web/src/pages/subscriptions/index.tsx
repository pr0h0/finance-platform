// Subscriptions (features 29, 60, 80): price, frequency, next payment, annualized cost,
// cancellation status; recurring charges detected from history can be accepted.
import { SUBSCRIPTION_STATUSES, type Subscription } from '@finplat/domain';
import { detectRecurring, type RecurringCandidate } from '@finplat/finance-engine';
import { Pencil, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useOpsMutation, useSnapshot } from '../../features/analytics/hooks.ts';
import { type Snapshot, todayIso } from '../../features/analytics/snapshot.ts';
import {
  Amount,
  Button,
  Card,
  DataBanner,
  Dialog,
  Empty,
  ErrorText,
  Field,
  Input,
  Loading,
  Page,
  parseMoneyInput,
  Select,
  Stat,
} from '../../features/analytics/ui.tsx';
import { subscriptionCosts } from '../../features/dashboard/compute.ts';
import { describeRRule } from '../../features/planning/rrule.ts';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';

const FREQS = [
  ['FREQ=WEEKLY', 'Weekly'],
  ['FREQ=MONTHLY', 'Monthly'],
  ['FREQ=MONTHLY;INTERVAL=3', 'Quarterly'],
  ['FREQ=MONTHLY;INTERVAL=6', 'Every 6 months'],
  ['FREQ=YEARLY', 'Yearly'],
] as const;

type Draft = { sub?: Subscription; candidate?: RecurringCandidate };

export default function SubscriptionsPage() {
  const t = useT();
  const snap = useSnapshot();
  const f = useFormat();
  const [edit, setEdit] = useState<Draft | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  if (snap.error)
    return (
      <Page title={t('subscriptions.page.subscriptions', 'Subscriptions')}>
        <ErrorText error={snap.error} />
      </Page>
    );
  if (!snap.data) return <Loading />;
  const s = snap.data;
  const c = subscriptionCosts(s);
  const tracked = new Set(s.plans.map((p) => p.description.toLowerCase()));
  const trackedMerchants = new Set(s.plans.map((p) => p.merchantId).filter(Boolean));
  const candidates = detectRecurring(s.ledger, s.today).filter(
    (x) =>
      x.kind === 'expense' &&
      !tracked.has(x.description.toLowerCase()) &&
      !(x.merchantId && trackedMerchants.has(x.merchantId)) &&
      !dismissed.includes(x.transactionIds.join()),
  );
  const order = { active: 0, trial: 1, paused: 2, cancelled: 3 } as const;
  const rows = [...c.rows].sort(
    (a, b) => order[a.sub.status] - order[b.sub.status] || a.sub.name.localeCompare(b.sub.name),
  );
  return (
    <Page
      title={t('subscriptions.page.subscriptions', 'Subscriptions')}
      actions={
        <Button variant="primary" onClick={() => setEdit({})}>
          <Plus aria-hidden className="size-4" />{' '}
          {t('subscriptions.page.addSubscription', 'Add subscription')}
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Stat
            label={t('subscriptions.page.monthlyEquivalent', 'Monthly equivalent')}
            value={<Amount value={c.monthly} />}
          />
        </Card>
        <Card>
          <Stat
            label={t('subscriptions.page.annualCost', 'Annual cost')}
            value={<Amount value={c.annual} />}
          />
        </Card>
        <Card>
          <Stat
            label={t('subscriptions.page.active', 'Active')}
            value={rows.filter((r) => r.sub.status === 'active' || r.sub.status === 'trial').length}
          />
        </Card>
        <Card>
          <Stat
            label={t('subscriptions.page.cancelled', 'Cancelled')}
            value={rows.filter((r) => r.sub.status === 'cancelled').length}
          />
        </Card>
      </div>
      {!c.complete && (
        <DataBanner
          warnings={[
            t(
              'subscriptions.page.noRateNotInTotals',
              'Some subscriptions have no exchange rate to {{currency}} and are not in the totals.',
              { currency: s.currency },
            ),
          ]}
        />
      )}
      <Card title={t('subscriptions.page.trackedSubscriptions', 'Tracked subscriptions')}>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-1">{t('account.name', 'Name')}</th>
                  <th>{t('subscriptions.page.price', 'Price')}</th>
                  <th>{t('subscriptions.page.billing', 'Billing')}</th>
                  <th>{t('subscriptions.page.nextPayment', 'Next payment')}</th>
                  <th>{t('sync.status', 'Status')}</th>
                  <th className="text-right">{t('subscriptions.page.perMonth', 'Per month')}</th>
                  <th className="text-right">{t('subscriptions.page.perYear', 'Per year')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.sub.id}
                    className={`border-b border-line/60 ${r.sub.status === 'cancelled' ? 'text-muted' : ''}`}
                  >
                    <td className="py-1.5">
                      {r.sub.url ? (
                        <a
                          className="hover:underline"
                          href={r.sub.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {r.sub.name}
                        </a>
                      ) : (
                        r.sub.name
                      )}
                    </td>
                    <td>
                      <Amount value={r.plan?.amount} />
                    </td>
                    <td className="text-xs">
                      {r.schedule ? describeRRule(r.schedule.rrule) : '—'}
                    </td>
                    <td>{r.next ? f.date(r.next.date) : '—'}</td>
                    <td>
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                        {r.sub.status}
                      </span>
                      {r.sub.status === 'trial' && r.sub.trialEndsAt && (
                        <span className="block text-[10px] text-warn">
                          {t('subscriptions.page.trialEndsDate', 'trial ends {{date}}', {
                            date: f.date(r.sub.trialEndsAt),
                          })}
                        </span>
                      )}
                      {r.sub.status === 'cancelled' && r.sub.cancelledAt && (
                        <span className="block text-[10px]">
                          {t('subscriptions.page.sinceDate', 'since {{date}}', {
                            date: f.date(r.sub.cancelledAt),
                          })}
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      <Amount value={r.cost?.monthly} />
                    </td>
                    <td className="text-right">
                      <Amount value={r.cost?.annual} />
                    </td>
                    <td className="text-right">
                      <Button
                        variant="ghost"
                        aria-label={t('subscriptions.page.edit', 'Edit {{name}}', {
                          name: r.sub.name,
                        })}
                        onClick={() => setEdit({ sub: r.sub })}
                      >
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {t('subscriptions.page.noSubscriptionsTrackedYet', 'No subscriptions tracked yet.')}
          </Empty>
        )}
      </Card>
      <Card title={t('subscriptions.page.detectedRecurringCharges', 'Detected recurring charges')}>
        {candidates.length ? (
          <ul className="divide-y divide-line text-sm">
            {candidates.map((x) => (
              <li
                key={x.transactionIds.join()}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span>
                  <span className="font-medium">
                    {x.description || t('subscriptions.page.unknownMerchant', 'Unknown merchant')}
                  </span>{' '}
                  <span className="text-muted">
                    <Amount value={x.amount} />{' '}
                    {t(
                      'subscriptions.page.cadenceLengthPaymentsLast',
                      '{{cadence}} · {{length}} payments, last {{date}} · confidence {{percent}}',
                      {
                        cadence: x.cadence,
                        length: x.transactionIds.length,
                        date: f.date(x.lastDate),
                        percent: f.percent(x.confidence, 0),
                      },
                    )}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button className="text-xs" onClick={() => setEdit({ candidate: x })}>
                    {t('subscriptions.page.track', 'Track')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-xs"
                    onClick={() => setDismissed([...dismissed, x.transactionIds.join()])}
                  >
                    {t('subscriptions.page.ignore', 'Ignore')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            {t(
              'subscriptions.page.noUntrackedRecurringCharges',
              'No untracked recurring charges found (needs at least 3 regular payments to the same merchant).',
            )}
          </Empty>
        )}
      </Card>
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={
          edit?.sub
            ? t('subscriptions.page.editSubscription', 'Edit subscription')
            : t('subscriptions.page.trackSubscription', 'Track subscription')
        }
      >
        {edit && <SubscriptionForm snap={s} draft={edit} onDone={() => setEdit(null)} />}
      </Dialog>
    </Page>
  );
}

function SubscriptionForm({
  snap,
  draft,
  onDone,
}: {
  snap: Snapshot;
  draft: Draft;
  onDone: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const sub = draft.sub;
  const cand = draft.candidate;
  const plan = sub?.plannedTransactionId
    ? snap.plans.find((p) => p.id === sub.plannedTransactionId)
    : undefined;
  const schedule = plan?.recurrenceId
    ? snap.schedules.find((x) => x.id === plan.recurrenceId)
    : undefined;
  const candTx = cand
    ? snap.transactions.find((t) => t.id === cand.transactionIds.at(-1))
    : undefined;
  const accounts = snap.accounts.filter((a) => !a.isArchived);
  const [name, setName] = useState(sub?.name ?? cand?.description ?? '');
  const [amount, setAmount] = useState(plan?.amount.amount ?? cand?.amount.amount ?? '');
  const [accountId, setAccountId] = useState(
    plan?.accountId ?? candTx?.postings[0]?.accountId ?? accounts[0]?.id ?? '',
  );
  const [rrule, setRrule] = useState(schedule?.rrule ?? (cand ? cand.rrule : 'FREQ=MONTHLY'));
  const [next, setNext] = useState(plan?.dueDate ?? todayIso());
  const [status, setStatus] = useState(sub?.status ?? 'active');
  const [trialEnds, setTrialEnds] = useState(sub?.trialEndsAt ?? '');
  const [url, setUrl] = useState(sub?.url ?? '');
  const [notes, setNotes] = useState(sub?.notes ?? '');
  const [err, setErr] = useState<unknown>(null);
  const currency =
    accounts.find((a) => a.id === accountId)?.currency ?? cand?.amount.currency ?? snap.currency;
  const categoryId = candTx?.splits[0]?.categoryId ?? null;

  const save = useOpsMutation(async (ops, v: { amount: { amount: string; currency: string } }) => {
    const planStatus =
      status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : 'active';
    const subFields = {
      name,
      status,
      trialEndsAt: status === 'trial' ? trialEnds || null : null,
      cancelledAt: status === 'cancelled' ? (sub?.cancelledAt ?? todayIso()) : null,
      url,
      notes,
      merchantId: sub?.merchantId ?? cand?.merchantId ?? null,
    };
    if (sub && plan) {
      const recurrenceChanged = schedule?.rrule !== rrule;
      await ops.update('planned_transactions', plan.id, {
        version: plan.version,
        description: name,
        amount: v.amount,
        accountId: accountId || null,
        status: planStatus,
        ...(recurrenceChanged
          ? { recurrence: { rrule, startDate: schedule?.startDate ?? next } }
          : {}),
      } as never);
      return ops.update('subscriptions', sub.id, { ...subFields, version: sub.version });
    }
    const p = await ops.create('planned_transactions', {
      kind: 'expense',
      accountId: accountId || null,
      categoryId,
      merchantId: subFields.merchantId,
      description: name,
      amount: v.amount,
      dueDate: next,
      confidence: 'certain',
      priority: 'normal',
      recurrence: { rrule, startDate: next },
    });
    if (planStatus !== 'active')
      await ops.update('planned_transactions', p.id, { status: planStatus } as never);
    return sub
      ? ops.update('subscriptions', sub.id, {
          ...subFields,
          plannedTransactionId: p.id,
          version: sub.version,
        })
      : ops.create('subscriptions', { ...subFields, plannedTransactionId: p.id });
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const m = parseMoneyInput(amount, currency, f.parseDecimal);
    if (!m) return setErr(new Error(`Enter a valid ${currency} price`));
    save.mutate({ amount: m }, { onSuccess: onDone, onError: setErr });
  };
  const freqKnown = FREQS.some(([r]) => r === rrule);
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label={t('account.name', 'Name')}>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('subscriptions.page.paidFrom', 'Paid from')}>
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.currency})
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t('subscriptions.page.priceIn', 'Price ({{currency}})', { currency: currency })}
        hint={
          sub
            ? t('subscriptions.page.aNewPriceApplies', 'A new price applies to future payments')
            : undefined
        }
      >
        <Input
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field label={t('subscriptions.page.billing', 'Billing')}>
        <Select value={rrule} onChange={(e) => setRrule(e.target.value)}>
          {!freqKnown && <option value={rrule}>{describeRRule(rrule)}</option>}
          {FREQS.map(([r, l]) => (
            <option key={r} value={r}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      {!plan && (
        <Field label={t('subscriptions.page.nextPayment', 'Next payment')}>
          <Input type="date" required value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      )}
      <Field label={t('sync.status', 'Status')}>
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {SUBSCRIPTION_STATUSES.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </Select>
      </Field>
      {status === 'trial' && (
        <Field label={t('subscriptions.page.trialEnds', 'Trial ends')}>
          <Input type="date" value={trialEnds} onChange={(e) => setTrialEnds(e.target.value)} />
        </Field>
      )}
      <Field label={t('subscriptions.page.websiteOptional', 'Website (optional)')}>
        <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label={t('transaction.notes', 'Notes')}>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {status === 'cancelled' && (
        <p className="col-span-full text-xs text-muted">
          {t(
            'subscriptions.page.cancellingStopsFuturePlanned',
            'Cancelling stops future planned payments; past payments stay in your history.',
          )}
        </p>
      )}
      <div className="col-span-full">
        <ErrorText error={err} />
      </div>
      <div className="col-span-full flex justify-end gap-2">
        <Button onClick={onDone}>{t('common.cancel', 'Cancel')}</Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {t('common.save', 'Save')}
        </Button>
      </div>
    </form>
  );
}
