// i18n (i18next) + exact locale formatting (format.ts). English is the source catalog; Bosnian
// (bs) is a skeleton that falls back to English. Add a language: copy locales/bs.ts, register it
// in CATALOGS. The web app can wrap `createI18n()` with react-i18next if it wants hooks.
import i18next, { type i18n, type TOptions } from 'i18next';
import { bs } from './locales/bs.ts';
import { type Catalog, en, type MessageKey } from './locales/en.ts';

export * from './format.ts';
export type { Catalog, MessageKey };
export { bs, en };
/** Message keys plus plural bases ("sync.pending" for sync.pending_one/_other). */
export type TKey =
  | MessageKey
  | (MessageKey extends infer K ? (K extends `${infer B}_one` ? B : never) : never);

export const CATALOGS: Record<string, Catalog> = { en, bs };
export const SUPPORTED_LOCALES = Object.keys(CATALOGS);

/** Best supported language for a BCP 47 tag ("bs-BA" -> "bs", "de" -> "en"). */
export function resolveLanguage(locale: string | undefined): string {
  const base = (locale ?? 'en').toLowerCase().split('-')[0] ?? 'en';
  return base in CATALOGS ? base : 'en';
}

/** A ready (synchronously initialized) i18next instance. */
export function createI18n(locale = 'en'): i18n {
  const inst = i18next.createInstance();
  void inst.init({
    lng: resolveLanguage(locale),
    fallbackLng: 'en',
    resources: Object.fromEntries(
      Object.entries(CATALOGS).map(([k, v]) => [k, { translation: v }]),
    ),
    keySeparator: false, // keys are flat ("nav.dashboard")
    nsSeparator: false,
    interpolation: { escapeValue: false }, // React escapes
    initAsync: false,
  });
  return inst;
}

const instances = new Map<string, i18n>();

/** Translate with a cached instance per language. */
export function t(key: TKey, locale = 'en', vars?: TOptions): string {
  const lang = resolveLanguage(locale);
  let inst = instances.get(lang);
  if (!inst) {
    inst = createI18n(lang);
    instances.set(lang, inst);
  }
  return inst.t(key, vars ?? {});
}

/** Message for an API/local error code, falling back to the generic one. */
export function errorMessage(code: string, locale = 'en', message = ''): string {
  const key = `error.${code}` as MessageKey;
  return key in en ? t(key, locale, { message }) : t('error.unknown', locale);
}
