// React access to the insight Snapshot. Query keys live under ['profile', id] so every write
// (useInvalidate) and every sync pull refreshes these pages too.
import type { FinanceOps } from '@finplat/storage';
import { useMutation, useQuery } from '@tanstack/react-query';
import { qk, useFinance, useInvalidate, useProfile } from '../../app/data.tsx';
import { todayIso } from '../../lib/format.ts';
import { loadSnapshot } from './snapshot.ts';

export function useSnapshot() {
  const ops = useFinance();
  const profile = useProfile();
  const today = todayIso();
  return useQuery({
    queryKey: qk(profile.id, 'insights', 'snapshot', today),
    queryFn: () => loadSnapshot(ops, profile.baseCurrency, today),
  });
}

/** A query over FinanceOps under the profile key. */
export function useOpsQuery<T>(
  key: unknown[],
  fn: (ops: FinanceOps) => Promise<T>,
  enabled = true,
) {
  const ops = useFinance();
  const profile = useProfile();
  return useQuery({
    queryKey: qk(profile.id, 'insights', ...key),
    queryFn: () => fn(ops),
    enabled,
  });
}

/** A write through FinanceOps; invalidates every profile query on success. */
export function useOpsMutation<A, T>(fn: (ops: FinanceOps, a: A) => Promise<T>) {
  const ops = useFinance();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (a: A) => fn(ops, a), onSuccess: () => invalidate() });
}
