import type { LocalStore, Migration, OutboxOp, TableDef } from './types.ts';

/** Synced entity tables; names equal the server table names = sync `entityType`. */
export const SYNCED_TABLES = [
  'accounts',
  'categories',
  'tags',
  'merchants',
  'transactions',
  'transaction_templates',
  'split_templates',
  'categorization_rules',
  'budgets',
  'budget_allocations',
  'recurrence_schedules',
  'planned_transactions',
  'planned_occurrences',
  'subscriptions',
  'savings_goals',
  'savings_contributions',
  'import_batches',
  'attachments',
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

const entity = (...indexes: string[]): TableDef => ({ key: 'id', indexes });

/**
 * Forward-only local schema migrations. Never edit a released entry; append a new version.
 * The local schemaVersion is independent of the server schema.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    tables: {
      accounts: entity(),
      categories: entity('parentId'),
      tags: entity(),
      merchants: entity('normalizedName'),
      transactions: entity('bookingDate', 'importRecordId', 'relatedTransactionId'),
      transaction_templates: entity(),
      split_templates: entity(),
      categorization_rules: entity(),
      budgets: entity(),
      budget_allocations: entity('budgetId'),
      recurrence_schedules: entity(),
      planned_transactions: entity('dueDate'),
      planned_occurrences: entity('plannedTransactionId'),
      subscriptions: entity(),
      savings_goals: entity(),
      savings_contributions: entity('goalId'),
      import_batches: entity(),
      attachments: entity('transactionId'),
      // local-only tables
      profiles: { key: 'id' },
      exchange_rates: entity('rateDate'),
      imported_raw_records: entity('importBatchId', 'dedupeFingerprint'),
      notifications: entity('createdAt'),
      settings: entity(), // id = `${profileId}:${key}`
      blobs: entity(), // attachment contents {id, profileId, blob}
      outbox: { key: 'seq', autoIncrement: true, indexes: [] },
      conflicts: entity(),
      checkpoints: { key: 'id' }, // id = profileId
      meta: { key: 'id' }, // device id, sync config, ...
    },
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Table definitions after applying migrations up to `version`. */
export function tablesAt(migrations: Migration[], version: number): Record<string, TableDef> {
  const out: Record<string, TableDef> = {};
  for (const m of migrations) {
    if (m.version > version) break;
    for (const [name, def] of Object.entries(m.tables)) {
      const prev = out[name];
      out[name] = prev
        ? { ...prev, indexes: [...new Set([...(prev.indexes ?? []), ...(def.indexes ?? [])])] }
        : def;
    }
  }
  return out;
}

// ---- outbox / checkpoint helpers (shared by every LocalStore implementation) ----

export async function pendingOps(store: LocalStore, profileId: string, limit: number) {
  return store.run('readonly', ['outbox'], (tx) =>
    tx.query<OutboxOp>('outbox', { profileId, limit, filter: (o) => o.status === 'pending' }),
  );
}

export async function allOps(store: LocalStore, profileId: string) {
  return store.run('readonly', ['outbox'], (tx) => tx.query<OutboxOp>('outbox', { profileId }));
}

/** Remove acknowledged ops (applied, or turned into a stored conflict). */
export async function ackOps(store: LocalStore, profileId: string, opIds: string[]) {
  if (opIds.length === 0) return;
  const ids = new Set(opIds);
  await store.run('readwrite', ['outbox'], async (tx) => {
    for (const o of await tx.query<OutboxOp>('outbox', {
      profileId,
      filter: (o) => ids.has(o.opId),
    }))
      await tx.delete('outbox', o.seq as number);
  });
}

/** Keep a server-rejected op visible (sync dashboard) but stop resending it. */
export async function rejectOp(
  store: LocalStore,
  profileId: string,
  opId: string,
  error: { code: string; message: string },
) {
  await store.run('readwrite', ['outbox'], async (tx) => {
    for (const o of await tx.query<OutboxOp>('outbox', {
      profileId,
      filter: (o) => o.opId === opId,
    }))
      await tx.put('outbox', { ...o, status: 'rejected', error });
  });
}

export async function getCheckpoint(store: LocalStore, profileId: string): Promise<number> {
  const c = await store.run('readonly', ['checkpoints'], (tx) =>
    tx.get<{ id: string; serverVersion: number }>('checkpoints', profileId),
  );
  return c?.serverVersion ?? 0;
}

export async function setCheckpoint(store: LocalStore, profileId: string, serverVersion: number) {
  await store.run('readwrite', ['checkpoints'], (tx) =>
    tx.put('checkpoints', { id: profileId, serverVersion }),
  );
}

export async function getMeta<T>(store: LocalStore, key: string): Promise<T | undefined> {
  const r = await store.run('readonly', ['meta'], (tx) =>
    tx.get<{ id: string; value: T }>('meta', key),
  );
  return r?.value;
}

export async function setMeta<T>(store: LocalStore, key: string, value: T) {
  await store.run('readwrite', ['meta'], (tx) => tx.put('meta', { id: key, value }));
}
