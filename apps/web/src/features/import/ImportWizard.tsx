// Import workflow (PLAN §25, Features 101, 110, 113, 115, 116, 122, 128, 129):
// choose account + importer → select/drop files → parse in a worker → check totals, balances,
// warnings → stage (immutable raw records, fp1 duplicates flagged) → review rows, categories,
// descriptions → commit. OCR results start deselected: every row needs explicit approval.
// Merchant templates (Feature 125): a merchant named in the description pre-fills its default
// category and split template; the user approves by committing (or unticks / saves new merchants).

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
  type MerchantMatcher,
  merchantMatcher,
  totals,
} from '@finplat/importer-sdk';
import type { ImportPreview } from '@finplat/storage';
import { FileUp, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '../../lib/i18n.ts';
import {
  describeError,
  type Refs,
  useEntities,
  useLedgerEnv,
  useTransactions,
  useWrite,
} from '../transactions/data.ts';
import { Badge, Button, ErrorText, Field, inputCls, MoneyText } from '../transactions/ui.tsx';
import { useAdapters } from './adapters.ts';
import { balanceStatus } from './checks.ts';
import { applyMerchantTemplates } from './merchant-templates.ts';
import { useImportSettings, useRecordCheck } from './store.ts';
import { type Candidate, callWorker } from './worker-types.ts';

const registry = createRegistry();
export const MANIFESTS = registry.manifests();

interface Choice {
  selected: boolean;
  categoryId: string | null;
  description: string;
  merchantId: string | null;
  splitTemplateId: string | null;
  /** Split template proposed by the merchant template (so the user can toggle it back on). */
  splitSuggestion: string | null;
}

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
  choices?: Record<string, Choice>;
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
  const t = useT();
  const { ops, locale, profileId } = useLedgerEnv();
  const adapters = useAdapters(profileId).granted;
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
  const splitTemplates = useEntities('split_templates');
  const matcher = useMemo(
    () => merchantMatcher(refs.merchants, splitTemplates.data ?? []),
    [refs.merchants, splitTemplates.data],
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
            adapter: adapters.find((a) => `custom-${a.id}` === importerId),
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
        source: j.file,
        statements: j.result.statements,
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
        const fromHistory = s && refs.category.has(s.value) ? s.value : null;
        const m = matcher(r.sourceDescription);
        choices[r.id] = {
          selected: row.outcome === 'new' && !j.result.requiresApproval,
          categoryId:
            fromHistory ?? (m?.categoryId && refs.category.has(m.categoryId) ? m.categoryId : null),
          description: r.sourceDescription,
          merchantId: m?.merchantId ?? null,
          // The user's own last choice for this description beats the merchant's split pattern.
          splitTemplateId: fromHistory ? null : (m?.splitTemplateId ?? null),
          splitSuggestion: m?.splitTemplateId ?? null,
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
      const templated = j.preview.rows.flatMap((row) => {
        const c = j.choices?.[row.record.id];
        return c?.selected && (c.merchantId || c.splitTemplateId)
          ? [
              {
                rawRecordId: row.record.id,
                merchantId: c.merchantId,
                splitTemplateId: c.splitTemplateId,
              },
            ]
          : [];
      });
      if (templated.length > 0) await applyTemplates.mutateAsync(templated);
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
  const applyTemplates = useWrite(applyMerchantTemplates);
  const saveMerchant = useWrite((o, v: { name: string; defaultCategoryId: string | null }) =>
    o.create('merchants', v),
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
        <Field label={t('quick.account', 'Account')}>
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
        <Field
          label={t('import.importWizard.importer', 'Importer')}
          hint={t(
            'import.importWizard.autoDetectPicksThe',
            'Auto-detect picks the best match per file',
          )}
        >
          {(id, d) => (
            <select
              id={id}
              aria-describedby={d}
              className={inputCls}
              value={importerId}
              onChange={(e) => setImporterId(e.target.value)}
            >
              <option value="">{t('import.importWizard.autoDetect', 'Auto-detect')}</option>
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.status === 'beta' ? ` ${t('import.importWizard.beta', '(beta)')}` : ''}
                </option>
              ))}
              {adapters.map((a) => (
                <option key={a.id} value={`custom-${a.id}`}>
                  {t('import.importWizard.custom', 'Custom:')} {a.name} ({a.version})
                </option>
              ))}
              {MANIFESTS.filter((m) => m.status === 'blocked_external').map((m) => (
                <option key={m.id} value={m.id} disabled>
                  {m.name}
                  {t('import.importWizard.awaitingFormat', ': awaiting format')}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label={t('import.importWizard.mappingTemplate', 'Mapping template')}
          hint={t(
            'import.importWizard.neededForCsvTsv',
            'Needed for CSV, TSV, XLSX and PDF tables',
          )}
        >
          {(id, d) => (
            <select
              id={id}
              aria-describedby={d}
              className={inputCls}
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">{t('common.none', 'None')}</option>
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
          {t(
            'import.importWizard.createAnAccountFirst',
            'Create an account first; every import belongs to one account.',
          )}
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
          {t(
            'import.importWizard.dropStatementFilesHere',
            'Drop statement files here or choose files (CSV, TSV, XLSX, XLS, OFX, QFX, QIF, CAMT.053/054, MT940, JSON, PDF)',
          )}
        </span>
        <span className="text-xs text-muted">
          {t(
            'import.importWizard.filesAreParsedIn',
            'Files are parsed in this browser; only the parsed records are stored.',
          )}
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
            {busy
              ? t('import.importWizard.parsing', 'Parsing…')
              : t('import.importWizard.parseFiles', 'Parse files')}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setJobs((js) => js.filter((j) => j.status === 'committed' || j.status === 'staged'))
            }
          >
            {t('import.importWizard.clearUnstaged', 'Clear unstaged')}
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
              <span className="text-xs text-muted">
                {Math.ceil(j.file.size / 1024)} {t('import.importWizard.kb', 'KB')}
              </span>
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
              aria-label={t('import.importWizard.parsingProgress', 'Parsing progress')}
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
                {t('import.importWizard.stageForReview', 'Stage for review')}
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
              splitTemplateName={(id) =>
                splitTemplates.data?.find((t) => t.id === id)?.name ?? 'split template'
              }
              onSaveMerchant={async (name, categoryId) => {
                try {
                  const m = await saveMerchant.mutateAsync({ name, defaultCategoryId: categoryId });
                  return merchantMatcher([m], splitTemplates.data ?? []);
                } catch (e) {
                  setErr(describeError(e));
                  return null;
                }
              }}
              onCommit={() => commit(j)}
              committing={commitWrite.isPending}
            />
          )}
          {j.status === 'committed' && j.committed && (
            <p role="status" className="text-sm text-pos">
              {t('import.importWizard.committed', 'Committed:')}{' '}
              {String(j.committed.stats.created ?? 0)}{' '}
              {t('import.importWizard.transactionsCreated', 'transactions created,')}{' '}
              {String(j.committed.stats.duplicates ?? 0)}{' '}
              {t('import.importWizard.duplicatesSkipped', 'duplicates skipped.')}
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
  const t = useT();
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
        {t('import.importWizard.statementOpeningBalance', 'Statement opening balance')}{' '}
        <MoneyText value={ob} locale={locale} />
      </span>
    ) : null;
  return (
    <Button size="sm" onClick={() => onCreate(ob)}>
      {t('import.importWizard.setOpeningBalance', 'Set opening balance')}{' '}
      <MoneyText value={ob} locale={locale} />
    </Button>
  );
}

function ParseSummary({ j, locale }: { j: Job; locale: string }) {
  const t = useT();
  const r = j.result as ImportResult;
  const tot = totals(r.records);
  const running = checkRunningBalances(r.records);
  const dates = r.records.map((x) => x.postingDate).sort();
  const name = MANIFESTS.find((m) => m.id === j.importerId)?.name ?? j.importerId;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {r.records.length} {t('import.importWizard.recordsBy', 'records by')}{' '}
        <strong>{name}</strong> ({r.format}
        {r.encoding && `, ${r.encoding}`}) · {dates[0] ?? '—'} {t('import.importWizard.to', 'to')}{' '}
        {dates.at(-1) ?? '—'} {t('import.importWizard.confidence', '· confidence')}{' '}
        {Math.round(r.confidence * 100)}%
        {j.candidates && j.candidates.length > 1 && (
          <span className="text-muted">
            {' '}
            {t('import.importWizard.alsoMatched', '· also matched:')}{' '}
            {j.candidates
              .slice(1, 3)
              .map((c) => c.name)
              .join(', ')}
          </span>
        )}
      </p>
      {r.requiresApproval && (
        <p className="text-warn">
          {t(
            'import.importWizard.ocrResultValuesMay',
            'OCR result: values may be wrong. Rows start unselected; approve each one after checking it against the document.',
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-4">
        {tot.map((x) => (
          <span key={x.currency}>
            {t('import.importWizard.in', 'In')} <MoneyText value={x.income} locale={locale} />{' '}
            {t('import.importWizard.out', '· Out')} <MoneyText value={x.expenses} locale={locale} />{' '}
            {t('import.importWizard.net', '· Net')}{' '}
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
            {t('import.importWizard.statement', 'Statement')} {s.ref ?? i + 1}{' '}
            {s.periodStart && `${s.periodStart}–${s.periodEnd}`}:{' '}
            {c.status === 'balanced' && (
              <Badge tone="green">{t('import.importWizard.balances', 'balances')}</Badge>
            )}
            {c.status === 'mismatch' && (
              <Badge tone="red">
                {t('import.importWizard.offBy', 'off by')} {c.difference.amount}{' '}
                {c.difference.currency}
              </Badge>
            )}
            {c.status === 'unverifiable' && (
              <Badge>
                {t('import.importWizard.notVerifiable', 'not verifiable:')} {c.reason}
              </Badge>
            )}
          </p>
        );
      })}
      {running.order !== 'unknown' && (
        <p>
          {t('import.importWizard.runningBalances', 'Running balances (')}
          {running.order.replace('_', ' ')}):{' '}
          {running.breaks.length === 0 ? (
            <Badge tone="green">{t('import.importWizard.consistent', 'consistent')}</Badge>
          ) : (
            <Badge tone="amber">
              {running.breaks.length} {t('import.importWizard.breaksRows', 'breaks (rows')}{' '}
              {running.breaks.slice(0, 8).join(', ')})
            </Badge>
          )}
        </p>
      )}
      {(r.errors.length > 0 || r.warnings.length > 0) && (
        <details>
          <summary className="cursor-pointer text-warn">
            {r.errors.length} {t('import.importWizard.errors', 'errors,')} {r.warnings.length}{' '}
            {t('import.importWizard.warnings', 'warnings')}
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
  splitTemplateName,
  onSaveMerchant,
}: {
  job: Job;
  refs: Refs;
  locale: string;
  onChange: (c: NonNullable<Job['choices']>) => void;
  onCommit: () => void;
  committing: boolean;
  splitTemplateName: (id: string) => string;
  onSaveMerchant: (name: string, categoryId: string | null) => Promise<MerchantMatcher | null>;
}) {
  const t = useT();
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
  // Save a merchant template from a row, then pre-fill every other unmatched, uncategorized row it matches.
  const saveMerchant = async (id: string) => {
    const c = choices[id] as Choice;
    const name = window.prompt('Merchant name (matched inside bank descriptions)', c.description);
    if (!name?.trim()) return;
    const match = await onSaveMerchant(name.trim(), c.categoryId);
    if (!match) return;
    const next = { ...choices };
    for (const row of p.rows) {
      const cur = next[row.record.id];
      if (!cur || cur.merchantId) continue;
      const m = match(row.record.sourceDescription) ?? (row.record.id === id ? match(name) : null);
      if (!m) continue;
      next[row.record.id] = {
        ...cur,
        merchantId: m.merchantId,
        categoryId: cur.categoryId ?? m.categoryId,
        splitTemplateId: cur.categoryId ? null : m.splitTemplateId,
        splitSuggestion: m.splitTemplateId,
      };
    }
    onChange(next);
  };
  const allOnPage = pageRows.every((r) => choices[r.record.id]?.selected);

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-sm">
        {p.totals.count} {t('import.importWizard.rows', 'rows ·')} {p.totals.duplicates}{' '}
        {t(
          'import.importWizard.alreadyImportedDuplicatesIncome',
          'already imported (duplicates) · income',
        )}{' '}
        <MoneyText value={p.totals.income} locale={locale} />{' '}
        {t('import.importWizard.expenses', '· expenses')}{' '}
        <MoneyText value={p.totals.expenses} locale={locale} />
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          aria-label={t('import.importWizard.showRows', 'Show rows')}
          className={`${inputCls} h-7 w-auto text-xs`}
          value={show}
          onChange={(e) => {
            setShow(e.target.value as typeof show);
            setPage(0);
          }}
        >
          <option value="all">{t('import.importWizard.allRows', 'All rows')}</option>
          <option value="new">{t('import.importWizard.newOnly', 'New only')}</option>
          <option value="duplicate">
            {t('import.importWizard.duplicatesOnly', 'Duplicates only')}
          </option>
          <option value="warnings">{t('import.importWizard.withWarnings', 'With warnings')}</option>
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
          {t('import.importWizard.selectAllNew', 'Select all new')}
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
          {t('import.importWizard.selectNone', 'Select none')}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="w-8 py-1">
                <input
                  type="checkbox"
                  aria-label={t('import.importWizard.selectPage', 'Select page')}
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
              <th className="font-medium">{t('transaction.date', 'Date')}</th>
              <th className="font-medium">{t('transaction.description', 'Description')}</th>
              <th className="text-right font-medium">{t('transaction.amount', 'Amount')}</th>
              <th className="font-medium">{t('transaction.category', 'Category')}</th>
              <th className="font-medium">{t('import.importWizard.flags', 'Flags')}</th>
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
                      onChange={(e) =>
                        set(r.id, { categoryId: e.target.value || null, splitTemplateId: null })
                      }
                    >
                      <option value="">
                        {t(
                          'import.importWizard.uncategorizedRulesMayApply',
                          'Uncategorized (rules may apply)',
                        )}
                      </option>
                      {refs.categoryOptions
                        .filter((o) => o.kind === kind)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                    </select>
                    {c.merchantId && (
                      <span className="block text-xs text-muted">
                        {refs.merchantName(c.merchantId)}
                      </span>
                    )}
                  </td>
                  <td className="text-xs">
                    {c.splitSuggestion && (
                      <label className="mr-1 inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={c.splitTemplateId !== null}
                          onChange={(e) =>
                            set(r.id, {
                              splitTemplateId: e.target.checked ? c.splitSuggestion : null,
                            })
                          }
                          aria-label={`Apply split template to row ${r.rowNumber}`}
                        />
                        {t('import.importWizard.split', 'split:')}{' '}
                        {splitTemplateName(c.splitSuggestion)}
                      </label>
                    )}
                    {!c.merchantId && (
                      <Button size="sm" onClick={() => saveMerchant(r.id)}>
                        {t('import.importWizard.saveMerchant', 'Save merchant')}
                      </Button>
                    )}
                    {row.outcome === 'duplicate' && (
                      <Badge tone="amber">{t('import.importWizard.duplicate', 'duplicate')}</Badge>
                    )}
                    {r.warnings.length > 0 && (
                      <span title={r.warnings.join('; ')} className="ml-1 text-warn">
                        {r.warnings.length} {t('import.importWizard.warningS', 'warning(s)')}
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
        <nav
          aria-label={t('import.importWizard.rowsPages', 'Rows pages')}
          className="flex items-center gap-2 text-sm"
        >
          <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            {t('reports.page.previous', 'Previous')}
          </Button>
          <span>
            {page * PAGE + 1}–{Math.min((page + 1) * PAGE, rows.length)} {t('goals.page.of', 'of')}{' '}
            {rows.length}
          </span>
          <Button
            size="sm"
            disabled={(page + 1) * PAGE >= rows.length}
            onClick={() => setPage(page + 1)}
          >
            {t('common.next', 'Next')}
          </Button>
        </nav>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onClick={onCommit} disabled={committing || selectedCount === 0}>
          {t('import.importWizard.commit', 'Commit')} {selectedCount}{' '}
          {t('import.importWizard.transactions', 'transactions')}
        </Button>
      </div>
    </div>
  );
}
