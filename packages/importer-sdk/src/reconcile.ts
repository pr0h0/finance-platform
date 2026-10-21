// Reconciliation helpers (Features 116, 129). Exact minor-unit arithmetic via finance-engine.
import { fromMinor, type Money, toMinor } from '@finplat/finance-engine';
import { canonicalReference } from './fingerprint.ts';
import type { NormalizedRecord, StatementInfo } from './types.ts';

export const signedMinor = (r: NormalizedRecord): bigint => {
  const m = toMinor({ amount: r.amount, currency: r.currency });
  return r.direction === 'debit' ? -m : m;
};

export const signed = (r: NormalizedRecord): Money => fromMinor(signedMinor(r), r.currency);

export interface Totals {
  currency: string;
  income: Money;
  expenses: Money; // positive magnitude
  net: Money;
  count: number;
}

/** Income/expense totals per currency (import workflow step 7). */
export function totals(records: readonly NormalizedRecord[]): Totals[] {
  const by = new Map<string, { inc: bigint; exp: bigint; n: number }>();
  for (const r of records) {
    const t = by.get(r.currency) ?? { inc: 0n, exp: 0n, n: 0 };
    const v = signedMinor(r);
    if (v < 0n) t.exp -= v;
    else t.inc += v;
    t.n++;
    by.set(r.currency, t);
  }
  return [...by.entries()].map(([c, t]) => ({
    currency: c,
    income: fromMinor(t.inc, c),
    expenses: fromMinor(t.exp, c),
    net: fromMinor(t.inc - t.exp, c),
    count: t.n,
  }));
}

export type BalanceCheck =
  | { status: 'balanced'; opening: Money; closing: Money }
  | {
      status: 'mismatch';
      opening: Money;
      closing: Money;
      expectedClosing: Money;
      difference: Money;
    }
  | { status: 'unverifiable'; reason: string };

/** opening + Σ signed amounts must equal closing (statement in one currency). */
export function checkStatementBalance(
  statement: StatementInfo,
  records: readonly NormalizedRecord[],
): BalanceCheck {
  const cur = statement.currency ?? records[0]?.currency;
  if (!cur || statement.openingBalance === undefined || statement.closingBalance === undefined)
    return { status: 'unverifiable', reason: 'statement has no opening/closing balance' };
  const rs = records.filter((r) => r.currency === cur);
  if (rs.length !== records.length)
    return { status: 'unverifiable', reason: 'records in more than one currency' };
  const opening = toMinor({ amount: statement.openingBalance, currency: cur });
  const closing = toMinor({ amount: statement.closingBalance, currency: cur });
  const expected = rs.reduce((s, r) => s + signedMinor(r), opening);
  const o = fromMinor(opening, cur);
  const c = fromMinor(closing, cur);
  if (expected === closing) return { status: 'balanced', opening: o, closing: c };
  return {
    status: 'mismatch',
    opening: o,
    closing: c,
    expectedClosing: fromMinor(expected, cur),
    difference: fromMinor(closing - expected, cur),
  };
}

export interface RunningBalanceCheck {
  order: 'oldest_first' | 'newest_first' | 'unknown';
  /** Rows where previous balance + amount ≠ printed balance. */
  breaks: number[];
  /** Balance before the chronologically first row with a running balance (Feature 129). */
  openingBalance?: Money;
  closingBalance?: Money;
}

/**
 * Verify printed running balances. Files may list rows newest-first; both orders are tried and the
 * one with fewer breaks wins. Rows without a balance are skipped.
 */
export function checkRunningBalances(records: readonly NormalizedRecord[]): RunningBalanceCheck {
  const rs = records.filter((r) => r.runningBalance !== undefined);
  if (rs.length === 0) return { order: 'unknown', breaks: [] };
  const bal = (r: NormalizedRecord) =>
    toMinor({ amount: r.runningBalance as string, currency: r.currency });
  const breaksFor = (seq: readonly NormalizedRecord[]) => {
    const b: number[] = [];
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1] as NormalizedRecord;
      const cur = seq[i] as NormalizedRecord;
      if (bal(prev) + signedMinor(cur) !== bal(cur)) b.push(cur.rowNumber);
    }
    return b;
  };
  const fwd = breaksFor(rs);
  const rev = breaksFor([...rs].reverse());
  const newest = rev.length < fwd.length;
  const chrono = newest ? [...rs].reverse() : rs;
  const first = chrono[0] as NormalizedRecord;
  const last = chrono[chrono.length - 1] as NormalizedRecord;
  return {
    order: rs.length < 2 ? 'unknown' : newest ? 'newest_first' : 'oldest_first',
    breaks: newest ? rev : fwd,
    openingBalance: fromMinor(bal(first) - signedMinor(first), first.currency),
    closingBalance: fromMinor(bal(last), last.currency),
  };
}

/** An already-saved transaction / raw record to dedup against. Amount is signed. */
export interface ExistingRecord {
  id: string;
  postingDate: string;
  amount: Money;
  fingerprint?: string;
  bankReference?: string;
}

export interface MatchOutcome {
  outcome: 'new' | 'duplicate' | 'matched' | 'conflict';
  existingId?: string;
  reason?: string;
}

const dayDiff = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Classify staged records against existing ones (same account):
 * duplicate = same fp1 fingerprint; conflict = same bank reference but different amount/date;
 * matched = same signed amount within ±toleranceDays of a not-yet-claimed manual entry; else new.
 * Duplicates within the staged batch itself are also reported.
 */
export function matchExisting(
  records: readonly NormalizedRecord[],
  existing: readonly ExistingRecord[],
  opts: { toleranceDays?: number } = {},
): MatchOutcome[] {
  const tol = opts.toleranceDays ?? 3;
  const byFp = new Map(existing.filter((e) => e.fingerprint).map((e) => [e.fingerprint, e]));
  const byRef = new Map<string, ExistingRecord>();
  for (const e of existing) {
    const ref = canonicalReference(e.bankReference);
    if (ref) byRef.set(`${e.amount.currency}:${ref}`, e);
  }
  const claimed = new Set<string>();
  const seenFp = new Set<string>();
  return records.map((r): MatchOutcome => {
    if (seenFp.has(r.fingerprint))
      return { outcome: 'duplicate', reason: 'repeated in this import' };
    seenFp.add(r.fingerprint);
    const fp = byFp.get(r.fingerprint);
    if (fp) {
      claimed.add(fp.id);
      return { outcome: 'duplicate', existingId: fp.id, reason: 'same fingerprint' };
    }
    const amount = signedMinor(r);
    const ref = canonicalReference(r.bankReference);
    const sameRef = ref ? byRef.get(`${r.currency}:${ref}`) : undefined;
    if (sameRef) {
      claimed.add(sameRef.id);
      return {
        outcome: 'conflict',
        existingId: sameRef.id,
        reason: 'same bank reference, different amount or date',
      };
    }
    let best: ExistingRecord | undefined;
    for (const e of existing) {
      if (claimed.has(e.id) || e.fingerprint || e.amount.currency !== r.currency) continue;
      if (toMinor(e.amount) !== amount) continue;
      const d = dayDiff(e.postingDate, r.postingDate);
      if (d <= tol && (!best || d < dayDiff(best.postingDate, r.postingDate))) best = e;
    }
    if (best) {
      claimed.add(best.id);
      return {
        outcome: 'matched',
        existingId: best.id,
        reason: 'same amount within date tolerance',
      };
    }
    return { outcome: 'new' };
  });
}
