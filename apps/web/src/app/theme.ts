import { useEffect } from 'react';
import { type Theme, useApp } from './store.ts';

export function resolveTheme(t: Theme, prefersDark: boolean): 'light' | 'dark' {
  return t === 'system' ? (prefersDark ? 'dark' : 'light') : t;
}

/** Keeps <html class="dark"> and <html lang> in sync with the preferences. */
export function useThemeAndLang() {
  const theme = useApp((s) => s.prefs.theme);
  const lang = useApp((s) => s.prefs.language);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle(
        'dark',
        resolveTheme(theme, mq?.matches ?? false) === 'dark',
      );
    apply();
    mq?.addEventListener('change', apply);
    return () => mq?.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
}
