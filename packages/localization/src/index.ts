// Message catalogs. English is the source; Bosnian (bs) and others are added as new catalogs
// with the same keys. Formatting of numbers/dates/money uses Intl with the profile locale.
export const en = {
  'app.name': 'Finance Platform',
  'mode.local': 'Local only',
  'mode.connect': 'Connect to server',
} as const;

export type MessageKey = keyof typeof en;
export type Catalog = Partial<Record<MessageKey, string>>;

const catalogs: Record<string, Catalog> = { en };

export function registerCatalog(locale: string, c: Catalog): void {
  catalogs[locale] = c;
}

export function t(key: MessageKey, locale = 'en'): string {
  return catalogs[locale]?.[key] ?? catalogs[locale.split('-')[0] ?? 'en']?.[key] ?? en[key];
}
