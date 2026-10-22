// The one place that builds the DataSource (PLAN §20): LocalDataSource in local mode,
// RemoteDataSource in connected mode, both on an IndexedDB store. Pages use useFinance() and
// never branch on the mode; server-only screens (devices, MCP, admin, households) use useApi().
//
// Query keys: ['profile', profileId, ...]. After a sync pull everything under
// ['profile', profileId] is invalidated, so pages re-read the local cache.
import { type ApiClient, createApiClient, type Schemas } from '@finplat/api-client';
import type { Profile } from '@finplat/domain';
import {
  type DataSource,
  type FinanceOps,
  getCheckpoint,
  IdbStore,
  LocalDataSource,
  StorageUnavailableError,
} from '@finplat/storage';
// sync-client (libsodium) is loaded only in connected mode to keep local mode light.
import type { Keyring, RemoteDataSource, SyncEngine } from '@finplat/sync-client';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useT } from '../lib/i18n.ts';
import { type Mode, useApp } from './store.ts';

export type SessionState = 'n/a' | 'checking' | 'ok' | 'expired' | 'offline';

export interface DataContextValue {
  mode: Mode | null;
  ds: DataSource | null;
  store: IdbStore;
  api: ApiClient | null;
  profiles: Profile[];
  profile: Profile | null;
  session: SessionState;
  /** Signed-in server user (connected mode). */
  user: Schemas['User'] | null;
  /** Profiles whose e2ee keyring is not unlocked on this device. */
  locked: Set<string>;
  refreshProfiles: () => Promise<Profile[]>;
  /** Rebuild the DataSource (after unlocking an e2ee profile, re-login, mode switch). */
  reload: () => void;
  engine: () => SyncEngine | null;
  syncNow: () => Promise<void>;
  updateProfile: (
    patch: Partial<Pick<Profile, 'name' | 'baseCurrency' | 'locale' | 'timezone' | 'weekStart'>>,
  ) => Promise<Profile>;
}

const Ctx = createContext<DataContextValue | null>(null);

/** Same-origin API client for the configured server ('' = this origin). */
export function makeApi(
  serverUrl: string,
  profileId?: () => string | undefined,
  onUnauth?: () => void,
) {
  return createApiClient({ baseUrl: serverUrl, profileId, onUnauthenticated: onUnauth });
}

export function DataProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const mode = useApp((s) => s.mode);
  const storeName = useApp((s) => s.storeName);
  const connection = useApp((s) => s.connection);
  const profileId = useApp((s) => s.profileId);
  const setApp = useApp((s) => s.set);
  const qc = useQueryClient();
  const [gen, setGen] = useState(0);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [session, setSession] = useState<SessionState>('n/a');
  const [user, setUser] = useState<Schemas['User'] | null>(null);
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const pidRef = useRef(profileId);
  pidRef.current = profileId;

  const store = useMemo(() => new IdbStore(storeName), [storeName]);
  const api = useMemo(
    () =>
      mode === 'remote' && connection
        ? makeApi(
            connection.serverUrl,
            () => pidRef.current ?? undefined,
            () => setSession('expired'),
          )
        : null,
    [mode, connection],
  );

  const [ds, setDs] = useState<DataSource | null>(null);

  // Server-generated notifications, emails and reports use the account locale: keep it on the UI language.
  // No setUser afterwards: re-rendering the whole tree for this would disturb open pages.
  const language = useApp((s) => s.prefs.language);
  const sentLocale = useRef<string | null>(null);
  useEffect(() => {
    if (!api || !user || user.locale === language || sentLocale.current === language) return;
    sentLocale.current = language;
    api.request('PATCH', '/api/v1/users/me', { locale: language }).catch(() => {
      sentLocale.current = null;
    });
  }, [api, user, language]);

  // build the DataSource
  // biome-ignore lint/correctness/useExhaustiveDependencies: gen forces a rebuild
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    (async () => {
      try {
        await store.open();
      } catch (e) {
        if (!cancelled)
          setFatal(
            e instanceof StorageUnavailableError
              ? 'This browser does not allow local storage (private mode or blocked site data). The app needs IndexedDB to keep your data.'
              : `Local database could not be opened: ${(e as Error).message}`,
          );
        return;
      }
      let next: DataSource | null = null;
      const keyringsFor = new Map<string, Keyring>();
      if (mode === 'local') next = new LocalDataSource(store);
      if (mode === 'remote' && api && connection) {
        const { loadKeyring, RemoteDataSource } = await import('@finplat/sync-client');
        const cached = await store.run('readonly', ['profiles'], (tx) =>
          tx.query<Profile>('profiles', {}),
        );
        const lockedNow = new Set<string>();
        for (const p of cached) {
          if (p.privacyMode !== 'e2ee') continue;
          const k = await loadKeyring(store, p.id);
          if (k) keyringsFor.set(p.id, k);
          else lockedNow.add(p.id);
        }
        if (!cancelled) setLocked(lockedNow);
        next = new RemoteDataSource({
          store,
          api,
          deviceId: connection.deviceId,
          keyringFor: (id) => keyringsFor.get(id),
        });
        setSession('checking');
        api
          .session()
          .then((r) => {
            if (cancelled) return;
            setSession('ok');
            setUser(r.user ?? null);
          })
          .catch((e: { status?: number }) => {
            if (!cancelled) setSession(e.status === 0 ? 'offline' : 'expired');
          });
      } else setSession('n/a');
      if (cancelled) return;
      setDs(next);
      if (next) {
        const list = await next.listProfiles().catch(() => [] as Profile[]);
        if (cancelled) return;
        setProfiles(list.filter((p) => !p.deletedAt));
        // e2ee profiles first seen now (fresh device) have no key here yet: locked until unlocked
        const fresh = list.filter((p) => p.privacyMode === 'e2ee' && !keyringsFor.has(p.id));
        if (fresh.length) setLocked((s) => new Set([...s, ...fresh.map((p) => p.id)]));
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [store, mode, api, connection, gen]);

  const refreshProfiles = useCallback(async () => {
    if (!ds) return [];
    const list = (await ds.listProfiles()).filter((p) => !p.deletedAt);
    setProfiles(list);
    return list;
  }, [ds]);

  // keep the active profile valid
  useEffect(() => {
    if (!ready || !ds) return;
    if (profiles.length && !profiles.some((p) => p.id === profileId))
      setApp({ profileId: profiles[0]?.id ?? null });
  }, [ready, ds, profiles, profileId, setApp]);

  const profile = profiles.find((p) => p.id === profileId) ?? null;

  const engine = useCallback(
    () =>
      ds && ds.mode === 'remote' && profileId ? (ds as RemoteDataSource).engine(profileId) : null,
    [ds, profileId],
  );

  const syncing = useRef(false);
  const syncNow = useCallback(async () => {
    const e = engine();
    if (!e || !profileId || locked.has(profileId) || syncing.current) return;
    syncing.current = true;
    try {
      if ((await getCheckpoint(store, profileId)) === 0) await e.downloadSnapshot();
      await e.sync();
    } finally {
      syncing.current = false;
      await qc.invalidateQueries({ queryKey: ['profile', profileId] });
    }
  }, [engine, profileId, locked, store, qc]);

  // background sync: on start, every minute, when the browser comes back online
  useEffect(() => {
    if (mode !== 'remote' || !ready || !profileId) return;
    const run = () => {
      if (navigator.onLine) syncNow().catch(() => undefined);
    };
    run();
    const t = setInterval(run, 60_000);
    window.addEventListener('online', run);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', run);
    };
  }, [mode, ready, profileId, syncNow]);

  const updateProfile = useCallback<DataContextValue['updateProfile']>(
    async (patch) => {
      if (!profile) throw new Error('no active profile');
      let next: Profile;
      if (api) next = await api.request<Profile>('PATCH', `/api/v1/profiles/${profile.id}`, patch);
      else next = { ...profile, ...patch, updatedAt: new Date().toISOString() };
      await store.run('readwrite', ['profiles'], (tx) => tx.put('profiles', next));
      setProfiles((ps) => ps.map((p) => (p.id === next.id ? next : p)));
      await qc.invalidateQueries({ queryKey: ['profile', next.id] });
      return next;
    },
    [api, profile, store, qc],
  );

  const value = useMemo<DataContextValue>(
    () => ({
      mode,
      ds,
      store,
      api,
      profiles,
      profile,
      session,
      user,
      locked,
      refreshProfiles,
      reload: () => setGen((g) => g + 1),
      engine,
      syncNow,
      updateProfile,
    }),
    [
      mode,
      ds,
      store,
      api,
      profiles,
      profile,
      session,
      user,
      locked,
      refreshProfiles,
      engine,
      syncNow,
      updateProfile,
    ],
  );

  if (fatal)
    return (
      <div role="alert" className="mx-auto max-w-lg p-8 text-sm">
        <h1 className="mb-2 text-lg font-semibold">
          {t('app.data.storageUnavailable', 'Storage unavailable')}
        </h1>
        <p>{fatal}</p>
      </div>
    );
  if (mode && !ready)
    return (
      <p className="p-8 text-sm text-muted" role="status">
        {t('app.data.openingLocalDatabase', 'Opening local database…')}
      </p>
    );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): DataContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useData outside DataProvider');
  return v;
}

/** The active profile's operations (identical API in local and connected mode). */
export function useFinance(): FinanceOps {
  const { ds, profile } = useData();
  if (!ds || !profile) throw new Error('no active profile');
  return ds.profile(profile.id);
}

export function useProfile(): Profile {
  const { profile } = useData();
  if (!profile) throw new Error('no active profile');
  return profile;
}

/** API client in connected mode, null in local mode. */
export function useApi(): ApiClient | null {
  return useData().api;
}

/** Query key under the active profile: invalidated after every sync. */
export const qk = (profileId: string, ...rest: unknown[]) => ['profile', profileId, ...rest];

/** Invalidate everything cached for the active profile (call after mutations). */
export function useInvalidate() {
  const qc = useQueryClient();
  const { profile } = useData();
  return useCallback(
    () => qc.invalidateQueries({ queryKey: ['profile', profile?.id] }),
    [qc, profile?.id],
  );
}
