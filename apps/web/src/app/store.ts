// App-level configuration that must be known before any database is opened (which mode, which
// IndexedDB, which server) plus per-device preferences. Persisted in localStorage; financial
// data never goes here. Everything profile-scoped lives in the DataSource.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Mode = 'local' | 'remote';
export type Theme = 'light' | 'dark' | 'system';
export type Language = 'en' | 'bs';

export interface Connection {
  /** '' = the server that serves this web app (same origin). */
  serverUrl: string;
  deviceId: string;
  email: string;
}

export interface Prefs {
  theme: Theme;
  language: Language;
  /** BCP 47 tag for numbers/dates ("en-US", "bs-BA", "de-DE"). */
  region: string;
  dateStyle: 'short' | 'medium' | 'long';
}

export interface LockConfig {
  /** Argon2id verifier from hashLockSecret (never the PIN itself). */
  hash: string;
  kind: 'pin' | 'password';
  autoLockMinutes: number; // 0 = only on reload
}

export interface BackupConfig {
  /** Days between reminders/automatic local backup downloads; 0 = off. */
  intervalDays: number;
  lastBackupAt: string | null;
}

export interface Recent {
  kind?: 'expense' | 'income' | 'transfer';
  accountId?: string;
  toAccountId?: string;
  categoryId?: string | null;
}

export interface AppState {
  onboarded: boolean;
  mode: Mode | null;
  /** IndexedDB name; the same store is used when switching between modes so nothing is lost. */
  storeName: string;
  connection: Connection | null;
  profileId: string | null;
  prefs: Prefs;
  sidebarCollapsed: boolean;
  lock: LockConfig | null;
  backup: BackupConfig;
  recent: Recent;
  set: (patch: Partial<Omit<AppState, 'set' | 'setPrefs'>>) => void;
  setPrefs: (patch: Partial<Prefs>) => void;
}

const defaultRegion = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
};

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      onboarded: false,
      mode: null,
      storeName: 'finplat',
      connection: null,
      profileId: null,
      prefs: {
        theme: 'system',
        language: defaultRegion().toLowerCase().startsWith('bs') ? 'bs' : 'en',
        region: defaultRegion(),
        dateStyle: 'medium',
      },
      sidebarCollapsed: false,
      lock: null,
      backup: { intervalDays: 7, lastBackupAt: null },
      recent: {},
      set: (patch) => set(patch),
      setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
    }),
    {
      name: 'finplat:app',
      version: 1,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** IndexedDB name for a fresh connection to a server (one cache database per server). */
export function storeNameFor(serverUrl: string): string {
  if (!serverUrl) return `finplat@${globalThis.location?.host ?? 'local'}`;
  try {
    return `finplat@${new URL(serverUrl).host}`;
  } catch {
    return `finplat@${serverUrl}`;
  }
}
