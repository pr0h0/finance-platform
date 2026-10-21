import type { Money } from '@finplat/domain';

export {
  CURRENCY_SCALES,
  convert,
  convertInverse,
  currencyScale,
  EUR_BAM_FIXED_RATE,
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
