// Import history (Feature 114/130): every batch with coverage and counts; rollback removes only
// the transactions a batch created (raw evidence stays); reprocess re-reads the original file
// with the current importer after rolling the old batch back.
import type * as D from '@finplat/domain';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../lib/i18n.ts';
import { describeError, type Refs, useImportBatches, useWrite } from '../transactions/data.ts';
import { Badge, Button, Empty, ErrorText } from '../transactions/ui.tsx';
import { MANIFESTS } from './ImportWizard.tsx';
import { useImportSettings } from './store.ts';

export function History({
  refs,
  onReprocess,
}: {
  refs: Refs;
  onReprocess: (file: File, batch: D.ImportBatch) => void;
}) {
  const t = useT();
  const batches = useImportBatches();
  const settings = useImportSettings();
  const rollback = useWrite((o, id: string) => o.rollbackImport(id));
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [reproc, setReproc] = useState<D.ImportBatch | null>(null);

  const pickForReprocess = (b: D.ImportBatch) => {
    setReproc(b);
    fileInput.current?.click();
  };
  const onFile = async (f: File | undefined) => {
    const b = reproc;
    setReproc(null);
    if (!f || !b) return;
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
    if (
      sha !== b.fileSha256 &&
      !window.confirm(
        t(
          'import.history.reprocessDifferentFile',
          'This is not the same file that was imported (different SHA-256). Reprocess anyway?',
        ),
      )
    )
      return;
    try {
      if (b.status === 'committed') await rollback.mutateAsync(b.id);
      onReprocess(f, b);
    } catch (e) {
      setErr(describeError(e));
    }
  };

  if (!batches.data?.length)
    return (
      <Empty title={t('import.history.noImportsYet', 'No imports yet')}>
        {t(
          'import.history.importedStatementsAppearHere',
          'Imported statements appear here with rollback and reprocess.',
        )}
      </Empty>
    );
  return (
    <div className="flex flex-col gap-2">
      <ErrorText error={err} />
      <input
        ref={fileInput}
        type="file"
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => onFile(e.target.files?.[0] ?? undefined)}
      />
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-2 py-2 font-medium">
                {t('transactions.transactionTable.imported', 'Imported')}
              </th>
              <th className="font-medium">{t('import.history.file', 'File')}</th>
              <th className="font-medium">{t('quick.account', 'Account')}</th>
              <th className="font-medium">{t('import.history.period', 'Period')}</th>
              <th className="font-medium">{t('import.history.rows', 'Rows')}</th>
              <th className="font-medium">{t('sync.status', 'Status')}</th>
              <th className="font-medium">
                <span className="sr-only">{t('common.actions', 'Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {batches.data.map((b) => {
              const check = settings.data?.checks[b.id];
              return (
                <tr key={b.id} className="border-t border-line">
                  <td className="px-2 py-2 whitespace-nowrap tabular-nums">
                    {b.createdAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="max-w-56 truncate">
                    {b.fileName}
                    <span className="block text-xs text-muted">
                      {MANIFESTS.find((m) => m.id === b.importerId)?.name ?? b.importerId}{' '}
                      {b.importerVersion}
                    </span>
                  </td>
                  <td>{b.accountId ? refs.accountName(b.accountId) : '—'}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {b.coverageStart ?? '?'} – {b.coverageEnd ?? '?'}
                  </td>
                  <td className="tabular-nums">
                    {String(b.stats.records ?? '?')}
                    {b.stats.created !== undefined && (
                      <span className="block text-xs text-muted">
                        {String(b.stats.created)} {t('import.history.created', 'created')}
                      </span>
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={
                        b.status === 'committed'
                          ? 'green'
                          : b.status === 'rolled_back'
                            ? 'neutral'
                            : b.status === 'failed'
                              ? 'red'
                              : 'blue'
                      }
                    >
                      {b.status.replace('_', ' ')}
                    </Badge>
                    {check === 'balanced' && (
                      <Badge tone="green">{t('import.history.balanced', 'balanced')}</Badge>
                    )}
                    {check === 'mismatch' && (
                      <Badge tone="red">
                        {t('import.history.balanceMismatch', 'balance mismatch')}
                      </Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {b.status === 'committed' && (
                      <>
                        <Link
                          className="mr-2 text-xs text-accent underline"
                          to={`/transactions?importBatchId=${b.id}`}
                        >
                          {t('admin.transactions', 'Transactions')}
                        </Link>
                        <Button
                          size="sm"
                          onClick={() =>
                            window.confirm(
                              t(
                                'import.history.rollbackConfirm',
                                'Roll back {{name}}? Its transactions are removed; the raw records stay as evidence.',
                                { name: b.fileName },
                              ),
                            ) && rollback.mutateAsync(b.id).catch((e) => setErr(describeError(e)))
                          }
                        >
                          {t('import.history.rollBack', 'Roll back')}
                        </Button>
                      </>
                    )}
                    {(b.status === 'committed' ||
                      b.status === 'rolled_back' ||
                      b.status === 'staged') && (
                      <Button size="sm" variant="ghost" onClick={() => pickForReprocess(b)}>
                        {t('import.history.reprocess', 'Reprocess…')}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        {t(
          'import.history.reprocessAsksForThe',
          'Reprocess asks for the original file again (only parsed records are stored), rolls the old batch back and stages the file with the current importer version.',
        )}
      </p>
    </div>
  );
}
