// Planned transactions: occurrence expansion with stored overrides, subscription annualization,
// installments and plan<->transaction matching. Mirrored by Go planning; cases in
// packages/test-fixtures/conformance/recurrence.json and subscriptions.json.
import type { LedgerTransaction } from './analytics.ts';
import { normalizeMerchantName } from './analytics.ts';
import { diffDays } from './dates.ts';
import { divRound } from './decimal.ts';
import { allocate, fromMinor, type Money, toMinor } from './money.ts';
import { expandRecurrence, parseRRule, type RecurrenceSpec } from './recurrence.ts';

export type Confidence = 'certain' | 'expected' | 'possible' | 'speculative';

export interface PlanLike {
  id: string;
  kind: 'income' | 'expense' | 'transfer';
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  merchantId?: string | null;
  description: string;
  amount: Money; // positive magnitude
  amountMin?: Money | null;
  amountMax?: Money | null;
  dueDate: string;
  recurrenceId: string | null;
  priority?: string;
  confidence: Confidence;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  installmentTotal?: number | null;
  installmentStart?: number | null;
  deletedAt?: string | null;
}

export interface ScheduleLike extends RecurrenceSpec {
  id: string;
}

export interface StoredOccurrence {
  plannedTransactionId: string;
  occurrenceDate: string;
  status: 'pending' | 'matched' | 'skipped' | 'paid_manual';
  amountOverride?: Money | null;
  dateOverride?: string | null;
  matchedTransactionId?: string | null;
}

export interface PlanOccurrence {
  planId: string;
  occurrenceDate: string; // identity (nominal rule date, or dueDate for one-off plans)
  date: string; // effective date: dateOverride ?? business-day adjusted date
  amount: Money;
  installmentNo: number | null;
  overdue: boolean;
}

/** Number of occurrences an installment plan still has: total - start + 1 (start defaults to 1). */
function installmentCap(p: PlanLike): number | null {
  if (!p.installmentTotal) return null;
  return Math.max(0, p.installmentTotal - (p.installmentStart ?? 1) + 1);
}

/**
 * Pending occurrences of active plans with an effective date in [from, to]. Occurrences stored as
 * matched / skipped / paid_manual are excluded (never double-counted, invariant 19). Stored pending
 * occurrences dated before `from` are returned on `from` with overdue = true when includeOverdue.
 */
export function planOccurrences(
  plans: readonly PlanLike[],
  schedules: readonly ScheduleLike[],
  stored: readonly StoredOccurrence[],
  from: string,
  to: string,
  opts: { includeOverdue?: boolean } = {},
): PlanOccurrence[] {
  const sched = new Map(schedules.map((s) => [s.id, s]));
  const st = new Map(stored.map((o) => [`${o.plannedTransactionId}|${o.occurrenceDate}`, o]));
  const out: PlanOccurrence[] = [];
  for (const p of plans) {
    if (p.status !== 'active' || p.deletedAt) continue;
    const s = p.recurrenceId ? sched.get(p.recurrenceId) : undefined;
    if (p.recurrenceId && !s) continue;
    const cap = installmentCap(p);
    // Expanded from the schedule start so installment numbers and overdue rows are known.
    const base = s
      ? expandRecurrence(
          { ...s, occurrenceCount: minNullable(s.occurrenceCount ?? null, cap) },
          s.startDate,
          to,
        )
      : cap === 0
        ? []
        : [{ date: p.dueDate, dueDate: p.dueDate }];
    base.forEach((o, i) => {
      const so = st.get(`${p.id}|${o.date}`);
      if (so && so.status !== 'pending') return;
      const date = so?.dateOverride ?? o.dueDate;
      const amount = so?.amountOverride ?? p.amount;
      const installmentNo = cap === null ? null : (p.installmentStart ?? 1) + i;
      if (date >= from && date <= to)
        out.push({
          planId: p.id,
          occurrenceDate: o.date,
          date,
          amount,
          installmentNo,
          overdue: false,
        });
      else if (date < from && so && opts.includeOverdue)
        out.push({
          planId: p.id,
          occurrenceDate: o.date,
          date: from,
          amount,
          installmentNo,
          overdue: true,
        });
    });
  }
  return out.sort((a, b) =>
    a.date === b.date
      ? a.planId < b.planId
        ? -1
        : a.planId > b.planId
          ? 1
          : 0
      : a.date < b.date
        ? -1
        : 1,
  );
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Occurrences per year as an exact fraction num/den (same as Go recurrence.PerYear). Documented
 * approximations: a year has 365 days / 52 weeks; an un-ordinaled weekday in a monthly rule counts
 * 4 per month. DAILY: 365 (or 52*|BYDAY|), times |BYMONTH|/12 when BYMONTH is set, / INTERVAL.
 * WEEKLY: 52*max(1,|BYDAY|) / INTERVAL. MONTHLY: (|BYMONTH| or 12) * n / INTERVAL with
 * n = |BYMONTHDAY|, else sum over BYDAY (plain 4, ordinal 1), else 1.
 * YEARLY: (|BYMONTH| or 1) * (|BYMONTHDAY| or 1) / INTERVAL.
 */
export function perYear(rrule: string): { num: number; den: number } {
  const r = parseRRule(rrule);
  switch (r.freq) {
    case 'DAILY': {
      const days = r.byDay.length ? 52 * r.byDay.length : 365;
      return r.byMonth.length
        ? { num: days * r.byMonth.length, den: 12 * r.interval }
        : { num: days, den: r.interval };
    }
    case 'WEEKLY':
      return { num: 52 * Math.max(1, r.byDay.length), den: r.interval };
    case 'MONTHLY': {
      const n = r.byMonthDay.length
        ? r.byMonthDay.length
        : r.byDay.length
          ? r.byDay.reduce((a, b) => a + (b.ordinal === null ? 4 : 1), 0)
          : 1;
      return { num: (r.byMonth.length || 12) * n, den: r.interval };
    }
    case 'YEARLY':
      return { num: (r.byMonth.length || 1) * (r.byMonthDay.length || 1), den: r.interval };
  }
}

export interface Annualized {
  perYear: { num: number; den: number };
  annual: Money;
  monthly: Money;
}

/** Annual (amount*num/den) and monthly (amount*num/(den*12)) equivalents, each rounded half_up once. */
export function annualize(amount: Money, rrule: string): Annualized {
  const py = perYear(rrule);
  const a = toMinor(amount) * BigInt(py.num);
  return {
    perYear: py,
    annual: fromMinor(divRound(a, BigInt(py.den), 'half_up'), amount.currency),
    monthly: fromMinor(divRound(a, BigInt(py.den) * 12n, 'half_up'), amount.currency),
  };
}

/** Spread an annual amount across 12 monthly budgets; parts sum exactly (largest remainder). */
export const spreadAnnual = (m: Money, months = 12): Money[] =>
  allocate(
    m,
    Array.from({ length: months }, () => '1'),
  );

export interface InstallmentProgress {
  total: number;
  paid: number;
  remaining: number;
  paidAmount: Money;
  outstanding: Money;
  nextDueDate: string | null;
}

/**
 * Installment plan progress. Installments before installmentStart count as paid; each later
 * occurrence counts as paid when stored as matched or paid_manual.
 */
export function installmentProgress(
  plan: PlanLike,
  schedule: ScheduleLike | null,
  stored: readonly StoredOccurrence[],
): InstallmentProgress {
  const total = plan.installmentTotal ?? 1;
  const start = plan.installmentStart ?? 1;
  const cap = Math.max(0, total - start + 1);
  const dates = schedule
    ? expandRecurrence({ ...schedule, occurrenceCount: cap }, schedule.startDate, '9000-12-31', cap)
    : [{ date: plan.dueDate, dueDate: plan.dueDate }];
  const st = new Map(
    stored.filter((o) => o.plannedTransactionId === plan.id).map((o) => [o.occurrenceDate, o]),
  );
  let paid = start - 1;
  let paidAmount = toMinor(plan.amount) * BigInt(start - 1);
  let nextDueDate: string | null = null;
  for (const o of dates) {
    const so = st.get(o.date);
    if (so && (so.status === 'matched' || so.status === 'paid_manual')) {
      paid++;
      paidAmount += toMinor(so.amountOverride ?? plan.amount);
    } else if (so?.status !== 'skipped' && nextDueDate === null) {
      nextDueDate = so?.dateOverride ?? o.dueDate;
    }
  }
  const remaining = Math.max(0, total - paid);
  return {
    total,
    paid,
    remaining,
    paidAmount: fromMinor(paidAmount, plan.amount.currency),
    outstanding: fromMinor(toMinor(plan.amount) * BigInt(remaining), plan.amount.currency),
    nextDueDate,
  };
}

export interface MatchSuggestion {
  plannedTransactionId: string;
  occurrenceDate: string;
  transactionId: string;
  score: string;
  reasons: string[];
}

/**
 * Suggest which actual transactions settle pending plan occurrences. Candidate when: same account,
 * direction matches the plan kind (expense = negative, income = positive), date within ±windowDays,
 * and |amount| within [amountMin, amountMax] (default ±10% of the plan amount). Score (0..1):
 * 0.4 amount (exact 0.4, in range 0.25) + 0.3 date (same day 0.3, else 0.3*(1 - d/(window+1)), 2dp)
 * + 0.3 counterparty (merchant id equal or normalized description equal 0.3, token overlap 0.15).
 * Greedy one-to-one assignment by score desc, then date distance, then ids.
 */
export function matchPlanned(
  occurrences: readonly PlanOccurrence[],
  plans: readonly PlanLike[],
  txs: readonly LedgerTransaction[],
  windowDays = 5,
): MatchSuggestion[] {
  const planById = new Map(plans.map((p) => [p.id, p]));
  const cands: (MatchSuggestion & { s: number; dd: number })[] = [];
  for (const o of occurrences) {
    const p = planById.get(o.planId);
    if (!p || p.kind === 'transfer' || !p.accountId) continue;
    const amt = toMinor(o.amount);
    const lo = p.amountMin ? toMinor(p.amountMin) : amt - amt / 10n;
    const hi = p.amountMax ? toMinor(p.amountMax) : amt + amt / 10n;
    for (const t of txs) {
      if (t.deletedAt || t.status === 'void' || (t.kind !== 'expense' && t.kind !== 'income'))
        continue;
      if (t.kind !== p.kind) continue;
      const post = t.postings.find((x) => x.accountId === p.accountId);
      if (!post || post.amount.currency !== o.amount.currency) continue;
      const dd = Math.abs(diffDays(t.bookingDate, o.date));
      if (dd > windowDays) continue;
      const v = toMinor(post.amount);
      const abs = v < 0n ? -v : v;
      if ((p.kind === 'expense') !== v < 0n || abs < lo || abs > hi) continue;
      const reasons: string[] = [];
      let s = abs === amt ? 40 : 25;
      reasons.push(abs === amt ? 'same amount' : 'amount within expected range');
      const ds = dd === 0 ? 30 : Math.floor((30 * (windowDays + 1 - dd)) / (windowDays + 1));
      s += ds;
      reasons.push(dd === 0 ? 'same date' : `${dd} day(s) apart`);
      const pn = normalizeMerchantName(p.description);
      const tn = normalizeMerchantName(t.payee || t.description || '');
      if ((p.merchantId && p.merchantId === t.merchantId) || (pn && pn === tn)) {
        s += 30;
        reasons.push('same merchant');
      } else if (pn && tn && overlap(pn, tn)) {
        s += 15;
        reasons.push('similar description');
      }
      cands.push({
        plannedTransactionId: p.id,
        occurrenceDate: o.occurrenceDate,
        transactionId: t.id,
        score: (s / 100).toFixed(2),
        reasons,
        s,
        dd,
      });
    }
  }
  cands.sort((a, b) => b.s - a.s || a.dd - b.dd || a.transactionId.localeCompare(b.transactionId));
  const usedOcc = new Set<string>();
  const usedTx = new Set<string>();
  const out: MatchSuggestion[] = [];
  for (const c of cands) {
    const ok = `${c.plannedTransactionId}|${c.occurrenceDate}`;
    if (usedOcc.has(ok) || usedTx.has(c.transactionId)) continue;
    usedOcc.add(ok);
    usedTx.add(c.transactionId);
    const { s: _s, dd: _dd, ...m } = c;
    out.push(m);
  }
  return out;
}

function overlap(a: string, b: string): boolean {
  const x = new Set(a.split(' '));
  return b.split(' ').some((t) => t.length >= 3 && x.has(t));
}
