// Import workflow (PLAN §25, Features 101, 110, 113, 115, 116, 122, 128, 129):
// choose account + importer → select/drop files → parse in a worker → check totals, balances,
// warnings → stage (immutable raw records, fp1 duplicates flagged) → review rows, categories,
// descriptions → commit. OCR results start deselected: every row needs explicit approval.

import { createRegistry } from '@finplat/bank-importers';
import type * as D from '@finplat/domain';
import {
  buildCategoryHistory,
  type LedgerTransaction,
  suggestCategory,
  toMinor,
} from '@finplat/finance-engine';
import {
  checkRunningBalances,
  checkStatementBalance,
  type ImportResult,
  totals,
} from '@finplat/importer-sdk';
import type { ImportPreview } from '@finplat/storage';
import { FileUp, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  describeError,
  type Refs,
  useLedgerEnv,
  useTransactions,
  useWrite,
} from '../transactions/data.ts';
import { Badge, Button, ErrorText, Field, inputCls, MoneyText } from '../transactions/ui.tsx';
import { balanceStatus } from './checks.ts';
import { useImportSettings, useRecordCheck } from './store.ts';
import { type Candidate, callWorker } from './worker-types.ts';

const registry = createRegistry();
export const MANIFESTS = registry.manifests();

interface Job {
  key: string;
  file: File;
  status: 'queued' | 'parsing' | 'parsed' | 'error' | 'staged' | 'committed';
  progress?: number;
  error?: string;
  result?: ImportResult;
  importerId?: string;
  candidates?: Candidate[];
  sha256?: string;
  preview?: ImportPreview;
  choices?: Record<string, { selected: boolean; categoryId: string | null; description: string }>;
  committed?: D.ImportBatch;
}

export function ImportWizard({
  refs,
  initialFiles,
  initialAccountId,
  onCommitted,
}: {
  refs: Refs;
  initialFiles?: File[];
  initialAccountId?: string;
  onCommitted?: () => void;
}) {
  const { ops, locale } = useLedgerEnv();
  const settings = useImportSettings();
  const txs = useTransactions();
  const accounts = refs.accounts.filter((a) => !a.isArchived);
  const [accountId, setAccountId] = useState(initialAccountId ?? accounts[0]?.id ?? '');
  const [importerId, setImporterId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [jobs, setJobs] = useState<Job[]>(() =>
    (initialFiles ?? []).map((f, i) => ({ key: `${i}:${f.name}`, file: f, status: 'queued' })),
  );
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const recordCheck = useRecordCheck();
  const account = refs.account.get(accountId);
  const templates = settings.data?.templates ?? [];
  const template = templates.find((t) => t.id === templateId);

  const history = useMemo(
    () => buildCategoryHistory((txs.data ?? []) as unknown as LedgerTransaction[]),
    [txs.data],
  );
  const hasOpening = (txs.data ?? []).some(
    (t) => t.kind === 'opening_balance' && t.postings.some((p) => p.accountId === accountId),
  );

  const update = (key: string, p: Partial<Job>) =>
    setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));
  const addFiles = (fl: FileList | File[] | null) => {
    const list = [...(fl ?? [])];
    setJobs((js) => [
      ...js,
      ...list.map((f) => ({
        key: `${Date.now()}:${Math.random()}:${f.name}`,
        file: f,
        status: 'queued' as const,
      })),
    ]);
  };

  const parseAll = async () => {
    setErr(null);
    if (!account) return setErr('Choose the account these statements belong to.');
    setBusy(true);
    for (const j of jobs.filter((x) => x.status === 'queued' || x.status === 'error')) {
      update(j.key, { status: 'parsing', progress: 0, error: undefined });
      try {
        const tplImporter = template
          ? template.format === 'pdf'
            ? 'generic-pdf-text'
            : template.format === 'xlsx' && /\.xls$/i.test(j.file.name)
              ? 'generic-xls'
              : `generic-${template.format}`
          : undefined;
        const r = await callWorker(
          {
            kind: 'parse',
            file: j.file,
            importerId: importerId || tplImporter,
            template,
            accountCurrency: account.currency,
          },
          (b, total) =>
            update(j.key, { progress: total ? Math.round((b / total) * 100) : undefined }),
        );
        if (r.type !== 'parsed') throw new Error('unexpected worker reply');
        update(j.key, {
          status: 'parsed',
          result: r.result,
          importerId: r.importerId,
          candidates: r.candidates,
          sha256: r.sha256,
        });
      } catch (e) {
        update(j.key, { status: 'error', error: describeError(e) });
      }
    }
    setBusy(false);
  };

  const stage = async (j: Job) => {
    setErr(null);
    if (!j.result || !j.importerId || !j.sha256 || !account) return;
    try {
      const preview = await ops.stageImport({
        accountId: account.id,
        importerId: j.importerId,
        importerVersion: j.result.importerVersion,
        fileName: j.file.name,
        fileSha256: j.sha256,
        fileSize: j.file.size,
        records: j.result.records.map((r) => ({
          ...r,
          warnings: r.warnings.map((w) => ({ message: w.message })),
        })),
      });
      const choices: NonNullable<Job['choices']> = {};
      for (const row of preview.rows) {
        const r = row.record;
        const s = suggestCategory(history, {
          id: r.id,
          kind: toMinor(r.amount) < 0n ? 'expense' : 'income',
          bookingDate: r.postingDate,
          payee: r.counterparty,
          description: r.sourceDescription,
          postings: [{ accountId: account.id, amount: r.amount }],
        });
        choices[r.id] = {
          selected: row.outcome === 'new' && !j.result.requiresApproval,
          categoryId: s && refs.category.has(s.value) ? s.value : null,
          description: r.sourceDescription,
        };
      }
      update(j.key, { status: 'staged', preview, choices });
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const commit = async (j: Job) => {
    setErr(null);
    if (!j.preview || !j.choices || !j.result) return;
    if (
      j.result.requiresApproval &&
      !window.confirm(
        'These values were read by OCR. Confirm you checked every selected row against the document.',
      )
    )
      return;
    try {
      const rows = j.preview.rows.map((row) => {
        const c = j.choices?.[row.record.id];
        return {
          rawRecordId: row.record.id,
          selected: c?.selected ?? false,
          categoryId: c?.categoryId ?? null,
          ...(c && c.description !== row.record.sourceDescription
            ? { description: c.description }
            : {}),
        };
      });
      const batch = await commitWrite.mutateAsync({ batchId: j.preview.batch.id, rows });
      await recordCheck
        .mutateAsync({ batchId: batch.id, status: balanceStatus(j.result) })
        .catch(() => undefined);
      update(j.key, { status: 'committed', committed: batch });
      onCommitted?.();
    } catch (e) {
      setErr(describeError(e));
    }
  };
  const commitWrite = useWrite(
    (o, v: { batchId: string; rows: Parameters<typeof o.commitImport>[1] }) =>
      o.commitImport(v.batchId, v.rows),
  );
  const opening = useWrite((o, m: D.Money) =>
    o.createTransaction({
      kind: 'opening_balance',
      accountId,
      amount: m,
      bookingDate: openingDate(jobs),
      description: 'Opening balance (from statement)',
    }),
  );

  const usable = MANIFESTS.filter((m) => m.status !== 'blocked_external');
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Account">
          {(id) => (
            <select
              id={id}
              className={inputCls}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Importer" hint="Auto-detect picks the best match per file">
          {(id, d) => (
            <select
              id={id}
              aria-describedby={d}
              className={inputCls}
              value={importerId}
              onChange={(e) => setImporterId(e.target.value)}
            >
              <option value="">Auto-detect</option>
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.status === 'beta' ? ' (beta)' : ''}
                </option>
              ))}
              {MANIFESTS.filter((m) => m.status === 'blocked_external').map((m) => (
                <option key={m.id} value={m.id} disabled>
                  {m.name}: awaiting format
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Mapping template" hint="Needed for CSV, TSV, XLSX and PDF tables">
          {(id, d) => (
            <select
              id={id}
              aria-describedby={d}
              className={inputCls}
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">None</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.format})
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {accounts.length === 0 && (
        <p className="text-sm text-warn">
          Create an account first; every import belongs to one account.
        </p>
      )}

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm focus-within:ring-2 focus-within:ring-accent ${drag ? 'border-accent bg-accent/10' : 'border-line'}`}
      >
        <FileUp size={24} aria-hidden className="text-muted" />
        <span>
          Drop statement files here or choose files (CSV, TSV, XLSX, XLS, OFX, QFX, QIF,
          CAMT.053/054, MT940, JSON, PDF)
        </span>
        <span className="text-xs text-muted">
          Files are parsed in this browser; only the parsed records are stored.
        </span>
        <input
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => addFiles(e.target.files)}
        />
      </label>

      {jobs.length > 0 && (
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={parseAll}
            disabled={busy || !jobs.some((j) => j.status === 'queued' || j.status === 'error')}
          >
            {busy ? 'Parsing…' : 'Parse files'}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setJobs((js) => js.filter((j) => j.status === 'committed' || j.status === 'staged'))
            }
          >
            Clear unstaged
          </Button>
        </div>
      )}
      <ErrorText error={err} />

      {jobs.map((j) => (
        <article
          key={j.key}
          aria-label={j.file.name}
          className="rounded-lg border border-line bg-surface p-3"
        >
          <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">
              {j.file.name}{' '}
              <span className="text-xs text-muted">{Math.ceil(j.file.size / 1024)} KB</span>
            </h3>
            <div className="flex items-center gap-2">
              <Badge
                tone={
                  j.status === 'error'
                    ? 'red'
                    : j.status === 'committed'
                      ? 'green'
                      : j.status === 'staged'
                        ? 'blue'
                        : 'neutral'
                }
              >
                {j.status}
              </Badge>
              {(j.status === 'queued' || j.status === 'error' || j.status === 'parsed') && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${j.file.name}`}
                  onClick={() => setJobs((js) => js.filter((x) => x.key !== j.key))}
                >
                  <X size={14} aria-hidden />
                </Button>
              )}
            </div>
          </header>
          {j.status === 'parsing' && (
            <progress
              className="w-full"
              max={100}
              value={j.progress}
              aria-label="Parsing progress"
            />
          )}
          {j.error && <ErrorText error={j.error} />}
          {j.result && <ParseSummary j={j} locale={locale} />}
          {j.status === 'parsed' && j.result && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={j.result.records.length === 0}
                onClick={() => stage(j)}
              >
                Stage for review
              </Button>
              {!hasOpening && (
                <OpeningOffer
                  result={j.result}
                  locale={locale}
                  onCreate={(m) => opening.mutateAsync(m).catch((e) => setErr(describeError(e)))}
                />
              )}
            </div>
          )}
          {j.status === 'staged' && j.preview && j.choices && (
            <StagedRows
              job={j}
              refs={refs}
              locale={locale}
              onChange={(choices) => update(j.key, { choices })}
              onCommit={() => commit(j)}
              committing={commitWrite.isPending}
            />
          )}
          {j.status === 'committed' && j.committed && (
            <p role="status" className="text-sm text-pos">
              Committed: {String(j.committed.stats.created ?? 0)} transactions created,{' '}
              {String(j.committed.stats.duplicates ?? 0)} duplicates skipped.
            </p>
          )}
        </article>
      ))}
    </div>
  );
}

const openingDate = (jobs: Job[]) =>
  jobs.flatMap((j) => j.result?.records.map((r) => r.postingDate) ?? []).sort()[0] ??
  new Date().toISOString().slice(0, 10);

function OpeningOffer({
  result,
  locale,
  onCreate,
}: {
  result: ImportResult;
  locale: string;
  onCreate: (m: D.Money) => void;
}) {
  // Feature 129: balance before the first row, from the statement or the running balances.
  const st = result.statements.find((s) => s.openingBalance !== undefined);
  const cur = st?.currency ?? result.records[0]?.currency;
  const fromStmt =
    st?.openingBalance !== undefined && cur
      ? { amount: st.openingBalance, currency: cur }
      : undefined;
  const ob = fromStmt ?? checkRunningBalances(result.records).openingBalance;
  if (!ob || toMinor(ob) <= 0n)
    return ob ? (
      <span className="text-xs text-muted">
        Statement opening balance <MoneyText value={ob} locale={locale} />
      </span>
    ) : null;
  return (
    <Button size="sm" onClick={() => onCreate(ob)}>
      Set opening balance <MoneyText value={ob} locale={locale} />
    </Button>
  );
}

function ParseSummary({ j, locale }: { j: Job; locale: string }) {
  const r = j.result as ImportResult;
  const t = totals(r.records);
  const running = checkRunningBalances(r.records);
  const dates = r.records.map((x) => x.postingDate).sort();
  const name = MANIFESTS.find((m) => m.id === j.importerId)?.name ?? j.importerId;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {r.records.length} records by <strong>{name}</strong> ({r.format}
        {r.encoding && `, ${r.encoding}`}) · {dates[0] ?? '—'} to {dates.at(-1) ?? '—'} · confidence{' '}
        {Math.round(r.confidence * 100)}%
        {j.candidates && j.candidates.length > 1 && (
          <span className="text-muted">
            {' '}
            · also matched:{' '}
            {j.candidates
              .slice(1, 3)
              .map((c) => c.name)
              .join(', ')}
          </span>
        )}
      </p>
      {r.requiresApproval && (
        <p className="text-warn">
          OCR result: values may be wrong. Rows start unselected; approve each one after checking it
          against the document.
        </p>
      )}
      <div className="flex flex-wrap gap-4">
        {t.map((x) => (
          <span key={x.currency}>
            In <MoneyText value={x.income} locale={locale} /> · Out{' '}
            <MoneyText value={x.expenses} locale={locale} /> · Net{' '}
            <MoneyText value={x.net} locale={locale} signed />
          </span>
        ))}
      </div>
      {r.statements.map((s, i) => {
        const c = checkStatementBalance(
          s,
          r.records.filter((x) => !s.ref || x.statementRef === s.ref),
        );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: statements have no stable id
          <p key={i}>
            Statement {s.ref ?? i + 1} {s.periodStart && `${s.periodStart}–${s.periodEnd}`}:{' '}
            {c.status === 'balanced' && <Badge tone="green">balances</Badge>}
            {c.status === 'mismatch' && (
              <Badge tone="red">
                off by {c.difference.amount} {c.difference.currency}
              </Badge>
            )}
            {c.status === 'unverifiable' && <Badge>not verifiable: {c.reason}</Badge>}
          </p>
        );
      })}
      {running.order !== 'unknown' && (
        <p>
          Running balances ({running.order.replace('_', ' ')}):{' '}
          {running.breaks.length === 0 ? (
            <Badge tone="green">consistent</Badge>
          ) : (
            <Badge tone="amber">
              {running.breaks.length} breaks (rows {running.breaks.slice(0, 8).join(', ')})
            </Badge>
          )}
        </p>
      )}
      {(r.errors.length > 0 || r.warnings.length > 0) && (
        <details>
          <summary className="cursor-pointer text-warn">
            {r.errors.length} errors, {r.warnings.length} warnings
          </summary>
          <ul className="mt-1 max-h-40 overflow-auto text-xs">
            {[
              ...r.errors.map((e) => ({ ...e, sev: 'error' })),
              ...r.warnings.map((w) => ({ ...w, sev: 'warning' })),
            ]
              .slice(0, 200)
              .map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: issues have no id
                <li key={i} className={e.sev === 'error' ? 'text-neg' : ''}>
                  {e.row !== undefined && `row ${e.row}: `}
                  {e.field && `${e.field}: `}
                  {e.message}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const PAGE = 100;

function StagedRows({
  job,
  refs,
  locale,
  onChange,
  onCommit,
  committing,
}: {
  job: Job;
  refs: Refs;
  locale: string;
  onChange: (c: NonNullable<Job['choices']>) => void;
  onCommit: () => void;
  committing: boolean;
}) {
  const p = job.preview as ImportPreview;
  const choices = job.choices as NonNullable<Job['choices']>;
  const [page, setPage] = useState(0);
  const [show, setShow] = useState<'all' | 'new' | 'duplicate' | 'warnings'>('all');
  const rows = p.rows.filter((r) =>
    show === 'all' ? true : show === 'warnings' ? r.record.warnings.length > 0 : r.outcome === show,
  );
  const pageRows = rows.slice(page * PAGE, (page + 1) * PAGE);
  const set = (id: string, v: Partial<NonNullable<Job['choices']>[string]>) =>
    onChange({
      ...choices,
      [id]: { ...(choices[id] as NonNullable<Job['choices']>[string]), ...v },
    });
  const selectedCount = Object.values(choices).filter((c) => c.selected).length;
  const allOnPage = pageRows.every((r) => choices[r.record.id]?.selected);

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-sm">
        {p.totals.count} rows · {p.totals.duplicates} already imported (duplicates) · income{' '}
        <MoneyText value={p.totals.income} locale={locale} /> · expenses{' '}
        <MoneyText value={p.totals.expenses} locale={locale} />
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          aria-label="Show rows"
          className={`${inputCls} h-7 w-auto text-xs`}
          value={show}
          onChange={(e) => {
            setShow(e.target.value as typeof show);
            setPage(0);
          }}
        >
          <option value="all">All rows</option>
          <option value="new">New only</option>
          <option value="duplicate">Duplicates only</option>
          <option value="warnings">With warnings</option>
        </select>
        <Button
          size="sm"
          onClick={() =>
            onChange(
              Object.fromEntries(
                Object.entries(choices).map(([k, c]) => [
                  k,
                  { ...c, selected: p.rows.find((r) => r.record.id === k)?.outcome === 'new' },
                ]),
              ),
            )
          }
        >
          Select all new
        </Button>
        <Button
          size="sm"
          onClick={() =>
            onChange(
              Object.fromEntries(
                Object.entries(choices).map(([k, c]) => [k, { ...c, selected: false }]),
              ),
            )
          }
        >
          Select none
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="w-8 py-1">
                <input
                  type="checkbox"
                  aria-label="Select page"
                  checked={allOnPage}
                  onChange={(e) =>
                    onChange({
                      ...choices,
                      ...Object.fromEntries(
                        pageRows.map((r) => [
                          r.record.id,
                          {
                            ...(choices[r.record.id] as NonNullable<Job['choices']>[string]),
                            selected: e.target.checked,
                          },
                        ]),
                      ),
                    })
                  }
                />
              </th>
              <th className="font-medium">Date</th>
              <th className="font-medium">Description</th>
              <th className="text-right font-medium">Amount</th>
              <th className="font-medium">Category</th>
              <th className="font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const r = row.record;
              const c = choices[r.id];
              if (!c) return null;
              const kind = toMinor(r.amount) < 0n ? 'expense' : 'income';
              return (
                <tr
                  key={r.id}
                  className={`border-t border-line ${row.outcome === 'duplicate' ? 'opacity-70' : ''}`}
                >
                  <td className="py-1">
                    <input
                      type="checkbox"
                      aria-label={`Import row ${r.rowNumber}`}
                      checked={c.selected}
                      onChange={(e) => set(r.id, { selected: e.target.checked })}
                    />
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{r.postingDate}</td>
                  <td className="min-w-48">
                    <input
                      aria-label={`Description of row ${r.rowNumber}`}
                      className={`${inputCls} h-7`}
                      value={c.description}
                      onChange={(e) => set(r.id, { description: e.target.value })}
                    />
                    {r.counterparty && <span className="text-xs text-muted">{r.counterparty}</span>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <MoneyText value={r.amount} locale={locale} signed />
                  </td>
                  <td>
                    <select
                      aria-label={`Category of row ${r.rowNumber}`}
                      className={`${inputCls} h-7 min-w-36 text-xs`}
                      value={c.categoryId ?? ''}
                      onChange={(e) => set(r.id, { categoryId: e.target.value || null })}
                    >
                      <option value="">Uncategorized (rules may apply)</option>
                      {refs.categoryOptions
                        .filter((o) => o.kind === kind)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td className="text-xs">
                    {row.outcome === 'duplicate' && <Badge tone="amber">duplicate</Badge>}
                    {r.warnings.length > 0 && (
                      <span title={r.warnings.join('; ')} className="ml-1 text-warn">
                        {r.warnings.length} warning(s)
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > PAGE && (
        <nav aria-label="Rows pages" className="flex items-center gap-2 text-sm">
          <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            {page * PAGE + 1}–{Math.min((page + 1) * PAGE, rows.length)} of {rows.length}
          </span>
          <Button
            size="sm"
            disabled={(page + 1) * PAGE >= rows.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </nav>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onClick={onCommit} disabled={committing || selectedCount === 0}>
          Commit {selectedCount} transactions
        </Button>
      </div>
    </div>
  );
}
