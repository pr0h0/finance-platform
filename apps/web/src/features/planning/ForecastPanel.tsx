// Forecast balance chart with optimistic/conservative band, lowest balance, shortfalls,
// month-end, safe-to-spend (with the profile's minimum reserve) and stated assumptions.

import { plotValue } from '@finplat/charts';
import { addMonths, type Money, toMinor } from '@finplat/finance-engine';
import type { Forecast } from '@finplat/forecasting';
import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
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
  const t = useT();
  const f = useFormat();
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat
        label={t('planning.forecastPanel.monthEndExpected', 'Month-end (expected)')}
        value={<Amount value={fc.monthEnd} tone />}
      />
      <Stat
        label={t('planning.forecastPanel.lowestBalanceExpected', 'Lowest balance (expected)')}
        value={<Amount value={fc.lowest.amount} tone />}
        hint={f.date(fc.lowest.date)}
      />
      <Stat
        label={t('planning.forecastPanel.safeToSpend', 'Safe to spend')}
        value={<Amount value={fc.safeToSpend} />}
        hint={t(
          'planning.forecastPanel.lowestConservativeBalanceUntil',
          'Lowest conservative balance until {{v0}}, minus reserve',
          { v0: f.date(fc.safeToSpendUntil) },
        )}
      />
      <Stat
        label={t('planning.forecastPanel.endOfForecast', 'End of forecast ({{v0}})', {
          v0: f.date(fc.to),
        })}
        value={<Amount value={fc.days.at(-1)?.expected as Money} tone />}
      />
      {fc.shortfalls.length > 0 && (
        <div
          role="alert"
          className="col-span-full flex gap-2 rounded-md border border-neg/40 bg-neg/10 p-3 text-sm"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 text-neg" />
          <div>
            <p className="font-medium">
              {t('planning.forecastPanel.projectedShortfall', 'Projected shortfall')}
            </p>
            <ul>
              {fc.shortfalls.map((s) => (
                <li key={`${s.accountId}|${s.date}`}>
                  {accountName(s.accountId)}{' '}
                  {t('planning.forecastPanel.goesBelowItsFloor', 'goes below its floor from')}{' '}
                  {f.date(s.date)} {t('planning.forecastPanel.lowest', '(lowest')}{' '}
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
  const t = useT();
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
      title={t('planning.forecastPanel.forecastBalance', 'Forecast balance')}
      actions={
        <fieldset
          aria-label={t('planning.forecastPanel.forecastHorizon', 'Forecast horizon')}
          className="flex gap-1"
        >
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
                  <th className="py-1">{t('transaction.date', 'Date')}</th>
                  <th>{t('planning.forecastPanel.conservative', 'Conservative')}</th>
                  <th>{t('planning.forecastPanel.expected', 'Expected')}</th>
                  <th>{t('planning.forecastPanel.optimistic', 'Optimistic')}</th>
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
            title={t(
              'planning.forecastPanel.projectedTotalBalanceWith',
              'Projected total balance with conservative to optimistic range',
            )}
            rows={rows}
            height={260}
            band={{ label: t('planning.forecastPanel.range', 'Range'), color: SERIES[0] as string }}
            series={[
              {
                key: 'expected',
                label: t('planning.forecastPanel.expected', 'Expected'),
                color: SERIES[0] as string,
                kind: 'line',
              },
              {
                key: 'conservative',
                label: t('planning.forecastPanel.conservative', 'Conservative'),
                color: SERIES[1] as string,
                kind: 'line',
              },
              {
                key: 'optimistic',
                label: t('planning.forecastPanel.optimistic', 'Optimistic'),
                color: SERIES[2] as string,
                kind: 'line',
              },
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
          <Field
            label={t('planning.forecastPanel.minimumReserve', 'Minimum reserve ({{currency}})', {
              currency: snap.currency,
            })}
          >
            <Input
              inputMode="decimal"
              value={reserveText}
              onChange={(e) => setReserveText(e.target.value)}
            />
          </Field>
          <Button type="submit">{t('planning.forecastPanel.saveReserve', 'Save reserve')}</Button>
        </form>
        <DataBanner warnings={fc.warnings} />
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">
            {t('planning.forecastPanel.assumptions', 'Assumptions')}
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {/* the engine's fc.assumptions in the UI language (keep in sync with @finplat/forecasting) */}
            {[
              t(
                'planning.assumption.start',
                'Starting balances are current ledger balances before any event on the start date.',
              ),
              t(
                'planning.assumption.expected',
                'Expected: certain and expected events at their planned amounts.',
              ),
              t(
                'planning.assumption.conservative',
                'Conservative: only certain income (at its minimum); every expense, including possible and speculative ones, at its maximum.',
              ),
              t(
                'planning.assumption.optimistic',
                'Optimistic: all income at its maximum; only certain and expected expenses at their minimum.',
              ),
              t(
                'planning.assumption.fx',
                'Foreign-currency balances are converted to {{currency}} at the {{date}} rate for the whole period.',
                { currency: fc.currency, date: fc.from },
              ),
              t(
                'planning.assumption.matched',
                'Planned occurrences already matched, skipped or paid are not counted again.',
              ),
              t(
                'planning.assumption.safeToSpend',
                'Safe-to-spend = lowest conservative balance of safe-to-spend accounts through {{until}} (the day before the next expected income, at most 31 days) minus the reserve.',
                { until: fc.safeToSpendUntil },
              ),
              t(
                'planning.assumption.estimates',
                'Forecasts are estimates, not guaranteed outcomes.',
              ),
            ].map((a) => (
              <li key={a}>{a}</li>
            ))}
            <li>
              {t(
                'planning.forecastPanel.expectedCountsConfirmedAnd',
                'Expected counts confirmed and estimated plans; conservative drops uncertain income and keeps all expenses at their maximum; optimistic the reverse. Forecasts are estimates, not guarantees.',
              )}
            </li>
          </ul>
        </details>
        {toMinor(fc.lowest.amount) < 0n && (
          <p className="sr-only">
            {t(
              'planning.forecastPanel.warningTheExpectedBalance',
              'Warning: the expected balance goes negative.',
            )}
          </p>
        )}
      </div>
    </Card>
  );
}
