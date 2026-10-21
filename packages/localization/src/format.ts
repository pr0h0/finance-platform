// Locale-aware display of exact values. Money and decimals are never converted to floats: the
// locale's pattern comes from Intl, the digits come from the decimal string.
export interface MoneyLike {
  amount: string; // decimal string at currency scale
  currency: string;
}

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, o: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${locale}|${JSON.stringify(o)}`;
  let f = nfCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat(locale, o);
    nfCache.set(k, f);
  }
  return f;
}

function split(value: string): { neg: boolean; int: bigint; frac: string } {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal string: ${value}`);
  return {
    neg: m[1] === '-' && /[1-9]/.test(`${m[2]}${m[3] ?? ''}`),
    int: BigInt(m[2] as string),
    frac: m[3] ?? '',
  };
}

function render(value: string, locale: string, o: Intl.NumberFormatOptions): string {
  const { neg, int, frac } = split(value);
  const digits = Math.max(frac.length, o.minimumFractionDigits ?? 0);
  const f = nf(locale, { ...o, minimumFractionDigits: digits, maximumFractionDigits: digits });
  // locale pattern (sign, currency, separators) from a placeholder; exact digits from the string
  const template = f.formatToParts(neg ? -1n : 1n);
  const intParts = nf(locale, { ...o, minimumFractionDigits: 0, maximumFractionDigits: 0 })
    .formatToParts(int)
    .filter((p) => p.type === 'integer' || p.type === 'group');
  let out = '';
  let intDone = false;
  for (const p of template) {
    if (p.type === 'integer' || p.type === 'group') {
      if (!intDone) out += intParts.map((x) => x.value).join('');
      intDone = true;
    } else if (p.type === 'fraction') out += frac.padEnd(digits, '0');
    else out += p.value;
  }
  return out;
}

/** "1.234,56 KM" (bs-BA), "BAM 1,234.56" (en-US). Exact for any magnitude. */
export function formatMoney(
  m: MoneyLike,
  locale = 'en',
  opts: {
    display?: 'symbol' | 'code' | 'name' | 'narrowSymbol';
    signDisplay?: 'auto' | 'always' | 'exceptZero';
  } = {},
): string {
  return render(m.amount, locale, {
    style: 'currency',
    currency: m.currency,
    currencyDisplay: opts.display ?? 'symbol',
    signDisplay: opts.signDisplay ?? 'auto',
  });
}

/** Decimal string with locale separators, keeping all given fraction digits. */
export function formatDecimal(value: string, locale = 'en', minFractionDigits = 0): string {
  return render(value, locale, { style: 'decimal', minimumFractionDigits: minFractionDigits });
}

/** Ratio as percent ("0.8234" -> "82.3%"); display only, ratios are not money. */
export function formatPercent(fraction: string, locale = 'en', fractionDigits = 1): string {
  return nf(locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Number(fraction));
}

/** Local calendar date "YYYY-MM-DD" rendered without any timezone shift. */
export function formatDate(
  isoDate: string,
  locale = 'en',
  style: 'short' | 'medium' | 'long' | 'full' = 'medium',
): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`not an ISO date: ${isoDate}`);
  return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: 'UTC' }).format(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  );
}

/** Instant in the profile's timezone. */
export function formatDateTime(instant: string, locale = 'en', timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(instant));
}

/** Month label for analytics axes ("2026-03" -> "Mar 2026"). */
export function formatMonth(yearMonth: string, locale = 'en'): string {
  const [y, mo] = yearMonth.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(y, mo - 1, 1));
}

/** Parse what a user typed in their locale ("1.234,56" in bs) into a plain decimal string. */
export function parseDecimalInput(input: string, locale = 'en'): string | null {
  const parts = nf(locale, { style: 'decimal' }).formatToParts(12345.6);
  const group = parts.find((p) => p.type === 'group')?.value ?? ',';
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  let s = input.trim().replace(/[\s  ]/g, '');
  if (group !== decimal) s = s.split(group).join('');
  s = s.replace(decimal, '.').replace(/^\+/, '').replace(/^−/, '-');
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}
