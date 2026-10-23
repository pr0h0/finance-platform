// E2EE keys in the OS credential store (native app). The sync client keeps its device key pair and
// profile keyrings as meta rows `e2ee:*`; this wrapper around a store's StorePersistence moves their
// values into the credential store and leaves only a marker in SQLite, so a copy of the app's data
// directory holds no keys. Older rows still in SQLite move over on the next start. Without a credential
// store (Android, a Linux session without Secret Service) rows stay in SQLite as before.
import type { StoreCommit, StorePersistence, StoreSnapshot } from '@finplat/storage';

export interface Secrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const MARK = { $keychain: 1 };
const isSecret = (table: string, key: unknown): key is string =>
  table === 'meta' && typeof key === 'string' && key.startsWith('e2ee:');
const isMark = (v: unknown) =>
  !!v && typeof v === 'object' && (v as Record<string, unknown>).$keychain === 1;

/** `secrets` null: no credential store; rows pass through (markers left by another session are
 * dropped: those keys are only in the credential store, and the profile asks to be unlocked again). */
export function withSecretRows(
  inner: StorePersistence,
  secrets: Secrets | null,
  storeName: string,
): StorePersistence {
  const item = (id: string) => `${storeName}/${id}`;
  const known = new Set<string>();
  return {
    async load(): Promise<StoreSnapshot | null> {
      const snap = await inner.load();
      const meta = snap?.tables.meta;
      if (!snap || !meta) return snap;
      const rows: typeof meta = [];
      const migrate: StoreCommit['changes'] = [];
      for (const r of meta) {
        const id = r.id;
        if (!isSecret('meta', id)) {
          rows.push(r);
          continue;
        }
        if (isMark(r.value)) {
          const v = secrets ? await secrets.get(item(id)) : null;
          if (v !== null) {
            rows.push({ ...r, value: JSON.parse(v) });
            known.add(id);
          }
          continue; // lost key: locked until unlocked again
        }
        rows.push(r);
        if (secrets) {
          await secrets.set(item(id), JSON.stringify(r.value));
          known.add(id);
          migrate.push({ table: 'meta', key: id, row: { ...r, value: MARK } });
        }
      }
      if (migrate.length)
        await inner.commit({ version: snap.version, seq: snap.seq, changes: migrate });
      return { ...snap, tables: { ...snap.tables, meta: rows } };
    },
    async commit(c: StoreCommit) {
      if (!secrets) return inner.commit(c);
      const changes: StoreCommit['changes'] = [];
      for (const ch of c.changes) {
        if (!isSecret(ch.table, ch.key)) {
          changes.push(ch);
          continue;
        }
        if (ch.row) {
          await secrets.set(item(ch.key), JSON.stringify(ch.row.value));
          known.add(ch.key);
          changes.push({ ...ch, row: { ...ch.row, value: MARK } });
        } else {
          await secrets.delete(item(ch.key));
          known.delete(ch.key);
          changes.push(ch);
        }
      }
      return inner.commit({ ...c, changes });
    },
    async destroy() {
      if (secrets) for (const id of known) await secrets.delete(item(id)).catch(() => undefined);
      known.clear();
      return inner.destroy();
    },
  };
}
