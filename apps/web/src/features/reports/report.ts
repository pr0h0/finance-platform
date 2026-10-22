// Financial report (feature 62) computed from a Snapshot with the shared engine rules.
import {
  addDays,
  addMonths,
  byCategory,
  byMerchant,
  cashflow,
  endOfMonth,
  type MissingRate,
  type Notice,
  netWorth,
  startOfMonth,
} from '@finplat/finance-engine';
import type { TFn } from '../../lib/i18n.ts';
import type { Snapshot } from '../analytics/snapshot.ts';

export type ReportKind = 'monthly' | 'quarterly' | 'annual' | 'custom';

/** [from, to] of the report period containing `date` (custom: given range). */
export function reportRange(
  kind: ReportKind,
  date: string,
  to?: string,
): { from: string; to: string } {
  if (kind === 'monthly') return { from: startOfMonth(date), to: endOfMonth(date) };
  if (kind === 'quarterly') {
    const m = Number(date.slice(5, 7));
    const q = `${date.slice(0, 4)}-${String(m - ((m - 1) % 3)).padStart(2, '0')}-01`;
    return { from: q, to: addDays(addMonths(q, 3), -1) };
  }
  if (kind === 'annual')
    return { from: `${date.slice(0, 4)}-01-01`, to: `${date.slice(0, 4)}-12-31` };
  return { from: date, to: to ?? date };
}

export function buildReport(s: Snapshot, from: string, to: string) {
  const opts = { from, to, currency: s.currency, convert: s.convert };
  const flow = cashflow(s.ledger, {
    ...opts,
    granularity: from.slice(0, 4) === to.slice(0, 4) && to <= endOfMonth(from) ? 'day' : 'month',
  });
  const categories = byCategory(s.ledger, { ...opts, categories: s.categories, rollup: 'parent' });
  const income = byCategory(s.ledger, {
    ...opts,
    kind: 'income',
    categories: s.categories,
    rollup: 'parent',
  });
  const merchants = byMerchant(s.ledger, { ...opts, merchants: s.merchants });
  const nwStart = netWorth(s.ledger, s.accounts, addDays(from, -1), s.currency, s.convert);
  const nwEnd = netWorth(s.ledger, s.accounts, to, s.currency, s.convert);
  const missing = new Map<string, MissingRate>();
  for (const m of [
    ...flow.missingRates,
    ...categories.missingRates,
    ...merchants.missingRates,
    ...nwStart.missingRates,
    ...nwEnd.missingRates,
  ])
    missing.set(`${m.from}|${m.to}|${m.date}`, m);
  const firstTx = s.ledger.reduce<string | null>(
    (a, t) => (!a || t.bookingDate < a ? t.bookingDate : a),
    null,
  );
  const warnings: Notice[] = [];
  if (!firstTx || firstTx > from)
    warnings.push(
      firstTx
        ? {
            key: 'reports.warning.historyStarts',
            en: 'Recorded history starts on {{date}}; the period before that has no data.',
            vars: { date: firstTx },
          }
        : { key: 'reports.warning.noTransactions', en: 'No transactions recorded.' },
    );
  return {
    from,
    to,
    currency: s.currency,
    totals: flow.totals,
    periods: flow.periods,
    categories: categories.rows,
    income: income.rows,
    merchants: merchants.rows.slice(0, 10),
    netWorth: { start: nwStart, end: nwEnd },
    missingRates: [...missing.values()],
    complete: missing.size === 0 && warnings.length === 0,
    warnings,
  };
}

export type Report = ReturnType<typeof buildReport>;

/** CSV rows with labels in the UI language (amounts stay plain decimal strings, dates ISO). */
export function reportCsv(r: Report, t: TFn): (string | number)[][] {
  const amount = t('reports.csv.amount', 'Amount');
  const count = t('reports.csv.transactions', 'Transactions');
  const income = t('transaction.kind.income', 'Income');
  const expenses = t('reports.page.expenses', 'Expenses');
  const net = t('reports.csv.net', 'Net');
  const rows: (string | number)[][] = [
    [t('reports.page.report', 'Report'), `${r.from} – ${r.to}`, r.currency],
    [income, r.totals.income.amount],
    [expenses, r.totals.expense.amount],
    [net, r.totals.net.amount],
    [t('reports.csv.savingsRate', 'Savings rate'), r.totals.savingsRate ?? ''],
    [t('reports.csv.netWorthStart', 'Net worth (start)'), r.netWorth.start.netWorth.amount],
    [t('reports.csv.netWorthEnd', 'Net worth (end)'), r.netWorth.end.netWorth.amount],
    [],
    [t('reports.csv.period', 'Period'), income, expenses, net],
    ...r.periods.map((p) => [p.period, p.income.amount, p.expense.amount, p.net.amount]),
    [],
    [t('reports.csv.spendingCategory', 'Spending category'), amount, count],
    ...r.categories.map((c) => [c.label, c.amount.amount, c.count]),
    [],
    [t('reports.csv.incomeCategory', 'Income category'), amount, count],
    ...r.income.map((c) => [c.label, c.amount.amount, c.count]),
    [],
    [t('reports.csv.merchant', 'Merchant'), amount, count],
    ...r.merchants.map((c) => [c.label, c.amount.amount, c.count]),
  ];
  if (!r.complete)
    rows.push(
      [],
      [
        t('reports.csv.incomplete', 'Incomplete'),
        ...r.warnings.map((w) => t(w.key, w.en, w.vars)),
        ...r.missingRates.map((m) =>
          t('reports.csv.noRateOn', 'no {{from}}/{{to}} rate on {{date}}', {
            from: m.from,
            to: m.to,
            date: m.date,
          }),
        ),
      ],
    );
  return rows;
}
