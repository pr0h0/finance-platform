// Virtualized transaction table (TanStack Table + TanStack Virtual). Only the visible rows are in
// the DOM, so 50k+ rows stay fast; sorting runs on the in-memory list.
import type * as D from '@finplat/domain';
import { compareDecimal } from '@finplat/finance-engine';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, FileInput, Paperclip, Repeat } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.ts';
import type { Refs } from './data.ts';
import { primaryAmount } from './model.ts';
import { Badge, MoneyText } from './ui.tsx';

const ROW_H = 44;
// Column widths; on phones the date moves under the description and account/category are hidden,
// so the description takes what is left and the amount stays on screen.
const COL: Record<string, string> = {
  select: 'w-9',
  date: 'w-[110px] max-md:hidden',
  description: 'md:w-[360px]',
  account: 'w-[160px] max-md:hidden',
  category: 'w-[180px] max-md:hidden',
  amount: 'w-[120px] md:w-[140px]',
};
const hideOnPhone = (id: string) => (COL[id]?.includes('max-md:hidden') ? 'max-md:hidden' : '');

export function TransactionTable({
  rows,
  refs,
  locale,
  selection,
  onSelectionChange,
  onOpen,
}: {
  rows: D.Transaction[];
  refs: Refs;
  locale: string;
  selection: RowSelectionState;
  onSelectionChange: (s: RowSelectionState) => void;
  onOpen: (t: D.Transaction) => void;
}) {
  const t = useT();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'date', desc: true }]);

  const columns = useMemo<ColumnDef<D.Transaction>[]>(
    () => [
      {
        id: 'select',
        enableSorting: false,
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label={t(
              'transactions.transactionTable.selectAllShownTransactions',
              'Select all shown transactions',
            )}
            checked={table.getIsAllRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomeRowsSelected();
            }}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={t('transactions.transactionTable.selectRow', 'Select {{name}}', {
              name:
                row.original.description ||
                t('transactions.transactionTable.transaction', 'transaction'),
            })}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            onClick={(e) => e.stopPropagation()}
          />
        ),
      },
      {
        id: 'date',
        header: t('transaction.date', 'Date'),
        accessorFn: (t) => `${t.bookingDate}|${t.createdAt}`,
        cell: ({ row }) => <span className="tabular-nums">{row.original.bookingDate}</span>,
      },
      {
        id: 'description',
        header: t('transactions.transactionTable.description', 'Description'),
        accessorFn: (t) =>
          (t.description || t.payee || refs.merchantName(t.merchantId)).toLowerCase(),
        cell: ({ row }) => {
          const tx = row.original;
          const merchant = refs.merchantName(tx.merchantId);
          return (
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                {tx.source === 'import' && (
                  <FileInput
                    size={14}
                    aria-label={t('transactions.transactionTable.imported', 'Imported')}
                    className="shrink-0 text-muted"
                  />
                )}
                {(tx.kind === 'transfer' || tx.kind === 'fx') && (
                  <Repeat
                    size={14}
                    aria-label={t('transaction.kind.transfer', 'Transfer')}
                    className="shrink-0 text-muted"
                  />
                )}
                {tx.attachmentIds.length > 0 && (
                  <Paperclip
                    size={14}
                    aria-label={t(
                      'transactions.transactionTable.hasAttachments',
                      'Has attachments',
                    )}
                    className="shrink-0 text-muted"
                  />
                )}
                <span className="truncate">
                  {tx.description || tx.payee || merchant || (
                    <em className="text-muted">
                      {t('transactions.transactionTable.noDescription', 'No description')}
                    </em>
                  )}
                </span>
                {merchant && tx.description && (
                  <span className="hidden truncate text-xs text-muted lg:inline">· {merchant}</span>
                )}
                {tx.status === 'pending' && (
                  <Badge tone="amber">
                    {t('transactions.transactionTable.pending', 'pending')}
                  </Badge>
                )}
                {tx.status === 'void' && (
                  <Badge tone="red">{t('transactions.transactionTable.void', 'void')}</Badge>
                )}
                {tx.excludeFromReports && (
                  <Badge>{t('transactions.transactionTable.excluded', 'excluded')}</Badge>
                )}
              </div>
              <div className="text-xs text-muted tabular-nums md:hidden">{tx.bookingDate}</div>
            </div>
          );
        },
      },
      {
        id: 'account',
        header: t('transactions.transactionTable.account', 'Account'),
        accessorFn: (t) => t.postings.map((p) => refs.accountName(p.accountId)).join(' → '),
        cell: ({ getValue }) => <span className="truncate">{getValue() as string}</span>,
      },
      {
        id: 'category',
        header: t('transaction.category', 'Category'),
        accessorFn: (tx) =>
          tx.kind === 'transfer' || tx.kind === 'fx'
            ? t('transaction.kind.transfer', 'Transfer')
            : tx.kind === 'opening_balance'
              ? t('transactions.transactionTable.openingBalance', 'Opening balance')
              : tx.kind === 'adjustment'
                ? t('transactions.transactionTable.adjustment', 'Adjustment')
                : tx.splits.length > 1
                  ? t('transactions.transactionTable.splitN', 'Split ({{n}})', {
                      n: tx.splits.length,
                    })
                  : refs.categoryLabel(tx.splits[0]?.categoryId ?? null),
        cell: ({ getValue, row }) => {
          const v = getValue() as string;
          const unc = v === 'Uncategorized' && row.original.kind !== 'adjustment';
          return <span className={`truncate ${unc ? 'text-warn' : ''}`}>{v}</span>;
        },
      },
      {
        id: 'amount',
        header: () => <span className="block text-right">{t('transaction.amount', 'Amount')}</span>,
        accessorFn: (t) => primaryAmount(t)?.amount ?? '0',
        sortingFn: (a, b) =>
          compareDecimal(
            primaryAmount(a.original)?.amount ?? '0',
            primaryAmount(b.original)?.amount ?? '0',
          ),
        cell: ({ row }) => {
          const t = row.original;
          const a = primaryAmount(t);
          const signed = t.kind !== 'transfer' && t.kind !== 'fx';
          return (
            <div className="text-right">
              <MoneyText value={a} locale={locale} signed={signed} />
              {t.postings[1] && t.postings[1].amount.currency !== a?.currency && (
                <div className="text-xs text-muted">
                  <MoneyText value={t.postings[1].amount} locale={locale} />
                </div>
              )}
            </div>
          );
        },
      },
    ],
    [refs, locale, t],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, rowSelection: selection },
    getRowId: (t) => t.id,
    onSortingChange: setSorting,
    onRowSelectionChange: (u) => onSelectionChange(typeof u === 'function' ? u(selection) : u),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const model = table.getRowModel().rows;
  const virt = useVirtualizer({
    count: model.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const items = virt.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virt.getTotalSize() - (items[items.length - 1]?.end ?? 0);

  const focusRow = (i: number) => {
    virt.scrollToIndex(i);
    requestAnimationFrame(() =>
      scrollRef.current?.querySelector<HTMLElement>(`tr[data-index="${i}"]`)?.focus(),
    );
  };

  return (
    <div
      ref={scrollRef}
      className="relative h-[calc(100dvh-16rem)] min-h-80 overflow-auto rounded-lg border border-line"
    >
      <table
        className="w-full table-fixed border-collapse text-sm"
        aria-rowcount={model.length + 1}
      >
        <colgroup>
          {table.getVisibleLeafColumns().map((c) => (
            <col key={c.id} className={COL[c.id]} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-muted">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const sorted = h.column.getIsSorted();
                return (
                  <th
                    key={h.id}
                    scope="col"
                    aria-sort={
                      sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                    }
                    className={`border-b border-line px-2 py-2 font-medium ${hideOnPhone(h.column.id)}`}
                  >
                    {h.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={h.column.getToggleSortingHandler()}
                        className="inline-flex w-full items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sorted === 'asc' && <ArrowUp size={12} aria-hidden />}
                        {sorted === 'desc' && <ArrowDown size={12} aria-hidden />}
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr aria-hidden>
              <td style={{ height: padTop }} colSpan={columns.length} />
            </tr>
          )}
          {items.map((vi) => {
            const row = model[vi.index];
            if (!row) return null;
            return (
              <tr
                key={row.id}
                data-index={vi.index}
                aria-rowindex={vi.index + 2}
                aria-selected={row.getIsSelected()}
                tabIndex={0}
                style={{ height: ROW_H }}
                onClick={() => onOpen(row.original)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter') onOpen(row.original);
                  else if (e.key === ' ') {
                    e.preventDefault();
                    row.toggleSelected();
                  } else if (e.key === 'ArrowDown' || e.key === 'j') {
                    e.preventDefault();
                    focusRow(Math.min(vi.index + 1, model.length - 1));
                  } else if (e.key === 'ArrowUp' || e.key === 'k') {
                    e.preventDefault();
                    focusRow(Math.max(vi.index - 1, 0));
                  }
                }}
                className={`cursor-pointer border-b border-line outline-none hover:bg-surface-2 focus-visible:bg-accent/10 ${row.getIsSelected() ? 'bg-accent/10' : ''} ${row.original.status === 'void' ? 'opacity-60' : ''}`}
              >
                {row.getVisibleCells().map((c) => (
                  <td
                    key={c.id}
                    className={`overflow-hidden px-2 whitespace-nowrap ${hideOnPhone(c.column.id)}`}
                  >
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
          {padBottom > 0 && (
            <tr aria-hidden>
              <td style={{ height: padBottom }} colSpan={columns.length} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
