import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useData, useProfile } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import { Button, Card, ErrorBox, Field, Select } from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { currencyCodes, currencyName } from '../lib/currencies.ts';
import { useT } from '../lib/i18n.ts';
import { PreferencesForm } from './PreferencesForm.tsx';

export function GeneralTab() {
  const t = useT();
  const profile = useProfile();
  const { updateProfile } = useData();
  const lang = useApp((s) => s.prefs.language);
  const [currency, setCurrency] = useState(profile.baseCurrency);
  const save = useMutation({
    mutationFn: () => updateProfile({ baseCurrency: currency }),
    onSuccess: () => toast(t('settings.saved', 'Saved')),
  });
  const readOnly = profile.role === 'viewer';
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('settings.display', 'Display (this device)')}>
        <PreferencesForm />
      </Card>
      <Card
        title={t('settings.reporting', 'Reporting currency of “{{name}}”', { name: profile.name })}
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label={t('settings.reportingLabel', 'Reporting currency')}
            hint={t(
              'settings.reportingHint',
              'Totals, budgets and analytics are converted to this currency with historical exchange rates. Account currencies do not change.',
            )}
            className="min-w-64 flex-1"
          >
            <Select
              value={currency}
              disabled={readOnly}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {currencyCodes().map((c) => (
                <option key={c} value={c}>
                  {c} — {currencyName(c, lang)}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={readOnly || currency === profile.baseCurrency}
            onClick={() => save.mutate()}
          >
            {t('common.save', 'Save')}
          </Button>
        </div>
        <div className="mt-2">
          <ErrorBox error={save.error} />
        </div>
      </Card>
    </div>
  );
}
