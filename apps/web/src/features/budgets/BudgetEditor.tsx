// Create / edit a budget or budget template: period, rollover, planned spending, alert
// thresholds and per-category (or overall) allocations. Allocating all income is never required.
import { BUDGET_PERIOD_TYPES, type Budget, ROLLOVER_POLICIES } from '@finplat/domain';
import type { Money } from '@finplat/finance-engine';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { useOpsMutation } from '../analytics/hooks.ts';
import { type Snapshot, todayIso } from '../analytics/snapshot.ts';
import { Button, ErrorText, Field, Input, parseMoneyInput, Select } from '../analytics/ui.tsx';

export interface AllocationRow {
  categoryId: string | null;
  amount: Money;
}

export const ROLLOVER_LABEL: Record<(typeof ROLLOVER_POLICIES)[number], string> = {
  none: 'No rollover',
  carry_surplus: 'Carry unused amount',
  carry_deficit: 'Carry overspending',
  carry_both: 'Carry both',
};

export function BudgetEditor({
  snap,
  budget,
  prefill,
  allocations = [],
  asTemplate = false,
  onDone,
}: {
  snap: Snapshot;
  budget?: Budget;
  prefill?: Partial<Budget>;
  allocations?: AllocationRow[];
  asTemplate?: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const init = budget ?? prefill;
  const [name, setName] = useState(init?.name ?? '');
  const [periodType, setPeriodType] = useState(init?.periodType ?? 'monthly');
  const [anchor, setAnchor] = useState(String(init?.periodAnchorDay ?? 1));
  const [startDate, setStartDate] = useState(init?.startDate ?? `${todayIso().slice(0, 7)}-01`);
  const [endDate, setEndDate] = useState(init?.endDate ?? '');
  const [currency, setCurrency] = useState(init?.currency ?? snap.currency);
  const [rollover, setRollover] = useState(init?.rolloverPolicy ?? 'none');
  const [includePlanned, setIncludePlanned] = useState(init?.includePlanned ?? true);
  const [thresholds, setThresholds] = useState(
    (init?.alertThresholds ?? ['0.8', '1.0'])
      .map((t) => String(Math.round(Number(t) * 100)))
      .join(', '),
  );
  const [lines, setLines] = useState(
    allocations.length
      ? allocations.map((a) => ({ categoryId: a.categoryId ?? '', amount: a.amount.amount }))
      : [{ categoryId: '', amount: '' }],
  );
  const [err, setErr] = useState<unknown>(null);
  const template = budget?.isTemplate ?? asTemplate;

  const save = useOpsMutation((ops, input: Record<string, unknown>) =>
    budget
      ? ops.update('budgets', budget.id, { ...input, version: budget.version } as never)
      : ops.create('budgets', input as never),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const allocs = [];
    for (const l of lines) {
      if (!l.amount.trim()) continue;
      const m = parseMoneyInput(l.amount, currency, f.parseDecimal);
      if (!m) return setErr(new Error(`Invalid ${currency} amount: ${l.amount}`));
      allocs.push({ categoryId: l.categoryId || null, amount: m });
    }
    if (!allocs.length)
      return setErr(new Error('Add at least one limit (overall or per category)'));
    const ts = thresholds
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((x) => Number(x));
    if (ts.some((x) => !Number.isFinite(x) || x <= 0 || x > 500))
      return setErr(new Error('Thresholds are percentages, e.g. 80, 100'));
    save.mutate(
      {
        name,
        periodType,
        periodAnchorDay: Number(anchor) || 1,
        startDate,
        endDate: endDate || null,
        currency,
        rolloverPolicy: rollover,
        includePlanned,
        alertThresholds: ts.sort((a, b) => a - b).map((x) => (x / 100).toFixed(2)),
        allocations: allocs,
        isTemplate: template,
        ...(!budget && prefill?.isTemplate && !template ? { templateId: prefill.id } : {}),
      },
      { onSuccess: onDone, onError: setErr },
    );
  };

  const currencies = [...new Set([snap.currency, ...snap.accounts.map((a) => a.currency)])];
  const cats = snap.categories.filter((c) => c.kind === 'expense' && !c.isArchived);
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field
        label={
          template
            ? t('budgets.budgetEditor.templateName', 'Template name')
            : t('profiles.name', 'Name')
        }
      >
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('budgets.budgetEditor.period', 'Period')}>
        <Select
          value={periodType}
          onChange={(e) => setPeriodType(e.target.value as typeof periodType)}
        >
          {BUDGET_PERIOD_TYPES.map((p) => (
            <option key={p} value={p}>
              {t(`budget.period.${p}`, p)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('budgets.budgetEditor.starts', 'Starts')}>
        <Input
          type="date"
          required
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
      </Field>
      <Field
        label={
          periodType === 'custom'
            ? t('budgets.budgetEditor.endsRequired', 'Ends (required)')
            : t('budgets.budgetEditor.endsOptional', 'Ends (optional)')
        }
      >
        <Input
          type="date"
          required={periodType === 'custom'}
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
      </Field>
      {(periodType === 'monthly' || periodType === 'quarterly' || periodType === 'yearly') && (
        <Field
          label={t('budgets.budgetEditor.periodStartsOnDay', 'Period starts on day')}
          hint={t('budgets.budgetEditor.eGSalaryDay', 'e.g. salary day; clamped to the month end')}
        >
          <Input
            type="number"
            min={1}
            max={31}
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
          />
        </Field>
      )}
      <Field label={t('profiles.currency', 'Currency')}>
        <Select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!!budget}>
          {currencies.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('budgets.budgetEditor.rollover', 'Rollover')}>
        <Select value={rollover} onChange={(e) => setRollover(e.target.value as typeof rollover)}>
          {ROLLOVER_POLICIES.map((r) => (
            <option key={r} value={r}>
              {t(`budget.rollover.${r}`, ROLLOVER_LABEL[r])}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('budgets.budgetEditor.alertAtOfLimit', 'Alert at (% of limit)')}>
        <Input value={thresholds} onChange={(e) => setThresholds(e.target.value)} />
      </Field>
      <label className="col-span-full flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includePlanned}
          onChange={(e) => setIncludePlanned(e.target.checked)}
        />
        {t(
          'budgets.budgetEditor.countPlannedCommittedExpenses',
          'Count planned (committed) expenses against the remaining amount',
        )}
      </label>
      <fieldset className="col-span-full space-y-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-medium">
          {t('budgets.budgetEditor.limits', 'Limits')}
        </legend>
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: editable rows without ids
          <div key={i} className="flex gap-2">
            <Select
              aria-label={t('transaction.category', 'Category')}
              className="flex-1"
              value={l.categoryId}
              onChange={(e) =>
                setLines(lines.map((x, j) => (j === i ? { ...x, categoryId: e.target.value } : x)))
              }
            >
              <option value="">
                {t('budgets.budgetEditor.allSpendingOverallLimit', 'All spending (overall limit)')}
              </option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Input
              aria-label={t('budgets.budgetEditor.limit', 'Limit ({{currency}})', {
                currency: currency,
              })}
              inputMode="decimal"
              className="w-32"
              value={l.amount}
              onChange={(e) =>
                setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
              }
            />
            <Button
              variant="ghost"
              aria-label={t('budgets.budgetEditor.removeLimit', 'Remove limit')}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          onClick={() => setLines([...lines, { categoryId: '', amount: '' }])}
        >
          <Plus aria-hidden className="size-4" /> {t('budgets.budgetEditor.addLimit', 'Add limit')}
        </Button>
        <p className="text-xs text-muted">
          {t(
            'budgets.budgetEditor.categoryLimitsIncludeTheir',
            'Category limits include their subcategories. You do not need to allocate all income.',
          )}
        </p>
      </fieldset>
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
