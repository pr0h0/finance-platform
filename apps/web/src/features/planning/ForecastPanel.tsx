// Forecast balance chart with optimistic/conservative band, lowest balance, shortfalls,
// month-end, safe-to-spend (with the profile's minimum reserve) and stated assumptions.

import { plotValue } from '@finplat/charts';
import { addMonths, type Money, toMinor } from '@finplat/finance-engine';
import type { Forecast } from '@finplat/forecasting';
import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useFormat } from '../../lib/format.ts';
import { ChartFrame, type ChartRow, MoneyChart } from '../analytics/chart.tsx';
import { useOpsMutation } from '../analytics/hooks.ts';
import type { Snapshot } from '../analytics/snapshot.ts';
import {
  Amount,
  Button,
  Card,
  DataBanner,
  Field,
  Input,
  parseMoneyInput,
  SERIES,
  Stat,
} from '../analytics/ui.tsx';
import { buildForecast } from './forecast.ts';

export const HORIZONS = [1, 3, 6, 12, 24, 60] as const;

export function forecastRows(f: Forecast, fmtDate: (d: string) => string, step = 1): ChartRow[] {
  return f.days
    .filter((_, i) => i % step === 0 || i === f.days.length - 1)
    .map((d) => ({
      x: d.date,
      label: fmtDate(d.date),
      money: { expected: d.expected, conservative: d.conservative, optimistic: d.optimistic },
      band: [plotValue(d.conservative), plotValue(d.optimistic)] as [number, number],
    }));
}

export function ForecastSummary({
  fc,
  accountName,
}: {
  fc: Forecast;
  accountName: (id: string) => string;
}) {
  const f = useFormat();
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat label="Month-end (expected)" value={<Amount value={fc.monthEnd} tone />} />
      <Stat
        label="Lowest balance (expected)"
        value={<Amount value={fc.lowest.amount} tone />}
        hint={f.date(fc.lowest.date)}
      />
      <Stat
        label="Safe to spend"
        value={<Amount value={fc.safeToSpend} />}
        hint={`Lowest conservative balance until ${f.date(fc.safeToSpendUntil)}, minus reserve`}
      />
      <Stat
        label={`End of forecast (${f.date(fc.to)})`}
        value={<Amount value={fc.days.at(-1)?.expected as Money} tone />}
      />
      {fc.shortfalls.length > 0 && (
        <div
          role="alert"
          className="col-span-full flex gap-2 rounded-md border border-neg/40 bg-neg/10 p-3 text-sm"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 text-neg" />
          <div>
            <p className="font-medium">Projected shortfall</p>
            <ul>
              {fc.shortfalls.map((s) => (
                <li key={`${s.accountId}|${s.date}`}>
                  {accountName(s.accountId)} goes below its floor from {f.date(s.date)} (lowest{' '}
                  <Amount value={s.amount} />)
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export function ForecastPanel({ snap }: { snap: Snapshot }) {
  const f = useFormat();
  const [months, setMonths] = useState<number>(3);
  const to = addMonths(snap.today, months);
  const fc = useMemo(() => buildForecast(snap, to), [snap, to]);
  const step = Math.max(1, Math.floor(fc.days.length / 120));
  const rows = forecastRows(fc, f.date, step);
  const reserve = snap.settings['forecast.minimumReserve'] as Money | undefined;
  const [reserveText, setReserveText] = useState(reserve?.amount ?? '');
  const saveReserve = useOpsMutation((ops, v: Money | null) =>
    ops.setSetting('forecast.minimumReserve', v),
  );
  const accName = new Map(snap.accounts.map((a) => [a.id, a.name]));

  return (
    <Card
      title="Forecast balance"
      actions={
        <fieldset aria-label="Forecast horizon" className="flex gap-1">
          {HORIZONS.map((h) => (
            <Button
              key={h}
              variant={h === months ? 'primary' : 'ghost'}
              aria-pressed={h === months}
              className="text-xs"
              onClick={() => setMonths(h)}
            >
              {h < 12 ? `${h}m` : `${h / 12}y`}
            </Button>
          ))}
        </fieldset>
      }
    >
      <div className="space-y-4">
        <ForecastSummary fc={fc} accountName={(id) => accName.get(id) ?? 'An account'} />
        <ChartFrame
          name="forecast"
          table={
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1">Date</th>
                  <th>Conservative</th>
                  <th>Expected</th>
                  <th>Optimistic</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.x}>
                    <td className="py-0.5">{r.label}</td>
                    <td>
                      <Amount value={r.money.conservative} />
                    </td>
                    <td>
                      <Amount value={r.money.expected} />
                    </td>
                    <td>
                      <Amount value={r.money.optimistic} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <MoneyChart
            title="Projected total balance with conservative to optimistic range"
            rows={rows}
            height={260}
            band={{ label: 'Range', color: SERIES[0] as string }}
            series={[
              { key: 'expected', label: 'Expected', color: SERIES[0] as string, kind: 'line' },
              {
                key: 'conservative',
                label: 'Conservative',
                color: SERIES[1] as string,
                kind: 'line',
              },
              { key: 'optimistic', label: 'Optimistic', color: SERIES[2] as string, kind: 'line' },
            ]}
          />
        </ChartFrame>
        <form
          className="no-print flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveReserve.mutate(
              reserveText.trim()
                ? parseMoneyInput(reserveText, snap.currency, f.parseDecimal)
                : null,
            );
          }}
        >
          <Field label={`Minimum reserve (${snap.currency})`}>
            <Input
              inputMode="decimal"
              value={reserveText}
              onChange={(e) => setReserveText(e.target.value)}
            />
          </Field>
          <Button type="submit">Save reserve</Button>
        </form>
        <DataBanner warnings={fc.warnings} />
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Assumptions</summary>
          <ul className="mt-1 list-disc pl-5">
            {fc.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
            <li>
              Expected counts confirmed and estimated plans; conservative drops uncertain income and
              keeps all expenses at their maximum; optimistic the reverse. Forecasts are estimates,
              not guarantees.
            </li>
          </ul>
        </details>
        {toMinor(fc.lowest.amount) < 0n && (
          <p className="sr-only">Warning: the expected balance goes negative.</p>
        )}
      </div>
    </Card>
  );
}
