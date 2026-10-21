// ISO 4217 codes from the browser (Intl), common ones first.
const COMMON = [
  'BAM',
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'RSD',
  'HRK',
  'TRY',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
];

export function currencyCodes(): string[] {
  let all: string[] = [];
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'currency',
      ) ?? [];
  } catch {
    all = [];
  }
  const common = COMMON.filter((c) => c !== 'HRK');
  return [...common, ...all.filter((c) => !common.includes(c))];
}

export function currencyName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Regions offered for number/date formatting. */
export const REGIONS = [
  'bs-BA',
  'hr-HR',
  'sr-Latn-RS',
  'en-US',
  'en-GB',
  'de-DE',
  'de-AT',
  'de-CH',
  'fr-FR',
  'it-IT',
  'es-ES',
  'nl-NL',
  'sv-SE',
  'pl-PL',
  'tr-TR',
];
