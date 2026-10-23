// What-if simulator (feature 69): hypothetical purchases, income changes and removed plans are
// applied to a copy of the forecast input. Nothing here writes to the DataSource.
import { addMonths, fromMinor, type Money, toMinor } from '@finplat/finance-engine';
import type { ScenarioAdjustment } from '@finplat/forecasting';
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { MoneyChart } from '../analytics/chart.tsx';
import type { Snapshot } from '../analytics/snapshot.ts';
import {
  Amount,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  parseMoneyInput,
  SERIES,
  Select,
  Stat,
} from '../analytics/ui.tsx';
import { HORIZONS } from './ForecastPanel.tsx';
import { simulate } from './forecast.ts';

type Draft = {
  type: 'purchase' | 'income' | 'expense_change' | 'remove';
  description: string;
  amount: string;
  date: string;
  recurring: boolean;
  accountId: string;
  planId: string;
};

export function WhatIf({ snap }: { snap: Snapshot }) {
  const t = useT();
  const f = useFormat();
  const accounts = snap.accounts.filter((a) => !a.isArchived);
  const [months, setMonths] = useState(6);
  const [items, setItems] = useState<ScenarioAdjustment[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const blank: Draft = {
    type: 'purchase',
    description: '',
    amount: '',
    date: snap.today,
    recurring: false,
    accountId: accounts[0]?.id ?? '',
    planId: '',
  };
  const [d, setD] = useState<Draft>(blank);
  const [err, setErr] = useState<unknown>(null);
  const to = addMonths(snap.today, months);
  const result = useMemo(
    () => (items.length ? simulate(snap, to, items) : null),
    [snap, to, items],
  );

  const add = () => {
    setErr(null);
    if (d.type === 'remove') {
      const p = snap.plans.find((x) => x.id === d.planId);
      if (!p) return setErr(new Error(t('planning.whatIf.choosePlan', 'Choose a plan')));
      setItems([
        ...items,
        {
          removePlannedTransactionId: p.id,
          description: t('planning.whatIf.without', 'Without {{name}}', { name: p.description }),
        },
      ]);
      setLabels([
        ...labels,
        t('planning.whatIf.removePlan', 'Remove plan: {{name}}', { name: p.description }),
      ]);
      return setD(blank);
    }
    const acc = accounts.find((a) => a.id === d.accountId);
    if (!acc) return setErr(new Error(t('common.chooseAccount', 'Choose an account')));
    const m = parseMoneyInput(d.amount, acc.currency, f.parseDecimal);
    if (!m || toMinor(m) <= 0n)
      return setErr(
        new Error(
          t('planning.whatIf.positiveAmount', 'Enter a positive {{cur}} amount', {
            cur: acc.currency,
          }),
        ),
      );
    const signed: Money = d.type === 'income' ? m : fromMinor(-toMinor(m), m.currency);
    const desc =
      d.description ||
      {
        purchase: t('planning.whatIf.purchase', 'Purchase'),
        income: t('planning.whatIf.extraIncome', 'Extra income'),
        expense_change: t('planning.whatIf.newExpense', 'New expense'),
      }[d.type];
    setItems([
      ...items,
      {
        description: desc,
        amount: signed,
        date: d.date,
        accountId: acc.id,
        ...(d.recurring ? { rrule: 'FREQ=MONTHLY' } : {}),
      },
    ]);
    setLabels([
      ...labels,
      d.recurring
        ? t('planning.whatIf.labelMonthly', '{{desc}}: {{amount}} monthly from {{date}}', {
            desc,
            amount: f.money(signed),
            date: f.date(d.date),
          })
        : t('planning.whatIf.labelOnce', '{{desc}}: {{amount}} on {{date}}', {
            desc,
            amount: f.money(signed),
            date: f.date(d.date),
          }),
    ]);
    setD(blank);
  };

  const rows =
    result?.baseline.days.map((day, i) => ({
      x: day.date,
      label: f.date(day.date),
      money: { baseline: day.expected, scenario: result.scenario.days[i]?.expected ?? null },
    })) ?? [];
  const step = Math.max(1, Math.floor(rows.length / 120));

  return (
    <Card
      title={t(
        'planning.whatIf.whatIfScenariosSimulation',
        'What-if scenarios (simulation only, nothing is saved)',
      )}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label={t('lock.change', 'Change')}>
            <Select
              value={d.type}
              onChange={(e) => setD({ ...d, type: e.target.value as Draft['type'] })}
            >
              <option value="purchase">{t('planning.whatIf.purchase', 'Purchase')}</option>
              <option value="expense_change">
                {t('planning.whatIf.newRecurringExpense', 'New recurring expense')}
              </option>
              <option value="income">{t('planning.whatIf.incomeChange', 'Income change')}</option>
              <option value="remove">{t('planning.whatIf.removeAPlan', 'Remove a plan')}</option>
            </Select>
          </Field>
          {d.type === 'remove' ? (
            <Field label={t('transactions.detailDrawer.plan', 'Plan')}>
              <Select value={d.planId} onChange={(e) => setD({ ...d, planId: e.target.value })}>
                <option value="">{t('quick.choose', 'Choose…')}</option>
                {snap.plans
                  .filter((p) => p.status === 'active')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.description}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : (
            <>
              <Field label={t('transaction.description', 'Description')}>
                <Input
                  value={d.description}
                  onChange={(e) => setD({ ...d, description: e.target.value })}
                />
              </Field>
              <Field label={t('transaction.amount', 'Amount')}>
                <Input
                  inputMode="decimal"
                  value={d.amount}
                  onChange={(e) => setD({ ...d, amount: e.target.value })}
                />
              </Field>
              <Field
                label={
                  d.recurring || d.type === 'expense_change'
                    ? t('planning.whatIf.starting', 'Starting')
                    : t('transaction.date', 'Date')
                }
              >
                <Input
                  type="date"
                  value={d.date}
                  onChange={(e) => setD({ ...d, date: e.target.value })}
                />
              </Field>
              <Field label={t('quick.account', 'Account')}>
                <Select
                  value={d.accountId}
                  onChange={(e) => setD({ ...d, accountId: e.target.value })}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={d.recurring || d.type === 'expense_change'}
                  disabled={d.type === 'expense_change'}
                  onChange={(e) => setD({ ...d, recurring: e.target.checked })}
                />
                {t('backup.monthly', 'Monthly')}
              </label>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => add()} disabled={!accounts.length}>
            {t('planning.whatIf.addToScenario', 'Add to scenario')}
          </Button>
          <Select
            aria-label={t('planning.whatIf.horizon', 'Horizon')}
            className="w-auto"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          >
            {HORIZONS.map((h) => (
              <option key={h} value={h}>
                {h} {t('planning.whatIf.months', 'months')}
              </option>
            ))}
          </Select>
          {items.length > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                setItems([]);
                setLabels([]);
              }}
            >
              {t('planning.whatIf.clear', 'Clear')}
            </Button>
          )}
        </div>
        <ErrorText error={err} />
        {labels.length > 0 && (
          <ul className="space-y-1 text-sm">
            {labels.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: scenario items have no ids and may repeat
              <li key={`${l}-${i}`} className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  aria-label={t('planning.whatIf.remove', 'Remove {{l}}', { l: l })}
                  onClick={() => {
                    setItems(items.filter((_, j) => j !== i));
                    setLabels(labels.filter((_, j) => j !== i));
                  }}
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
                {l}
              </li>
            ))}
          </ul>
        )}
        {result && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label={t('planning.whatIf.lowestBalance', 'Lowest balance')}
                value={<Amount value={result.scenario.lowest.amount} tone />}
                hint={
                  <>
                    {t('planning.whatIf.change2', 'change')}{' '}
                    <Amount value={result.delta.lowest} tone />
                  </>
                }
              />
              <Stat
                label={t('planning.whatIf.monthEnd', 'Month-end')}
                value={<Amount value={result.scenario.monthEnd} tone />}
                hint={
                  <>
                    {t('planning.whatIf.change2', 'change')}{' '}
                    <Amount value={result.delta.monthEnd} tone />
                  </>
                }
              />
              <Stat
                label={t('planning.whatIf.safeToSpend', 'Safe to spend')}
                value={<Amount value={result.scenario.safeToSpend} />}
                hint={
                  <>
                    {t('planning.whatIf.change2', 'change')}{' '}
                    <Amount value={result.delta.safeToSpend} tone />
                  </>
                }
              />
              <Stat
                label={t('planning.whatIf.endBalance', 'End balance')}
                value={<Amount value={result.scenario.days.at(-1)?.expected} tone />}
                hint={
                  <>
                    {t('planning.whatIf.change2', 'change')}{' '}
                    <Amount value={result.delta.end} tone />
                  </>
                }
              />
            </div>
            {result.scenario.shortfalls.length > 0 && (
              <p role="alert" className="text-sm text-neg">
                {t('planning.whatIf.thisScenarioCausesA', 'This scenario causes a shortfall from')}{' '}
                {f.date(result.scenario.shortfalls[0]?.date as string)}.
              </p>
            )}
            <MoneyChart
              title={t(
                'planning.whatIf.baselineVersusScenarioExpected',
                'Baseline versus scenario expected balance',
              )}
              rows={rows.filter((_, i) => i % step === 0)}
              series={[
                {
                  key: 'baseline',
                  label: t('planning.whatIf.baseline', 'Baseline'),
                  color: SERIES[0] as string,
                  kind: 'line',
                },
                {
                  key: 'scenario',
                  label: t('planning.whatIf.scenario', 'Scenario'),
                  color: SERIES[1] as string,
                  kind: 'line',
                },
              ]}
            />
          </>
        )}
      </div>
    </Card>
  );
}
