import {
  convertResolved,
  DEFAULT_ROUNDING,
  divRound,
  formatDecimal,
  fromMinor,
  type Money,
  pow10,
  type RateBook,
  type RoundingMode,
  rational,
  type ToReporting,
  toMinor,
} from '@finplat/finance-engine';

export {
  CURRENCY_SCALES,
  convert,
  convertInverse,
  convertResolved,
  createRateBook,
  currencyScale,
  EUR_BAM_FIXED_RATE,
  type RateBook,
  type RateSnapshot,
  type ResolvedRate,
  reportingConverter,
  type ToReporting,
} from '@finplat/finance-engine';

/**
 * Locale-aware display. Intl.NumberFormat accepts decimal strings exactly (no float conversion
 * for amounts within its 21-significant-digit display precision).
 */
export function formatMoney(m: Money, locale = 'en', opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency, ...opts }).format(
    m.amount as unknown as number, // string overload (ES2023 Intl.NumberFormat v3)
  );
}

/** Same shape as the API's ConvertResult. */
export interface ConvertResult {
  from: Money;
  to: Money;
  rate: string;
  rateDate: string;
  source: 'provider' | 'manual' | 'fixed';
  inverse: boolean;
}

/**
 * Built-in converter (feature 23). A manual `rate` (units of `to` per 1 from) overrides the book —
 * e.g. the bank's actual settlement rate (feature 20). Returns null when no rate is known.
 */
export function convertMoney(
  book: RateBook,
  m: Money,
  to: string,
  date: string,
  opts: { rate?: string; rounding?: RoundingMode } = {},
): ConvertResult | null {
  const mode = opts.rounding ?? DEFAULT_ROUNDING;
  if (opts.rate) {
    const r = rational(opts.rate);
    const res = convertResolved(
      m,
      {
        from: m.currency,
        to,
        ...r,
        rate: opts.rate,
        rateDate: date,
        source: 'manual',
        inverse: false,
        via: null,
      },
      mode,
    );
    return { from: m, to: res, rate: opts.rate, rateDate: date, source: 'manual', inverse: false };
  }
  const r = book.resolve(m.currency, to, date);
  if (!r) return null;
  return {
    from: m,
    to: convertResolved(m, r, mode),
    rate: r.rate,
    rateDate: r.rateDate,
    source: r.source,
    inverse: r.inverse,
  };
}

export interface ExposureRow {
  currency: string;
  original: Money;
  converted: Money;
  share: string; // fraction of the converted total, 4 decimals half_up
}

/**
 * Currency exposure (feature 24): balances grouped by currency, valued at `asOf` in `currency`.
 * Balances without a rate are reported in `missing` and left out of the shares.
 */
export function currencyExposure(
  balances: readonly Money[],
  currency: string,
  convert: ToReporting,
  asOf: string,
): { rows: ExposureRow[]; total: Money; missing: string[] } {
  const byCur = new Map<string, bigint>();
  for (const b of balances) byCur.set(b.currency, (byCur.get(b.currency) ?? 0n) + toMinor(b));
  const rows: Omit<ExposureRow, 'share'>[] = [];
  const missing: string[] = [];
  for (const [c, v] of [...byCur.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const original = fromMinor(v, c);
    const converted = convert(original, asOf);
    if (converted) rows.push({ currency: c, original, converted });
    else missing.push(c);
  }
  const total = rows.reduce((a, r) => a + toMinor(r.converted), 0n);
  return {
    rows: rows.map((r) => ({
      ...r,
      share:
        total === 0n
          ? '0.0000'
          : formatDecimal({
              units: divRound(toMinor(r.converted) * pow10(4), total, 'half_up'),
              scale: 4,
            }),
    })),
    total: fromMinor(total, currency),
    missing,
  };
}
