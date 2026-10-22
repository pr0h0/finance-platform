// Savings goals (features 72–75): targets, contributions/withdrawals, progress, completion
// estimate, emergency fund coverage.
import { GOAL_KINDS, GOAL_STATUSES, PRIORITIES, type SavingsGoal } from '@finplat/domain';
import { fromMinor, toMinor } from '@finplat/finance-engine';
import { Pencil, Plus, Trash2 } from 'lucide-react';
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
  ProgressBar,
  parseMoneyInput,
  Select,
  Stat,
} from '../../features/analytics/ui.tsx';
import { emergencyFund, goalRows } from '../../features/goals/compute.ts';
import { PRIORITY_LABEL } from '../../features/planning/labels.ts';
import { describeRRule } from '../../features/planning/rrule.ts';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';

const KIND_LABEL = {
  general: 'General',
  emergency_fund: 'Emergency fund',
  purchase: 'Purchase',
  debt_payoff: 'Debt payoff',
} as const;
const BASIS = {
  complete: 'Target reached',
  plan: 'Based on the planned transfer schedule',
  history: 'Based on the last 3 months of contributions',
  none: 'No contributions yet to estimate from',
} as const;

export default function GoalsPage() {
  const t = useT();
  const snap = useSnapshot();
  const f = useFormat();
  const [edit, setEdit] = useState<{ goal?: SavingsGoal } | null>(null);
  const [contrib, setContrib] = useState<SavingsGoal | null>(null);
  const del = useOpsMutation((ops, id: string) => ops.remove('savings_contributions', id));
  if (snap.error)
    return (
      <Page title={t('goals.page.savingsGoals', 'Savings goals')}>
        <ErrorText error={snap.error} />
      </Page>
    );
  if (!snap.data) return <Loading />;
  const s = snap.data;
  const rows = goalRows(s);
  const ef = emergencyFund(s);
  return (
    <Page
      title={t('goals.page.savingsGoals', 'Savings goals')}
      actions={
        <Button variant="primary" onClick={() => setEdit({})}>
          <Plus aria-hidden className="size-4" /> {t('goals.page.newGoal', 'New goal')}
        </Button>
      }
    >
      <Card title={t('goals.page.emergencyFund', 'Emergency fund')}>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label={t('goals.page.monthsCovered', 'Months covered')}
            value={ef.months ?? '—'}
            hint={ef.target ? `Target ${ef.target} months` : undefined}
          />
          <Stat
            label={t('goals.page.reserve', 'Reserve')}
            value={<Amount value={ef.reserve} />}
            hint={t('goals.page.savedInEmergencyFund', 'Saved in emergency-fund goals')}
          />
          <Stat
            label={t('goals.page.essentialExpensesMonth', 'Essential expenses / month')}
            value={<Amount value={ef.monthly} />}
            hint={
              ef.basis === 'essential_plans'
                ? t('goals.page.fromRecurringPlansMarked', 'From recurring plans marked Essential')
                : t('goals.page.noEssentialPlans6', 'No essential plans: 6-month average spending')
            }
          />
          {ef.target && ef.months && (
            <div>
              <ProgressBar
                label={`${ef.months} of ${ef.target} months`}
                parts={[
                  { value: Number(ef.months), className: 'bg-pos', title: 'covered' },
                  {
                    value: Math.max(0, ef.target - Number(ef.months)),
                    className: 'bg-transparent',
                    title: 'missing',
                  },
                ]}
              />
            </div>
          )}
        </div>
        <DataBanner
          warnings={ef.complete ? [] : ['Some amounts have no exchange rate and are left out.']}
        />
      </Card>

      {rows.length === 0 && (
        <Card>
          <Empty>{t('goals.page.noGoalsYet', 'No goals yet.')}</Empty>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {rows.map(({ goal: g, projection: p, contributions, plan }) => (
          <Card
            key={g.id}
            title={
              <span className="text-fg">
                {g.name}{' '}
                <span className="text-xs font-normal text-muted">
                  {KIND_LABEL[g.kind]} · {PRIORITY_LABEL[g.priority]} · {g.status}
                </span>
              </span>
            }
            actions={
              <Button
                variant="ghost"
                aria-label={`Edit ${g.name}`}
                onClick={() => setEdit({ goal: g })}
              >
                <Pencil aria-hidden className="size-4" />
              </Button>
            }
          >
            <div className="space-y-3 text-sm">
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-semibold">
                  <Amount value={p.saved} />
                </span>
                <span className="text-muted">
                  {t('goals.page.of', 'of')} <Amount value={g.targetAmount} /> ·{' '}
                  {f.percent(p.progress, 0)}
                </span>
              </div>
              <ProgressBar
                label={`${f.percent(p.progress, 0)} saved`}
                parts={[
                  { value: Number(p.progress), className: 'bg-pos', title: 'saved' },
                  {
                    value: Math.max(0, 1 - Number(p.progress)),
                    className: 'bg-transparent',
                    title: 'remaining',
                  },
                ]}
              />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-muted">{t('goals.page.remaining', 'Remaining')}</dt>
                <dd>
                  <Amount value={p.remaining} />
                </dd>
                <dt className="text-muted">
                  {t('goals.page.estimatedCompletion', 'Estimated completion')}
                </dt>
                <dd>
                  {p.estimatedCompletionDate ? f.date(p.estimatedCompletionDate) : '—'}
                  <span className="block text-xs text-muted">{BASIS[p.basis]}</span>
                </dd>
                {g.targetDate && (
                  <>
                    <dt className="text-muted">{t('goals.page.targetDate', 'Target date')}</dt>
                    <dd>
                      {f.date(g.targetDate)}{' '}
                      {p.onTrack !== null && (
                        <span className={p.onTrack ? 'text-pos' : 'text-warn'}>
                          (
                          {p.onTrack
                            ? t('goals.page.onTrack', 'on track')
                            : t('goals.page.behind', 'behind')}
                          )
                        </span>
                      )}
                    </dd>
                  </>
                )}
                {p.requiredMonthly && (
                  <>
                    <dt className="text-muted">
                      {t('goals.page.neededPerMonth', 'Needed per month')}
                    </dt>
                    <dd>
                      <Amount value={p.requiredMonthly} />
                    </dd>
                  </>
                )}
                {plan && (
                  <>
                    <dt className="text-muted">
                      {t('goals.page.plannedTransfer', 'Planned transfer')}
                    </dt>
                    <dd>
                      <Amount value={plan.amount} /> · {describeRRule(plan.rrule)}
                    </dd>
                  </>
                )}
              </dl>
              <div className="flex gap-2">
                <Button onClick={() => setContrib(g)}>
                  {t('goals.page.addContribution', 'Add contribution')}
                </Button>
              </div>
              {contributions.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted">
                    {t('goals.page.contributionsLength', 'Contributions ({{length}})', {
                      length: contributions.length,
                    })}
                  </summary>
                  <ul className="mt-1 divide-y divide-line">
                    {contributions.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 py-1">
                        <span className="text-muted">
                          {f.date(c.contributionDate)} {c.notes}
                        </span>
                        <span className="flex items-center gap-1">
                          <Amount value={c.amount} tone />
                          <Button
                            variant="ghost"
                            aria-label={t('goals.page.deleteContribution', 'Delete contribution')}
                            onClick={() => confirm('Delete this contribution?') && del.mutate(c.id)}
                          >
                            <Trash2 aria-hidden className="size-3.5" />
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </Card>
        ))}
      </div>
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={
          edit?.goal ? t('goals.page.editGoal', 'Edit goal') : t('goals.page.newGoal', 'New goal')
        }
      >
        {edit && <GoalForm snap={s} goal={edit.goal} onDone={() => setEdit(null)} />}
      </Dialog>
      <Dialog
        open={!!contrib}
        onClose={() => setContrib(null)}
        title={t('goals.page.contribution', 'Contribution')}
      >
        {contrib && <ContributionForm goal={contrib} onDone={() => setContrib(null)} />}
      </Dialog>
    </Page>
  );
}

function GoalForm({
  snap,
  goal,
  onDone,
}: {
  snap: Snapshot;
  goal?: SavingsGoal;
  onDone: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const [name, setName] = useState(goal?.name ?? '');
  const [kind, setKind] = useState(goal?.kind ?? 'general');
  const [currency, setCurrency] = useState(goal?.targetAmount.currency ?? snap.currency);
  const [target, setTarget] = useState(goal?.targetAmount.amount ?? '');
  const [starting, setStarting] = useState(goal?.startingAmount.amount ?? '');
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [accountId, setAccountId] = useState(goal?.accountId ?? '');
  const [months, setMonths] = useState(String(goal?.emergencyMonths ?? ''));
  const [priority, setPriority] = useState(goal?.priority ?? 'normal');
  const [status, setStatus] = useState(goal?.status ?? 'active');
  const [err, setErr] = useState<unknown>(null);
  const save = useOpsMutation((ops, v: Record<string, unknown>) =>
    goal
      ? ops.update('savings_goals', goal.id, { ...v, version: goal.version } as never)
      : ops.create('savings_goals', v as never),
  );
  const remove = useOpsMutation((ops) =>
    goal ? ops.remove('savings_goals', goal.id, goal.version) : Promise.resolve(),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = parseMoneyInput(target, currency, f.parseDecimal);
    if (!t || toMinor(t) <= 0n) return setErr(new Error('Enter a positive target amount'));
    const st = starting.trim()
      ? parseMoneyInput(starting, currency, f.parseDecimal)
      : fromMinor(0n, currency);
    if (!st) return setErr(new Error('Invalid starting amount'));
    save.mutate(
      {
        name,
        kind,
        targetAmount: t,
        startingAmount: st,
        targetDate: targetDate || null,
        accountId: accountId || null,
        emergencyMonths: kind === 'emergency_fund' && months ? Number(months) : null,
        priority,
        ...(goal
          ? {
              status,
              completedAt:
                status === 'completed' ? (goal.completedAt ?? new Date().toISOString()) : null,
            }
          : {}),
      },
      { onSuccess: onDone, onError: setErr },
    );
  };
  const currencies = [...new Set([snap.currency, ...snap.accounts.map((a) => a.currency)])];
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label={t('account.name', 'Name')}>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('backup.kind', 'Kind')}>
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {GOAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('account.currency', 'Currency')}>
        <Select value={currency} disabled={!!goal} onChange={(e) => setCurrency(e.target.value)}>
          {currencies.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('goals.page.targetAmount', 'Target amount')}>
        <Input
          required
          inputMode="decimal"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      </Field>
      <Field label={t('goals.page.alreadySaved', 'Already saved')}>
        <Input inputMode="decimal" value={starting} onChange={(e) => setStarting(e.target.value)} />
      </Field>
      <Field label={t('goals.page.targetDateOptional', 'Target date (optional)')}>
        <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
      </Field>
      <Field
        label={t('goals.page.savingsAccountOptional', 'Savings account (optional)')}
        hint={t(
          'goals.page.recurringPlannedTransfersInto',
          'Recurring planned transfers into it drive the estimate',
        )}
      >
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">{t('common.none', 'None')}</option>
          {snap.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
      {kind === 'emergency_fund' && (
        <Field label={t('goals.page.monthsOfEssentialsTo', 'Months of essentials to cover')}>
          <Input
            type="number"
            min={1}
            max={36}
            value={months}
            onChange={(e) => setMonths(e.target.value)}
          />
        </Field>
      )}
      <Field label={t('goals.page.priority', 'Priority')}>
        <Select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </Select>
      </Field>
      {goal && (
        <Field label={t('sync.status', 'Status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {GOAL_STATUSES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </Select>
        </Field>
      )}
      <div className="col-span-full">
        <ErrorText error={err} />
      </div>
      <div className="col-span-full flex justify-between gap-2">
        {goal ? (
          <Button
            variant="danger"
            onClick={() =>
              confirm('Delete this goal?') &&
              remove.mutate(undefined, { onSuccess: onDone, onError: setErr })
            }
          >
            {t('common.delete', 'Delete')}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button onClick={onDone}>{t('common.cancel', 'Cancel')}</Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {t('common.save', 'Save')}
          </Button>
        </div>
      </div>
    </form>
  );
}

function ContributionForm({ goal, onDone }: { goal: SavingsGoal; onDone: () => void }) {
  const t = useT();
  const f = useFormat();
  const [amount, setAmount] = useState('');
  const [withdraw, setWithdraw] = useState(false);
  const [date, setDate] = useState(todayIso());
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const save = useOpsMutation((ops, v: Parameters<typeof ops.create<'savings_contributions'>>[1]) =>
    ops.create('savings_contributions', v),
  );
  const cur = goal.targetAmount.currency;
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        const m = parseMoneyInput(amount, cur, f.parseDecimal);
        if (!m || toMinor(m) <= 0n) return setErr(new Error(`Enter a positive ${cur} amount`));
        save.mutate(
          {
            goalId: goal.id,
            amount: withdraw ? fromMinor(-toMinor(m), cur) : m,
            contributionDate: date,
            notes,
          },
          { onSuccess: onDone, onError: setErr },
        );
      }}
    >
      <Field label={`Amount (${cur})`}>
        <Input
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field label={t('transaction.date', 'Date')}>
        <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={withdraw} onChange={(e) => setWithdraw(e.target.checked)} />{' '}
        {t('goals.page.withdrawal', 'Withdrawal')}
      </label>
      <Field label={t('transaction.notes', 'Notes')}>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
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
