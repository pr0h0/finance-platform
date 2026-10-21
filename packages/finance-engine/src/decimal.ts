// Exact decimal arithmetic on bigint. A decimal is units * 10^-scale.
// Algorithm must match apps/api/internal/money (shared conformance fixtures).

export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up' | 'floor' | 'ceiling';
export const ROUNDING_MODES: readonly RoundingMode[] = [
  'half_up',
  'half_even',
  'down',
  'up',
  'floor',
  'ceiling',
];

export interface Dec {
  units: bigint;
  scale: number;
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function parseDecimal(s: string): Dec {
  if (typeof s !== 'string' || !DECIMAL_RE.test(s)) {
    throw new Error(`invalid decimal string: ${JSON.stringify(s)}`);
  }
  const dot = s.indexOf('.');
  const scale = dot < 0 ? 0 : s.length - dot - 1;
  return { units: BigInt(s.replace('.', '')), scale };
}

export function isDecimalString(s: unknown): s is string {
  return typeof s === 'string' && DECIMAL_RE.test(s);
}

export const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Rescale exactly (only upward; throws if digits would be lost). */
export function rescale(d: Dec, scale: number): Dec {
  if (scale >= d.scale) return { units: d.units * pow10(scale - d.scale), scale };
  const f = pow10(d.scale - scale);
  if (d.units % f !== 0n)
    throw new Error(`cannot rescale ${formatDecimal(d)} to ${scale} without rounding`);
  return { units: d.units / f, scale };
}

export function formatDecimal(d: Dec): string {
  const neg = d.units < 0n;
  let digits = (neg ? -d.units : d.units).toString();
  if (d.scale > 0) {
    digits = digits.padStart(d.scale + 1, '0');
    digits = `${digits.slice(0, -d.scale)}.${digits.slice(-d.scale)}`;
  }
  return neg && d.units !== 0n ? `-${digits}` : digits;
}

/** Integer quotient num/den rounded with `mode`. den must be non-zero. Exact. */
export function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den === 0n) throw new Error('division by zero');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const q = num / den; // truncates toward zero
  const r = num % den; // sign of num
  if (r === 0n) return q;
  const sign = num < 0n ? -1n : 1n;
  const twice = 2n * (r < 0n ? -r : r);
  switch (mode) {
    case 'down':
      return q;
    case 'up':
      return q + sign;
    case 'floor':
      return sign < 0n ? q - 1n : q;
    case 'ceiling':
      return sign > 0n ? q + 1n : q;
    case 'half_up':
      return twice >= den ? q + sign : q;
    case 'half_even':
      if (twice > den) return q + sign;
      if (twice < den) return q;
      return q % 2n === 0n ? q : q + sign;
  }
}

/** Round a decimal string to `scale` fraction digits. */
export function roundDecimal(value: string, scale: number, mode: RoundingMode): string {
  const d = parseDecimal(value);
  if (d.scale <= scale) return formatDecimal(rescale(d, scale));
  return formatDecimal({ units: divRound(d.units, pow10(d.scale - scale), mode), scale });
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const s = Math.max(x.scale, y.scale);
  const d = rescale(x, s).units - rescale(y, s).units;
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}
