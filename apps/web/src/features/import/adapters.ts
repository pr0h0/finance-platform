// Custom code adapters (Feature 112) are kept on this device only, per profile (localStorage):
// user code is never synced or uploaded. An adapter runs only after the user granted it, and the
// grant is bound to the SHA-256 of the code, so any edit needs a new grant.
import type { CustomAdapter } from '@finplat/importer-sdk';
import { useCallback, useEffect, useState } from 'react';

export interface StoredAdapter extends CustomAdapter {
  /** SHA-256 of `code` the user approved, with the time; absent = not granted. */
  grant?: { codeSha256: string; at: string };
}

const key = (profileId: string) => `finplat.import.adapters.${profileId}`;

export async function sha256Text(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function loadAdapters(profileId: string): StoredAdapter[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(profileId)) ?? '[]');
    return Array.isArray(v) ? (v as StoredAdapter[]) : [];
  } catch {
    return [];
  }
}

function store(profileId: string, list: StoredAdapter[]) {
  localStorage.setItem(key(profileId), JSON.stringify(list));
  window.dispatchEvent(new Event('finplat-adapters'));
}

/** Granted adapters whose code still matches the grant. */
export async function grantedAdapters(list: readonly StoredAdapter[]): Promise<StoredAdapter[]> {
  const out: StoredAdapter[] = [];
  for (const a of list)
    if (a.grant && a.grant.codeSha256 === (await sha256Text(a.code))) out.push(a);
  return out;
}

export function useAdapters(profileId: string) {
  const [list, setList] = useState(() => loadAdapters(profileId));
  const [granted, setGranted] = useState<StoredAdapter[]>([]);
  useEffect(() => {
    const reload = () => setList(loadAdapters(profileId));
    reload();
    window.addEventListener('finplat-adapters', reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener('finplat-adapters', reload);
      window.removeEventListener('storage', reload);
    };
  }, [profileId]);
  useEffect(() => {
    let live = true;
    grantedAdapters(list).then((g) => live && setGranted(g));
    return () => {
      live = false;
    };
  }, [list]);
  /** Save (replace by id). Editing the code drops the grant unless the hash is unchanged. */
  const save = useCallback(
    async (a: StoredAdapter, grant: boolean) => {
      const codeSha256 = await sha256Text(a.code);
      const next: StoredAdapter = { ...a, grant: undefined };
      if (grant) next.grant = { codeSha256, at: new Date().toISOString() };
      else if (a.grant?.codeSha256 === codeSha256) next.grant = a.grant;
      const cur = loadAdapters(profileId).filter((x) => x.id !== a.id);
      store(profileId, [...cur, next]);
    },
    [profileId],
  );
  const remove = useCallback(
    (id: string) =>
      store(
        profileId,
        loadAdapters(profileId).filter((x) => x.id !== id),
      ),
    [profileId],
  );
  return { list, granted, save, remove };
}
