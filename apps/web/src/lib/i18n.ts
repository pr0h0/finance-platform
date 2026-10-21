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

/** Readable message for an ApiError/ServiceError/Error in the UI language. */
export function errorText(e: unknown, lang = useApp.getState().prefs.language): string {
  const err = e as { code?: string; message?: string; status?: number; details?: unknown } | null;
  if (!err) return '';
  if (err.code) {
    const fields = (err.details as { fields?: Record<string, string> } | undefined)?.fields;
    const base = errorMessage(err.code, lang, err.message ?? '');
    if (base === errorMessage('unknown', lang) && err.message) return err.message;
    if (fields && Object.keys(fields).length)
      return `${base} ${Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')}`;
    return base;
  }
  return err.message ?? String(e);
}
