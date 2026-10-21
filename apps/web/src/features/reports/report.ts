// Financial report (feature 62) computed from a Snapshot with the shared engine rules.
import {
  addDays,
  addMonths,
  byCategory,
  byMerchant,
  cashflow,
  endOfMonth,
  type MissingRate,
  netWorth,
  startOfMonth,
} from '@finplat/finance-engine';
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
  const warnings: string[] = [];
  if (!firstTx || firstTx > from)
    warnings.push(
      firstTx
        ? `Recorded history starts on ${firstTx}; the period before that has no data.`
        : 'No transactions recorded.',
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

export function reportCsv(r: Report): (string | number)[][] {
  const rows: (string | number)[][] = [
    ['Report', `${r.from} to ${r.to}`, r.currency],
    ['Income', r.totals.income.amount],
    ['Expenses', r.totals.expense.amount],
    ['Net', r.totals.net.amount],
    ['Savings rate', r.totals.savingsRate ?? ''],
    ['Net worth (start)', r.netWorth.start.netWorth.amount],
    ['Net worth (end)', r.netWorth.end.netWorth.amount],
    [],
    ['Period', 'Income', 'Expenses', 'Net'],
    ...r.periods.map((p) => [p.period, p.income.amount, p.expense.amount, p.net.amount]),
    [],
    ['Spending category', 'Amount', 'Transactions'],
    ...r.categories.map((c) => [c.label, c.amount.amount, c.count]),
    [],
    ['Income category', 'Amount', 'Transactions'],
    ...r.income.map((c) => [c.label, c.amount.amount, c.count]),
    [],
    ['Merchant', 'Amount', 'Transactions'],
    ...r.merchants.map((c) => [c.label, c.amount.amount, c.count]),
  ];
  if (!r.complete)
    rows.push(
      [],
      [
        'Incomplete',
        ...r.warnings,
        ...r.missingRates.map((m) => `no ${m.from}/${m.to} rate on ${m.date}`),
      ],
    );
  return rows;
}
