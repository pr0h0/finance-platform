// Drill-down links from aggregated figures to the filtered transactions list. Parameter names
// follow the transactions page filter (features/transactions/model.ts TxFilter).
import { UNCATEGORIZED } from '@finplat/finance-engine';

export function transactionsLink(f: {
  from?: string;
  to?: string;
  categoryKey?: string;
  merchantKey?: string;
  accountIds?: readonly string[];
  kind?: string;
  currency?: string;
}): string {
  const p = new URLSearchParams();
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.kind) p.set('kind', f.kind);
  if (f.currency) p.set('currency', f.currency);
  if (f.categoryKey)
    p.set('categoryId', f.categoryKey === UNCATEGORIZED ? '__none' : f.categoryKey);
  if (f.merchantKey) {
    if (f.merchantKey.startsWith('name:')) p.set('q', f.merchantKey.slice(5));
    else p.set('merchantId', f.merchantKey);
  }
  if (f.accountIds?.length) p.set('accountIds', f.accountIds.join(','));
  return `/transactions?${p.toString()}`;
}
