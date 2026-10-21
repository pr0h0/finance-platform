import type { StorageEstimate } from './types.ts';

type StorageManagerLike = {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
};

const manager = (): StorageManagerLike | undefined =>
  (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator?.storage;

/** Storage usage for the sync dashboard / backup warnings; null where the browser can't tell. */
export async function storageEstimate(): Promise<StorageEstimate> {
  const m = manager();
  const e = await m?.estimate?.().catch(() => undefined);
  const persisted = (await m?.persisted?.().catch(() => undefined)) ?? null;
  return { usage: e?.usage ?? null, quota: e?.quota ?? null, persisted };
}

/** Ask the browser not to evict our data. Returns false when refused or unsupported. */
export async function requestPersistence(): Promise<boolean> {
  return (
    (await manager()
      ?.persist?.()
      .catch(() => false)) ?? false
  );
}

/** True when free space is below `fraction` of the quota (show the backup/cleanup warning). */
export function isLowOnSpace(e: StorageEstimate, fraction = 0.1): boolean {
  if (e.usage === null || e.quota === null || e.quota === 0) return false;
  return (e.quota - e.usage) / e.quota < fraction;
}
