// What-if simulator (feature 69): hypothetical purchases, income changes and removed plans are
// applied to a copy of the forecast input. Nothing here writes to the DataSource.
import { addMonths, fromMinor, type Money, toMinor } from '@finplat/finance-engine';
import type { ScenarioAdjustment } from '@finplat/forecasting';
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useFormat } from '../../lib/format.ts';
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
      if (!p) return setErr(new Error('Choose a plan'));
      setItems([
        ...items,
        { removePlannedTransactionId: p.id, description: `Without ${p.description}` },
      ]);
      setLabels([...labels, `Remove plan: ${p.description}`]);
      return setD(blank);
    }
    const acc = accounts.find((a) => a.id === d.accountId);
    if (!acc) return setErr(new Error('Choose an account'));
    const m = parseMoneyInput(d.amount, acc.currency, f.parseDecimal);
    if (!m || toMinor(m) <= 0n) return setErr(new Error(`Enter a positive ${acc.currency} amount`));
    const signed: Money = d.type === 'income' ? m : fromMinor(-toMinor(m), m.currency);
    const desc =
      d.description ||
      { purchase: 'Purchase', income: 'Extra income', expense_change: 'New expense' }[d.type];
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
      `${desc}: ${f.money(signed)} ${d.recurring ? 'monthly from' : 'on'} ${f.date(d.date)}`,
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
    <Card title="What-if scenarios (simulation only, nothing is saved)">
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Change">
            <Select
              value={d.type}
              onChange={(e) => setD({ ...d, type: e.target.value as Draft['type'] })}
            >
              <option value="purchase">Purchase</option>
              <option value="expense_change">New recurring expense</option>
              <option value="income">Income change</option>
              <option value="remove">Remove a plan</option>
            </Select>
          </Field>
          {d.type === 'remove' ? (
            <Field label="Plan">
              <Select value={d.planId} onChange={(e) => setD({ ...d, planId: e.target.value })}>
                <option value="">Choose…</option>
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
              <Field label="Description">
                <Input
                  value={d.description}
                  onChange={(e) => setD({ ...d, description: e.target.value })}
                />
              </Field>
              <Field label="Amount">
                <Input
                  inputMode="decimal"
                  value={d.amount}
                  onChange={(e) => setD({ ...d, amount: e.target.value })}
                />
              </Field>
              <Field label={d.recurring || d.type === 'expense_change' ? 'Starting' : 'Date'}>
                <Input
                  type="date"
                  value={d.date}
                  onChange={(e) => setD({ ...d, date: e.target.value })}
                />
              </Field>
              <Field label="Account">
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
                Monthly
              </label>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => add()} disabled={!accounts.length}>
            Add to scenario
          </Button>
          <Select
            aria-label="Horizon"
            className="w-auto"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          >
            {HORIZONS.map((h) => (
              <option key={h} value={h}>
                {h} months
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
              Clear
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
                  aria-label={`Remove ${l}`}
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
                label="Lowest balance"
                value={<Amount value={result.scenario.lowest.amount} tone />}
                hint={
                  <>
                    change <Amount value={result.delta.lowest} tone />
                  </>
                }
              />
              <Stat
                label="Month-end"
                value={<Amount value={result.scenario.monthEnd} tone />}
                hint={
                  <>
                    change <Amount value={result.delta.monthEnd} tone />
                  </>
                }
              />
              <Stat
                label="Safe to spend"
                value={<Amount value={result.scenario.safeToSpend} />}
                hint={
                  <>
                    change <Amount value={result.delta.safeToSpend} tone />
                  </>
                }
              />
              <Stat
                label="End balance"
                value={<Amount value={result.scenario.days.at(-1)?.expected} tone />}
                hint={
                  <>
                    change <Amount value={result.delta.end} tone />
                  </>
                }
              />
            </div>
            {result.scenario.shortfalls.length > 0 && (
              <p role="alert" className="text-sm text-neg">
                This scenario causes a shortfall from{' '}
                {f.date(result.scenario.shortfalls[0]?.date as string)}.
              </p>
            )}
            <MoneyChart
              title="Baseline versus scenario expected balance"
              rows={rows.filter((_, i) => i % step === 0)}
              series={[
                { key: 'baseline', label: 'Baseline', color: SERIES[0] as string, kind: 'line' },
                { key: 'scenario', label: 'Scenario', color: SERIES[1] as string, kind: 'line' },
              ]}
            />
          </>
        )}
      </div>
    </Card>
  );
}
