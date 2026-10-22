// Transactions page (PLAN §33): virtualized table, filters, bulk edit, details drawer, quick entry,
// uncategorized inbox and export. URL params: ?accountId= ?categoryId= ?importBatchId= ?tab=inbox
// ?new=expense|income|transfer (quick action from the dashboard).
import type * as D from '@finplat/domain';
import type { RowSelectionState } from '@tanstack/react-table';
import { Download, Pencil, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useData } from '../../app/data.tsx';
import { BulkEdit } from '../../features/transactions/BulkEdit.tsx';
import { DetailDrawer } from '../../features/transactions/DetailDrawer.tsx';
import {
  useImportBatches,
  useLedgerEnv,
  useRefs,
  useTransactions,
} from '../../features/transactions/data.ts';
import { DuplicatesList, useDuplicates } from '../../features/transactions/duplicates.tsx';
import { EntryForm } from '../../features/transactions/EntryForm.tsx';
import { exportTransactions } from '../../features/transactions/export.ts';
import { Filters } from '../../features/transactions/Filters.tsx';
import { Inbox } from '../../features/transactions/Inbox.tsx';
import {
  filterTransactions,
  isUncategorized,
  type TxFilter,
  totalsByCurrency,
} from '../../features/transactions/model.ts';
import { TransactionTable } from '../../features/transactions/TransactionTable.tsx';
import {
  Button,
  Dialog,
  Empty,
  ErrorText,
  MoneyText,
  PageHeader,
  Tabs,
} from '../../features/transactions/ui.tsx';
import { useT } from '../../lib/i18n.ts';

type Kind = 'expense' | 'income' | 'transfer';

export default function TransactionsPage() {
  const t = useT();
  const { locale } = useLedgerEnv();
  const { store, profile } = useData();
  const [params, setParams] = useSearchParams();
  const refs = useRefs();
  const all = useTransactions();
  const batches = useImportBatches().data ?? [];
  const [filter, setFilter] = useState<TxFilter>(() => {
    const f: TxFilter = {};
    const a = params.get('accountId');
    if (a) f.accountIds = [a];
    for (const k of ['categoryId', 'merchantId', 'importBatchId', 'tagId', 'from', 'to'] as const) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f;
  });
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<Kind | null>(() => {
    const n = params.get('new');
    return n === 'expense' || n === 'income' || n === 'transfer' ? n : null;
  });
  const [bulkOpen, setBulkOpen] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const tabParam = params.get('tab');
  const tab = tabParam === 'inbox' || tabParam === 'duplicates' ? tabParam : 'all';

  // raw record -> batch, only built when filtering by import batch
  const [batchOfRecord, setBatchOfRecord] = useState<Map<string, string> | undefined>();
  useEffect(() => {
    if (!filter.importBatchId || batchOfRecord) return;
    store
      .run('readonly', ['imported_raw_records'], (tx) =>
        tx.query<D.ImportedRawRecord & { profileId: string }>('imported_raw_records', {
          profileId: profile?.id,
        }),
      )
      .then((rs) => setBatchOfRecord(new Map(rs.map((r) => [r.id, r.importBatchId]))));
  }, [filter.importBatchId, batchOfRecord, store, profile?.id]);

  const rows = useMemo(
    () =>
      filterTransactions(all.data ?? [], filter, {
        merchantName: refs.merchantName,
        batchOfRecord,
      }),
    [all.data, filter, refs, batchOfRecord],
  );
  const currencies = useMemo(
    () =>
      [
        ...new Set((all.data ?? []).flatMap((t) => t.postings.map((p) => p.amount.currency))),
      ].sort(),
    [all.data],
  );
  const selected = useMemo(() => rows.filter((r) => selection[r.id]), [rows, selection]);
  const inboxCount = useMemo(() => (all.data ?? []).filter(isUncategorized).length, [all.data]);

  const dups = useDuplicates().groups.length;
  const setTab = (t: 'all' | 'inbox' | 'duplicates') => {
    const p = new URLSearchParams(params);
    if (t !== 'all') p.set('tab', t);
    else p.delete('tab');
    setParams(p, { replace: true });
  };
  const closeNew = () => {
    setNewKind(null);
    if (params.has('new')) {
      const p = new URLSearchParams(params);
      p.delete('new');
      setParams(p, { replace: true });
    }
  };
  const doExport = async (format: 'csv' | 'json' | 'xlsx') => {
    setExportErr(null);
    try {
      await exportTransactions(format, selected.length ? selected : rows, refs);
    } catch (e) {
      setExportErr((e as Error).message);
    }
  };

  return (
    <div>
      <PageHeader
        title={t('nav.transactions', 'Transactions')}
        actions={
          <>
            <details className="relative">
              <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm font-medium">
                <Download size={14} aria-hidden /> {t('transactions.page.export', 'Export')}
                {selected.length ? ` (${selected.length})` : ''}
              </summary>
              <div className="absolute right-0 z-20 mt-1 flex w-40 flex-col rounded-md border border-line bg-surface p-1 shadow-lg">
                {(['csv', 'json', 'xlsx'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                    onClick={() => doExport(f)}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </details>
            <Button variant="primary" onClick={() => setNewKind('expense')}>
              <Plus size={14} aria-hidden />{' '}
              {t('transactions.page.newTransaction', 'New transaction')}
            </Button>
          </>
        }
      >
        {all.data
          ? `${rows.length.toLocaleString(locale)} of ${all.data.length.toLocaleString(locale)} shown`
          : t('common.loading', 'Loading…')}
      </PageHeader>
      <ErrorText error={exportErr} />
      <Tabs
        label={t('transactions.page.transactionViews', 'Transaction views')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: 'All transactions' },
          { id: 'inbox', label: `Uncategorized inbox${inboxCount ? ` (${inboxCount})` : ''}` },
          { id: 'duplicates', label: `Possible duplicates${dups ? ` (${dups})` : ''}` },
        ]}
      />
      {tab === 'inbox' ? (
        <Inbox refs={refs} onOpen={(t) => setOpenId(t.id)} />
      ) : tab === 'duplicates' ? (
        <DuplicatesList refs={refs} onOpen={setOpenId} />
      ) : (
        <>
          <Filters
            value={filter}
            onChange={setFilter}
            refs={refs}
            currencies={currencies}
            batches={batches}
          />
          {selected.length > 0 && (
            <section
              aria-label={t('transactions.page.selection', 'Selection')}
              className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
            >
              <span>
                {t('transactions.page.lengthSelected', '{{length}} selected ·', {
                  length: selected.length,
                })}{' '}
                {totalsByCurrency(selected).map((m) => (
                  <MoneyText key={m.currency} value={m} locale={locale} className="mr-2" />
                ))}
              </span>
              <Button size="sm" onClick={() => setBulkOpen(true)}>
                <Pencil size={12} aria-hidden /> {t('transactions.page.bulkEdit', 'Bulk edit')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelection({})}>
                {t('transactions.page.clearSelection', 'Clear selection')}
              </Button>
            </section>
          )}
          {all.error ? (
            <ErrorText error={String(all.error)} />
          ) : all.data && all.data.length === 0 ? (
            <Empty title={t('transactions.page.noTransactionsYet', 'No transactions yet')}>
              {t(
                'transactions.page.addOneWithNew',
                'Add one with “New transaction”, or import a bank statement in the Import center.',
              )}
            </Empty>
          ) : (
            <TransactionTable
              rows={rows}
              refs={refs}
              locale={locale}
              selection={selection}
              onSelectionChange={setSelection}
              onOpen={(t) => setOpenId(t.id)}
            />
          )}
        </>
      )}

      <Dialog
        open={!!openId}
        onClose={() => setOpenId(null)}
        title={t('transactions.page.transaction', 'Transaction')}
        side
      >
        {openId && <DetailDrawer txId={openId} refs={refs} onClose={() => setOpenId(null)} />}
      </Dialog>
      <Dialog
        open={!!newKind}
        onClose={closeNew}
        title={t('transactions.page.newTransaction', 'New transaction')}
      >
        {newKind && !refs.loading && (
          <EntryForm
            refs={refs}
            initialKind={newKind}
            onDone={(t) => {
              closeNew();
              setOpenId(t.id);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title={t('transactions.page.bulkEdit', 'Bulk edit')}
      >
        {bulkOpen && (
          <BulkEdit
            rows={selected}
            refs={refs}
            onDone={() => {
              setBulkOpen(false);
              setSelection({});
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
