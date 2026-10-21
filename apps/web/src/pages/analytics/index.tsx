// Analytics (PLAN §35, features 54–65, 24): filters, interactive charts with exact tooltips,
// drill-down to transactions, reporting-currency switch, incomplete-data banners, currency
// exposure and fees, unusual expenses with explanations + dismissal, deterministic insights.
import {
  addMonths,
  detectAnomalies,
  endOfMonth,
  fromMinor,
  type Granularity,
  monthlyInsights,
  startOfMonth,
  toMinor,
} from '@finplat/finance-engine';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChartFrame, type ChartRow, MoneyChart } from '../../features/analytics/chart.tsx';
import {
  categoryTrend,
  conversionFees,
  currencyDistribution,
  type Filters,
  historyStart,
  incomeByCategory,
  incomeVsExpenses,
  merchantRanking,
  netWorthHistory,
  periodComparison,
  plannedVsActual,
  recurringCosts,
  spendingByCategory,
  spendingByCurrency,
} from '../../features/analytics/compute.ts';
import { transactionsLink } from '../../features/analytics/drill.ts';
import { useOpsMutation, useOpsQuery, useSnapshot } from '../../features/analytics/hooks.ts';
import { converterFor, type Snapshot } from '../../features/analytics/snapshot.ts';
import {
  Amount,
  Button,
  Card,
  DataBanner,
  Empty,
  ErrorText,
  Field,
  Input,
  Loading,
  Page,
  ProgressBar,
  SERIES,
  SERIES_OTHER,
  Select,
  Stat,
} from '../../features/analytics/ui.tsx';
import { buildForecast } from '../../features/planning/forecast.ts';
import { useFormat } from '../../lib/format.ts';

const PRESETS = [
  ['month', 'This month'],
  ['3m', 'Last 3 months'],
  ['6m', 'Last 6 months'],
  ['12m', 'Last 12 months'],
  ['ytd', 'Year to date'],
  ['custom', 'Custom'],
] as const;
type Preset = (typeof PRESETS)[number][0];

function presetRange(p: Preset, today: string): { from: string; to: string } {
  const back = (n: number) => ({ from: startOfMonth(addMonths(today, -(n - 1))), to: today });
  switch (p) {
    case 'month':
      return { from: startOfMonth(today), to: today };
    case '3m':
      return back(3);
    case '6m':
      return back(6);
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default:
      return back(12);
  }
}

export default function AnalyticsPage() {
  const snap = useSnapshot();
  const [preset, setPreset] = useState<Preset>('6m');
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [currency, setCurrency] = useState<string | null>(null);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const conv = useOpsQuery(
    ['converter', currency],
    (ops) => converterFor(ops, currency as string),
    !!currency,
  );

  if (snap.error)
    return (
      <Page title="Analytics">
        <ErrorText error={snap.error} />
      </Page>
    );
  if (!snap.data) return <Loading />;
  const s = snap.data;
  const range = preset === 'custom' && custom ? custom : presetRange(preset, s.today);
  const cur = currency ?? s.currency;
  if (currency && !conv.data) return <Loading />;
  const f: Filters = {
    ...range,
    currency: cur,
    convert: currency ? (conv.data as Filters['convert']) : s.convert,
    accountIds,
    granularity,
  };
  const currencies = [...new Set([s.currency, ...s.accounts.map((a) => a.currency)])];
  const start = historyStart(s);

  return (
    <Page title="Analytics">
      <Card>
        <fieldset className="flex flex-wrap items-end gap-3" aria-label="Filters">
          <Field label="Period">
            <Select
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value as Preset);
                if (e.target.value === 'custom' && !custom) setCustom(range);
              }}
            >
              {PRESETS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          {preset === 'custom' && custom && (
            <>
              <Field label="From">
                <Input
                  type="date"
                  value={custom.from}
                  max={custom.to}
                  onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  value={custom.to}
                  min={custom.from}
                  onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="Group by">
            <Select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
            >
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </Select>
          </Field>
          <Field label="Reporting currency">
            <Select
              value={cur}
              onChange={(e) => setCurrency(e.target.value === s.currency ? null : e.target.value)}
            >
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Accounts">
            <Select
              multiple
              size={Math.min(4, Math.max(2, s.accounts.length))}
              className="h-auto min-w-40"
              value={accountIds}
              onChange={(e) => setAccountIds([...e.target.selectedOptions].map((o) => o.value))}
            >
              {s.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          {accountIds.length > 0 && (
            <Button variant="ghost" onClick={() => setAccountIds([])}>
              All accounts
            </Button>
          )}
        </fieldset>
        {start && start > range.from && (
          <div className="mt-3">
            <DataBanner
              warnings={[
                `Recorded history starts on ${start}; earlier parts of this period have no data, so comparisons and averages may be understated.`,
              ]}
            />
          </div>
        )}
        {!start && (
          <div className="mt-3">
            <Empty>No transactions recorded yet.</Empty>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CategorySection s={s} f={f} />
        <IncomeExpenseSection s={s} f={f} />
      </div>
      <TrendSection s={s} f={f} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ComparisonSection s={s} f={f} />
        <MerchantSection s={s} f={f} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NetWorthSection s={s} f={f} />
        <ForecastEvolution s={s} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CurrencySection s={s} f={f} />
        <RecurringSection s={s} f={f} />
      </div>
      <PlannedActualSection s={s} f={f} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AnomalySection s={s} f={f} />
        <InsightSection s={s} f={f} />
      </div>
    </Page>
  );
}

type P = { s: Snapshot; f: Filters };

function CategorySection({ s, f }: P) {
  const [kind, setKind] = useState<'spending' | 'income'>('spending');
  const [rollup, setRollup] = useState<'parent' | 'none'>('parent');
  const r = kind === 'spending' ? spendingByCategory(s, f, rollup) : incomeByCategory(s, f);
  const total = Number(r.total.amount) || 1;
  return (
    <Card
      title={kind === 'spending' ? 'Expenses by category' : 'Income by category'}
      actions={
        <>
          <Select
            aria-label="Kind"
            className="h-8 w-auto text-xs"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="spending">Expenses</option>
            <option value="income">Income</option>
          </Select>
          {kind === 'spending' && (
            <Select
              aria-label="Subcategories"
              className="h-8 w-auto text-xs"
              value={rollup}
              onChange={(e) => setRollup(e.target.value as typeof rollup)}
            >
              <option value="parent">Top-level</option>
              <option value="none">Subcategories</option>
            </Select>
          )}
        </>
      }
    >
      <DataBanner missingRates={r.missingRates} />
      {r.rows.length === 0 ? (
        <Empty>No {kind === 'spending' ? 'spending' : 'income'} in this period.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>Category</th>
              <th>Share</th>
              <th>Amount</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((c, i) => (
              <tr key={c.key}>
                <td className="w-1/3 py-1 pr-2">
                  <Link
                    className="hover:underline"
                    to={transactionsLink({
                      ...f,
                      categoryKey: c.key,
                      kind: kind === 'spending' ? 'expense' : 'income',
                    })}
                  >
                    {c.label}
                  </Link>
                </td>
                <td className="w-1/3">
                  <ProgressBar
                    label={`${((Number(c.amount.amount) / total) * 100).toFixed(1)}%`}
                    parts={[
                      {
                        value: Number(c.amount.amount) / total,
                        className: '',
                        title: c.label,
                        color: SERIES[i] ?? SERIES_OTHER,
                      },
                      {
                        value: Math.max(0, 1 - Number(c.amount.amount) / total),
                        className: 'bg-transparent',
                        title: 'rest',
                      },
                    ]}
                  />
                </td>
                <td className="text-right">
                  <Amount value={c.amount} />
                </td>
                <td className="w-10 text-right text-xs text-muted">{c.count}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td className="pt-2">Total</td>
              <td />
              <td className="pt-2 text-right">
                <Amount value={r.total} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </Card>
  );
}

function periodLabel(fmt: ReturnType<typeof useFormat>, p: string) {
  return /^\d{4}-\d{2}$/.test(p) ? fmt.month(p) : p;
}

function periodRange(p: string): { from: string; to: string } | null {
  if (/^\d{4}-\d{2}$/.test(p)) return { from: `${p}-01`, to: endOfMonth(`${p}-01`) };
  if (/^\d{4}$/.test(p)) return { from: `${p}-01-01`, to: `${p}-12-31` };
  const q = /^(\d{4})-Q([1-4])$/.exec(p);
  if (q) {
    const m = String((Number(q[2]) - 1) * 3 + 1).padStart(2, '0');
    return { from: `${q[1]}-${m}-01`, to: endOfMonth(addMonths(`${q[1]}-${m}-01`, 2)) };
  }
  return null;
}

function IncomeExpenseSection({ s, f }: P) {
  const fmt = useFormat();
  const nav = useNavigate();
  const r = incomeVsExpenses(s, f);
  const rows: ChartRow[] = r.periods.map((p) => ({
    x: p.period,
    label: periodLabel(fmt, p.period),
    money: { income: p.income, expense: p.expense, net: p.net },
  }));
  return (
    <Card title="Income versus expenses">
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Stat label="Income" value={<Amount value={r.totals.income} />} />
        <Stat label="Expenses" value={<Amount value={r.totals.expense} />} />
        <Stat label="Net" value={<Amount value={r.totals.net} tone />} />
        <Stat
          label="Savings rate"
          value={r.totals.savingsRate ? fmt.percent(r.totals.savingsRate) : '—'}
          hint="(income − spending) / income"
        />
      </div>
      <DataBanner missingRates={r.missingRates} />
      {rows.length ? (
        <ChartFrame
          name="income-vs-expenses"
          table={
            <MoneyTable
              rows={rows}
              cols={[
                ['income', 'Income'],
                ['expense', 'Expenses'],
                ['net', 'Net'],
              ]}
            />
          }
        >
          <MoneyChart
            title="Income versus expenses per period; select a period to see its transactions"
            rows={rows}
            onSelect={(row) => {
              const pr = periodRange(row.x);
              if (pr) nav(transactionsLink({ ...pr, accountIds: f.accountIds }));
            }}
            series={[
              { key: 'income', label: 'Income', color: SERIES[0] as string },
              { key: 'expense', label: 'Expenses', color: SERIES[1] as string },
            ]}
          />
          <h3 className="mt-4 mb-1 text-xs font-medium text-muted">Savings rate per period</h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {r.periods.map((p) => (
              <li key={p.period}>
                {periodLabel(fmt, p.period)}:{' '}
                <span className="tabular-nums">
                  {p.savingsRate ? fmt.percent(p.savingsRate) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </ChartFrame>
      ) : (
        <Empty>No income or expenses in this period.</Empty>
      )}
    </Card>
  );
}

function MoneyTable({
  rows,
  cols,
}: {
  rows: readonly ChartRow[];
  cols: readonly (readonly [string, string])[];
}) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1">Period</th>
          {cols.map(([k, l]) => (
            <th key={k} className="text-right">
              {l}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.x}>
            <td className="py-0.5">{r.label}</td>
            {cols.map(([k]) => (
              <td key={k} className="text-right">
                <Amount value={r.money[k]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrendSection({ s, f }: P) {
  const fmt = useFormat();
  const nav = useNavigate();
  const t = categoryTrend(s, f);
  const rows: ChartRow[] = t.rows.map((r) => ({
    x: r.month,
    label: fmt.month(r.month),
    money: r.values,
  }));
  const series = t.keys.map((k, i) => ({
    key: k.key,
    label: k.label,
    color: k.key === 'other' ? SERIES_OTHER : (SERIES[i] as string),
    stack: 'a',
  }));
  return (
    <Card title="Monthly spending and long-term trend (top categories)">
      <DataBanner missingRates={t.missingRates} />
      {series.length ? (
        <ChartFrame
          name="spending-trend"
          table={<MoneyTable rows={rows} cols={t.keys.map((k) => [k.key, k.label] as const)} />}
        >
          <MoneyChart
            title="Monthly spending by top category, stacked"
            rows={rows}
            series={series}
            height={260}
            onSelect={(r) =>
              nav(
                transactionsLink({
                  from: `${r.x}-01`,
                  to: endOfMonth(`${r.x}-01`),
                  kind: 'expense',
                  accountIds: f.accountIds,
                }),
              )
            }
          />
        </ChartFrame>
      ) : (
        <Empty>No spending in this period.</Empty>
      )}
    </Card>
  );
}

function ComparisonSection({ s, f }: P) {
  const fmt = useFormat();
  const [mode, setMode] = useState<'previous' | 'year_ago'>('previous');
  const c = periodComparison(s, f, mode);
  const diff = toMinor(c.total.current) - toMinor(c.total.previous);
  return (
    <Card
      title="Period comparison"
      actions={
        <Select
          aria-label="Compare with"
          className="h-8 w-auto text-xs"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="previous">Previous period</option>
          <option value="year_ago">Same period last year</option>
        </Select>
      }
    >
      <p className="mb-2 text-xs text-muted">
        {fmt.date(f.from)} – {fmt.date(f.to)} vs {fmt.date(c.range.from)} – {fmt.date(c.range.to)} ·
        total <Amount value={c.total.current} /> vs <Amount value={c.total.previous} /> (
        {diff > 0n ? 'more' : diff < 0n ? 'less' : 'same'})
      </p>
      <DataBanner missingRates={c.missingRates} />
      {c.rows.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-1">Category</th>
              <th className="text-right">Now</th>
              <th className="text-right">Before</th>
              <th className="text-right">Change</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.slice(0, 12).map((r) => (
              <tr key={r.key} className="border-b border-line/60">
                <td className="py-1">{r.label}</td>
                <td className="text-right">
                  <Amount value={r.current} />
                </td>
                <td className="text-right">
                  <Amount value={r.previous} />
                </td>
                <td
                  className={`text-right ${toMinor(r.change) > 0n ? 'text-neg' : toMinor(r.change) < 0n ? 'text-pos' : ''}`}
                >
                  <Amount value={r.change} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No spending in either period.</Empty>
      )}
    </Card>
  );
}

function MerchantSection({ s, f }: P) {
  const r = merchantRanking(s, f);
  return (
    <Card title="Merchant ranking">
      <DataBanner missingRates={r.missingRates} />
      {r.rows.length ? (
        <ol className="space-y-1 text-sm">
          {r.rows.slice(0, 15).map((m, i) => (
            <li key={m.key} className="flex justify-between gap-2">
              <Link
                className="truncate hover:underline"
                to={transactionsLink({ ...f, merchantKey: m.key, kind: 'expense' })}
              >
                <span className="mr-2 inline-block w-5 text-right text-xs text-muted">{i + 1}</span>
                {m.label}
              </Link>
              <span>
                <Amount value={m.amount} /> <span className="text-xs text-muted">· {m.count}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <Empty>No merchant spending in this period.</Empty>
      )}
      <p className="mt-2 text-xs text-muted">
        Grouped by merchant (aliases merged), else by normalized payee/description.
      </p>
    </Card>
  );
}

function NetWorthSection({ s, f }: P) {
  const fmt = useFormat();
  const n = netWorthHistory(s, f);
  const rows: ChartRow[] = n.points.map((p) => ({
    x: p.date,
    label: fmt.month(p.date.slice(0, 7)),
    money: { assets: p.assets, liabilities: p.liabilities, netWorth: p.netWorth },
  }));
  const last = n.points.at(-1);
  return (
    <Card title="Net worth">
      {last && (
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Net worth" value={<Amount value={last.netWorth} tone />} />
          <Stat label="Assets" value={<Amount value={last.assets} />} />
          <Stat label="Liabilities" value={<Amount value={last.liabilities} />} />
        </div>
      )}
      <DataBanner missingRates={n.missingRates} />
      <ChartFrame
        name="net-worth"
        table={
          <MoneyTable
            rows={rows}
            cols={[
              ['assets', 'Assets'],
              ['liabilities', 'Liabilities'],
              ['netWorth', 'Net worth'],
            ]}
          />
        }
      >
        <MoneyChart
          title="Assets, liabilities and net worth at each month end"
          rows={rows}
          series={[
            { key: 'netWorth', label: 'Net worth', color: SERIES[0] as string, kind: 'line' },
            { key: 'assets', label: 'Assets', color: SERIES[2] as string, kind: 'line' },
            { key: 'liabilities', label: 'Liabilities', color: SERIES[1] as string, kind: 'line' },
          ]}
        />
      </ChartFrame>
      <p className="mt-1 text-xs text-muted">
        Valued at each month end's exchange rate; accounts excluded from net worth are left out.
      </p>
    </Card>
  );
}

function ForecastEvolution({ s }: { s: Snapshot }) {
  const fmt = useFormat();
  const fc = buildForecast(s, addMonths(s.today, 12));
  const rows: ChartRow[] = fc.days
    .filter((d, i) => i === 0 || d.date.endsWith('-01') || i === fc.days.length - 1)
    .map((d) => ({
      x: d.date,
      label: fmt.date(d.date),
      money: { expected: d.expected, conservative: d.conservative, optimistic: d.optimistic },
    }));
  return (
    <Card title="Forecast evolution (12 months)">
      <DataBanner warnings={fc.warnings} />
      <ChartFrame
        name="forecast-evolution"
        table={
          <MoneyTable
            rows={rows}
            cols={[
              ['conservative', 'Conservative'],
              ['expected', 'Expected'],
              ['optimistic', 'Optimistic'],
            ]}
          />
        }
      >
        <MoneyChart
          title="Projected balance: conservative, expected and optimistic"
          rows={rows}
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
      <p className="mt-1 text-xs text-muted">
        An estimate from plans and today's balances, not a guarantee.{' '}
        <Link className="text-accent hover:underline" to="/planning">
          Planning
        </Link>
      </p>
    </Card>
  );
}

function CurrencySection({ s, f }: P) {
  const fmt = useFormat();
  const ex = currencyDistribution(s, f);
  const spend = spendingByCurrency(s, f);
  const fees = conversionFees(s, f);
  return (
    <Card title="Currency distribution and fees">
      {ex.missing.length > 0 && (
        <DataBanner
          warnings={[
            `No ${ex.missing.join(', ')}/${f.currency} rate: those balances are not in the shares.`,
          ]}
        />
      )}
      {ex.rows.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-1">Currency</th>
              <th>Share of assets</th>
              <th className="text-right">Balance</th>
              <th className="text-right">In {f.currency}</th>
            </tr>
          </thead>
          <tbody>
            {ex.rows.map((r, i) => (
              <tr key={r.currency} className="border-b border-line/60">
                <td className="py-1">{r.currency}</td>
                <td className="w-1/3">
                  <ProgressBar
                    label={fmt.percent(r.share)}
                    parts={[
                      {
                        value: Number(r.share),
                        className: '',
                        title: r.currency,
                        color: SERIES[i] ?? SERIES_OTHER,
                      },
                      { value: 1 - Number(r.share), className: 'bg-transparent', title: 'rest' },
                    ]}
                  />
                  <span className="text-[10px] text-muted">{fmt.percent(r.share)}</span>
                </td>
                <td className="text-right">
                  <Amount value={r.original} />
                </td>
                <td className="text-right">
                  <Amount value={r.converted} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No balances.</Empty>
      )}
      {spend.length > 0 && (
        <div className="mt-3 text-sm">
          <h3 className="mb-1 text-xs font-medium text-muted">
            Spending by original currency (this period)
          </h3>
          <ul className="space-y-0.5">
            {spend.map((x) => (
              <li key={x.currency} className="flex justify-between">
                <span>{x.currency}</span>
                <span>
                  <Amount value={x.amount} />{' '}
                  {x.currency !== f.currency && (
                    <span className="text-xs text-muted">
                      ≈ <Amount value={x.converted} />
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 text-sm">
        <h3 className="mb-1 text-xs font-medium text-muted">
          Currency and transfer fees (this period)
        </h3>
        {fees.items.length ? (
          <>
            <p>
              Total <Amount value={fees.total} /> in {fees.items.length} fee
              {fees.items.length === 1 ? '' : 's'}
              {!fees.complete && ' (some without a rate are left out)'}
            </p>
            <Link
              className="text-xs text-accent hover:underline"
              to={transactionsLink({ ...f, kind: 'expense' })}
            >
              See expenses
            </Link>
          </>
        ) : (
          <p className="text-muted">No fees recorded on transfers or exchanges.</p>
        )}
      </div>
    </Card>
  );
}

function RecurringSection({ s, f }: P) {
  const r = recurringCosts(s, f);
  return (
    <Card title="Subscription and recurring spending">
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Stat label="Monthly equivalent" value={<Amount value={r.monthly} />} />
        <Stat label="Annual equivalent" value={<Amount value={r.annual} />} />
      </div>
      {!r.complete && (
        <DataBanner
          warnings={['Some plans have no exchange rate and are left out of the totals.']}
        />
      )}
      {r.rows.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-1">Plan</th>
              <th className="text-right">Monthly</th>
              <th className="text-right">Annual</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((x) => (
              <tr key={x.plan.id} className="border-b border-line/60">
                <td className="py-1">{x.plan.description}</td>
                <td className="text-right">
                  <Amount value={x.monthly ?? x.native.monthly} />
                </td>
                <td className="text-right">
                  <Amount value={x.annual ?? x.native.annual} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>
          No recurring expense plans.{' '}
          <Link className="underline" to="/subscriptions">
            Subscriptions
          </Link>
        </Empty>
      )}
    </Card>
  );
}

function PlannedActualSection({ s, f }: P) {
  const fmt = useFormat();
  const rows = plannedVsActual(s, f).filter((r) => r.actual);
  let planned = 0n;
  let actual = 0n;
  for (const r of rows) {
    const p = f.convert(r.planned, r.occurrence.occurrenceDate);
    const a = r.actual && f.convert(r.actual, r.occurrence.occurrenceDate);
    if (p && a) {
      planned += toMinor(p);
      actual += toMinor(a);
    }
  }
  return (
    <Card title="Planned versus actual">
      {rows.length ? (
        <>
          <p className="mb-2 text-sm">
            {rows.length} matched payments: planned{' '}
            <Amount value={fromMinor(planned, f.currency)} />, paid{' '}
            <Amount value={fromMinor(actual, f.currency)} />, difference{' '}
            <Amount value={fromMinor(actual - planned, f.currency)} />
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-1">Date</th>
                <th>Plan</th>
                <th className="text-right">Planned</th>
                <th className="text-right">Actual</th>
                <th className="text-right">Variance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.plan.id}|${r.occurrence.occurrenceDate}`}
                  className="border-b border-line/60"
                >
                  <td className="py-1">{fmt.date(r.occurrence.occurrenceDate)}</td>
                  <td>{r.plan.description}</td>
                  <td className="text-right">
                    <Amount value={r.planned} />
                  </td>
                  <td className="text-right">
                    <Amount value={r.actual} />
                  </td>
                  <td className="text-right">
                    <Amount value={r.variance} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <Empty>
          No planned payments matched to transactions in this period. Match them on the Planning
          page.
        </Empty>
      )}
    </Card>
  );
}

function AnomalySection({ s, f }: P) {
  const fmt = useFormat();
  const dismissed = (s.settings['analytics.dismissedAnomalies'] as string[] | undefined) ?? [];
  const [showDismissed, setShowDismissed] = useState(false);
  const save = useOpsMutation((ops, ids: string[]) =>
    ops.setSetting('analytics.dismissedAnomalies', ids),
  );
  const all = detectAnomalies(s.ledger, {
    from: f.from,
    to: f.to,
    currency: f.currency,
    convert: f.convert,
  });
  const list = all.filter((a) => showDismissed || !dismissed.includes(a.id));
  return (
    <Card
      title="Unusual expenses"
      actions={
        dismissed.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowDismissed(!showDismissed)}>
            {showDismissed ? 'Hide dismissed' : `Show dismissed (${dismissed.length})`}
          </Button>
        )
      }
    >
      {list.length ? (
        <ul className="space-y-3 text-sm">
          {list.map((a) => {
            const isDismissed = dismissed.includes(a.id);
            const txId = a.data.transactionId as string;
            const t = s.transactions.find((x) => x.id === txId);
            return (
              <li key={a.id} className={isDismissed ? 'opacity-60' : ''}>
                <p className="font-medium">
                  {t?.description || t?.payee || a.title}
                  {t && (
                    <span className="ml-2 text-xs font-normal text-muted">
                      {fmt.date(t.bookingDate)}
                    </span>
                  )}
                </p>
                <p className="text-muted">{a.body}</p>
                <p className="text-xs text-muted">
                  Rule:{' '}
                  {a.data.rule === 'large_vs_category'
                    ? '≥ 3× the category median (needs ≥ 5 earlier transactions)'
                    : '≥ 2× the merchant median (needs ≥ 3 earlier transactions)'}
                  ; history = 180 days before the period.
                </p>
                <div className="mt-1 flex gap-2">
                  {t && (
                    <Link
                      className="text-xs text-accent hover:underline"
                      to={transactionsLink({
                        from: t.bookingDate,
                        to: t.bookingDate,
                        accountIds: t.postings.map((p) => p.accountId),
                      })}
                    >
                      View transaction
                    </Link>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      save.mutate(
                        isDismissed ? dismissed.filter((x) => x !== a.id) : [...dismissed, a.id],
                      )
                    }
                  >
                    {isDismissed ? 'Restore' : 'Dismiss'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>Nothing unusual in this period.</Empty>
      )}
    </Card>
  );
}

function InsightSection({ s, f }: P) {
  const dismissed = new Set((s.settings['insights.dismissed'] as string[] | undefined) ?? []);
  const save = useOpsMutation((ops, ids: string[]) => ops.setSetting('insights.dismissed', ids));
  const list = monthlyInsights(s.ledger, {
    month: f.to,
    currency: f.currency,
    convert: f.convert,
    dismissed,
  });
  return (
    <Card title={<span id="insights">Insights for {f.to.slice(0, 7)}</span>}>
      {list.length ? (
        <ul className="space-y-3 text-sm">
          {list.map((i) => (
            <li key={i.id}>
              <p className={i.severity === 'info' ? 'font-medium' : 'font-medium text-warn'}>
                {i.title}
              </p>
              <p className="text-muted">{i.body}</p>
              <Button size="sm" variant="ghost" onClick={() => save.mutate([...dismissed, i.id])}>
                Dismiss
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No notable changes compared with the previous 3 months.</Empty>
      )}
      <p className="mt-2 text-xs text-muted">
        Deterministic rules: category spikes (≥ 1.3× the 3-month average), spending change ≥ 20%,
        savings rate. No AI.
      </p>
    </Card>
  );
}
