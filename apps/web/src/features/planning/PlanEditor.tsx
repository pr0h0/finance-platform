// Create / edit a planned transaction: one-off or recurring, income/expense/transfer, priority,
// confidence, amount range, installments, reminders and recurrence end.
import {
  BUSINESS_DAY_ADJUSTMENTS,
  CONFIDENCE_LEVELS,
  PLAN_STATUSES,
  type PlannedTransaction,
  PRIORITIES,
  type RecurrenceSchedule,
} from '@finplat/domain';
import { type FormEvent, useState } from 'react';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { useOpsMutation } from '../analytics/hooks.ts';
import type { Snapshot } from '../analytics/snapshot.ts';
import { todayIso } from '../analytics/snapshot.ts';
import { Button, ErrorText, Field, Input, parseMoneyInput, Select } from '../analytics/ui.tsx';
import { CONFIDENCE_LABEL, PRIORITY_LABEL } from './labels.ts';
import { buildRRule, parseRecurrence, type RecurrenceForm, WEEKDAYS } from './rrule.ts';

export function PlanEditor({
  snap,
  plan,
  initial,
  onDone,
}: {
  snap: Snapshot;
  plan?: PlannedTransaction;
  initial?: { kind?: PlannedTransaction['kind']; dueDate?: string };
  onDone: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const schedule: RecurrenceSchedule | undefined = plan?.recurrenceId
    ? snap.schedules.find((s) => s.id === plan.recurrenceId)
    : undefined;
  const accounts = snap.accounts.filter((a) => !a.isArchived);
  const [kind, setKind] = useState(plan?.kind ?? initial?.kind ?? 'expense');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [accountId, setAccountId] = useState(plan?.accountId ?? accounts[0]?.id ?? '');
  const [toAccountId, setToAccountId] = useState(plan?.toAccountId ?? '');
  const [categoryId, setCategoryId] = useState(plan?.categoryId ?? '');
  const [amount, setAmount] = useState(plan?.amount.amount ?? '');
  const [amountMin, setAmountMin] = useState(plan?.amountMin?.amount ?? '');
  const [amountMax, setAmountMax] = useState(plan?.amountMax?.amount ?? '');
  const [dueDate, setDueDate] = useState(plan?.dueDate ?? initial?.dueDate ?? todayIso());
  const parsed = parseRecurrence(schedule?.rrule);
  const [rec, setRec] = useState<RecurrenceForm>(parsed);
  const [custom] = useState(parsed.custom);
  const [endMode, setEndMode] = useState<'never' | 'until' | 'count'>(
    schedule?.endDate ? 'until' : schedule?.occurrenceCount ? 'count' : 'never',
  );
  const [endDate, setEndDate] = useState(schedule?.endDate ?? '');
  const [count, setCount] = useState(String(schedule?.occurrenceCount ?? ''));
  const [bda, setBda] = useState(schedule?.businessDayAdjustment ?? 'none');
  const [priority, setPriority] = useState(plan?.priority ?? 'normal');
  const [confidence, setConfidence] = useState(plan?.confidence ?? 'expected');
  const [installments, setInstallments] = useState(String(plan?.installmentTotal ?? ''));
  const [installmentStart, setInstallmentStart] = useState(String(plan?.installmentStart ?? ''));
  const [reminder, setReminder] = useState(String(plan?.reminderDaysBefore ?? ''));
  const [status, setStatus] = useState(plan?.status ?? 'active');
  const [notes, setNotes] = useState(plan?.notes ?? '');
  const [err, setErr] = useState<unknown>(null);

  const currency = accounts.find((a) => a.id === accountId)?.currency ?? snap.currency;
  const save = useOpsMutation(async (ops, input: Record<string, unknown>) =>
    plan
      ? ops.update('planned_transactions', plan.id, { ...input, version: plan.version })
      : ops.create('planned_transactions', input as never),
  );
  const remove = useOpsMutation(
    async (ops) => plan && ops.remove('planned_transactions', plan.id, plan.version),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const amt = parseMoneyInput(amount, currency, f.parseDecimal);
    if (!amt) return setErr(new Error(`Enter a valid ${currency} amount`));
    const opt = (s: string) => (s.trim() ? parseMoneyInput(s, currency, f.parseDecimal) : null);
    let rrule: string | null;
    try {
      rrule = custom && rec.freq === parsed.freq ? custom : buildRRule(rec);
    } catch (x) {
      return setErr(x);
    }
    const int = (s: string) => (s.trim() ? Number.parseInt(s, 10) : null);
    save.mutate(
      {
        kind,
        description,
        accountId: accountId || null,
        toAccountId: kind === 'transfer' ? toAccountId || null : null,
        categoryId: kind === 'transfer' ? null : categoryId || null,
        amount: amt,
        amountMin: opt(amountMin),
        amountMax: opt(amountMax),
        dueDate,
        recurrence: rrule
          ? {
              rrule,
              startDate: dueDate,
              endDate: endMode === 'until' ? endDate || null : null,
              occurrenceCount: endMode === 'count' ? int(count) : null,
              businessDayAdjustment: bda,
            }
          : null,
        priority,
        confidence,
        installmentTotal: int(installments),
        installmentStart: int(installmentStart),
        reminderDaysBefore: int(reminder),
        notes,
        ...(plan ? { status } : {}),
      },
      { onSuccess: onDone, onError: setErr },
    );
  };

  const cats = snap.categories.filter(
    (c) => !c.isArchived && (kind === 'income' ? c.kind === 'income' : c.kind === 'expense'),
  );
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label={t('notif.type', 'Type')}>
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="expense">{t('transaction.kind.expense', 'Expense')}</option>
          <option value="income">{t('transaction.kind.income', 'Income')}</option>
          <option value="transfer">{t('transaction.kind.transfer', 'Transfer')}</option>
        </Select>
      </Field>
      <Field label={t('transaction.description', 'Description')}>
        <Input required value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field
        label={
          kind === 'transfer' ? t('quick.from', 'From account') : t('quick.account', 'Account')
        }
      >
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.currency})
            </option>
          ))}
        </Select>
      </Field>
      {kind === 'transfer' ? (
        <Field label={t('quick.to', 'To account')}>
          <Select required value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
            <option value="">{t('quick.choose', 'Choose…')}</option>
            {accounts
              .filter((a) => a.id !== accountId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
          </Select>
        </Field>
      ) : (
        <Field label={t('transaction.category', 'Category')}>
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t('transaction.uncategorized', 'Uncategorized')}</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label={t('planning.planEditor.amount', 'Amount ({{currency}})', { currency: currency })}
      >
        <Input
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field label={t('planning.planEditor.dueDateFirstOccurrence', 'Due date (first occurrence)')}>
        <Input type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </Field>
      <Field
        label={t('planning.planEditor.minimumOptional', 'Minimum (optional)')}
        hint={t(
          'planning.planEditor.variableBillsRangeUsed',
          'Variable bills: range used by forecasts',
        )}
      >
        <Input
          inputMode="decimal"
          value={amountMin}
          onChange={(e) => setAmountMin(e.target.value)}
        />
      </Field>
      <Field label={t('planning.planEditor.maximumOptional', 'Maximum (optional)')}>
        <Input
          inputMode="decimal"
          value={amountMax}
          onChange={(e) => setAmountMax(e.target.value)}
        />
      </Field>

      <fieldset className="col-span-full grid grid-cols-1 gap-3 rounded-md border border-line p-3 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">{t('lock.repeat', 'Repeat')}</legend>
        <Field label={t('planning.planEditor.frequency', 'Frequency')}>
          <Select
            value={rec.freq}
            onChange={(e) => setRec({ ...rec, freq: e.target.value as RecurrenceForm['freq'] })}
          >
            <option value="none">
              {t('planning.planEditor.doesNotRepeat', 'Does not repeat')}
            </option>
            <option value="DAILY">{t('backup.daily', 'Daily')}</option>
            <option value="WEEKLY">{t('backup.weekly', 'Weekly')}</option>
            <option value="MONTHLY">{t('backup.monthly', 'Monthly')}</option>
            <option value="YEARLY">{t('planning.planEditor.yearly', 'Yearly')}</option>
          </Select>
        </Field>
        {rec.freq !== 'none' && (
          <>
            <Field label={t('planning.planEditor.everyInterval', 'Every (interval)')}>
              <Input
                type="number"
                min={1}
                max={99}
                value={rec.interval}
                onChange={(e) => setRec({ ...rec, interval: Number(e.target.value) || 1 })}
              />
            </Field>
            {custom && rec.freq === parsed.freq && (
              <p className="col-span-full text-xs text-muted">
                {t('planning.planEditor.customRuleKept', 'Custom rule kept:')} {custom}
              </p>
            )}
            {rec.freq === 'WEEKLY' && (
              <fieldset
                className="col-span-full flex flex-wrap gap-2"
                aria-label={t('planning.planEditor.weekdays', 'Weekdays')}
              >
                {WEEKDAYS.map((d) => (
                  <label key={d} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={rec.byDay.includes(d)}
                      onChange={(e) =>
                        setRec({
                          ...rec,
                          byDay: e.target.checked
                            ? [...rec.byDay, d]
                            : rec.byDay.filter((x) => x !== d),
                        })
                      }
                    />
                    {d}
                  </label>
                ))}
              </fieldset>
            )}
            {rec.freq === 'MONTHLY' && (
              <Field
                label={t('planning.planEditor.dayOfMonth', 'Day of month')}
                hint={t(
                  'planning.planEditor.missingDaysEG',
                  'Missing days (e.g. 31 in April) fall on the month end',
                )}
              >
                <Select
                  value={rec.byMonthDay ?? ''}
                  onChange={(e) =>
                    setRec({ ...rec, byMonthDay: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">
                    {t('planning.planEditor.sameAsDueDate', 'Same as due date')}
                  </option>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                  <option value={-1}>{t('planning.planEditor.lastDay', 'Last day')}</option>
                </Select>
              </Field>
            )}
            <Field label={t('planning.planEditor.weekendHandling', 'Weekend handling')}>
              <Select value={bda} onChange={(e) => setBda(e.target.value as typeof bda)}>
                {BUSINESS_DAY_ADJUSTMENTS.map((b) => (
                  <option key={b} value={b}>
                    {
                      {
                        none: t('planning.planEditor.keepDate', 'Keep date'),
                        previous: t(
                          'planning.planEditor.previousWeekday',
                          'Move to previous weekday',
                        ),
                        next: t('planning.planEditor.nextWeekday', 'Move to next weekday'),
                      }[b]
                    }
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('planning.planEditor.ends', 'Ends')}>
              <Select
                value={endMode}
                onChange={(e) => setEndMode(e.target.value as typeof endMode)}
              >
                <option value="never">{t('planning.planEditor.never', 'Never')}</option>
                <option value="until">{t('planning.planEditor.onDate', 'On date')}</option>
                <option value="count">
                  {t('planning.planEditor.afterNTimes', 'After N times')}
                </option>
              </Select>
            </Field>
            {endMode === 'until' && (
              <Field label={t('planning.planEditor.endDate', 'End date')}>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
            )}
            {endMode === 'count' && (
              <Field label={t('planning.planEditor.occurrences', 'Occurrences')}>
                <Input
                  type="number"
                  min={1}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              </Field>
            )}
          </>
        )}
      </fieldset>

      <Field label={t('goals.page.priority', 'Priority')}>
        <Select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(`planning.priority.${p}`, PRIORITY_LABEL[p])}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('planning.planEditor.confidence', 'Confidence')}>
        <Select
          value={confidence}
          onChange={(e) => setConfidence(e.target.value as typeof confidence)}
        >
          {CONFIDENCE_LEVELS.map((c) => (
            <option key={c} value={c}>
              {t(`planning.confidence.${c}`, CONFIDENCE_LABEL[c])}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t('planning.planEditor.installmentsTotalOptional', 'Installments (total, optional)')}
      >
        <Input
          type="number"
          min={1}
          value={installments}
          onChange={(e) => setInstallments(e.target.value)}
        />
      </Field>
      {installments && (
        <Field
          label={t('planning.planEditor.firstInstallmentNumber', 'First installment number')}
          hint={t('planning.planEditor.eG4When', 'e.g. 4 when 3 were paid before')}
        >
          <Input
            type="number"
            min={1}
            value={installmentStart}
            onChange={(e) => setInstallmentStart(e.target.value)}
          />
        </Field>
      )}
      <Field
        label={t('planning.planEditor.remindDaysBeforeOptional', 'Remind days before (optional)')}
      >
        <Input
          type="number"
          min={0}
          max={60}
          value={reminder}
          onChange={(e) => setReminder(e.target.value)}
        />
      </Field>
      {plan && (
        <Field label={t('sync.status', 'Status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {PLAN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t('transaction.notes', 'Notes')}>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="col-span-full">
        <ErrorText error={err} />
      </div>
      <div className="col-span-full flex justify-between gap-2">
        {plan ? (
          <Button
            variant="danger"
            onClick={() =>
              confirm(
                t(
                  'planning.planEditor.confirmDelete',
                  'Delete this plan and all its future occurrences?',
                ),
              ) && remove.mutate(undefined, { onSuccess: onDone, onError: setErr })
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
