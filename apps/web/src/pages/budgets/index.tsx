// Budgets (features 39–46): category/overall limits per period, rollover, alerts, actual vs
// committed vs remaining, templates.
import type { Budget, BudgetAllocation } from '@finplat/domain';
import { addDays, addMonths, maxDate, toMinor } from '@finplat/finance-engine';
import type { EntityName } from '@finplat/storage';
import { Archive, ChevronLeft, ChevronRight, Copy, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { transactionsLink } from '../../features/analytics/drill.ts';
import { useOpsMutation, useOpsQuery, useSnapshot } from '../../features/analytics/hooks.ts';
import type { Snapshot } from '../../features/analytics/snapshot.ts';
import {
  Amount,
  Button,
  Card,
  DataBanner,
  Dialog,
  Empty,
  ErrorText,
  Loading,
  Page,
  ProgressBar,
} from '../../features/analytics/ui.tsx';
import {
  type AllocationRow,
  BudgetEditor,
  ROLLOVER_LABEL,
} from '../../features/budgets/BudgetEditor.tsx';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';

type Edit = {
  budget?: Budget;
  allocations?: AllocationRow[];
  asTemplate?: boolean;
  fromTemplate?: Budget;
};

export default function BudgetsPage() {
  const t = useT();
  const snap = useSnapshot();
  const allocs = useOpsQuery(
    ['budget-allocations'],
    (ops) =>
      // ponytail: budget_allocations is a profile table outside the typed EntityName list.
      ops.list('budget_allocations' as EntityName) as unknown as Promise<BudgetAllocation[]>,
  );
  const [edit, setEdit] = useState<Edit | null>(null);
  if (snap.error)
    return (
      <Page title={t('budgets.page.budgets', 'Budgets')}>
        <ErrorText error={snap.error} />
      </Page>
    );
  if (!snap.data) return <Loading />;
  const s = snap.data;
  const allocFor = (id: string): AllocationRow[] =>
    (allocs.data ?? [])
      .filter((a) => a.budgetId === id && !a.budgetPeriodId) // period rows are server-managed
      .map((a) => ({ categoryId: a.categoryId, amount: a.amount }));
  const budgets = s.budgets.filter((b) => !b.isTemplate && !b.isArchived);
  const templates = s.budgets.filter((b) => b.isTemplate && !b.isArchived);

  return (
    <Page
      title={t('budgets.page.budgets', 'Budgets')}
      actions={
        <>
          <Button onClick={() => setEdit({ asTemplate: true })}>
            {t('budgets.page.newTemplate', 'New template')}
          </Button>
          <Button variant="primary" onClick={() => setEdit({})}>
            <Plus aria-hidden className="size-4" /> {t('budgets.page.newBudget', 'New budget')}
          </Button>
        </>
      }
    >
      {budgets.length === 0 && (
        <Card>
          <Empty>
            {t(
              'budgets.page.noBudgetsYetCreate',
              'No budgets yet. Create an overall monthly limit or limits for individual categories.',
            )}
          </Empty>
        </Card>
      )}
      {budgets.map((b) => (
        <BudgetCard
          key={b.id}
          snap={s}
          budget={b}
          onEdit={() => setEdit({ budget: b, allocations: allocFor(b.id) })}
          onTemplate={() =>
            setEdit({ asTemplate: true, allocations: allocFor(b.id), fromTemplate: b })
          }
        />
      ))}
      <Card title={t('transactions.entryForm.templates', 'Templates')}>
        {templates.length ? (
          <ul className="divide-y divide-line text-sm">
            {templates.map((tpl) => (
              <li key={tpl.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {tpl.name}{' '}
                  <span className="text-xs text-muted">
                    ({tpl.periodType}, {allocFor(tpl.id).length}{' '}
                    {t('budgets.page.limits', 'limits)')}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button
                    className="text-xs"
                    onClick={() => setEdit({ allocations: allocFor(tpl.id), fromTemplate: tpl })}
                  >
                    <Copy aria-hidden className="size-3.5" /> {t('onb.use', 'Use')}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={t('budgets.page.edit', 'Edit {{name}}', { name: tpl.name })}
                    onClick={() => setEdit({ budget: tpl, allocations: allocFor(tpl.id) })}
                  >
                    <Pencil aria-hidden className="size-4" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            {t(
              'budgets.page.templatesAreReusableSets',
              'Templates are reusable sets of limits for different situations (e.g. "Tight month", "Holiday month").',
            )}
          </Empty>
        )}
      </Card>
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={
          edit?.budget
            ? t('common.edit', 'Edit')
            : edit?.asTemplate
              ? t('budgets.page.newTemplate', 'New template')
              : t('budgets.page.newBudget', 'New budget')
        }
      >
        {edit && (
          <BudgetEditor
            snap={s}
            budget={edit.budget}
            prefill={
              edit.fromTemplate && {
                ...edit.fromTemplate,
                name: edit.asTemplate
                  ? `${edit.fromTemplate.name} template`
                  : edit.fromTemplate.name,
                startDate: edit.asTemplate
                  ? edit.fromTemplate.startDate
                  : `${s.today.slice(0, 8)}01`,
              }
            }
            allocations={edit.allocations}
            asTemplate={edit.asTemplate}
            onDone={() => setEdit(null)}
            key={edit.budget?.id ?? 'new'}
          />
        )}
      </Dialog>
    </Page>
  );
}

function shift(b: Budget, date: string, dir: number): string {
  if (b.periodType === 'weekly') return addDays(date, 7 * dir);
  return addMonths(
    date,
    dir * ({ monthly: 1, quarterly: 3, yearly: 12, custom: 0 } as const)[b.periodType],
  );
}

function BudgetCard({
  snap,
  budget,
  onEdit,
  onTemplate,
}: {
  snap: Snapshot;
  budget: Budget;
  onEdit: () => void;
  onTemplate: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const [date, setDate] = useState(maxDate(snap.today, budget.startDate));
  const st = useOpsQuery(['budget-status', budget.id, date], (ops) =>
    ops.budgetStatus(budget.id, date),
  );
  const archive = useOpsMutation((ops) =>
    ops.update('budgets', budget.id, { isArchived: true, version: budget.version } as never),
  );
  const catName = new Map(snap.categories.map((c) => [c.id, c.name]));
  const s = st.data;
  return (
    <Card
      title={
        <span className="text-fg">
          {budget.name}{' '}
          <span className="text-xs font-normal text-muted">
            {budget.periodType} · {ROLLOVER_LABEL[budget.rolloverPolicy]}
          </span>
        </span>
      }
      actions={
        <>
          {budget.periodType !== 'custom' && (
            <>
              <Button
                variant="ghost"
                aria-label={t('budgets.page.previousPeriod', 'Previous period')}
                onClick={() => setDate(shift(budget, date, -1))}
                disabled={!!s && s.periodStart <= budget.startDate}
              >
                <ChevronLeft aria-hidden className="size-4" />
              </Button>
              <Button
                variant="ghost"
                aria-label={t('budgets.page.nextPeriod', 'Next period')}
                onClick={() => setDate(shift(budget, date, 1))}
              >
                <ChevronRight aria-hidden className="size-4" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            aria-label={t('transactions.entryForm.saveAsTemplate', 'Save as template')}
            title={t('transactions.entryForm.saveAsTemplate', 'Save as template')}
            onClick={onTemplate}
          >
            <Copy aria-hidden className="size-4" />
          </Button>
          <Button
            variant="ghost"
            aria-label={t('budgets.page.edit', 'Edit {{name}}', { name: budget.name })}
            onClick={onEdit}
          >
            <Pencil aria-hidden className="size-4" />
          </Button>
          <Button
            variant="ghost"
            aria-label={t('budgets.page.archive', 'Archive {{name}}', { name: budget.name })}
            onClick={() => confirm('Archive this budget?') && archive.mutate(undefined)}
          >
            <Archive aria-hidden className="size-4" />
          </Button>
        </>
      }
    >
      {st.error && <ErrorText error={st.error} />}
      {s && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {f.date(s.periodStart)} – {f.date(s.periodEnd)}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-1">{t('budgets.page.limitFor', 'Limit for')}</th>
                  <th className="w-1/3">{t('budgets.page.progress', 'Progress')}</th>
                  <th className="text-right">{t('budgets.page.actual', 'Actual')}</th>
                  <th className="text-right">{t('budgets.page.committed', 'Committed')}</th>
                  <th className="text-right">{t('goals.page.remaining', 'Remaining')}</th>
                  <th className="text-right">{t('budgets.page.limit', 'Limit')}</th>
                </tr>
              </thead>
              <tbody>
                {s.lines.map((l) => {
                  const lim = Math.max(Number(l.limit.amount), 0.000001);
                  const over = toMinor(l.remaining) < 0n;
                  return (
                    <tr key={l.categoryId ?? 'all'} className="border-b border-line/60">
                      <td className="py-1.5">
                        <Link
                          className="hover:underline"
                          to={transactionsLink({
                            from: s.periodStart,
                            to: s.periodEnd,
                            kind: 'expense',
                            ...(l.categoryId ? { categoryKey: l.categoryId } : {}),
                          })}
                        >
                          {l.categoryId
                            ? (catName.get(l.categoryId) ?? t('budgets.page.unknown', 'Unknown'))
                            : t('budgets.page.allSpending', 'All spending')}
                        </Link>
                        {l.alert && (
                          <span
                            className={`ml-2 rounded px-1 text-[10px] ${over ? 'bg-neg/15 text-neg' : 'bg-warn/15 text-warn'}`}
                          >
                            {over
                              ? t('budgets.page.over', 'over')
                              : `${Math.round(Number(l.alert) * 100)}% reached`}
                          </span>
                        )}
                      </td>
                      <td>
                        <ProgressBar
                          label={t('budgets.page.used', '{{v0}}% used', {
                            v0: l.utilization ? Math.round(Number(l.utilization) * 100) : 0,
                          })}
                          parts={[
                            {
                              value: Number(l.actual.amount) / lim,
                              className: over ? 'bg-neg' : 'bg-accent',
                              title: 'actual',
                            },
                            {
                              value: budget.includePlanned ? Number(l.planned.amount) / lim : 0,
                              className: 'bg-warn',
                              title: 'committed',
                            },
                            {
                              value: Math.max(0, Number(l.remaining.amount)) / lim,
                              className: 'bg-transparent',
                              title: 'remaining',
                            },
                          ]}
                        />
                        <span className="text-[10px] text-muted">
                          {l.utilization ? f.percent(l.utilization, 0) : '—'}
                        </span>
                      </td>
                      <td className="text-right">
                        <Amount value={l.actual} />
                      </td>
                      <td className="text-right">
                        <Amount value={l.planned} />
                      </td>
                      <td className={`text-right ${over ? 'text-neg' : ''}`}>
                        <Amount value={l.remaining} />
                      </td>
                      <td className="text-right">
                        <Amount value={l.limit} />
                        {toMinor(l.rolloverIn) !== 0n && (
                          <span className="block text-[10px] text-muted">
                            {t('budgets.page.inclRollover', 'incl. rollover')}{' '}
                            <Amount value={l.rolloverIn} />
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-medium">
                  <td className="py-1.5">{t('budgets.page.total', 'Total')}</td>
                  <td />
                  <td className="text-right">
                    <Amount value={s.totals.actual} />
                  </td>
                  <td className="text-right">
                    <Amount value={s.totals.planned} />
                  </td>
                  <td className="text-right">
                    <Amount value={s.totals.remaining} tone />
                  </td>
                  <td className="text-right">
                    <Amount value={s.totals.limit} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="flex flex-wrap gap-3 text-xs text-muted">
            <span>
              <span aria-hidden className="mr-1 inline-block size-2 rounded-sm bg-accent" />
              {t('budgets.page.actual', 'Actual')}
            </span>
            <span>
              <span aria-hidden className="mr-1 inline-block size-2 rounded-sm bg-warn" />
              {t('budgets.page.committedPlannedUnmatched', 'Committed (planned, unmatched)')}
            </span>
            <span>
              <span aria-hidden className="mr-1 inline-block size-2 rounded-sm bg-surface-2" />
              {t('goals.page.remaining', 'Remaining')}
            </span>
          </p>
          <DataBanner warnings={s.warnings} />
        </div>
      )}
    </Card>
  );
}
