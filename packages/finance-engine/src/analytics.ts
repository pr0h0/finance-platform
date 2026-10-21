// Deterministic aggregation rules (ADR 0003, invariants 6, 9–11). The Go analytics module must
// produce the same numbers: packages/test-fixtures/conformance/aggregation.json.
//
// Rules:
// - A transaction counts when: not deleted, status != void, excludeFromReports is false.
// - income  -> +splits (by category).  expense -> +splits as spending.
// - refund  -> -splits as spending (reduces the refunded categories; never income).
// - transfer, fx, opening_balance, adjustment never count as income or expense. Credit-card payments
//   are transfers, so card purchases count once (as expenses on the card account).
// - A transaction without splits counts |posting| per posting as uncategorized.
// - Conversion: each split is converted at the booking-date rate (ToReporting), rounded once.
//   A missing rate leaves that amount out, lists the pair/date in missingRates and marks the result
//   incomplete. Nothing is guessed.
import { dateRange, type Granularity, periodKey } from './dates.ts';
import { divRound, formatDecimal, pow10 } from './decimal.ts';
import type { ToReporting } from './fx.ts';
import { type AccountBalance, balances } from './ledger.ts';
import { fromMinor, type Money, toMinor } from './money.ts';

export type TxKind =
  | 'income'
  | 'expense'
  | 'transfer'
  | 'refund'
  | 'adjustment'
  | 'opening_balance'
  | 'fx';

export interface LedgerTransaction {
  id: string;
  kind: TxKind;
  status?: string;
  bookingDate: string;
  excludeFromReports?: boolean;
  deletedAt?: string | null;
  merchantId?: string | null;
  payee?: string;
  description?: string;
  relatedTransactionId?: string | null;
  importRecordId?: string | null;
  categorizationSource?: string;
  postings: readonly { accountId: string; amount: Money }[];
  splits?: readonly { categoryId: string | null; amount: Money }[];
}

export interface CategoryLike {
  id: string;
  parentId: string | null;
  name: string;
}

export interface AnalyticsRow {
  key: string;
  label: string;
  amount: Money;
  count: number;
  period?: string;
}

export interface MissingRate {
  from: string;
  to: string;
  date: string;
}

export interface AnalyticsResult {
  currency: string;
  from: string;
  to: string;
  rows: AnalyticsRow[];
  total: Money;
  complete: boolean;
  warnings: string[];
  missingRates: MissingRate[];
}

export interface AggregateOptions {
  from: string; // inclusive booking-date range
  to: string;
  currency: string;
  convert: ToReporting;
  accountIds?: readonly string[];
}

export const UNCATEGORIZED = 'uncategorized';

export const isLive = (t: LedgerTransaction): boolean => !t.deletedAt && t.status !== 'void';
export const countsInReports = (t: LedgerTransaction): boolean =>
  isLive(t) && !t.excludeFromReports;

/** Balance per account+currency from live transactions (opening balances and transfers included). */
export function accountBalances(
  txs: readonly LedgerTransaction[],
  asOf?: string,
): AccountBalance[] {
  return balances(
    txs
      .filter((t) => isLive(t) && (!asOf || t.bookingDate <= asOf))
      .flatMap((t) => t.postings.map((p) => ({ accountId: p.accountId, ...p.amount }))),
  );
}

/** One signed category allocation of a counted transaction in the reporting currency. */
export interface Flow {
  txId: string;
  date: string;
  kind: 'income' | 'spending';
  categoryId: string | null;
  merchantKey: string;
  amount: Money; // income: positive; spending: positive for expenses, negative for refunds
}

export interface FlowsResult {
  flows: Flow[];
  missingRates: MissingRate[];
}

/**
 * Turn transactions into reporting-currency category flows, applying every inclusion rule.
 * All aggregation functions build on this.
 */
export function flows(txs: readonly LedgerTransaction[], opts: AggregateOptions): FlowsResult {
  const accounts = opts.accountIds ? new Set(opts.accountIds) : null;
  const out: Flow[] = [];
  const missing = new Map<string, MissingRate>();
  for (const t of txs) {
    if (t.kind !== 'income' && t.kind !== 'expense' && t.kind !== 'refund') continue;
    if (!countsInReports(t) || t.bookingDate < opts.from || t.bookingDate > opts.to) continue;
    if (accounts && !t.postings.some((p) => accounts.has(p.accountId))) continue;
    const parts: { categoryId: string | null; amount: Money }[] = t.splits?.length
      ? [...t.splits]
      : t.postings.map((p) => ({ categoryId: null, amount: abs(p.amount) }));
    const sign = t.kind === 'refund' ? -1n : 1n;
    const mk = merchantKey(t);
    for (const s of parts) {
      if (toMinor(s.amount) === 0n) continue;
      const v = opts.convert(s.amount, t.bookingDate);
      if (!v) {
        const k = `${s.amount.currency}|${t.bookingDate}`;
        missing.set(k, { from: s.amount.currency, to: opts.currency, date: t.bookingDate });
        continue;
      }
      out.push({
        txId: t.id,
        date: t.bookingDate,
        kind: t.kind === 'income' ? 'income' : 'spending',
        categoryId: s.categoryId,
        merchantKey: mk,
        amount: fromMinor(toMinor(v) * sign, v.currency),
      });
    }
  }
  return {
    flows: out,
    missingRates: [...missing.values()].sort((a, b) =>
      a.date === b.date ? (a.from + a.to).localeCompare(b.from + b.to) : a.date < b.date ? -1 : 1,
    ),
  };
}

const abs = (m: Money): Money => fromMinor(toMinor(m) < 0n ? -toMinor(m) : toMinor(m), m.currency);

/**
 * Normalize a merchant / payee string for grouping and matching: lowercase, letters only,
 * tokens containing digits dropped (card numbers, store ids, dates), whitespace collapsed.
 * "KONZUM 1234 SARAJEVO" -> "konzum sarajevo".
 */
export function normalizeMerchantName(s: string): string {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((tok) => tok && !/\p{N}/u.test(tok))
    .join(' ');
}

export function merchantKey(t: Pick<LedgerTransaction, 'merchantId' | 'payee' | 'description'>) {
  if (t.merchantId) return t.merchantId;
  const n = normalizeMerchantName(t.payee || t.description || '');
  return n ? `name:${n}` : 'name:';
}

function result(
  opts: AggregateOptions,
  rows: AnalyticsRow[],
  missingRates: MissingRate[],
): AnalyticsResult {
  const total = rows.reduce((a, r) => a + toMinor(r.amount), 0n);
  return {
    currency: opts.currency,
    from: opts.from,
    to: opts.to,
    rows,
    total: fromMinor(total, opts.currency),
    complete: missingRates.length === 0,
    warnings: missingRates.length
      ? [`${missingRates.length} transaction date(s) skipped: missing exchange rate`]
      : [],
    missingRates,
  };
}

function groupRows(
  fs: readonly Flow[],
  currency: string,
  keyOf: (f: Flow) => string,
  labelOf: (key: string) => string,
): AnalyticsRow[] {
  const acc = new Map<string, { sum: bigint; txs: Set<string> }>();
  for (const f of fs) {
    const k = keyOf(f);
    const e = acc.get(k) ?? { sum: 0n, txs: new Set<string>() };
    e.sum += toMinor(f.amount);
    e.txs.add(f.txId);
    acc.set(k, e);
  }
  return [...acc.entries()]
    .map(([key, e]) => ({
      key,
      label: labelOf(key),
      amount: fromMinor(e.sum, currency),
      count: e.txs.size,
    }))
    .sort((a, b) => {
      const d = toMinor(b.amount) - toMinor(a.amount);
      return d !== 0n ? (d > 0n ? 1 : -1) : a.key.localeCompare(b.key);
    });
}

/** Map each category to its root ancestor (cycles and unknown parents stop the walk). */
export function rootCategory(categories: readonly CategoryLike[]): (id: string | null) => string {
  const parent = new Map(categories.map((c) => [c.id, c.parentId]));
  return (id) => {
    if (!id) return UNCATEGORIZED;
    let cur = id;
    const seen = new Set<string>();
    for (;;) {
      const p = parent.get(cur);
      if (!p || seen.has(p) || !parent.has(p)) return cur;
      seen.add(cur);
      cur = p;
    }
  };
}

export interface CategoryOptions extends AggregateOptions {
  kind?: 'spending' | 'income';
  categories?: readonly CategoryLike[];
  rollup?: 'none' | 'parent'; // parent: subcategories are summed into their top-level category
}

/** Spending (or income) by category, rows sorted by amount desc then key. */
export function byCategory(txs: readonly LedgerTransaction[], opts: CategoryOptions) {
  const { flows: fs, missingRates } = flows(txs, opts);
  const kind = opts.kind ?? 'spending';
  const cats = opts.categories ?? [];
  const names = new Map(cats.map((c) => [c.id, c.name]));
  const root = rootCategory(cats);
  const keyOf =
    opts.rollup === 'parent'
      ? (f: Flow) => root(f.categoryId)
      : (f: Flow) => f.categoryId ?? UNCATEGORIZED;
  const rows = groupRows(
    fs.filter((f) => f.kind === kind),
    opts.currency,
    keyOf,
    (k) => (k === UNCATEGORIZED ? 'Uncategorized' : (names.get(k) ?? k)),
  );
  return result(opts, rows, missingRates);
}

/** Spending by merchant (merchantId, else normalized payee/description). */
export function byMerchant(
  txs: readonly LedgerTransaction[],
  opts: AggregateOptions & { merchants?: readonly { id: string; name: string }[] },
) {
  const { flows: fs, missingRates } = flows(txs, opts);
  const names = new Map((opts.merchants ?? []).map((m) => [m.id, m.name]));
  const rows = groupRows(
    fs.filter((f) => f.kind === 'spending'),
    opts.currency,
    (f) => f.merchantKey,
    (k) => names.get(k) ?? (k.startsWith('name:') ? k.slice(5) || 'Unknown' : k),
  );
  return result(opts, rows, missingRates);
}

export interface CashflowPeriod {
  period: string;
  income: Money;
  expense: Money; // net spending (expenses minus refunds)
  net: Money;
  savingsRate: string | null;
}

/**
 * Savings rate = (income - net spending) / income, a fraction with 4 decimals rounded half_up;
 * null when income <= 0. Transfers to savings are not spending, so they count as saved.
 */
export function savingsRate(income: Money, expense: Money): string | null {
  const i = toMinor(income);
  if (i <= 0n) return null;
  const e = toMinor(expense);
  return formatDecimal({ units: divRound((i - e) * pow10(4), i, 'half_up'), scale: 4 });
}

export interface CashflowResult {
  currency: string;
  from: string;
  to: string;
  periods: CashflowPeriod[];
  totals: Omit<CashflowPeriod, 'period'>;
  complete: boolean;
  missingRates: MissingRate[];
}

/** Income vs expenses per period (only periods with activity are listed, ascending). */
export function cashflow(
  txs: readonly LedgerTransaction[],
  opts: AggregateOptions & { granularity: Granularity },
): CashflowResult {
  const { flows: fs, missingRates } = flows(txs, opts);
  const acc = new Map<string, { inc: bigint; exp: bigint }>();
  let ti = 0n;
  let te = 0n;
  for (const f of fs) {
    const k = periodKey(f.date, opts.granularity);
    const e = acc.get(k) ?? { inc: 0n, exp: 0n };
    const v = toMinor(f.amount);
    if (f.kind === 'income') {
      e.inc += v;
      ti += v;
    } else {
      e.exp += v;
      te += v;
    }
    acc.set(k, e);
  }
  const mk = (inc: bigint, exp: bigint) => {
    const income = fromMinor(inc, opts.currency);
    const expense = fromMinor(exp, opts.currency);
    return {
      income,
      expense,
      net: fromMinor(inc - exp, opts.currency),
      savingsRate: savingsRate(income, expense),
    };
  };
  return {
    currency: opts.currency,
    from: opts.from,
    to: opts.to,
    periods: [...acc.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([period, e]) => ({ period, ...mk(e.inc, e.exp) })),
    totals: mk(ti, te),
    complete: missingRates.length === 0,
    missingRates,
  };
}

export interface BalancePoint {
  date: string;
  balance: Money;
}

/**
 * End-of-day balance of one account (in `currency`, its posting currency) for every date in
 * [from, to] — the opening value includes everything booked before `from`.
 */
export function balanceHistory(
  txs: readonly LedgerTransaction[],
  accountId: string,
  currency: string,
  from: string,
  to: string,
): BalancePoint[] {
  const deltas = new Map<string, bigint>();
  let opening = 0n;
  for (const t of txs) {
    if (!isLive(t) || t.bookingDate > to) continue;
    for (const p of t.postings) {
      if (p.accountId !== accountId || p.amount.currency !== currency) continue;
      const v = toMinor(p.amount);
      if (t.bookingDate < from) opening += v;
      else deltas.set(t.bookingDate, (deltas.get(t.bookingDate) ?? 0n) + v);
    }
  }
  let bal = opening;
  return dateRange(from, to).map((date) => {
    bal += deltas.get(date) ?? 0n;
    return { date, balance: fromMinor(bal, currency) };
  });
}

export interface NetWorthAccount {
  id: string;
  accountType: string;
  includeInNetWorth?: boolean;
}

export const LIABILITY_TYPES: readonly string[] = [
  'credit_card',
  'loan',
  'mortgage',
  'other_liability',
];

export interface NetWorth {
  assets: Money;
  liabilities: Money; // positive magnitude owed (net of liability accounts' balances)
  netWorth: Money;
  complete: boolean;
  missingRates: MissingRate[];
}

/**
 * Net worth at `asOf`: balances valued at the asOf rate. Asset accounts sum into assets, liability
 * accounts (normally negative balances) into liabilities as a positive amount owed.
 */
export function netWorth(
  txs: readonly LedgerTransaction[],
  accounts: readonly NetWorthAccount[],
  asOf: string,
  currency: string,
  convert: ToReporting,
): NetWorth {
  const info = new Map(accounts.map((a) => [a.id, a]));
  let assets = 0n;
  let liabilities = 0n;
  const missing: MissingRate[] = [];
  for (const b of accountBalances(txs, asOf)) {
    const a = info.get(b.accountId);
    if (!a || a.includeInNetWorth === false) continue;
    const v = convert({ amount: b.amount, currency: b.currency }, asOf);
    if (!v) {
      missing.push({ from: b.currency, to: currency, date: asOf });
      continue;
    }
    if (LIABILITY_TYPES.includes(a.accountType)) liabilities -= toMinor(v);
    else assets += toMinor(v);
  }
  return {
    assets: fromMinor(assets, currency),
    liabilities: fromMinor(liabilities, currency),
    netWorth: fromMinor(assets - liabilities, currency),
    complete: missing.length === 0,
    missingRates: missing,
  };
}
