// Planning (PLAN §34, features 26–38, 66–71): calendar / list / timeline of planned income and
// expenses, commitments, forecast, what-if, annual plan, installments, planned vs actual.
import type { PlannedTransaction } from '@finplat/domain';
import { addMonths, endOfMonth, startOfMonth } from '@finplat/finance-engine';
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus, Rows3 } from 'lucide-react';
import { useState } from 'react';
import { useProfile } from '../../app/data.tsx';
import { useSnapshot } from '../../features/analytics/hooks.ts';
import {
  Amount,
  Button,
  Card,
  DataBanner,
  Dialog,
  ErrorText,
  Loading,
  Page,
  Stat,
} from '../../features/analytics/ui.tsx';
import { ForecastPanel } from '../../features/planning/ForecastPanel.tsx';
import { OccurrenceDetail } from '../../features/planning/OccurrenceDialog.tsx';
import { commitments, type OccRow, occurrenceRows } from '../../features/planning/occurrences.ts';
import { PlanEditor } from '../../features/planning/PlanEditor.tsx';
import {
  AnnualPlanCard,
  CalendarView,
  InstallmentsCard,
  ListView,
  PlannedVsActualCard,
  TimelineView,
} from '../../features/planning/Views.tsx';
import { WhatIf } from '../../features/planning/WhatIf.tsx';
import { useFormat } from '../../lib/format.ts';

type View = 'calendar' | 'list' | 'timeline';

export default function PlanningPage() {
  const snap = useSnapshot();
  const profile = useProfile();
  const f = useFormat();
  const [view, setView] = useState<View>('calendar');
  const [month, setMonth] = useState<string | null>(null);
  const [open, setOpen] = useState<OccRow | null>(null);
  const [edit, setEdit] = useState<{ plan?: PlannedTransaction; dueDate?: string } | null>(null);
  const [kindFilter, setKindFilter] = useState<'all' | 'income' | 'expense' | 'transfer'>('all');

  if (snap.error)
    return (
      <Page title="Planning">
        <ErrorText error={snap.error} />
      </Page>
    );
  if (!snap.data) return <Loading />;
  const s = snap.data;
  const m = month ?? startOfMonth(s.today);
  const from = view === 'calendar' ? startOfMonth(m) : m;
  const to = view === 'calendar' ? endOfMonth(m) : endOfMonth(addMonths(m, 2));
  const rows = occurrenceRows(s, from, to).filter(
    (r) => kindFilter === 'all' || r.plan.kind === kindFilter,
  );
  const c = commitments(s, rows);

  return (
    <Page
      title="Planning"
      actions={
        <Button variant="primary" onClick={() => setEdit({})}>
          <Plus aria-hidden className="size-4" /> Plan transaction
        </Button>
      }
    >
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              aria-label="Previous"
              onClick={() => setMonth(addMonths(m, -1))}
            >
              <ChevronLeft aria-hidden className="size-4" />
            </Button>
            <h2 className="min-w-36 text-center font-medium">
              {view === 'calendar'
                ? f.month(m.slice(0, 7))
                : `${f.month(m.slice(0, 7))} – ${f.month(to.slice(0, 7))}`}
            </h2>
            <Button variant="ghost" aria-label="Next" onClick={() => setMonth(addMonths(m, 1))}>
              <ChevronRight aria-hidden className="size-4" />
            </Button>
            <Button variant="ghost" className="text-xs" onClick={() => setMonth(null)}>
              Today
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Show"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            >
              <option value="all">All plans</option>
              <option value="expense">Expenses</option>
              <option value="income">Income</option>
              <option value="transfer">Transfers</option>
            </select>
            <div role="tablist" aria-label="View" className="flex rounded-md border border-line">
              {(
                [
                  ['calendar', CalendarDays, 'Calendar'],
                  ['list', List, 'List'],
                  ['timeline', Rows3, 'Timeline'],
                ] as const
              ).map(([v, Icon, label]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={`flex items-center gap-1 px-2 py-1 text-sm ${view === v ? 'bg-surface-2 font-medium' : 'text-muted'}`}
                >
                  <Icon aria-hidden className="size-4" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Committed expenses" value={<Amount value={c.expense} />} />
          <Stat label="Expected income" value={<Amount value={c.income} />} />
          <Stat label="Planned items" value={rows.filter((r) => r.status === 'pending').length} />
          <Stat label="Overdue" value={rows.filter((r) => r.overdue).length} />
        </div>
        {!c.complete && (
          <DataBanner
            warnings={[
              'Some planned amounts have no exchange rate to ' +
                s.currency +
                ' and are not in the totals.',
            ]}
          />
        )}
        {view === 'calendar' && (
          <CalendarView
            month={m}
            rows={rows}
            weekStart={profile.weekStart}
            today={s.today}
            onOpen={setOpen}
            onNew={(d) => setEdit({ dueDate: d })}
          />
        )}
        {view === 'list' && <ListView rows={rows} onOpen={setOpen} />}
        {view === 'timeline' && <TimelineView rows={rows} onOpen={setOpen} />}
      </Card>

      <ForecastPanel snap={s} />
      <WhatIf snap={s} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AnnualPlanCard snap={s} />
        <div className="space-y-4">
          <InstallmentsCard snap={s} />
          <PlannedVsActualCard snap={s} />
        </div>
      </div>

      <Dialog open={!!open} onClose={() => setOpen(null)} title="Occurrence">
        {open && (
          <OccurrenceDetail
            snap={s}
            row={open}
            onDone={() => setOpen(null)}
            onEditPlan={() => {
              setEdit({ plan: open.plan });
              setOpen(null);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.plan ? 'Edit plan' : 'New planned transaction'}
      >
        {edit && (
          <PlanEditor
            key={edit.plan?.id ?? edit.dueDate ?? 'new'}
            snap={s}
            plan={edit.plan}
            initial={{ dueDate: edit.dueDate }}
            onDone={() => setEdit(null)}
          />
        )}
      </Dialog>
    </Page>
  );
}
