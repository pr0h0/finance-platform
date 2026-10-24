// UI translation: t(key, englishText, vars). English text lives next to the code that uses it
// (it is the source catalog); other languages register messages by key. Lookup order: app
// messages for the language, @finplat/localization catalogs, then the English text.
// Interpolation: {{name}}.
import { CATALOGS, errorMessage } from '@finplat/localization';
import { useCallback } from 'react';
import { type Language, useApp } from '../app/store.ts';
import { bs } from './messages.bs.ts';

const messages: Record<string, Record<string, string>> = { bs: { ...bs } };

/** Add translations for a language (feature modules can call this at import time). */
export function registerMessages(lang: Language, m: Record<string, string>) {
  messages[lang] = { ...messages[lang], ...m };
}

export type TFn = (key: string, en: string, vars?: Record<string, string | number>) => string;

export function translate(
  lang: string,
  key: string,
  en: string,
  vars?: Record<string, string | number>,
): string {
  const pkg = CATALOGS[lang] as Record<string, string> | undefined;
  const s = messages[lang]?.[key] ?? (lang === 'en' ? undefined : pkg?.[key]) ?? en;
  return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? '')) : s;
}

export function useT(): TFn {
  const lang = useApp((s) => s.prefs.language);
  return useCallback((key, en, vars) => translate(lang, key, en, vars), [lang]);
}

/** translate() in the current UI language, for code outside components (validation, helpers). */
export const tNow: TFn = (key, en, vars) =>
  translate(useApp.getState().prefs.language, key, en, vars);

/** Readable message for an ApiError/ServiceError/Error in the UI language. */
export function errorText(e: unknown, lang = useApp.getState().prefs.language): string {
  const err = e as { code?: string; message?: string; status?: number; details?: unknown } | null;
  if (!err) return '';
  if (err.code) {
    const details = err.details as
      | { fields?: Record<string, string>; fieldCodes?: Record<string, FieldCode> }
      | undefined;
    const fields = details?.fields;
    const base = errorMessage(err.code, lang, err.message ?? '');
    // App-side codes (import worker): translated by `error.<code>` with the thrown English as default.
    if (base === errorMessage('unknown', lang) && err.message)
      return messages[lang]?.[`error.${err.code}`] ?? err.message;
    if (fields && Object.keys(fields).length)
      return `${base} ${Object.entries(fields)
        .map(([k, v]) => `${k}: ${fieldText(lang, v, details?.fieldCodes?.[k])}`)
        .join('; ')}`;
    return base;
  }
  return err.message ?? String(e);
}

type FieldCode = { code: string; params?: Record<string, string> };

// API details.fieldCodes (apps/api/internal/httpx fieldRules); unknown codes keep the server's message.
const FIELD_TEXT: Record<string, (t: TFn, p: Record<string, string>) => string> = {
  required: (t) => t('error.field.required', 'required'),
  required_max_length: (t, p) =>
    t('error.field.required_max_length', 'required, at most {{max}} characters', p),
  max_length: (t, p) => t('error.field.max_length', 'at most {{max}} characters', p),
  length: (t, p) => t('error.field.length', '{{min}}-{{max}} characters', p),
  too_long: (t) => t('error.field.too_long', 'too long'),
  too_large: (t) => t('error.field.too_large', 'too large'),
  invalid_id: (t) => t('error.field.invalid_id', 'invalid id'),
  invalid_date: (t) => t('error.field.invalid_date', 'expected a date (YYYY-MM-DD)'),
  unknown_currency: (t) => t('error.field.unknown_currency', 'unknown currency'),
  positive: (t) => t('error.field.positive', 'must be positive'),
  not_zero: (t) => t('error.field.not_zero', 'must not be zero'),
  invalid_decimal: (t) => t('error.field.invalid_decimal', 'expected a number'),
  invalid_email: (t) => t('error.field.invalid_email', 'invalid email address'),
  unknown_reference: (t) => t('error.field.unknown_reference', 'not found'),
  not_before: (t, p) => t('error.field.not_before', 'must not be before {{other}}', p),
  future: (t) => t('error.field.future', 'must be in the future'),
  max_days: (t, p) => t('error.field.max_days', 'range is limited to {{max}} days', p),
  invalid_timezone: (t) => t('error.field.invalid_timezone', 'unknown time zone'),
  invalid_locale: (t) => t('error.field.invalid_locale', 'invalid language'),
  one_of: (t, p) => t('error.field.one_of', 'one of: {{options}}', p),
};

function fieldText(lang: string, message: string, c: FieldCode | undefined): string {
  const f = c && FIELD_TEXT[c.code];
  return f ? f((k, en, v) => translate(lang, k, en, v), c.params ?? {}) : message;
}
