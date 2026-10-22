import type * as D from '@finplat/domain';
import { TRANSACTION_KINDS, TRANSACTION_SOURCES, TRANSACTION_STATUSES } from '@finplat/domain';
import { Search } from 'lucide-react';
import { useT } from '../../lib/i18n.ts';
import type { Refs } from './data.ts';
import type { TxFilter } from './model.ts';
import { Button, inputCls } from './ui.tsx';

export function Filters({
  value,
  onChange,
  refs,
  currencies,
  batches,
}: {
  value: TxFilter;
  onChange: (f: TxFilter) => void;
  refs: Refs;
  currencies: string[];
  batches: D.ImportBatch[];
}) {
  const t = useT();
  const set = (k: keyof TxFilter, v: string) => {
    const next = { ...value };
    if (k === 'accountIds') next.accountIds = v ? [v] : undefined;
    else if (v) (next as Record<string, string>)[k] = v;
    else delete next[k];
    onChange(next);
  };
  const sel = (
    k: keyof TxFilter,
    label: string,
    opts: { id: string; label: string }[],
    all = 'All',
  ) => (
    <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs text-muted">
      {label}
      <select
        className={inputCls}
        value={k === 'accountIds' ? (value.accountIds?.[0] ?? '') : ((value[k] as string) ?? '')}
        onChange={(e) => set(k, e.target.value)}
      >
        <option value="">{all}</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const active = Object.keys(value).length;
  return (
    <search
      className="mb-3 flex flex-col gap-2"
      aria-label={t('transactions.filters.transactionFilters', 'Transaction filters')}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-56 flex-[2] flex-col gap-1 text-xs text-muted">
          {t('common.search', 'Search')}
          <span className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-2.5 left-2 text-muted"
              aria-hidden
            />
            <input
              type="search"
              className={`${inputCls} w-full pl-7`}
              placeholder={t(
                'transactions.filters.descriptionPayeeNotesReference',
                'Description, payee, notes, reference, merchant',
              )}
              value={value.q ?? ''}
              onChange={(e) => set('q', e.target.value)}
            />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t('reports.page.from', 'From')}
          <input
            type="date"
            className={inputCls}
            value={value.from ?? ''}
            onChange={(e) => set('from', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t('reports.page.to', 'To')}
          <input
            type="date"
            className={inputCls}
            value={value.to ?? ''}
            onChange={(e) => set('to', e.target.value)}
          />
        </label>
        {sel(
          'accountIds',
          'Account',
          refs.accounts.map((a) => ({
            id: a.id,
            label: a.name + (a.isArchived ? ' (archived)' : ''),
          })),
        )}
        {sel('categoryId', 'Category', [
          { id: '__none', label: 'Uncategorized' },
          ...refs.categoryOptions,
        ])}
        {active > 0 && (
          <Button variant="ghost" onClick={() => onChange({})}>
            {t('transactions.filters.clearFiltersActive', 'Clear filters ({{active}})', {
              active: active,
            })}
          </Button>
        )}
      </div>
      <details className="group">
        <summary className="cursor-pointer text-xs text-muted select-none">
          {t('transactions.filters.moreFilters', 'More filters')}
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {sel(
            'merchantId',
            'Merchant',
            refs.merchants.map((m) => ({ id: m.id, label: m.name })),
          )}
          {sel(
            'currency',
            'Currency',
            currencies.map((c) => ({ id: c, label: c })),
          )}
          {sel(
            'tagId',
            'Tag',
            refs.tags.map((t) => ({ id: t.id, label: t.name })),
          )}
          {sel(
            'kind',
            'Type',
            TRANSACTION_KINDS.map((k) => ({ id: k, label: k.replace('_', ' ') })),
          )}
          {sel(
            'status',
            'Status',
            TRANSACTION_STATUSES.map((k) => ({ id: k, label: k })),
          )}
          {sel(
            'source',
            'Source',
            TRANSACTION_SOURCES.map((k) => ({ id: k, label: k.replace('_', ' ') })),
          )}
          {sel(
            'importBatchId',
            'Import batch',
            batches.map((b) => ({
              id: b.id,
              label: `${b.fileName} (${b.coverageStart ?? '?'} – ${b.coverageEnd ?? '?'})`,
            })),
          )}
          <label className="flex w-28 flex-col gap-1 text-xs text-muted">
            {t('transactions.filters.minAmount', 'Min amount')}
            <input
              inputMode="decimal"
              className={inputCls}
              value={value.minAmount ?? ''}
              onChange={(e) => set('minAmount', e.target.value.replace(',', '.'))}
            />
          </label>
          <label className="flex w-28 flex-col gap-1 text-xs text-muted">
            {t('transactions.filters.maxAmount', 'Max amount')}
            <input
              inputMode="decimal"
              className={inputCls}
              value={value.maxAmount ?? ''}
              onChange={(e) => set('maxAmount', e.target.value.replace(',', '.'))}
            />
          </label>
        </div>
      </details>
    </search>
  );
}
