// Transparent, deterministic insights and unusual-expense detection (PLAN §64–65). No AI.
// The Go analytics module applies the same rules (conformance/insights.json).
import { type AggregateOptions, type Flow, flows, type LedgerTransaction } from './analytics.ts';
import { addDays, addMonths, endOfMonth, monthKey, startOfMonth } from './dates.ts';
import { divRound, formatDecimal, pow10 } from './decimal.ts';
import type { ToReporting } from './fx.ts';
import { fromMinor, toMinor } from './money.ts';

export interface Insight {
  id: string; // stable, used for dismissal
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  data: Record<string, unknown>;
}

const fmt = (units: bigint, cur: string) => `${fromMinor(units, cur).amount} ${cur}`;
const ratio2 = (a: bigint, b: bigint) =>
  formatDecimal({ units: divRound(a * pow10(2), b, 'half_up'), scale: 2 });
const lowerMedian = (xs: bigint[]): bigint => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)] as bigint;
};

/**
 * Unusual expenses among spending flows booked in [from, to] (per transaction, summed over its
 * splits per category). History = the `lookbackDays` before `from`.
 * - large_vs_category: amount >= 3x the median of >= 5 historical transactions in the category.
 * - large_vs_merchant: amount >= 2x the median of >= 3 historical transactions at the merchant.
 * Only one insight per transaction (category rule first). Amounts must be >= minAmount (minor units
 * of the reporting currency, default 0). Dismissed ids are filtered out.
 */
export function detectAnomalies(
  txs: readonly LedgerTransaction[],
  opts: {
    from: string;
    to: string;
    currency: string;
    convert: ToReporting;
    lookbackDays?: number;
    minAmount?: bigint;
    dismissed?: ReadonlySet<string>;
  },
): Insight[] {
  const histFrom = addDays(opts.from, -(opts.lookbackDays ?? 180));
  const all = flows(txs, { ...opts, from: histFrom, to: opts.to } as AggregateOptions).flows.filter(
    (f) => f.kind === 'spending' && toMinor(f.amount) > 0n,
  );
  // per (tx, category) and per tx (merchant) amounts
  const byTxCat = new Map<string, { f: Flow; v: bigint }>();
  const byTx = new Map<string, { f: Flow; v: bigint }>();
  for (const f of all) {
    const k = `${f.txId}|${f.categoryId ?? ''}`;
    const v = toMinor(f.amount);
    const a = byTxCat.get(k);
    byTxCat.set(k, { f, v: (a?.v ?? 0n) + v });
    const b = byTx.get(f.txId);
    byTx.set(f.txId, { f, v: (b?.v ?? 0n) + v });
  }
  const catHist = new Map<string, bigint[]>();
  const merHist = new Map<string, bigint[]>();
  for (const { f, v } of byTxCat.values())
    if (f.date < opts.from && f.categoryId) push(catHist, f.categoryId, v);
  for (const { f, v } of byTx.values())
    if (f.date < opts.from && !f.merchantKey.endsWith(':')) push(merHist, f.merchantKey, v);

  const out: Insight[] = [];
  const flagged = new Set<string>();
  const min = opts.minAmount ?? 0n;
  const sorted = [...byTxCat.values()].sort((a, b) =>
    a.f.date < b.f.date ? -1 : a.f.date > b.f.date ? 1 : a.f.txId.localeCompare(b.f.txId),
  );
  for (const { f, v } of sorted) {
    if (f.date < opts.from || !f.categoryId || v < min || flagged.has(f.txId)) continue;
    const h = catHist.get(f.categoryId);
    if (!h || h.length < 5) continue;
    const med = lowerMedian(h);
    if (med > 0n && v >= 3n * med) {
      flagged.add(f.txId);
      out.push(anomaly(f, 'large_vs_category', v, med, opts.currency, h.length));
    }
  }
  for (const { f, v } of [...byTx.values()].sort((a, b) => a.f.txId.localeCompare(b.f.txId))) {
    if (f.date < opts.from || v < min || flagged.has(f.txId)) continue;
    const h = merHist.get(f.merchantKey);
    if (!h || h.length < 3) continue;
    const med = lowerMedian(h);
    if (med > 0n && v >= 2n * med) {
      flagged.add(f.txId);
      out.push(anomaly(f, 'large_vs_merchant', v, med, opts.currency, h.length));
    }
  }
  return out.filter((i) => !opts.dismissed?.has(i.id));
}

function push(m: Map<string, bigint[]>, k: string, v: bigint) {
  const l = m.get(k) ?? [];
  l.push(v);
  m.set(k, l);
}

function anomaly(f: Flow, rule: string, v: bigint, med: bigint, cur: string, n: number): Insight {
  const what = rule === 'large_vs_category' ? 'this category' : 'this merchant';
  return {
    id: `anomaly:${f.txId}:${rule}`,
    kind: 'unusual_expense',
    severity: 'warning',
    title: 'Unusually large expense',
    body: `${fmt(v, cur)} on ${f.date} is ${ratio2(v, med)}x the usual ${fmt(med, cur)} for ${what} (median of ${n} earlier transactions).`,
    data: {
      transactionId: f.txId,
      rule,
      amount: fromMinor(v, cur),
      median: fromMinor(med, cur),
      ratio: ratio2(v, med),
      categoryId: f.categoryId,
    },
  };
}

/**
 * Monthly insights for the month containing `month` (YYYY-MM-DD), compared with the 3 previous
 * calendar months:
 * - category_spike: category spending >= 1.3x its 3-month average and at least minDelta more
 *   (only categories with spending in at least one previous month).
 * - spending_change: total spending vs the previous month, when it changed by >= 20% and minDelta.
 * - savings_rate: the month's savings rate (info), when there was income.
 */
export function monthlyInsights(
  txs: readonly LedgerTransaction[],
  opts: {
    month: string;
    currency: string;
    convert: ToReporting;
    minDelta?: bigint;
    dismissed?: ReadonlySet<string>;
  },
): Insight[] {
  const cur = opts.currency;
  const start = startOfMonth(opts.month);
  const histStart = addMonths(start, -3);
  const { flows: fs } = flows(txs, {
    from: histStart,
    to: endOfMonth(start),
    currency: cur,
    convert: opts.convert,
  });
  const mk = monthKey(start);
  const prevMk = monthKey(addMonths(start, -1));
  const cat = new Map<string, { now: bigint; hist: bigint }>();
  const spend = new Map<string, bigint>();
  let income = 0n;
  for (const f of fs) {
    const m = monthKey(f.date);
    const v = toMinor(f.amount);
    if (f.kind === 'income') {
      if (m === mk) income += v;
      continue;
    }
    spend.set(m, (spend.get(m) ?? 0n) + v);
    const k = f.categoryId ?? 'uncategorized';
    const e = cat.get(k) ?? { now: 0n, hist: 0n };
    if (m === mk) e.now += v;
    else e.hist += v;
    cat.set(k, e);
  }
  const minDelta = opts.minDelta ?? 0n;
  const out: Insight[] = [];
  for (const [k, e] of [...cat.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (e.hist <= 0n || e.now <= 0n) continue;
    // now >= 1.3 * hist/3  <=>  30 * now >= 13 * hist
    const avg = divRound(e.hist, 3n, 'half_up');
    if (30n * e.now >= 13n * e.hist && e.now - avg >= minDelta && e.now > avg) {
      out.push({
        id: `category_spike:${mk}:${k}`,
        kind: 'category_spike',
        severity: 'info',
        title: 'Category spending is up',
        body: `Spending in this category is ${fmt(e.now, cur)} this month vs a 3-month average of ${fmt(avg, cur)}.`,
        data: {
          categoryId: k === 'uncategorized' ? null : k,
          month: mk,
          amount: fromMinor(e.now, cur),
          average: fromMinor(avg, cur),
        },
      });
    }
  }
  const now = spend.get(mk) ?? 0n;
  const prev = spend.get(prevMk) ?? 0n;
  const delta = now - prev;
  const absDelta = delta < 0n ? -delta : delta;
  if (prev > 0n && absDelta * 5n >= prev && absDelta >= minDelta) {
    out.push({
      id: `spending_change:${mk}`,
      kind: 'spending_change',
      severity: delta > 0n ? 'warning' : 'info',
      title: delta > 0n ? 'Spending increased' : 'Spending decreased',
      body: `Total spending is ${fmt(now, cur)} vs ${fmt(prev, cur)} last month (${delta > 0n ? '+' : '-'}${ratio2(absDelta * 100n, prev)}%).`,
      data: { month: mk, amount: fromMinor(now, cur), previous: fromMinor(prev, cur) },
    });
  }
  if (income > 0n) {
    const rate = formatDecimal({
      units: divRound((income - now) * pow10(4), income, 'half_up'),
      scale: 4,
    });
    out.push({
      id: `savings_rate:${mk}`,
      kind: 'savings_rate',
      severity: income - now < 0n ? 'warning' : 'info',
      title: 'Savings rate',
      body: `You kept ${ratio2((income - now) * 100n, income)}% of this month's income (${fmt(income - now, cur)}).`,
      data: {
        month: mk,
        savingsRate: rate,
        income: fromMinor(income, cur),
        spending: fromMinor(now, cur),
      },
    });
  }
  return out.filter((i) => !opts.dismissed?.has(i.id));
}
