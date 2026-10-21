// Language, number/date region, date style and theme (features 103, 104). Device-level.

import { formatDate, formatMoney } from '@finplat/localization';
import { useApp } from '../app/store.ts';
import { Field, Select } from '../components/ui/index.tsx';
import { REGIONS } from '../lib/currencies.ts';
import { useT } from '../lib/i18n.ts';

export function PreferencesForm() {
  const t = useT();
  const prefs = useApp((s) => s.prefs);
  const setPrefs = useApp((s) => s.setPrefs);
  const regions = REGIONS.includes(prefs.region) ? REGIONS : [prefs.region, ...REGIONS];
  const regionName = (r: string) => {
    try {
      return new Intl.DisplayNames([prefs.language], { type: 'language' }).of(r) ?? r;
    } catch {
      return r;
    }
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label={t('settings.language', 'Language')}
        hint={t(
          'settings.languageHint',
          'Bosnian is partially translated; missing text is shown in English.',
        )}
      >
        <Select
          value={prefs.language}
          onChange={(e) => setPrefs({ language: e.target.value as 'en' | 'bs' })}
        >
          <option value="en">English</option>
          <option value="bs">Bosanski</option>
        </Select>
      </Field>
      <Field
        label={t('settings.region', 'Number and date format')}
        hint={`${formatMoney({ amount: '-1234567.89', currency: 'BAM' }, prefs.region)} · ${formatDate('2026-03-31', prefs.region, prefs.dateStyle)}`}
      >
        <Select value={prefs.region} onChange={(e) => setPrefs({ region: e.target.value })}>
          {regions.map((r) => (
            <option key={r} value={r}>
              {regionName(r)} ({r})
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('settings.dateStyle', 'Date style')}>
        <Select
          value={prefs.dateStyle}
          onChange={(e) => setPrefs({ dateStyle: e.target.value as 'short' | 'medium' | 'long' })}
        >
          <option value="short">{formatDate('2026-03-31', prefs.region, 'short')}</option>
          <option value="medium">{formatDate('2026-03-31', prefs.region, 'medium')}</option>
          <option value="long">{formatDate('2026-03-31', prefs.region, 'long')}</option>
        </Select>
      </Field>
      <Field label={t('settings.theme', 'Theme')}>
        <Select
          value={prefs.theme}
          onChange={(e) => setPrefs({ theme: e.target.value as 'light' | 'dark' | 'system' })}
        >
          <option value="system">{t('settings.themeSystem', 'System')}</option>
          <option value="light">{t('settings.themeLight', 'Light')}</option>
          <option value="dark">{t('settings.themeDark', 'Dark')}</option>
        </Select>
      </Field>
    </div>
  );
}
