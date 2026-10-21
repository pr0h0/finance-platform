// Feature 92: multiple independent financial profiles (create, switch, rename, delete on server).
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  cx,
  ErrorBox,
  Field,
  Input,
  Select,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { currencyCodes } from '../lib/currencies.ts';
import { useT } from '../lib/i18n.ts';

export function ProfilesTab() {
  const t = useT();
  const { profiles, profile, ds, api, refreshProfiles, updateProfile } = useData();
  const setApp = useApp((s) => s.set);
  const region = useApp((s) => s.prefs.region);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(profile?.baseCurrency ?? 'BAM');
  const [rename, setRename] = useState(profile?.name ?? '');
  const [del, setDel] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      if (!ds) throw new Error('no data source');
      const p = await ds.createProfile({
        name: name.trim(),
        baseCurrency: currency,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: region,
        weekStart: 1,
      });
      await refreshProfiles();
      return p;
    },
    onSuccess: (p) => {
      setName('');
      setApp({ profileId: p.id });
      toast(t('profiles.created', 'Profile created and selected'));
    },
  });
  const doRename = useMutation({
    mutationFn: () => updateProfile({ name: rename.trim() }),
    onSuccess: () => toast(t('settings.saved', 'Saved')),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api?.request('DELETE', `/api/v1/profiles/${id}`);
      await refreshProfiles();
    },
    onSuccess: () => {
      setDel(null);
      toast(t('profiles.deleted', 'Profile deleted on the server'));
    },
  });
  const target = profiles.find((p) => p.id === del);

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('profiles.list', 'Your profiles')}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th>{t('profiles.name', 'Name')}</th>
                <th>{t('profiles.currency', 'Currency')}</th>
                <th>{t('profiles.access', 'Access')}</th>
                <th>
                  <span className="sr-only">{t('common.actions', 'Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className={cx(p.id === profile?.id && 'bg-surface-2')}>
                  <td>
                    {p.name}{' '}
                    {p.id === profile?.id && (
                      <Badge tone="accent">{t('profiles.active', 'active')}</Badge>
                    )}
                  </td>
                  <td>{p.baseCurrency}</td>
                  <td className="space-x-1">
                    {p.role && <Badge>{p.role}</Badge>}
                    {p.privacyMode === 'e2ee' && <Badge tone="accent">E2EE</Badge>}
                    {p.householdId && <Badge>{t('profiles.household', 'household')}</Badge>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {p.id !== profile?.id && (
                      <Button size="sm" onClick={() => setApp({ profileId: p.id })}>
                        {t('profiles.switch', 'Switch')}
                      </Button>
                    )}
                    {api && p.role === 'owner' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-neg"
                        onClick={() => setDel(p.id)}
                      >
                        {t('common.delete', 'Delete')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!api && (
          <p className="mt-2 text-xs text-muted">
            {t(
              'profiles.localNote',
              'Local profiles live in this browser only. Back them up from Backups & data.',
            )}
          </p>
        )}
      </Card>

      {profile && profile.role !== 'viewer' && (
        <Card title={t('profiles.renameTitle', 'Rename “{{name}}”', { name: profile.name })}>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              doRename.mutate();
            }}
          >
            <Field label={t('profiles.name', 'Name')} className="flex-1">
              <Input
                required
                maxLength={200}
                value={rename}
                onChange={(e) => setRename(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              busy={doRename.isPending}
              disabled={!rename.trim() || rename === profile.name}
            >
              {t('common.save', 'Save')}
            </Button>
          </form>
          <div className="mt-2">
            <ErrorBox error={doRename.error} />
          </div>
        </Card>
      )}

      <Card title={t('profiles.new', 'New profile')}>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('profiles.name', 'Name')}>
            <Input
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t('profiles.currency', 'Currency')}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencyCodes().map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" busy={create.isPending}>
            {t('common.add', 'Add')}
          </Button>
        </form>
        <div className="mt-2">
          <ErrorBox error={create.error} />
        </div>
      </Card>

      <ConfirmDialog
        open={!!target}
        onOpenChange={(o) => {
          if (!o) {
            setDel(null);
            setConfirmName('');
          }
        }}
        title={t('profiles.deleteTitle', 'Delete “{{name}}” on the server?', {
          name: target?.name ?? '',
        })}
        confirmLabel={t('common.delete', 'Delete')}
        danger
        busy={remove.isPending}
        onConfirm={() => target && confirmName === target.name && remove.mutate(target.id)}
      >
        <p>
          {t(
            'profiles.deleteText',
            'The profile and its data are removed from the server for every member. Copies already on devices are not deleted. Type the profile name to confirm.',
          )}
        </p>
        <Input
          className="mt-2"
          aria-label={t('profiles.name', 'Name')}
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
        />
        <div className="mt-2">
          <ErrorBox error={remove.error} />
        </div>
      </ConfirmDialog>
    </div>
  );
}
