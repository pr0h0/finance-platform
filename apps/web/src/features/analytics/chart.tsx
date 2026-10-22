// Recharts wrappers: plot numbers are display-only; tooltips always show the exact Money
// carried next to each point (never a float sum).

import { plotValue } from '@finplat/charts';
import type { Money } from '@finplat/finance-engine';
import { type ReactNode, useRef } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { downloadChartPng } from '../reports/export.ts';
import { Button } from './ui.tsx';

export interface Series {
  key: string;
  label: string;
  color: string;
  kind?: 'bar' | 'line' | 'area';
  stack?: string;
}

/** Rows: { x, label, money: { [seriesKey]: Money } }. */
export interface ChartRow {
  x: string;
  label: string;
  money: Record<string, Money | null>;
  band?: [number, number];
}

const axis = { stroke: 'var(--muted)', fontSize: 11, tickLine: false, axisLine: false } as const;

function TooltipBody({ row, series }: { row: ChartRow | undefined; series: readonly Series[] }) {
  const f = useFormat();
  if (!row) return null;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 font-medium">{row.label}</div>
      {series.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted">
            <span
              aria-hidden
              className="inline-block size-2 rounded-sm"
              style={{ background: s.color }}
            />
            {s.label}
          </span>
          <span className="tabular-nums">
            {row.money[s.key] ? f.money(row.money[s.key] as Money) : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

export function MoneyChart({
  rows,
  series,
  height = 240,
  onSelect,
  band,
  title,
}: {
  rows: readonly ChartRow[];
  series: readonly Series[];
  height?: number;
  onSelect?: (row: ChartRow) => void;
  band?: { label: string; color: string };
  title: string;
}) {
  const data = rows.map((r) => ({
    ...r,
    ...Object.fromEntries(
      series.map((s) => [s.key, r.money[s.key] ? plotValue(r.money[s.key] as Money) : null]),
    ),
  }));
  const anyBar = series.some((s) => (s.kind ?? 'bar') === 'bar');
  const Chart =
    anyBar && series.every((s) => (s.kind ?? 'bar') === 'bar') ? BarChart : ComposedChart;
  return (
    <figure aria-label={title} className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <Chart
          data={data}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          onClick={(e: { activeTooltipIndex?: number | string | null }) => {
            const i = Number(e?.activeTooltipIndex);
            const r = Number.isInteger(i) ? rows[i] : undefined;
            if (onSelect && r) onSelect(r);
          }}
          style={onSelect ? { cursor: 'pointer' } : undefined}
        >
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="label" {...axis} minTickGap={12} />
          <YAxis
            {...axis}
            width={56}
            tickFormatter={(v: number) =>
              Intl.NumberFormat(undefined, { notation: 'compact' }).format(v)
            }
          />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)', stroke: 'var(--line)' }}
            content={({ active, label }) =>
              active ? (
                <TooltipBody row={rows.find((r) => r.label === label)} series={series} />
              ) : null
            }
          />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)' }} />}
          {band && (
            <Area
              dataKey="band"
              name={band.label}
              stroke="none"
              fill={band.color}
              fillOpacity={0.15}
              isAnimationActive={false}
              legendType="none"
            />
          )}
          {series.map((s) =>
            (s.kind ?? 'bar') === 'bar' ? (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.color}
                radius={[4, 4, 0, 0]}
                stackId={s.stack}
                maxBarSize={36}
                isAnimationActive={false}
              />
            ) : s.kind === 'area' ? (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                fill={s.color}
                fillOpacity={0.12}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ),
          )}
        </Chart>
      </ResponsiveContainer>
      <figcaption className="sr-only">{title}</figcaption>
    </figure>
  );
}

/** Wraps a chart with a PNG export button and an optional table toggle (accessible view). */
export function ChartFrame({
  name,
  children,
  table,
}: {
  name: string;
  children: ReactNode;
  table?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref}>{children}</div>
      <div className="no-print mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          className="text-xs"
          onClick={() =>
            ref.current &&
            downloadChartPng(ref.current, `${name}.png`).catch((e) => alert((e as Error).message))
          }
        >
          {t('analytics.chart.exportPng', 'Export PNG')}
        </Button>
        {table && (
          <details className="w-full text-sm">
            <summary className="cursor-pointer text-xs text-muted">
              {t('analytics.chart.showAsTable', 'Show as table')}
            </summary>
            <div className="mt-2 overflow-x-auto">{table}</div>
          </details>
        )}
      </div>
    </div>
  );
}
