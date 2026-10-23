// Planning views: month calendar, list and timeline of occurrences; annual plan; installments;
// planned vs actual; match suggestions.

import {
  addDays,
  addMonths,
  endOfMonth,
  isoWeekday,
  startOfMonth,
  toMinor,
} from '@finplat/finance-engine';
import { intlLocale } from '@finplat/localization';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { ChartFrame, MoneyChart } from '../analytics/chart.tsx';
import { plannedVsActual } from '../analytics/compute.ts';
import { useOpsMutation } from '../analytics/hooks.ts';
import type { Snapshot } from '../analytics/snapshot.ts';
import { Amount, Button, Card, DataBanner, Empty, ProgressBar, SERIES } from '../analytics/ui.tsx';
import { CONFIDENCE_LABEL, PRIORITY_LABEL } from './labels.ts';
import { annualPlan, installments, matchSuggestions, type OccRow } from './occurrences.ts';

const tone = (r: OccRow) =>
  r.status !== 'pending'
    ? 'text-muted line-through'
    : r.overdue
      ? 'text-neg'
      : r.plan.kind === 'income'
        ? 'text-pos'
        : '';

function Badge({ r }: { r: OccRow }) {
  const t = useT();
  const label = r.overdue
    ? t('planning.occurrenceDialog.overdue', 'overdue')
    : r.status === 'pending'
      ? t(`planning.confidence.${r.plan.confidence}`, CONFIDENCE_LABEL[r.plan.confidence])
      : t(`planning.occurrenceStatus.${r.status}`, r.status);
  return <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{label}</span>;
}

export function CalendarView({
  month,
  rows,
  weekStart,
  onOpen,
  onNew,
  today,
}: {
  month: string; // YYYY-MM-01
  rows: readonly OccRow[];
  weekStart: number; // 1 = Monday … 7 = Sunday
  onOpen: (r: OccRow) => void;
  onNew: (date: string) => void;
  today: string;
}) {
  const t = useT();
  const f = useFormat();
  const first = startOfMonth(month);
  const lead = (isoWeekday(first) - (weekStart || 1) + 7) % 7;
  const start = addDays(first, -lead);
  const last = endOfMonth(month);
  const days: string[] = [];
  for (let d = start; d <= last || days.length % 7; d = addDays(d, 1)) days.push(d);
  const byDay = new Map<string, OccRow[]>();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const names = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(intlLocale(f.locale), { weekday: 'short', timeZone: 'UTC' }).format(
      Date.UTC(2024, 0, 1 + (((weekStart || 1) - 1 + i) % 7)),
    ),
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-xs">
        <caption className="sr-only">
          {t('planning.views.billCalendar', 'Bill calendar')} {f.month(month.slice(0, 7))}
        </caption>
        <thead>
          <tr>
            {names.map((n) => (
              <th
                key={n}
                scope="col"
                className="border border-line bg-surface-2 p-1 font-medium text-muted"
              >
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: days.length / 7 }, (_, w) => (
            <tr key={days[w * 7]}>
              {days.slice(w * 7, w * 7 + 7).map((d) => {
                const items = byDay.get(d) ?? [];
                const out = d.slice(0, 7) !== month.slice(0, 7);
                return (
                  <td
                    key={d}
                    className={`h-20 border border-line p-1 align-top ${out ? 'bg-surface-2' : 'bg-surface'}`}
                  >
                    <button
                      type="button"
                      className={`mb-1 rounded px-1 ${d === today ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2'}`}
                      aria-label={t(
                        'planning.views.planSomethingOn',
                        'Plan something on {{date}}',
                        {
                          date: f.date(d),
                        },
                      )}
                      onClick={() => onNew(d)}
                    >
                      {Number(d.slice(8))}
                    </button>
                    <ul className="space-y-0.5">
                      {items.map((r) => (
                        <li key={`${r.plan.id}|${r.occurrenceDate}`}>
                          <button
                            type="button"
                            onClick={() => onOpen(r)}
                            className={`w-full truncate rounded px-1 text-left hover:bg-surface-2 ${tone(r)}`}
                          >
                            <span className="hidden md:inline">{r.plan.description} </span>
                            <Amount value={r.amount} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ListView({
  rows,
  onOpen,
}: {
  rows: readonly OccRow[];
  onOpen: (r: OccRow) => void;
}) {
  const t = useT();
  const f = useFormat();
  if (!rows.length)
    return (
      <Empty>{t('planning.views.nothingPlannedInThis', 'Nothing planned in this period.')}</Empty>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="py-1.5">{t('transaction.date', 'Date')}</th>
            <th>{t('transaction.description', 'Description')}</th>
            <th>{t('notif.type', 'Type')}</th>
            <th>{t('goals.page.priority', 'Priority')}</th>
            <th>{t('sync.status', 'Status')}</th>
            <th className="text-right">{t('transaction.amount', 'Amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.plan.id}|${r.occurrenceDate}`}
              className="border-b border-line/60 hover:bg-surface-2"
            >
              <td className="py-1.5 whitespace-nowrap">{f.date(r.date)}</td>
              <td>
                <button
                  type="button"
                  className={`text-left hover:underline ${tone(r)}`}
                  onClick={() => onOpen(r)}
                >
                  {r.plan.description}
                  {r.installmentNo && (
                    <span className="text-xs text-muted">
                      {' '}
                      ({r.installmentNo}/{r.plan.installmentTotal})
                    </span>
                  )}
                </button>
              </td>
              <td>{t(`transaction.kind.${r.plan.kind}`, r.plan.kind)}</td>
              <td>{t(`planning.priority.${r.plan.priority}`, PRIORITY_LABEL[r.plan.priority])}</td>
              <td>
                <Badge r={r} />
              </td>
              <td className="text-right">
                <Amount
                  value={
                    r.plan.kind === 'income'
                      ? r.amount
                      : { ...r.amount, amount: `-${r.amount.amount}` }
                  }
                  tone
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Timeline: occurrences grouped by week with a running committed total. */
export function TimelineView({
  rows,
  onOpen,
}: {
  rows: readonly OccRow[];
  onOpen: (r: OccRow) => void;
}) {
  const t = useT();
  const f = useFormat();
  if (!rows.length)
    return (
      <Empty>{t('planning.views.nothingPlannedInThis', 'Nothing planned in this period.')}</Empty>
    );
  const groups = new Map<string, OccRow[]>();
  for (const r of rows) {
    const wk = addDays(r.date, -(isoWeekday(r.date) - 1));
    groups.set(wk, [...(groups.get(wk) ?? []), r]);
  }
  return (
    <ol className="relative space-y-4 border-l border-line pl-4">
      {[...groups.entries()].map(([wk, items]) => (
        <li key={wk}>
          <span
            aria-hidden
            className="absolute -left-1.5 mt-1 size-3 rounded-full border-2 border-surface bg-accent"
          />
          <h3 className="text-xs font-medium text-muted">
            {t('planning.views.weekOf', 'Week of')} {f.date(wk)}
          </h3>
          <ul className="mt-1 space-y-1 text-sm">
            {items.map((r) => (
              <li
                key={`${r.plan.id}|${r.occurrenceDate}`}
                className="flex items-center justify-between gap-2"
              >
                <button
                  type="button"
                  className={`truncate text-left hover:underline ${tone(r)}`}
                  onClick={() => onOpen(r)}
                >
                  <span className="text-muted">{f.date(r.date)}</span> {r.plan.description}
                </button>
                <span className="flex items-center gap-2">
                  <Badge r={r} />
                  <Amount
                    value={
                      r.plan.kind === 'income'
                        ? r.amount
                        : { ...r.amount, amount: `-${r.amount.amount}` }
                    }
                    tone
                  />
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export function AnnualPlanCard({ snap }: { snap: Snapshot }) {
  const t = useT();
  const f = useFormat();
  const a = annualPlan(snap);
  return (
    <Card title={t('planning.views.annualPlanNext12', 'Annual plan (next 12 months)')}>
      <ChartFrame
        name="annual-plan"
        table={
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th>{t('planning.views.month', 'Month')}</th>
                  <th>{t('transaction.kind.income', 'Income')}</th>
                  <th>{t('reports.page.expenses', 'Expenses')}</th>
                  <th>{t('planning.views.setAsideMonthly', 'Set aside monthly')}</th>
                </tr>
              </thead>
              <tbody>
                {a.months.map((m) => (
                  <tr key={m.month}>
                    <td>{f.month(m.month)}</td>
                    <td>
                      <Amount value={m.income} />
                    </td>
                    <td>
                      <Amount value={m.expense} />
                    </td>
                    <td>
                      <Amount value={m.smoothed} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        }
      >
        <MoneyChart
          title={t(
            'planning.views.scheduledIncomeAndExpenses',
            'Scheduled income and expenses per month',
          )}
          rows={a.months.map((m) => ({
            x: m.month,
            label: f.month(m.month),
            money: { income: m.income, expense: m.expense },
          }))}
          series={[
            {
              key: 'income',
              label: t('planning.views.plannedIncome', 'Planned income'),
              color: SERIES[0] as string,
            },
            {
              key: 'expense',
              label: t('planning.views.plannedExpenses', 'Planned expenses'),
              color: SERIES[1] as string,
            },
          ]}
        />
      </ChartFrame>
      {a.items.length > 0 ? (
        <div className="mt-3 text-sm">
          <p className="mb-1 text-muted">
            {t(
              'planning.views.nonMonthlyExpensesSmoothed',
              'Non-monthly expenses smoothed into a monthly set-aside of',
            )}{' '}
            <Amount value={a.months[0]?.smoothed} />{' '}
            {t('planning.views.notAddedToBudgets', '(not added to budgets automatically):')}
          </p>
          <ul className="space-y-0.5">
            {a.items.map((i) => (
              <li key={i.plan.id} className="flex justify-between">
                <span>{i.plan.description}</span>
                <span>
                  <Amount value={i.annual} /> {t('planning.views.year', '/ year')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Empty>
          {t('planning.views.noAnnualOrIrregular', 'No annual or irregular expenses planned.')}
        </Empty>
      )}
      <DataBanner
        warnings={
          a.complete
            ? []
            : [
                t(
                  'planning.views.someAmountsNoRate',
                  'Some amounts have no exchange rate and are left out.',
                ),
              ]
        }
      />
    </Card>
  );
}

export function InstallmentsCard({ snap }: { snap: Snapshot }) {
  const t = useT();
  const f = useFormat();
  const list = installments(snap);
  if (!list.length) return null;
  return (
    <Card title={t('planning.views.installments', 'Installments')}>
      <ul className="space-y-3 text-sm">
        {list.map(({ plan, progress: p }) => (
          <li key={plan.id}>
            <div className="flex flex-wrap justify-between gap-2">
              <span>{plan.description}</span>
              <span className="text-xs text-muted">
                {p.paid}/{p.total} {t('planning.views.paidOutstanding', 'paid · outstanding')}{' '}
                <Amount value={p.outstanding} /> {t('planning.views.next', '· next')}{' '}
                {p.nextDueDate ? f.date(p.nextDueDate) : '—'}
              </span>
            </div>
            <ProgressBar
              label={t(
                'planning.views.ofInstallmentsPaid',
                '{{paid}} of {{total}} installments paid',
                { paid: p.paid, total: p.total },
              )}
              parts={[
                { value: p.paid, className: 'bg-pos', title: 'paid' },
                { value: p.remaining, className: 'bg-transparent', title: 'remaining' },
              ]}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function PlannedVsActualCard({ snap }: { snap: Snapshot }) {
  const t = useT();
  const f = useFormat();
  const from = startOfMonth(addMonths(snap.today, -2));
  const rows = plannedVsActual(snap, {
    from,
    to: snap.today,
    currency: snap.currency,
    convert: snap.convert,
    granularity: 'month',
  });
  const suggestions = matchSuggestions(snap);
  const plans = new Map(snap.plans.map((p) => [p.id, p]));
  const tx = new Map(snap.transactions.map((t) => [t.id, t]));
  const match = useOpsMutation((ops, s: (typeof suggestions)[number]) =>
    ops.setOccurrence(s.plannedTransactionId, s.occurrenceDate, {
      status: 'matched',
      matchedTransactionId: s.transactionId,
    }),
  );
  return (
    <Card
      title={t('planning.views.plannedVersusActualLast', 'Planned versus actual (last 3 months)')}
    >
      {suggestions.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1 text-sm font-medium">
            {t('planning.views.suggestedMatches', 'Suggested matches')}
          </h3>
          <ul className="space-y-1 text-sm">
            {suggestions.map((s) => {
              const txn = tx.get(s.transactionId);
              return (
                <li
                  key={`${s.plannedTransactionId}|${s.occurrenceDate}`}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    {plans.get(s.plannedTransactionId)?.description} ({f.date(s.occurrenceDate)}) ↔{' '}
                    {txn?.description ||
                      txn?.payee ||
                      t('transactions.transactionTable.transaction', 'transaction')}{' '}
                    {t('planning.views.on', 'on')} {txn && f.date(txn.bookingDate)}
                    <span className="ml-1 text-xs text-muted">
                      {t('planning.views.score', 'score')} {s.score}: {s.reasons.join(', ')}
                    </span>
                  </span>
                  <Button className="text-xs" onClick={() => match.mutate(s)}>
                    {t('transactions.detailDrawer.match', 'Match')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-1">{t('transaction.date', 'Date')}</th>
                <th>{t('transactions.detailDrawer.plan', 'Plan')}</th>
                <th>{t('sync.status', 'Status')}</th>
                <th className="text-right">{t('planning.views.planned', 'Planned')}</th>
                <th className="text-right">{t('planning.views.actual', 'Actual')}</th>
                <th className="text-right">{t('planning.views.variance', 'Variance')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.plan.id}|${r.occurrence.occurrenceDate}`}
                  className="border-b border-line/60"
                >
                  <td className="py-1">{f.date(r.occurrence.occurrenceDate)}</td>
                  <td>{r.plan.description}</td>
                  <td className="text-xs text-muted">
                    {t(`planning.occurrenceStatus.${r.occurrence.status}`, r.occurrence.status)}
                  </td>
                  <td className="text-right">
                    <Amount value={r.planned} />
                  </td>
                  <td className="text-right">
                    <Amount value={r.actual} />
                  </td>
                  <td
                    className={`text-right ${r.variance && toMinor(r.variance) > 0n && r.plan.kind === 'expense' ? 'text-neg' : ''}`}
                  >
                    <Amount value={r.variance} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>
          {t(
            'planning.views.noResolvedOccurrencesYet',
            'No resolved occurrences yet. Match or mark occurrences paid to compare planned and actual amounts.',
          )}
        </Empty>
      )}
    </Card>
  );
}
