// Analytics page figures (PLAN §35) from a Snapshot; every function takes the active filters.

import { currencyExposure } from '@finplat/currency';
import {
  addDays,
  addMonths,
  annualize,
  byCategory,
  byMerchant,
  cashflow,
  diffDays,
  endOfMonth,
  flows,
  fromMinor,
  type Granularity,
  type MissingRate,
  minDate,
  netWorth,
  startOfMonth,
  type ToReporting,
  toMinor,
} from '@finplat/finance-engine';
import type { Snapshot } from './snapshot.ts';

export interface Filters {
  from: string;
  to: string;
  currency: string;
  convert: ToReporting;
  accountIds?: string[];
  granularity: Granularity;
}

const opt = (f: Filters) => ({
  from: f.from,
  to: f.to,
  currency: f.currency,
  convert: f.convert,
  ...(f.accountIds?.length ? { accountIds: f.accountIds } : {}),
});

export const spendingByCategory = (s: Snapshot, f: Filters, rollup: 'parent' | 'none' = 'parent') =>
  byCategory(s.ledger, { ...opt(f), categories: s.categories, rollup });

export const incomeByCategory = (s: Snapshot, f: Filters) =>
  byCategory(s.ledger, { ...opt(f), kind: 'income', categories: s.categories, rollup: 'parent' });

export const incomeVsExpenses = (s: Snapshot, f: Filters) =>
  cashflow(s.ledger, { ...opt(f), granularity: f.granularity });

export const merchantRanking = (s: Snapshot, f: Filters) =>
  byMerchant(s.ledger, { ...opt(f), merchants: s.merchants });

/** Monthly spending per top-level category (stacked trend), top `n` categories + other. */
export function categoryTrend(s: Snapshot, f: Filters, n = 5) {
  const total = spendingByCategory(s, f);
  const top = total.rows.slice(0, n).map((r) => r.key);
  const parent = new Map(s.categories.map((c) => [c.id, c.parentId]));
  const root = (id: string | null) => {
    let cur = id;
    for (let i = 0; cur && parent.get(cur) && i < 50; i++) cur = parent.get(cur) ?? null;
    return cur ?? 'uncategorized';
  };
  const { flows: fs } = flows(s.ledger, opt(f));
  const per = new Map<string, Map<string, bigint>>();
  for (const x of fs) {
    if (x.kind !== 'spending') continue;
    const k = x.date.slice(0, 7);
    const key = top.includes(root(x.categoryId)) ? root(x.categoryId) : 'other';
    const m = per.get(k) ?? new Map<string, bigint>();
    m.set(key, (m.get(key) ?? 0n) + toMinor(x.amount));
    per.set(k, m);
  }
  const months: string[] = [];
  for (let d = startOfMonth(f.from); d <= f.to; d = addMonths(d, 1)) months.push(d.slice(0, 7));
  const labels = new Map(total.rows.map((r) => [r.key, r.label]));
  const keys = [...top, ...(total.rows.length > n ? ['other'] : [])];
  return {
    keys: keys.map((k) => ({ key: k, label: k === 'other' ? 'Other' : (labels.get(k) ?? k) })),
    rows: months.map((month) => ({
      month,
      values: Object.fromEntries(
        keys.map((k) => [k, fromMinor(per.get(month)?.get(k) ?? 0n, f.currency)]),
      ),
    })),
    complete: total.complete,
    missingRates: total.missingRates,
  };
}

/** The same-length period just before, or the same dates one year earlier. */
export function comparisonRange(from: string, to: string, mode: 'previous' | 'year_ago') {
  if (mode === 'year_ago') return { from: addMonths(from, -12), to: addMonths(to, -12) };
  const len = diffDays(to, from) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

export function periodComparison(s: Snapshot, f: Filters, mode: 'previous' | 'year_ago') {
  const prev = comparisonRange(f.from, f.to, mode);
  const cur = spendingByCategory(s, f);
  const old = spendingByCategory(s, { ...f, ...prev });
  const keys = new Map<string, string>();
  for (const r of [...cur.rows, ...old.rows]) keys.set(r.key, r.label);
  const get = (rows: typeof cur.rows, k: string) =>
    rows.find((r) => r.key === k)?.amount ?? fromMinor(0n, f.currency);
  const rows = [...keys.entries()].map(([key, label]) => {
    const a = get(cur.rows, key);
    const b = get(old.rows, key);
    return {
      key,
      label,
      current: a,
      previous: b,
      change: fromMinor(toMinor(a) - toMinor(b), f.currency),
    };
  });
  rows.sort((x, y) =>
    toMinor(y.current) > toMinor(x.current) ? 1 : toMinor(y.current) < toMinor(x.current) ? -1 : 0,
  );
  return {
    range: prev,
    rows,
    total: { current: cur.total, previous: old.total },
    complete: cur.complete && old.complete,
    missingRates: [...cur.missingRates, ...old.missingRates],
  };
}

/** Net worth (assets, liabilities) at each month end in range, valued at that date's rate. */
export function netWorthHistory(s: Snapshot, f: Filters) {
  const out = [];
  const missing: MissingRate[] = [];
  for (let d = startOfMonth(f.from); d <= f.to; d = addMonths(d, 1)) {
    const at = minDate(endOfMonth(d), f.to);
    const nw = netWorth(s.ledger, s.accounts, at, f.currency, f.convert);
    missing.push(...nw.missingRates);
    out.push({ date: at, assets: nw.assets, liabilities: nw.liabilities, netWorth: nw.netWorth });
  }
  return { points: out, complete: missing.length === 0, missingRates: missing };
}

/** Balances by currency valued in the reporting currency (feature 24). */
export function currencyDistribution(s: Snapshot, f: Filters) {
  const balances = s.accounts
    .filter((a) => !f.accountIds?.length || f.accountIds.includes(a.id))
    .flatMap((a) => (a.classification === 'asset' ? a.balances : []));
  return currencyExposure(balances, f.currency, f.convert, minDate(f.to, s.today));
}

/** Spending in each original transaction currency within the range (before conversion). */
export function spendingByCurrency(s: Snapshot, f: Filters) {
  const per = new Map<string, bigint>();
  for (const t of s.ledger) {
    if (
      t.kind !== 'expense' ||
      t.bookingDate < f.from ||
      t.bookingDate > f.to ||
      t.deletedAt ||
      t.status === 'void' ||
      t.excludeFromReports
    )
      continue;
    if (f.accountIds?.length && !t.postings.some((p) => f.accountIds?.includes(p.accountId)))
      continue;
    for (const p of t.postings)
      per.set(p.amount.currency, (per.get(p.amount.currency) ?? 0n) - toMinor(p.amount));
  }
  return [...per.entries()].map(([c, v]) => ({
    currency: c,
    amount: fromMinor(v, c),
    converted: f.convert(fromMinor(v, c), f.to),
  }));
}

/** Currency fees: fee expenses linked to transfers/fx transactions (relatedTransactionId). */
export function conversionFees(s: Snapshot, f: Filters) {
  const twoSided = new Set(
    s.transactions.filter((t) => t.kind === 'transfer' || t.kind === 'fx').map((t) => t.id),
  );
  let total = 0n;
  let complete = true;
  const items = [];
  for (const t of s.transactions) {
    if (t.kind !== 'expense' || !t.relatedTransactionId || !twoSided.has(t.relatedTransactionId))
      continue;
    if (t.bookingDate < f.from || t.bookingDate > f.to || t.status === 'void') continue;
    const native = fromMinor(
      -t.postings.reduce((a, p) => a + toMinor(p.amount), 0n),
      t.postings[0]?.amount.currency ?? f.currency,
    );
    const c = f.convert(native, t.bookingDate);
    if (c) total += toMinor(c);
    else complete = false;
    items.push({ t, native, converted: c });
  }
  return { items, total: fromMinor(total, f.currency), complete };
}

/** Recurring spending (active recurring expense plans) as monthly and annual equivalents. */
export function recurringCosts(s: Snapshot, f: Filters) {
  const sched = new Map(s.schedules.map((x) => [x.id, x]));
  let monthly = 0n;
  let annual = 0n;
  let complete = true;
  const rows = [];
  for (const p of s.plans) {
    if (p.kind !== 'expense' || p.status !== 'active' || !p.recurrenceId) continue;
    const sc = sched.get(p.recurrenceId);
    if (!sc) continue;
    const a = annualize(p.amount, sc.rrule);
    const mo = f.convert(a.monthly, s.today);
    const yr = f.convert(a.annual, s.today);
    if (mo && yr) {
      monthly += toMinor(mo);
      annual += toMinor(yr);
    } else complete = false;
    rows.push({ plan: p, rrule: sc.rrule, monthly: mo, annual: yr, native: a });
  }
  rows.sort((x, y) => (toMinor(y.native.annual) > toMinor(x.native.annual) ? 1 : -1));
  return {
    rows,
    monthly: fromMinor(monthly, f.currency),
    annual: fromMinor(annual, f.currency),
    complete,
  };
}

/** Planned vs actual per resolved/pending occurrence in range. */
export function plannedVsActual(s: Snapshot, f: Filters) {
  const tx = new Map(s.transactions.map((t) => [t.id, t]));
  const rows = [];
  for (const o of s.storedOccurrences) {
    if (o.occurrenceDate < f.from || o.occurrenceDate > f.to) continue;
    const plan = s.plans.find((p) => p.id === o.plannedTransactionId);
    if (!plan) continue;
    const planned = o.amountOverride ?? plan.amount;
    const t = o.matchedTransactionId ? tx.get(o.matchedTransactionId) : undefined;
    const actual = t
      ? fromMinor(
          t.postings
            .filter((p) => p.accountId === plan.accountId || !plan.accountId)
            .reduce(
              (a, p) => a + (toMinor(p.amount) < 0n ? -toMinor(p.amount) : toMinor(p.amount)),
              0n,
            ),
          planned.currency,
        )
      : null;
    rows.push({
      plan,
      occurrence: o,
      planned,
      actual,
      variance: actual ? fromMinor(toMinor(actual) - toMinor(planned), planned.currency) : null,
    });
  }
  return rows.sort((a, b) =>
    a.occurrence.occurrenceDate.localeCompare(b.occurrence.occurrenceDate),
  );
}

/** First transaction date (history completeness banner). */
export const historyStart = (s: Snapshot) =>
  s.ledger.reduce<string | null>((a, t) => (!a || t.bookingDate < a ? t.bookingDate : a), null);
