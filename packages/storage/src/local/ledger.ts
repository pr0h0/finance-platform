// Posting/split derivation for local mode. Mirrors apps/api/internal/transactions/service.go
// (Create / buildTransfer / refundSplits / applyAmount) so a transaction created offline has the
// same postings the server would derive.
import type { Account, Conversion, Money, Posting, Split, SplitTemplate } from '@finplat/domain';
import {
  allocate,
  compare,
  convertResolved,
  createRateBook,
  fromMinor,
  negate,
  type RateSnapshot,
  sum,
  toMinor,
} from '@finplat/finance-engine';
import { invalid, ServiceError, unprocessable } from './errors.ts';

export const SPLIT_KINDS = new Set(['expense', 'income', 'refund']);

export const abs = (m: Money): Money => (toMinor(m) < 0n ? negate(m) : m);

export function posting(
  newId: () => string,
  accountId: string,
  amount: Money,
  lineNo: number,
  extra: Partial<Posting> = {},
): Posting {
  return {
    id: newId(),
    accountId,
    amount,
    originalAmount: null,
    exchangeRateId: null,
    lineNo,
    memo: '',
    ...extra,
  };
}

export interface SplitIn {
  id?: string;
  categoryId: string | null;
  amount: Money;
  description?: string;
  notes?: string;
}

export function buildSplits(
  newId: () => string,
  input: SplitIn[] | undefined,
  categoryId: string | null | undefined,
  total: Money,
): Split[] {
  const t = abs(total);
  if (!input || input.length === 0)
    return [
      {
        id: newId(),
        categoryId: categoryId ?? null,
        amount: t,
        description: '',
        notes: '',
        sortOrder: 0,
      },
    ];
  if (categoryId !== undefined) throw invalid({ splits: 'use either categoryId or splits' });
  let s = 0n;
  for (const x of input) {
    if (x.amount.currency !== t.currency) throw invalid({ splits: 'split currency must match' });
    if (toMinor(x.amount) <= 0n) throw invalid({ splits: 'split amounts must be positive' });
    s += toMinor(x.amount);
  }
  if (s !== toMinor(t))
    throw invalid({ splits: 'splits must sum exactly to the transaction amount' });
  return input.map((x, i) => ({
    id: x.id ?? newId(),
    categoryId: x.categoryId,
    amount: x.amount,
    description: x.description ?? '',
    notes: x.notes ?? '',
    sortOrder: i,
  }));
}

/** Fixed-amount lines first, the remainder by weight (largest remainder, exact). */
export function applySplitTemplate(newId: () => string, tpl: SplitTemplate, total: Money): Split[] {
  const t = abs(total);
  const weighted = tpl.lines.filter((l) => l.weight !== undefined);
  const fixed = sum(
    tpl.lines.filter((l) => l.amount).map((l) => l.amount as Money),
    t.currency,
  );
  const rest = toMinor(t) - toMinor(fixed);
  if (rest < 0n) throw unprocessable('split template fixed amounts exceed the transaction');
  if (rest > 0n && weighted.length === 0)
    throw unprocessable('split template fixed amounts do not cover the transaction');
  const parts = weighted.length
    ? allocate(
        fromMinor(rest, t.currency),
        weighted.map((l) => l.weight as string),
      )
    : [];
  const out: Split[] = [];
  for (const l of tpl.lines) {
    const amount = l.amount ?? parts[weighted.indexOf(l)];
    if (!amount || toMinor(amount) <= 0n) continue;
    out.push({
      id: newId(),
      categoryId: l.categoryId,
      amount,
      description: l.description,
      notes: '',
      sortOrder: out.length,
    });
  }
  return out;
}

export interface TransferResult {
  kind: 'transfer' | 'fx';
  postings: Posting[];
  conversion: Conversion | null;
}

/** Two legs; different currencies make it `fx` (bank_actual with toAmount, else market rate). */
export function buildTransfer(
  newId: () => string,
  src: Account,
  dst: Account,
  amount: Money,
  toAmount: Money | undefined,
  kind: string,
  bookingDate: string,
  rates: RateSnapshot[],
  fee: Money | undefined,
): TransferResult {
  let to = toAmount ?? (dst.currency === amount.currency ? amount : undefined);
  let conversion: Conversion | null = null;
  if (!to) {
    const r = createRateBook(rates).resolve(amount.currency, dst.currency, bookingDate);
    if (!r)
      throw new ServiceError(
        422,
        'rate_unavailable',
        `no ${amount.currency}/${dst.currency} rate on ${bookingDate}; send toAmount (the amount actually received)`,
      );
    to = convertResolved(amount, r);
    const method = ({ provider: 'market', manual: 'manual', fixed: 'fixed' } as const)[r.source];
    conversion = {
      from: amount,
      to,
      rate: r.rate,
      rateDate: r.rateDate,
      method,
      exchangeRateId: null,
      fee: null,
    };
  }
  if (toMinor(to) <= 0n) throw invalid({ toAmount: 'must be positive' });
  let outKind: 'transfer' | 'fx';
  if (to.currency === amount.currency) {
    if (kind === 'fx') throw invalid({ kind: 'fx needs two different currencies; use transfer' });
    if (compare(to, amount) !== 0)
      throw invalid({
        toAmount: 'a same-currency transfer moves the same amount; record the fee separately',
      });
    outKind = 'transfer';
  } else {
    outKind = 'fx';
    conversion ??= {
      from: amount,
      to,
      rate: impliedRate(amount, to),
      rateDate: bookingDate,
      method: 'bank_actual',
      exchangeRateId: null,
      fee: null,
    };
    if (fee) conversion = { ...conversion, fee };
  }
  return {
    kind: outKind,
    conversion,
    postings: [posting(newId, src.id, negate(amount), 0), posting(newId, dst.id, to, 1)],
  };
}

/** to / from with 18 fraction digits, trailing zeros trimmed (same as Go impliedRate). */
export function impliedRate(from: Money, to: Money): string {
  const f = decimalParts(from.amount);
  const t = decimalParts(to.amount);
  // (t.units / 10^t.scale) / (f.units / 10^f.scale) * 10^18
  const num = t.units * 10n ** BigInt(f.scale + 18);
  const den = f.units * 10n ** BigInt(t.scale);
  const q = num / den; // big.Rat.FloatString rounds half away from zero; amounts are positive
  const r = num % den;
  const rounded = r * 2n >= den ? q + 1n : q;
  const s = rounded.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '');
}

function decimalParts(s: string): { units: bigint; scale: number } {
  const [i, f = ''] = s.replace('-', '').split('.');
  return { units: BigInt(`${i}${f}`), scale: f.length };
}
