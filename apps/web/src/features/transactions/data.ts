// Data hooks shared by the ledger pages (transactions, accounts, import, rules, converter).
// Everything goes through the profile's FinanceOps (LocalDataSource or RemoteDataSource), so the
// pages behave the same in local and connected mode. Writes invalidate every cached query of the
// profile: simple and always correct (dashboards and analytics read the same ledger).
import type * as D from '@finplat/domain';
import type { FinanceOps } from '@finplat/storage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { qk, useApi, useData, useFinance, useProfile } from '../../app/data.tsx';
import { useApp } from '../../app/store.ts';
import { errorText, useT } from '../../lib/i18n.ts';

export { qk };

/** Active profile, its operations, the number/date locale and (connected mode) the API client. */
export function useLedgerEnv() {
  const ops = useFinance();
  const profile = useProfile();
  const locale = useApp((s) => s.prefs.region);
  const api = useApi();
  const { mode, syncNow } = useData();
  return { ops, profile, profileId: profile.id, locale, api, mode, syncNow };
}

/** All live transactions of the profile (one store read; filtering/sorting happen in memory). */
export function useTransactions() {
  const { ops, profileId } = useLedgerEnv();
  return useQuery({
    queryKey: qk(profileId, 'transactions'),
    // ledger() returns the stored Transaction rows typed as engine LedgerTransaction.
    queryFn: async () => (await ops.ledger()) as unknown as D.Transaction[],
  });
}

export function useImportBatches() {
  const { ops, profileId } = useLedgerEnv();
  return useQuery({
    queryKey: qk(profileId, 'import_batches'),
    queryFn: async () =>
      (await ops.listImports()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
}

type ListEntity = Parameters<FinanceOps['list']>[0];

export function useEntities<E extends ListEntity>(entity: E) {
  const { ops, profileId } = useLedgerEnv();
  return useQuery({
    queryKey: qk(profileId, entity),
    queryFn: () => ops.list(entity),
  });
}

/** Name lookups for accounts, categories, merchants and tags. */
export function useRefs() {
  const accounts = useEntities('accounts');
  const categories = useEntities('categories');
  const merchants = useEntities('merchants');
  const tags = useEntities('tags');
  const t = useT();
  return useMemo(() => {
    const acc = new Map((accounts.data ?? []).map((a) => [a.id, a]));
    const cat = new Map((categories.data ?? []).map((c) => [c.id, c]));
    const mer = new Map((merchants.data ?? []).map((m) => [m.id, m]));
    const tag = new Map((tags.data ?? []).map((t) => [t.id, t]));
    const categoryLabel = (id: string | null) => {
      if (!id) return t('transaction.uncategorized', 'Uncategorized');
      const c = cat.get(id);
      if (!c) return t('transactions.refs.unknownCategory', 'Unknown category');
      const p = c.parentId ? cat.get(c.parentId) : undefined;
      return p ? `${p.name} / ${c.name}` : c.name;
    };
    return {
      loading: accounts.isLoading || categories.isLoading || merchants.isLoading || tags.isLoading,
      accounts: accounts.data ?? [],
      categories: categories.data ?? [],
      merchants: merchants.data ?? [],
      tags: tags.data ?? [],
      account: acc,
      category: cat,
      merchant: mer,
      tag: tag,
      accountName: (id: string) =>
        acc.get(id)?.name ?? t('transactions.refs.unknownAccount', 'Unknown account'),
      categoryLabel,
      merchantName: (id: string | null) => (id ? (mer.get(id)?.name ?? '') : ''),
      tagName: (id: string) => tag.get(id)?.name ?? '',
      /** Categories sorted as "Parent / Child" for pickers, archived ones left out. */
      categoryOptions: (categories.data ?? [])
        .filter((c) => !c.isArchived)
        .map((c) => ({ id: c.id, label: categoryLabel(c.id), kind: c.kind }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  }, [
    accounts.data,
    categories.data,
    merchants.data,
    tags.data,
    accounts.isLoading,
    categories.isLoading,
    merchants.isLoading,
    tags.isLoading,
    t,
  ]);
}
export type Refs = ReturnType<typeof useRefs>;

export const describeError = (e: unknown) => errorText(e);

/** Mutation that invalidates the whole profile cache on success. */
export function useWrite<A, R>(fn: (ops: FinanceOps, args: A) => Promise<R>) {
  const { ops, profileId } = useLedgerEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: A) => fn(ops, args),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile', profileId] }),
  });
}
