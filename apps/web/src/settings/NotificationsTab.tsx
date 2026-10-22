// Notification delivery preferences (features 31, 43, 81): email (SMTP) and Web Push per type,
// quiet hours. Server-side, so connected mode only; in-app notifications work in both modes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useData } from '../app/data.tsx';
import {
  Button,
  Card,
  Checkbox,
  ErrorBox,
  Field,
  Input,
  Notice,
  Switch,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import {
  currentSubscription,
  pushSupported,
  subscribePush,
  unsubscribePush,
} from '../features/notifications/push.ts';
import { registerMessages, useT } from '../lib/i18n.ts';

registerMessages('bs', {
  'settings.notifications': 'Obavještenja',
  'notif.delivery': 'Obavještenja e-poštom i push',
  'notif.localOnly':
    'E-poštu i push obavještenja šalje server. Ovaj uređaj radi samo lokalno, pa se obavještenja prikazuju u aplikaciji (i kao obavještenja preglednika dok je otvorena).',
  'notif.channels': 'Kanali',
  'notif.email': 'Obavještenja e-poštom',
  'notif.emailTo': 'Šalje se na {{email}}',
  'notif.emailOff': 'Nije dostupno: administrator servera nije podesio SMTP.',
  'notif.testEmail': 'Pošalji probni e-mail',
  'notif.push': 'Push obavještenja',
  'notif.pushDevices': 'Pretplaćenih preglednika: {{n}}.',
  'notif.pushUnsupported': 'Ovaj preglednik ne podržava push.',
  'notif.pushThis': 'Ovaj preglednik prima push.',
  'notif.pushNotThis': 'Ovaj preglednik još ne prima push.',
  'notif.pushDisableHere': 'Isključi u ovom pregledniku',
  'notif.pushEnableHere': 'Uključi u ovom pregledniku',
  'notif.testPush': 'Pošalji probni push',
  'notif.testSent': 'Probno obavještenje poslano',
  'notif.types': 'Šta slati',
  'notif.type': 'Vrsta',
  'notif.emailShort': 'E-pošta',
  'notif.pushShort': 'Push',
  'notif.type.bills': 'Podsjetnici za račune (dospijeće, kašnjenje, kraj probnog perioda)',
  'notif.type.budgets': 'Upozorenja budžeta i prognoze niskog stanja',
  'notif.type.anomalies': 'Neuobičajeni troškovi',
  'notif.type.sync': 'Konflikti sinhronizacije',
  'notif.inAppAlways':
    'Obavještenja u aplikaciji se uvijek prikazuju; ove postavke važe samo za e-poštu i push.',
  'notif.quiet': 'Tihi sati',
  'notif.quietFrom': 'Od',
  'notif.quietTo': 'Do',
  'notif.quietClear': 'Bez tihih sati',
  'notif.quietHint': 'E-pošta i push čekaju kraj tihih sati (vremenska zona vašeg računa).',
});

type Channel = {
  enabled: boolean;
  bills: boolean;
  budgets: boolean;
  anomalies: boolean;
  sync: boolean;
};
type Prefs = {
  email: Channel;
  push: Channel;
  quietHoursStart: string;
  quietHoursEnd: string;
};
type PrefsOut = Prefs & {
  emailConfigured: boolean;
  emailAddress: string;
  pushPublicKey: string;
  pushSubscriptions: number;
};
const TYPES = ['bills', 'budgets', 'anomalies', 'sync'] as const;
const KEY = ['server', 'notification-preferences'];

export function NotificationsTab() {
  const t = useT();
  const { api } = useData();
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: KEY,
    enabled: !!api,
    queryFn: () =>
      api?.request<PrefsOut>('GET', '/api/v1/notifications/preferences') ?? Promise.reject(),
  });
  const device = useQuery({
    queryKey: ['push-subscription'],
    queryFn: async () => !!(await currentSubscription()),
  });
  const [form, setForm] = useState<Prefs | null>(null);
  useEffect(() => {
    if (prefs.data) setForm(prefs.data);
  }, [prefs.data]);

  const save = useMutation({
    mutationFn: (p: Prefs) =>
      api?.request<Prefs>('PUT', '/api/v1/notifications/preferences', {
        email: p.email,
        push: p.push,
        quietHoursStart: p.quietHoursStart,
        quietHoursEnd: p.quietHoursEnd,
      }) ?? Promise.resolve(p),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast(t('settings.saved', 'Saved'));
    },
  });
  const thisDevice = useMutation({
    mutationFn: async (on: boolean) => {
      if (!api || !prefs.data) return;
      if (on) await subscribePush(api, prefs.data.pushPublicKey);
      else await unsubscribePush(api);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['push-subscription'] });
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const test = useMutation({
    mutationFn: (channel: 'email' | 'push') =>
      api?.request('POST', '/api/v1/notifications/test', { channel }) ?? Promise.resolve(),
    onSuccess: () => toast(t('notif.testSent', 'Test notification sent')),
  });

  if (!api)
    return (
      <Card title={t('notif.delivery', 'Email and push notifications')}>
        <Notice>
          {t(
            'notif.localOnly',
            'Email and push delivery are sent by a server. This device works in local-only mode, so notifications appear in the app (and as browser notifications while it is open).',
          )}{' '}
          <Link className="underline" to="/settings?tab=connection">
            {t('settings.connect', 'Connect to server')}
          </Link>
        </Notice>
      </Card>
    );
  if (prefs.error) return <ErrorBox error={prefs.error} />;
  if (!form || !prefs.data) return null;
  const info = prefs.data;
  const set = (ch: 'email' | 'push', k: keyof Channel, v: boolean) =>
    setForm({ ...form, [ch]: { ...form[ch], [k]: v } });
  const label: Record<(typeof TYPES)[number], string> = {
    bills: t('notif.type.bills', 'Bill reminders (due, overdue, trials ending)'),
    budgets: t('notif.type.budgets', 'Budget alerts and low balance forecasts'),
    anomalies: t('notif.type.anomalies', 'Unusual expenses'),
    sync: t('notif.type.sync', 'Sync conflicts'),
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
    >
      <Card title={t('notif.channels', 'Channels')}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              label={t('notif.email', 'Email notifications')}
              checked={form.email.enabled}
              disabled={!info.emailConfigured}
              onChange={(v) => set('email', 'enabled', v)}
            />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{t('notif.email', 'Email notifications')}</p>
              <p className="text-xs text-muted">
                {info.emailConfigured
                  ? t('notif.emailTo', 'Sent to {{email}}', { email: info.emailAddress })
                  : t(
                      'notif.emailOff',
                      'Not available: the server administrator has not configured SMTP.',
                    )}
              </p>
            </div>
            <Button
              size="sm"
              disabled={!info.emailConfigured || test.isPending}
              onClick={() => test.mutate('email')}
            >
              {t('notif.testEmail', 'Send test email')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              label={t('notif.push', 'Push notifications')}
              checked={form.push.enabled}
              onChange={(v) => set('push', 'enabled', v)}
            />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{t('notif.push', 'Push notifications')}</p>
              <p className="text-xs text-muted">
                {t('notif.pushDevices', '{{n}} browser(s) subscribed.', {
                  n: String(info.pushSubscriptions),
                })}{' '}
                {!pushSupported()
                  ? t('notif.pushUnsupported', 'This browser does not support push.')
                  : device.data
                    ? t('notif.pushThis', 'This browser receives push.')
                    : t('notif.pushNotThis', 'This browser does not receive push yet.')}
              </p>
            </div>
            {pushSupported() && (
              <Button
                size="sm"
                busy={thisDevice.isPending}
                onClick={() => thisDevice.mutate(!device.data)}
              >
                {device.data
                  ? t('notif.pushDisableHere', 'Stop on this browser')
                  : t('notif.pushEnableHere', 'Enable on this browser')}
              </Button>
            )}
            <Button
              size="sm"
              disabled={info.pushSubscriptions === 0 || test.isPending}
              onClick={() => test.mutate('push')}
            >
              {t('notif.testPush', 'Send test push')}
            </Button>
          </div>
          <ErrorBox error={thisDevice.error ?? test.error} />
        </div>
      </Card>

      <Card title={t('notif.types', 'What to send')}>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className="text-left">{t('notif.type', 'Type')}</th>
              <th>{t('notif.emailShort', 'Email')}</th>
              <th>{t('notif.pushShort', 'Push')}</th>
            </tr>
          </thead>
          <tbody>
            {TYPES.map((k) => (
              <tr key={k}>
                <td>{label[k]}</td>
                {(['email', 'push'] as const).map((ch) => (
                  <td key={ch} className="text-center">
                    <Checkbox
                      className="justify-center"
                      label={<span className="sr-only">{`${label[k]} — ${ch}`}</span>}
                      checked={form[ch][k]}
                      disabled={!form[ch].enabled}
                      onChange={(e) => set(ch, k, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">
          {t(
            'notif.inAppAlways',
            'In-app notifications are always shown; these settings only control email and push.',
          )}
        </p>
      </Card>

      <Card title={t('notif.quiet', 'Quiet hours')}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('notif.quietFrom', 'From')}>
            <Input
              type="time"
              value={form.quietHoursStart}
              onChange={(e) => setForm({ ...form, quietHoursStart: e.target.value })}
            />
          </Field>
          <Field label={t('notif.quietTo', 'Until')}>
            <Input
              type="time"
              value={form.quietHoursEnd}
              onChange={(e) => setForm({ ...form, quietHoursEnd: e.target.value })}
            />
          </Field>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setForm({ ...form, quietHoursStart: '', quietHoursEnd: '' })}
          >
            {t('notif.quietClear', 'No quiet hours')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          {t(
            'notif.quietHint',
            'Email and push wait until quiet hours end (your account time zone).',
          )}
        </p>
      </Card>

      <div>
        <Button type="submit" variant="primary" busy={save.isPending}>
          {t('common.save', 'Save')}
        </Button>
        <ErrorBox error={save.error} />
      </div>
    </form>
  );
}
