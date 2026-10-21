import { currencyScale } from './currencies.ts';
import {
  type Dec,
  divRound,
  formatDecimal,
  parseDecimal,
  pow10,
  type RoundingMode,
  rescale,
} from './decimal.ts';

/**
 * Authoritative money representation across the platform:
 * `amount` is a decimal string with exactly the currency's minor-unit scale
 * ("150.00" BAM, "100" JPY, "1.250" KWD); `currency` is an ISO 4217 code.
 */
export interface Money {
  amount: string;
  currency: string;
}

export const DEFAULT_ROUNDING: RoundingMode = 'half_up';

function scaleOf(currency: string): number {
  const s = currencyScale(currency);
  if (s === undefined) throw new Error(`unknown currency: ${currency}`);
  return s;
}

/** Validates and normalizes. Rejects more fraction digits than the currency allows. */
export function money(amount: string, currency: string): Money {
  const scale = scaleOf(currency);
  // rescale throws when digits would be lost ("1.505" EUR); trailing zeros are fine.
  return { amount: formatDecimal(rescale(parseDecimal(amount), scale)), currency };
}

export function toMinor(m: Money): bigint {
  return rescale(parseDecimal(m.amount), scaleOf(m.currency)).units;
}

export function fromMinor(units: bigint, currency: string): Money {
  return { amount: formatDecimal({ units, scale: scaleOf(currency) }), currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency)
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return fromMinor(toMinor(a) + toMinor(b), a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return fromMinor(toMinor(a) - toMinor(b), a.currency);
}

export const negate = (a: Money): Money => fromMinor(-toMinor(a), a.currency);
export const isZero = (a: Money): boolean => toMinor(a) === 0n;
export const isNegative = (a: Money): boolean => toMinor(a) < 0n;
export const compare = (a: Money, b: Money): -1 | 0 | 1 => {
  sameCurrency(a, b);
  const d = toMinor(a) - toMinor(b);
  return d === 0n ? 0 : d < 0n ? -1 : 1;
};

export function sum(items: readonly Money[], currency: string): Money {
  let t = 0n;
  for (const m of items) {
    if (m.currency !== currency) throw new Error(`currency mismatch: ${m.currency} vs ${currency}`);
    t += toMinor(m);
  }
  return fromMinor(t, currency);
}

/** amount * factor, rounded once to the currency scale. */
export function multiply(m: Money, factor: string, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  const a = parseDecimal(m.amount);
  const f = parseDecimal(factor);
  const scale = scaleOf(m.currency);
  return fromMinor(divRound(a.units * f.units, pow10(a.scale + f.scale - scale), mode), m.currency);
}

/** Convert with `rate` = units of `to` per 1 unit of m.currency. Rounded once to `to` scale. */
export function convert(
  m: Money,
  to: string,
  rate: string,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  return multiply({ amount: m.amount, currency: to }, rate, mode);
}

/** Convert with `rate` quoted the other way (units of m.currency per 1 `to`), i.e. amount / rate. */
export function convertInverse(
  m: Money,
  to: string,
  rate: string,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  const a = parseDecimal(m.amount);
  const r: Dec = parseDecimal(rate);
  if (r.units === 0n) throw new Error('rate must be non-zero');
  const scale = scaleOf(to);
  // result units = a.units * 10^-a.scale / (r.units * 10^-r.scale) * 10^scale
  const num = a.units * pow10(r.scale + scale);
  const den = r.units * pow10(a.scale);
  return fromMinor(divRound(num, den, mode), to);
}

/**
 * Split `m` across non-negative `weights` (decimal strings) with the largest-remainder method.
 * Parts always sum exactly to `m`. Remainder minor units go to the largest fractional
 * remainders; ties go to the lower index. Negative totals are allocated by magnitude.
 */
export function allocate(m: Money, weights: readonly string[]): Money[] {
  if (weights.length === 0) throw new Error('allocate: no weights');
  const ws = weights.map(parseDecimal);
  if (ws.some((w) => w.units < 0n)) throw new Error('allocate: negative weight');
  const s = Math.max(...ws.map((w) => w.scale));
  const iw = ws.map((w) => rescale(w, s).units);
  const total = iw.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new Error('allocate: weights sum to zero');
  const t = toMinor(m);
  const sign = t < 0n ? -1n : 1n;
  const abs = t * sign;
  const parts = iw.map((w) => (abs * w) / total);
  const rems = iw.map((w, i) => ({ i, r: (abs * w) % total }));
  let left = abs - parts.reduce((a, b) => a + b, 0n);
  rems.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
  for (const { i } of rems) {
    if (left === 0n) break;
    parts[i] = (parts[i] ?? 0n) + 1n; // left < parts.length, so one pass suffices
    left--;
  }
  return parts.map((p) => fromMinor(p * sign, m.currency));
}

export const splitEvenly = (m: Money, n: number): Money[] => allocate(m, Array(n).fill('1'));
