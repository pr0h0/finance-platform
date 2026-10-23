// First-launch wizard (PLAN §36, feature 106): welcome → language/region → primary currency →
// mode (local / connect) → local profile or server sign-in → initial accounts with optional
// opening balances → default categories → optional import → dashboard. Optional steps can be
// skipped; nothing is pre-filled with sample data. Step state lives outside the component
// because the DataProvider remounts its children when the mode changes.
import type * as D from '@finplat/domain';
import { ACCOUNT_TYPES } from '@finplat/domain';
import { money } from '@finplat/finance-engine';
import { LocalDataSource, requestPersistence, storageEstimate } from '@finplat/storage';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Cloud, HardDrive } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { create } from 'zustand';
import { qk, useData, useFinance } from '../app/data.tsx';
import { storeNameFor, useApp } from '../app/store.ts';
import {
  Badge,
  Button,
  Checkbox,
  cx,
  ErrorBox,
  Field,
  Input,
  Notice,
  Select,
  tableClass,
} from '../components/ui/index.tsx';
import { currencyCodes, currencyName } from '../lib/currencies.ts';
import { formatBytes, todayIso, useFormat } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { fetchServerStatus } from '../lib/server-status.ts';
import { isNative } from '../platform/native.ts';
import { openStore } from '../platform/store.ts';
import { PreferencesForm } from '../settings/PreferencesForm.tsx';
import { AuthStep, ServerStep, type VerifiedServer } from './connect.tsx';
import { seedLocalCategories } from './defaults.ts';

type Step =
  | 'welcome'
  | 'region'
  | 'currency'
  | 'mode'
  | 'local-profile'
  | 'server'
  | 'auth'
  | 'server-profile'
  | 'accounts'
  | 'categories'
  | 'import';

const ORDER: Step[] = [
  'welcome',
  'region',
  'currency',
  'mode',
  'local-profile',
  'accounts',
  'categories',
  'import',
];

export const useWizard = create<{ step: Step; currency: string; server: VerifiedServer | null }>(
  () => ({
    step: 'welcome',
    currency: 'BAM',
    server: null,
  }),
);
const go = (step: Step) => useWizard.setState({ step });

function Frame({
  step,
  title,
  description,
  children,
  footer,
}: {
  step: Step;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  const idx = ORDER.indexOf(
    step === 'server' || step === 'auth' || step === 'server-profile' ? 'local-profile' : step,
  );
  return (
    <main
      id="main"
      className="flex min-h-dvh items-start justify-center px-4 py-8 pt-[max(2rem,env(safe-area-inset-top))] sm:items-center"
    >
      <section
        aria-labelledby="onb-title"
        className="w-full max-w-xl rounded-lg border border-line bg-surface p-6"
      >
        <p className="mb-1 text-xs text-muted">
          {t('onb.progress', 'Step {{n}} of {{total}}', { n: idx + 1, total: ORDER.length })}
        </p>
        <div aria-hidden className="mb-4 h-1 rounded bg-surface-2">
          <div
            className="h-1 rounded bg-accent"
            style={{ width: `${((idx + 1) / ORDER.length) * 100}%` }}
          />
        </div>
        <h1 id="onb-title" className="text-lg font-semibold">
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        <div className="mt-5">{children}</div>
        {footer && <div className="mt-6 flex flex-wrap justify-between gap-2">{footer}</div>}
      </section>
    </main>
  );
}

export function Onboarding() {
  const step = useWizard((s) => s.step);
  const { mode, profile } = useData();
  // After a reload mid-wizard the mode/profile already exist: continue after that point.
  const onboarded = useApp((s) => s.onboarded);
  let effective: Step = step;
  if (
    mode &&
    profile &&
    ORDER.indexOf(step) < ORDER.indexOf('accounts') &&
    step !== 'server-profile'
  )
    effective = 'accounts';
  // finished onboarding earlier but no usable profile now (deleted, or none on the server)
  if (onboarded && mode && !profile)
    effective = mode === 'remote' ? 'server-profile' : 'local-profile';
  switch (effective) {
    case 'welcome':
      return <Welcome />;
    case 'region':
      return <Region />;
    case 'currency':
      return <Currency />;
    case 'mode':
      return <ModeStep />;
    case 'local-profile':
      return <LocalProfile />;
    case 'server':
      return <Server />;
    case 'auth':
      return <Auth />;
    case 'server-profile':
      return <ServerProfile />;
    case 'accounts':
      return profile ? <Accounts /> : <ModeStep />;
    case 'categories':
      return profile ? <Categories /> : <ModeStep />;
    case 'import':
      return <ImportStep />;
  }
}

function Welcome() {
  const t = useT();
  const [checking, setChecking] = useState(false);
  // Existing account on this server: skip region/currency/mode (defaults stay; they only shape new
  // profiles) and go straight to sign-in. Another server goes through the normal server step.
  const signIn = async () => {
    if (isNative) return go('server'); // no own server: ask which one
    setChecking(true);
    const st = await fetchServerStatus('');
    setChecking(false);
    if (st.state === 'ok')
      useWizard.setState({
        server: { baseUrl: '', display: globalThis.location.origin, meta: st.meta },
        step: 'auth',
      });
    else go('server');
  };
  return (
    <Frame
      step="welcome"
      title={t('onb.welcome', 'Welcome')}
      description={t(
        'onb.welcomeText',
        'A private, local-first finance app: track expenses and income across accounts and currencies, plan bills, budget and forecast. Setting up takes a minute; optional steps can be skipped.',
      )}
      footer={
        <>
          <Button busy={checking} onClick={signIn}>
            {t('onb.haveAccount', 'I already have an account')}
          </Button>
          <Button variant="primary" className="ml-auto" onClick={() => go('region')}>
            {t('onb.start', 'Get started')}
          </Button>
        </>
      }
    />
  );
}

function Region() {
  const t = useT();
  return (
    <Frame
      step="region"
      title={t('onb.region', 'Language and region')}
      footer={
        <>
          <Button onClick={() => go('welcome')}>{t('common.back', 'Back')}</Button>
          <Button variant="primary" onClick={() => go('currency')}>
            {t('common.next', 'Next')}
          </Button>
        </>
      }
    >
      <PreferencesForm />
    </Frame>
  );
}

function Currency() {
  const t = useT();
  const currency = useWizard((s) => s.currency);
  const lang = useApp((s) => s.prefs.language);
  return (
    <Frame
      step="currency"
      title={t('onb.currency', 'Primary currency')}
      description={t(
        'onb.currencyText',
        'Totals, budgets and reports are shown in this currency. Accounts can still use any currency; you can change it later in Settings.',
      )}
      footer={
        <>
          <Button onClick={() => go('region')}>{t('common.back', 'Back')}</Button>
          <Button variant="primary" onClick={() => go('mode')}>
            {t('common.next', 'Next')}
          </Button>
        </>
      }
    >
      <Field label={t('onb.currencyLabel', 'Reporting currency')}>
        <Select value={currency} onChange={(e) => useWizard.setState({ currency: e.target.value })}>
          {currencyCodes().map((c) => (
            <option key={c} value={c}>
              {c} — {currencyName(c, lang)}
            </option>
          ))}
        </Select>
      </Field>
    </Frame>
  );
}

function ModeCard({
  icon,
  title,
  text,
  points,
  onChoose,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  points: string[];
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className="flex flex-col gap-2 rounded-lg border border-line p-4 text-left hover:border-accent focus-visible:border-accent"
    >
      <span className="flex items-center gap-2 font-medium">
        {icon}
        {title}
      </span>
      <span className="text-sm text-muted">{text}</span>
      <ul className="list-disc pl-5 text-sm text-muted">
        {points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </button>
  );
}

function ModeStep() {
  const t = useT();
  return (
    <Frame
      step="mode"
      title={t('mode.title', 'How do you want to use the app?')}
      description={t(
        'onb.modeText',
        'You can switch later in Settings → Connection without losing data.',
      )}
      footer={<Button onClick={() => go('currency')}>{t('common.back', 'Back')}</Button>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <ModeCard
          icon={<HardDrive className="size-5" aria-hidden />}
          title={t('mode.local', 'Local only')}
          text={t('onb.localText', 'Everything stays in this browser. No account, no server.')}
          points={[
            t('onb.local1', 'Works offline'),
            t('onb.local2', 'No automatic uploads'),
            t('onb.local3', 'Encrypted backups you download'),
          ]}
          onChoose={() => go('local-profile')}
        />
        <ModeCard
          icon={<Cloud className="size-5" aria-hidden />}
          title={t('mode.connect', 'Connect to server')}
          text={t(
            'onb.connectText',
            'Sign in to your own or a self-hosted server and sync devices.',
          )}
          points={[
            t('onb.connect1', 'Profiles downloaded and cached'),
            t('onb.connect2', 'Offline edits sync later'),
            t('onb.connect3', 'Households, MCP, server backups'),
          ]}
          onChoose={() => go('server')}
        />
      </div>
    </Frame>
  );
}

function LocalProfile() {
  const t = useT();
  const currency = useWizard((s) => s.currency);
  const prefs = useApp((s) => s.prefs);
  const setApp = useApp((s) => s.set);
  const [name, setName] = useState(t('onb.defaultProfile', 'Personal'));
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const est = useQuery({ queryKey: ['storage-estimate'], queryFn: storageEstimate });
  const existing = useQuery({
    queryKey: ['local-profiles'],
    queryFn: () => new LocalDataSource(openStore('finplat')).listProfiles(),
  });
  const create = useMutation({
    mutationFn: async () => {
      const ds = new LocalDataSource(openStore('finplat'));
      return ds.createProfile({
        name: name.trim(),
        baseCurrency: currency,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: prefs.region,
        weekStart: 1,
      });
    },
    onSuccess: (p) => {
      setApp({ mode: 'local', storeName: 'finplat', profileId: p.id, connection: null });
      go('accounts');
    },
  });
  const persisted0 = persisted ?? est.data?.persisted ?? null;
  return (
    <Frame
      step="local-profile"
      title={t('onb.localTitle', 'Local profile')}
      footer={<Button onClick={() => go('mode')}>{t('common.back', 'Back')}</Button>}
    >
      <Notice
        tone="warn"
        title={t('onb.evictionTitle', 'Browser storage is not a safe place on its own')}
      >
        {t(
          'onb.eviction',
          'Your data is stored only in this browser. Clearing site data, private windows, or the browser reclaiming space can delete it. Download encrypted backups regularly (Settings → Backups); the app reminds you.',
        )}
      </Notice>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">
          {t('onb.storage', 'Storage: {{used}} used of {{quota}}', {
            used: formatBytes(est.data?.usage),
            quota: formatBytes(est.data?.quota),
          })}
        </span>
        {persisted0 ? (
          <Badge tone="pos">
            {t('storage.persisted', 'Protected from automatic browser cleanup')}
          </Badge>
        ) : (
          <Button size="sm" onClick={async () => setPersisted(await requestPersistence())}>
            {t('storage.request', 'Ask the browser to keep this data')}
          </Button>
        )}
        {persisted === false && (
          <span className="text-xs text-muted">
            {t('storage.refused', 'The browser declined; backups are your safety net.')}
          </span>
        )}
      </div>
      {(existing.data?.length ?? 0) > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium">
            {t('onb.existing', 'Profiles already on this device')}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {existing.data?.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {p.name} <span className="text-muted">{p.baseCurrency}</span>
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    setApp({
                      mode: 'local',
                      storeName: 'finplat',
                      profileId: p.id,
                      connection: null,
                    });
                    go('accounts');
                  }}
                >
                  {t('onb.use', 'Use')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field
          label={t('onb.profileName', 'Profile name')}
          hint={t('onb.profileHint', 'Profiles keep finances separate (e.g. personal, business).')}
        >
          <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorBox error={create.error} />
        <Button
          type="submit"
          variant="primary"
          busy={create.isPending}
          className="self-start justify-self-start"
        >
          {t('onb.createProfile', 'Create profile')}
        </Button>
      </form>
    </Frame>
  );
}

function Server() {
  const t = useT();
  return (
    <Frame
      step="server"
      title={t('mode.connect', 'Connect to server')}
      description={t(
        'onb.serverText',
        'Enter the address of a compatible server. Nothing is sent until you confirm you trust it.',
      )}
      footer={<Button onClick={() => go('mode')}>{t('common.back', 'Back')}</Button>}
    >
      <ServerStep
        onVerified={(server) => {
          useWizard.setState({ server, step: 'auth' });
        }}
      />
    </Frame>
  );
}

function Auth() {
  const t = useT();
  const server = useWizard((s) => s.server);
  const setApp = useApp((s) => s.set);
  if (!server) return <Server />;
  return (
    <Frame
      step="auth"
      title={t('onb.authTitle', 'Sign in to {{host}}', { host: server.display })}
      footer={<Button onClick={() => go('server')}>{t('common.back', 'Back')}</Button>}
    >
      <AuthStep
        server={server}
        onSignedIn={(s) => {
          setApp({
            mode: 'remote',
            storeName: storeNameFor(server.baseUrl),
            connection: {
              serverUrl: server.baseUrl,
              deviceId: s.deviceId,
              email: s.email,
              ...(s.token ? { token: s.token } : {}),
            },
            profileId: null,
          });
          go('server-profile');
        }}
      />
    </Frame>
  );
}

function ServerProfile() {
  const t = useT();
  const finish = useFinish();
  const currency = useWizard((s) => s.currency);
  const { profiles, refreshProfiles, ds, updateProfile, profile } = useData();
  const setApp = useApp((s) => s.set);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      if (!ds) throw new Error('not connected');
      const p = await ds.createProfile({
        name: name.trim(),
        baseCurrency: currency,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: useApp.getState().prefs.region,
        weekStart: 1,
      });
      await refreshProfiles();
      return p;
    },
    onSuccess: (p) => {
      setApp({ profileId: p.id });
      go('accounts');
    },
  });
  const setCurrency = useMutation({
    mutationFn: () => updateProfile({ baseCurrency: currency }),
    onSuccess: () => go('accounts'),
  });
  return (
    <Frame
      step="server-profile"
      title={t('onb.serverProfiles', 'Choose a profile')}
      description={t(
        'onb.serverProfilesText',
        'Profiles on this server you can access. The selected one is downloaded to this browser for offline use.',
      )}
    >
      <ul className="flex flex-col gap-1">
        {profiles.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
          >
            <span>
              {p.name} <span className="text-muted">{p.baseCurrency}</span>{' '}
              {p.role && <Badge>{p.role}</Badge>}{' '}
              {p.privacyMode === 'e2ee' && <Badge tone="accent">E2EE</Badge>}
            </span>
            <Button
              size="sm"
              variant={profile?.id === p.id ? 'primary' : 'secondary'}
              onClick={() => {
                setApp({ profileId: p.id });
                // A profile that already has data is set up: straight to the dashboard.
                if (p.syncVersion > 0) finish();
                else if (p.baseCurrency === currency || p.role !== 'owner') go('accounts');
              }}
            >
              {t('onb.use', 'Use')}
            </Button>
          </li>
        ))}
      </ul>
      {profile &&
        profile.baseCurrency !== currency &&
        profile.role === 'owner' &&
        profile.syncVersion === 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span>
              {t('onb.currencyDiffers', '“{{name}}” uses {{cur}}. Switch it to {{want}}?', {
                name: profile.name,
                cur: profile.baseCurrency,
                want: currency,
              })}
            </span>
            <Button size="sm" busy={setCurrency.isPending} onClick={() => setCurrency.mutate()}>
              {t('onb.switchCurrency', 'Use {{want}}', { want: currency })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => go('accounts')}>
              {t('onb.keepCurrency', 'Keep {{cur}}', { cur: profile.baseCurrency })}
            </Button>
            <ErrorBox error={setCurrency.error} />
          </div>
        )}
      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label={t('onb.newServerProfile', 'Or create a new profile')} className="flex-1">
          <Input required value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" busy={create.isPending}>
          {t('common.add', 'Add')}
        </Button>
      </form>
      <div className="mt-2">
        <ErrorBox error={create.error} />
      </div>
    </Frame>
  );
}

const ASSET_TYPES = [
  'checking',
  'savings',
  'cash',
  'wallet',
  'prepaid',
  'investment',
  'other_asset',
];

function Accounts() {
  const t = useT();
  const finish = useFinish();
  const fmt = useFormat();
  const ops = useFinance();
  const { profile } = useData();
  const pid = profile?.id ?? '';
  const accounts = useQuery({ queryKey: qk(pid, 'accounts'), queryFn: () => ops.list('accounts') });
  const [f, setF] = useState({
    name: '',
    accountType: 'checking' as D.AccountType,
    currency: profile?.baseCurrency ?? 'BAM',
    opening: '',
    openingDate: todayIso(),
  });
  const [err, setErr] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      let openingBalance: D.Money | undefined;
      if (f.opening.trim()) {
        const v = fmt.parseDecimal(f.opening);
        if (v === null) throw new Error(t('onb.badAmount', 'The opening balance is not a number.'));
        openingBalance = money(v, f.currency);
      }
      return ops.create('accounts', {
        name: f.name.trim(),
        accountType: f.accountType,
        currency: f.currency,
        openingDate: openingBalance ? f.openingDate : null,
        ...(openingBalance ? { openingBalance } : {}),
      });
    },
    onSuccess: async () => {
      setF((x) => ({ ...x, name: '', opening: '' }));
      await accounts.refetch();
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    add.mutate();
  }
  const list = (accounts.data ?? []).filter((a) => !a.deletedAt);
  const liability = !ASSET_TYPES.includes(f.accountType);
  return (
    <Frame
      step="accounts"
      title={t('onb.accounts', 'Your accounts')}
      description={t(
        'onb.accountsText',
        'Add the accounts you want to track: bank accounts, cash, cards, loans. The opening balance is optional; imports can reconstruct history later.',
      )}
      footer={
        <>
          {list.length ? (
            <Button onClick={() => finish()}>{t('onb.finish', 'Go to dashboard')}</Button>
          ) : (
            <span />
          )}
          <Button variant="primary" onClick={() => go('categories')}>
            {list.length ? t('common.next', 'Next') : t('common.skip', 'Skip')}
          </Button>
        </>
      }
    >
      {list.length > 0 && (
        <div className="overflow-x-auto">
          <table className={cx(tableClass, 'mb-4')}>
            <thead>
              <tr>
                <th>{t('account.name', 'Name')}</th>
                <th>{t('account.type', 'Type')}</th>
                <th>{t('account.currency', 'Currency')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{t(`accountType.${a.accountType}`, a.accountType)}</td>
                  <td>{a.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('account.name', 'Name')} className="sm:col-span-2">
          <Input
            required
            maxLength={200}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </Field>
        <Field label={t('account.type', 'Type')}>
          <Select
            value={f.accountType}
            onChange={(e) => setF({ ...f, accountType: e.target.value as D.AccountType })}
          >
            {ACCOUNT_TYPES.map((a) => (
              <option key={a} value={a}>
                {t(`accountType.${a}`, a)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('account.currency', 'Currency')}>
          <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            {currencyCodes().map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('onb.openingBalance', 'Opening balance (optional)')}
          hint={
            liability
              ? t('onb.liabilityHint', 'For debt enter a negative amount, e.g. -1200.00.')
              : undefined
          }
        >
          <Input
            inputMode="decimal"
            value={f.opening}
            onChange={(e) => setF({ ...f, opening: e.target.value })}
          />
        </Field>
        <Field label={t('onb.openingDate', 'Balance as of')}>
          <Input
            type="date"
            value={f.openingDate}
            onChange={(e) => setF({ ...f, openingDate: e.target.value })}
          />
        </Field>
        {err && <p className="text-sm text-neg sm:col-span-2">{err}</p>}
        <div className="sm:col-span-2">
          <ErrorBox error={add.error} />
        </div>
        <Button type="submit" busy={add.isPending} className="self-start justify-self-start">
          {t('onb.addAccount', 'Add account')}
        </Button>
      </form>
    </Frame>
  );
}

function Categories() {
  const t = useT();
  const ops = useFinance();
  const { api, syncNow, profiles, locked } = useData();
  const profileId = useApp((s) => s.profileId);
  const e2ee = profiles.find((p) => p.id === profileId)?.privacyMode === 'e2ee';
  const [seed, setSeed] = useState(true);
  const run = useMutation({
    mutationFn: async () => {
      if (!seed) return;
      // e2ee: categories are created here and pushed encrypted; a locked profile already has its own
      if (e2ee) {
        if (profileId && !locked.has(profileId)) await seedLocalCategories(ops);
      } else if (api) {
        await api.request('POST', '/api/v1/categories/defaults');
        await syncNow();
      } else await seedLocalCategories(ops);
    },
    onSuccess: () => go('import'),
  });
  return (
    <Frame
      step="categories"
      title={t('onb.categories', 'Categories')}
      description={t(
        'onb.categoriesText',
        'Start with a common set of expense and income categories. You can rename, merge or delete them any time.',
      )}
      footer={
        <>
          <Button onClick={() => go('accounts')}>{t('common.back', 'Back')}</Button>
          <Button variant="primary" busy={run.isPending} onClick={() => run.mutate()}>
            {t('common.next', 'Next')}
          </Button>
        </>
      }
    >
      <Checkbox
        checked={seed}
        onChange={(e) => setSeed(e.target.checked)}
        label={t('onb.seed', 'Create starter categories (Housing, Food, Transport, Salary …)')}
        hint={t('onb.seedHint', 'Skipped automatically if the profile already has categories.')}
      />
      <div className="mt-3">
        <ErrorBox error={run.error} />
      </div>
    </Frame>
  );
}

/** Ends the wizard (every remaining step is optional). */
function useFinish() {
  const setApp = useApp((s) => s.set);
  const navigate = useNavigate();
  return (to = '/') => {
    setApp({ onboarded: true });
    useWizard.setState({ step: 'welcome' });
    navigate(to);
  };
}

function ImportStep() {
  const t = useT();
  const finish = useFinish();
  return (
    <Frame
      step="import"
      title={t('onb.import', 'Import bank statements (optional)')}
      description={t(
        'onb.importText',
        'Import CSV, Excel, OFX/QIF, CAMT, MT940 or PDF statements. Every import is previewed first and can be rolled back.',
      )}
      footer={
        <>
          <Button onClick={() => finish('/import')}>
            {t('onb.importNow', 'Import a statement')}
          </Button>
          <Button variant="primary" onClick={() => finish('/')}>
            {t('onb.finish', 'Go to dashboard')}
          </Button>
        </>
      }
    />
  );
}
