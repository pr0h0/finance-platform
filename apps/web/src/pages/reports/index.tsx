// Reports (features 62–63): monthly / quarterly / annual / custom; export CSV, PDF (browser
// print to PDF with a print stylesheet) and PNG of the chart.
import { addDays, addMonths, startOfMonth, subtract } from '@finplat/finance-engine';
import { Download, FileDown, Printer } from 'lucide-react';
import { useState } from 'react';
import { ChartFrame, type ChartRow, MoneyChart } from '../../features/analytics/chart.tsx';
import { useSnapshot } from '../../features/analytics/hooks.ts';
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
  SERIES,
  Select,
  Stat,
} from '../../features/analytics/ui.tsx';
import { downloadCsv } from '../../features/reports/export.ts';
import {
  buildReport,
  type ReportKind,
  reportCsv,
  reportRange,
} from '../../features/reports/report.ts';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';

export default function ReportsPage() {
  const t = useT();
  const snap = useSnapshot();
  const f = useFormat();
  const [kind, setKind] = useState<ReportKind>('monthly');
  const [date, setDate] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState<string | null>(null);
  if (snap.error)
    return (
      <Page title={t('reports.page.reports', 'Reports')}>
        <ErrorText error={snap.error} />
      </Page>
    );
  if (!snap.data) return <Loading />;
  const s = snap.data;
  const anchor = date ?? (kind === 'monthly' ? startOfMonth(addMonths(s.today, -1)) : s.today);
  const range = reportRange(kind, anchor, customTo ?? s.today);
  const r = buildReport(s, range.from, range.to);
  const step = (dir: number) =>
    setDate(
      addMonths(
        range.from,
        dir * ({ monthly: 1, quarterly: 3, annual: 12, custom: 0 } as const)[kind],
      ),
    );
  const title = t(
    `reports.title.${kind}`,
    `${{ monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', custom: 'Custom' }[kind]} report {{from}} – {{to}}`,
    {
      from: f.date(r.from),
      to: f.date(r.to),
    },
  );
  const fileBase = `report-${r.from}-${r.to}`;
  const rows: ChartRow[] = r.periods.map((p) => ({
    x: p.period,
    label: /^\d{4}-\d{2}$/.test(p.period) ? f.month(p.period) : f.date(p.period),
    money: { income: p.income, expense: p.expense },
  }));

  return (
    <Page
      title={t('reports.page.reports', 'Reports')}
      actions={
        <>
          <Button onClick={() => downloadCsv(`${fileBase}.csv`, reportCsv(r, t))}>
            <Download aria-hidden className="size-4" /> CSV
          </Button>
          <Button onClick={() => window.print()}>
            <Printer aria-hidden className="size-4" /> {t('reports.page.pdfPrint', 'PDF / Print')}
          </Button>
        </>
      }
    >
      <Card className="no-print">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('reports.page.report', 'Report')}>
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ReportKind);
                setDate(null);
              }}
            >
              <option value="monthly">{t('backup.monthly', 'Monthly')}</option>
              <option value="quarterly">{t('reports.page.quarterly', 'Quarterly')}</option>
              <option value="annual">{t('reports.page.annual', 'Annual')}</option>
              <option value="custom">{t('reports.page.customDates', 'Custom dates')}</option>
            </Select>
          </Field>
          {kind === 'custom' ? (
            <>
              <Field label={t('reports.page.from', 'From')}>
                <Input
                  type="date"
                  value={range.from}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
              </Field>
              <Field label={t('reports.page.to', 'To')}>
                <Input
                  type="date"
                  value={range.to}
                  min={range.from}
                  onChange={(e) => e.target.value && setCustomTo(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <div className="flex gap-1">
              <Button onClick={() => step(-1)}>{t('reports.page.previous', 'Previous')}</Button>
              <Button onClick={() => step(1)} disabled={addDays(range.to, 1) > s.today}>
                {t('common.next', 'Next')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      <article className="space-y-4" aria-label={title}>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-xs text-muted">
          {t(
            'reports.page.allAmountsInCurrency',
            'All amounts in {{currency}}, converted at booking-date rates. Generated {{date}}.',
            { currency: r.currency, date: f.date(s.today) },
          )}
        </p>
        <DataBanner missingRates={r.missingRates} warnings={r.warnings} />
        <Card>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat
              label={t('transaction.kind.income', 'Income')}
              value={<Amount value={r.totals.income} />}
            />
            <Stat
              label={t('reports.page.expenses', 'Expenses')}
              value={<Amount value={r.totals.expense} />}
            />
            <Stat
              label={t('reports.page.net', 'Net')}
              value={<Amount value={r.totals.net} tone />}
            />
            <Stat
              label={t('reports.page.savingsRate', 'Savings rate')}
              value={r.totals.savingsRate ? f.percent(r.totals.savingsRate) : '—'}
            />
            <Stat
              label={t('reports.page.netWorthChange', 'Net worth change')}
              value={
                <Amount value={subtract(r.netWorth.end.netWorth, r.netWorth.start.netWorth)} tone />
              }
              hint={
                <>
                  {t('reports.page.end', 'end')} <Amount value={r.netWorth.end.netWorth} />
                </>
              }
            />
          </div>
        </Card>
        <Card title={t('reports.page.cashFlow', 'Cash flow')}>
          {rows.length ? (
            <ChartFrame name={`${fileBase}-cashflow`}>
              <MoneyChart
                title={t(
                  'reports.page.incomeAndExpensesIn',
                  'Income and expenses in the report period',
                )}
                rows={rows}
                series={[
                  {
                    key: 'income',
                    label: t('transaction.kind.income', 'Income'),
                    color: SERIES[0] as string,
                  },
                  {
                    key: 'expense',
                    label: t('reports.page.expenses', 'Expenses'),
                    color: SERIES[1] as string,
                  },
                ]}
              />
            </ChartFrame>
          ) : (
            <Empty>
              {t('reports.page.noIncomeOrExpenses', 'No income or expenses in this period.')}
            </Empty>
          )}
        </Card>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <RowsCard
            title={t('reports.page.spendingByCategory', 'Spending by category')}
            rows={r.categories}
          />
          <RowsCard
            title={t('reports.page.incomeByCategory', 'Income by category')}
            rows={r.income}
          />
          <RowsCard title={t('reports.page.topMerchants', 'Top merchants')} rows={r.merchants} />
        </div>
        <Card title={t('reports.page.netWorth', 'Net worth')}>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <dt className="text-muted">
              {t('reports.page.startDate', 'Start ({{date}})', {
                date: f.date(addDays(r.from, -1)),
              })}
            </dt>
            <dd>
              <Amount value={r.netWorth.start.netWorth} />
            </dd>
            <dt className="text-muted">
              {t('reports.page.endDate', 'End ({{date}})', { date: f.date(r.to) })}
            </dt>
            <dd>
              <Amount value={r.netWorth.end.netWorth} />
            </dd>
            <dt className="text-muted">{t('reports.page.assets', 'Assets')}</dt>
            <dd>
              <Amount value={r.netWorth.end.assets} />
            </dd>
            <dt className="text-muted">{t('reports.page.liabilities', 'Liabilities')}</dt>
            <dd>
              <Amount value={r.netWorth.end.liabilities} />
            </dd>
          </dl>
        </Card>
        <p className="no-print flex items-center gap-1 text-xs text-muted">
          <FileDown aria-hidden className="size-3.5" />{' '}
          {t(
            'reports.page.pdfChooseSaveAs',
            'PDF: choose "Save as PDF" in the print dialog; navigation and controls are hidden in print.',
          )}
        </p>
      </article>
    </Page>
  );
}

function RowsCard({
  title,
  rows,
}: {
  title: string;
  rows: {
    key: string;
    label: string;
    amount: { amount: string; currency: string };
    count: number;
  }[];
}) {
  const t = useT();
  return (
    <Card title={title}>
      {rows.length ? (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((c) => (
              <tr key={c.key} className="border-b border-line/60">
                <td className="py-1">{c.label}</td>
                <td className="text-right">
                  <Amount value={c.amount} />
                </td>
                <td className="w-8 text-right text-xs text-muted">{c.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t('reports.page.none', 'None.')}</Empty>
      )}
    </Card>
  );
}
