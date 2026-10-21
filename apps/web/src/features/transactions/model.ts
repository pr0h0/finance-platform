// Pure transaction-list logic: filtering, amount helpers, split arithmetic and export.
// Money stays in decimal strings / bigint minor units (finance-engine); never floats.
import type * as D from '@finplat/domain';
import { compareDecimal, fromMinor, toMinor } from '@finplat/finance-engine';

export const SPLIT_KINDS = new Set(['expense', 'income', 'refund']);

/** Signed amount of the first posting (the account the entry was made on). */
export const primaryAmount = (t: D.Transaction): D.Money | null => t.postings[0]?.amount ?? null;

export const absMoney = (m: D.Money): D.Money => {
  const v = toMinor(m);
  return v < 0n ? fromMinor(-v, m.currency) : m;
};

export const isUncategorized = (t: D.Transaction) =>
  SPLIT_KINDS.has(t.kind) && t.status !== 'void' && t.splits.some((s) => s.categoryId === null);

export interface TxFilter {
  from?: string;
  to?: string;
  accountIds?: string[];
  categoryId?: string; // '__none' = uncategorized
  merchantId?: string;
  currency?: string;
  tagId?: string;
  kind?: string;
  source?: string; // 'import' | 'manual' | ...
  importBatchId?: string;
  status?: string;
  minAmount?: string; // magnitude
  maxAmount?: string;
  q?: string;
}

export interface Lookups {
  merchantName: (id: string | null) => string;
  /** raw record id -> import batch id (only needed for the importBatchId filter) */
  batchOfRecord?: Map<string, string>;
}

export function filterTransactions(
  rows: readonly D.Transaction[],
  f: TxFilter,
  lk: Lookups,
): D.Transaction[] {
  const q = f.q?.trim().toLowerCase();
  const accounts = f.accountIds?.length ? new Set(f.accountIds) : null;
  const dec = (s?: string) => (s && /^\d+(\.\d+)?$/.test(s) ? s : undefined); // ignore half-typed input
  f = { ...f, minAmount: dec(f.minAmount), maxAmount: dec(f.maxAmount) };
  return rows.filter((t) => {
    if (f.from && t.bookingDate < f.from) return false;
    if (f.to && t.bookingDate > f.to) return false;
    if (accounts && !t.postings.some((p) => accounts.has(p.accountId))) return false;
    if (f.categoryId === '__none') {
      if (!isUncategorized(t)) return false;
    } else if (f.categoryId && !t.splits.some((s) => s.categoryId === f.categoryId)) return false;
    if (f.merchantId && t.merchantId !== f.merchantId) return false;
    if (f.currency && !t.postings.some((p) => p.amount.currency === f.currency)) return false;
    if (f.tagId && !t.tagIds.includes(f.tagId)) return false;
    if (f.kind && t.kind !== f.kind) return false;
    if (f.source && t.source !== f.source) return false;
    if (f.status && t.status !== f.status) return false;
    if (f.importBatchId) {
      const b = t.importRecordId ? lk.batchOfRecord?.get(t.importRecordId) : undefined;
      if (b !== f.importBatchId) return false;
    }
    const amt = primaryAmount(t);
    if (amt && (f.minAmount || f.maxAmount)) {
      const a = absMoney(amt).amount;
      if (f.minAmount && compareDecimal(a, f.minAmount) < 0) return false;
      if (f.maxAmount && compareDecimal(a, f.maxAmount) > 0) return false;
    }
    if (q) {
      const hay =
        `${t.description}\n${t.payee}\n${t.notes}\n${t.reference}\n${lk.merchantName(t.merchantId)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Totals per currency of the signed primary amounts (e.g. for the selection footer). */
export function totalsByCurrency(rows: readonly D.Transaction[]): D.Money[] {
  const m = new Map<string, bigint>();
  for (const t of rows) {
    const a = primaryAmount(t);
    if (!a || t.kind === 'transfer' || t.kind === 'fx') continue;
    m.set(a.currency, (m.get(a.currency) ?? 0n) + toMinor(a));
  }
  return [...m.entries()].sort().map(([c, v]) => fromMinor(v, c));
}

/** Same entry again, dated today; imported links and ids are not copied. */
export function duplicateInput(tx: D.Transaction, bookingDate: string) {
  const [p0, p1] = tx.postings;
  const amount = absMoney((p0 as D.Posting).amount);
  const base = {
    accountId: (p0 as D.Posting).accountId,
    amount,
    bookingDate,
    description: tx.description,
    payee: tx.payee,
    notes: tx.notes,
    merchantId: tx.merchantId,
    tagIds: tx.tagIds,
    reference: '',
  };
  if ((tx.kind === 'transfer' || tx.kind === 'fx') && p1)
    return {
      ...base,
      kind: 'transfer' as const,
      toAccountId: p1.accountId,
      toAmount: absMoney(p1.amount),
    };
  return {
    ...base,
    kind: tx.kind as 'expense' | 'income',
    splits: tx.splits.map((s) => ({
      categoryId: s.categoryId,
      amount: s.amount,
      description: s.description,
    })),
  };
}

// ------------------------------------------------------------------ splits

export interface SplitDraft {
  key: string;
  categoryId: string | null;
  amount: string; // decimal string as typed (magnitude)
  description: string;
}

/** Remainder = total − Σ lines in minor units; null when a line is not a valid amount. */
export function splitRemainder(total: D.Money, lines: readonly SplitDraft[]): D.Money | null {
  let left = toMinor(absMoney(total));
  for (const l of lines) {
    const v = parseAmount(l.amount, total.currency);
    if (v === null || v <= 0n) return null;
    left -= v;
  }
  return fromMinor(left, total.currency);
}

/** Decimal string → minor units at the currency scale, or null (too many decimals, junk). */
export function parseAmount(s: string, currency: string): bigint | null {
  const t = s.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  try {
    return toMinor({ amount: t, currency });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ export

export interface ExportNames {
  account: (id: string) => string;
  category: (id: string | null) => string;
  merchant: (id: string | null) => string;
  tag: (id: string) => string;
}

export const EXPORT_COLUMNS = [
  'id',
  'date',
  'kind',
  'status',
  'account',
  'amount',
  'currency',
  'description',
  'payee',
  'merchant',
  'categories',
  'tags',
  'reference',
  'notes',
  'source',
] as const;

/** One row per posting (transfers produce two), so amounts per account always reconcile. */
export function exportRows(rows: readonly D.Transaction[], n: ExportNames): string[][] {
  const out: string[][] = [];
  for (const t of rows)
    for (const p of t.postings)
      out.push([
        t.id,
        t.bookingDate,
        t.kind,
        t.status,
        n.account(p.accountId),
        p.amount.amount,
        p.amount.currency,
        t.description,
        t.payee,
        n.merchant(t.merchantId),
        t.splits.map((s) => `${n.category(s.categoryId)}=${s.amount.amount}`).join('; '),
        t.tagIds.map(n.tag).join('; '),
        t.reference,
        t.notes,
        t.source,
      ]);
  return out;
}

const csvCell = (v: string) => {
  // Neutralize spreadsheet formula injection, then quote when needed.
  const s = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header: readonly string[], rows: readonly string[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
