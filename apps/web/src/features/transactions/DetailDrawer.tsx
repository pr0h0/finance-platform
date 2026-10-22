// Transaction detail: interpretation edits, original bank record (read-only), splits,
// attachments, refunds, planned-transaction matching, history/undo, duplicate/void/delete.
import type * as D from '@finplat/domain';
import { fromMinor, matchPlanned, money, toMinor } from '@finplat/finance-engine';
import { inputFromBlob } from '@finplat/importer-sdk';
import { useQuery } from '@tanstack/react-query';
import { Ban, Copy, FileUp, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useData } from '../../app/data.tsx';
import { useT } from '../../lib/i18n.ts';
import { ocrAssets } from '../../lib/ocr.ts';
import {
  describeError,
  qk,
  type Refs,
  useEntities,
  useLedgerEnv,
  useTransactions,
  useWrite,
} from './data.ts';
import { DuplicateNotice } from './duplicates.tsx';
import { absMoney, duplicateInput, primaryAmount, SPLIT_KINDS } from './model.ts';
import { extractReceipt } from './receipt.ts';
import { SplitEditor } from './SplitEditor.tsx';
import { Badge, Button, ErrorText, Field, inputCls, MoneyText, today, toMoney } from './ui.tsx';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line py-4">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function DetailDrawer({
  txId,
  refs,
  onClose,
}: {
  txId: string;
  refs: Refs;
  onClose: () => void;
}) {
  const t = useT();
  const all = useTransactions();
  const tx = all.data?.find((t) => t.id === txId);
  if (!tx)
    return (
      <p className="text-sm text-muted">
        {all.isLoading
          ? t('common.loading', 'Loading…')
          : t(
              'transactions.detailDrawer.thisTransactionNoLonger',
              'This transaction no longer exists.',
            )}
      </p>
    );
  return (
    <Detail
      key={`${tx.id}:${tx.version}`}
      tx={tx}
      all={all.data ?? []}
      refs={refs}
      onClose={onClose}
    />
  );
}

function Detail({
  tx,
  all,
  refs,
  onClose,
}: {
  tx: D.Transaction;
  all: D.Transaction[];
  refs: Refs;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const amt = primaryAmount(tx);
  const related = tx.relatedTransactionId
    ? all.find((t) => t.id === tx.relatedTransactionId)
    : undefined;
  return (
    <div className="flex flex-col">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-2xl font-semibold">
            <MoneyText
              value={amt}
              locale={locale}
              signed={tx.kind !== 'transfer' && tx.kind !== 'fx'}
            />
          </p>
          <p className="text-sm text-muted">
            {tx.bookingDate} · {tx.postings.map((p) => refs.accountName(p.accountId)).join(' → ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge tone="blue">{tx.kind.replace('_', ' ')}</Badge>
          <Badge
            tone={tx.status === 'void' ? 'red' : tx.status === 'pending' ? 'amber' : 'neutral'}
          >
            {tx.status}
          </Badge>
          <Badge>{tx.source}</Badge>
          {tx.categorizationSource !== 'none' && (
            <Badge>
              {t(
                'transactions.detailDrawer.categoryCategorizationsource',
                'category: {{categorizationSource}}',
                { categorizationSource: tx.categorizationSource },
              )}
            </Badge>
          )}
        </div>
      </div>
      <DuplicateNotice tx={tx} refs={refs} />
      {tx.conversion && (
        <p className="mb-2 text-sm">
          {t('transactions.detailDrawer.exchanged', 'Exchanged')}{' '}
          <MoneyText value={tx.conversion.from} locale={locale} /> →{' '}
          <MoneyText value={tx.conversion.to} locale={locale} />{' '}
          {t(
            'transactions.detailDrawer.atRateMethodRatedate',
            'at {{rate}} ({{method}}, {{rateDate}})',
            {
              rate: tx.conversion.rate,
              method: tx.conversion.method,
              rateDate: tx.conversion.rateDate,
            },
          )}
          {tx.conversion.fee && (
            <>
              {t('transactions.detailDrawer.fee', ', fee')}{' '}
              <MoneyText value={tx.conversion.fee} locale={locale} />
            </>
          )}
        </p>
      )}
      {tx.postings[0]?.originalAmount && (
        <p className="mb-2 text-sm">
          {t('transactions.detailDrawer.originalAmount', 'Original amount')}{' '}
          <MoneyText value={tx.postings[0].originalAmount} locale={locale} />
        </p>
      )}
      {related && (
        <p className="mb-2 text-sm">
          {t('transactions.detailDrawer.linkedTo', 'Linked to {{kind}} “{{name}}” on {{date}}', {
            kind: related.kind,
            name: related.description || related.payee || '',
            date: related.bookingDate,
          })}{' '}
          (<MoneyText value={primaryAmount(related)} locale={locale} />)
        </p>
      )}

      <EditFields tx={tx} refs={refs} />
      {SPLIT_KINDS.has(tx.kind) && (
        <Section
          title={t('transactions.detailDrawer.categoriesAndSplits', 'Categories and splits')}
        >
          <SplitEditor tx={tx} refs={refs} />
        </Section>
      )}
      {tx.importRecordId && (
        <Section
          title={t(
            'transactions.detailDrawer.originalBankRecordRead',
            'Original bank record (read-only)',
          )}
        >
          <RawRecord id={tx.importRecordId} />
        </Section>
      )}
      <Section title={t('transaction.attachments', 'Attachments')}>
        <Attachments tx={tx} />
      </Section>
      {tx.kind === 'expense' && (
        <Section title={t('transactions.detailDrawer.refunds', 'Refunds')}>
          <Refunds tx={tx} all={all} refs={refs} />
        </Section>
      )}
      {(tx.kind === 'expense' || tx.kind === 'income') && (
        <Section title={t('transactions.detailDrawer.plannedTransaction', 'Planned transaction')}>
          <PlanMatch tx={tx} />
        </Section>
      )}
      <Section title={t('mcp.history', 'History')}>
        <History tx={tx} />
      </Section>
      <Actions tx={tx} onClose={onClose} />
    </div>
  );
}

function EditFields({ tx, refs }: { tx: D.Transaction; refs: Refs }) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const amt = primaryAmount(tx);
  const editableAmount = !tx.importRecordId && tx.splits.length <= 1 && tx.postings.length === 1;
  const [f, setF] = useState({
    description: tx.description,
    payee: tx.payee,
    notes: tx.notes,
    reference: tx.reference,
    merchantId: tx.merchantId ?? '',
    bookingDate: tx.bookingDate,
    status: tx.status === 'reconciled' ? 'cleared' : tx.status,
    excludeFromReports: tx.excludeFromReports,
    tagIds: tx.tagIds,
    amount: amt ? absMoney(amt).amount : '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const save = useWrite((ops, p: Parameters<typeof ops.updateTransaction>[1]) =>
    ops.updateTransaction(tx.id, p),
  );
  const up = (p: Partial<typeof f>) => {
    setOk(false);
    setF((x) => ({ ...x, ...p }));
  };

  const submit = async () => {
    setErr(null);
    const patch: Parameters<typeof save.mutateAsync>[0] = { version: tx.version };
    if (f.description !== tx.description) patch.description = f.description;
    if (f.payee !== tx.payee) patch.payee = f.payee;
    if (f.notes !== tx.notes) patch.notes = f.notes;
    if (f.reference !== tx.reference) patch.reference = f.reference;
    if ((f.merchantId || null) !== tx.merchantId) patch.merchantId = f.merchantId || null;
    if (f.bookingDate !== tx.bookingDate) patch.bookingDate = f.bookingDate;
    if (f.status !== tx.status && tx.status !== 'reconciled')
      patch.status = f.status as 'pending' | 'cleared' | 'void';
    if (f.excludeFromReports !== tx.excludeFromReports)
      patch.excludeFromReports = f.excludeFromReports;
    if (f.tagIds.join() !== tx.tagIds.join()) patch.tagIds = f.tagIds;
    if (editableAmount && amt && f.amount !== absMoney(amt).amount) {
      const m = toMoney(f.amount, amt.currency, locale);
      if (!m || toMinor(m) <= 0n) return setErr('Invalid amount.');
      patch.amount =
        tx.kind === 'opening_balance' || tx.kind === 'adjustment'
          ? amt.amount.startsWith('-')
            ? { ...m, amount: `-${m.amount}` }
            : m
          : m;
    }
    if (Object.keys(patch).length === 1) return;
    try {
      await save.mutateAsync(patch);
      setOk(true);
    } catch (e) {
      setErr(describeError(e));
    }
  };

  return (
    <Section title={t('transactions.detailDrawer.details', 'Details')}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('transaction.description', 'Description')}>
          {(id) => (
            <input
              id={id}
              className={inputCls}
              value={f.description}
              onChange={(e) => up({ description: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('transactions.detailDrawer.payee', 'Payee')}>
          {(id) => (
            <input
              id={id}
              className={inputCls}
              value={f.payee}
              onChange={(e) => up({ payee: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('transaction.merchant', 'Merchant')}>
          {(id) => (
            <select
              id={id}
              className={inputCls}
              value={f.merchantId}
              onChange={(e) => up({ merchantId: e.target.value })}
            >
              <option value="">{t('common.none', 'None')}</option>
              {refs.merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('transactions.detailDrawer.reference', 'Reference')}>
          {(id) => (
            <input
              id={id}
              className={inputCls}
              value={f.reference}
              onChange={(e) => up({ reference: e.target.value })}
            />
          )}
        </Field>
        <Field
          label={t('transactions.detailDrawer.bookingDate', 'Booking date')}
          hint={
            tx.importRecordId
              ? t('transactions.detailDrawer.fixedByTheBank', 'Fixed by the bank record')
              : undefined
          }
        >
          {(id, d) => (
            <input
              id={id}
              aria-describedby={d}
              type="date"
              disabled={!!tx.importRecordId}
              className={inputCls}
              value={f.bookingDate}
              onChange={(e) => up({ bookingDate: e.target.value })}
            />
          )}
        </Field>
        <Field
          label={`Amount (${amt?.currency ?? ''})`}
          hint={
            tx.importRecordId
              ? t(
                  'transactions.detailDrawer.fixedByTheBank2',
                  'Fixed by the bank record; record an adjustment instead',
                )
              : !editableAmount
                ? t(
                    'transactions.detailDrawer.changeSplitsOrPostings',
                    'Change splits or postings to change the amount',
                  )
                : undefined
          }
        >
          {(id, d) => (
            <input
              id={id}
              aria-describedby={d}
              inputMode="decimal"
              disabled={!editableAmount}
              className={inputCls}
              value={f.amount}
              onChange={(e) => up({ amount: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('sync.status', 'Status')}>
          {(id) => (
            <select
              id={id}
              className={inputCls}
              value={f.status}
              disabled={tx.status === 'reconciled'}
              onChange={(e) => up({ status: e.target.value as typeof f.status })}
            >
              <option value="cleared">{t('transactions.detailDrawer.cleared', 'Cleared')}</option>
              <option value="pending">{t('transactions.detailDrawer.pending', 'Pending')}</option>
              <option value="void">
                {t(
                  'transactions.detailDrawer.voidArchivedNotCounted',
                  'Void (archived, not counted)',
                )}
              </option>
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            checked={f.excludeFromReports}
            onChange={(e) => up({ excludeFromReports: e.target.checked })}
          />{' '}
          {t('transactions.detailDrawer.excludeFromReports', 'Exclude from reports')}
        </label>
      </div>
      {refs.tags.length > 0 && (
        <fieldset className="mt-3">
          <legend className="mb-1 text-xs font-medium text-muted">
            {t('transaction.tags', 'Tags')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {refs.tags.map((t) => (
              <label key={t.id} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={f.tagIds.includes(t.id)}
                  onChange={(e) =>
                    up({
                      tagIds: e.target.checked
                        ? [...f.tagIds, t.id]
                        : f.tagIds.filter((x) => x !== t.id),
                    })
                  }
                />
                {t.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Field label={t('transaction.notes', 'Notes')} className="mt-3">
        {(id) => (
          <textarea
            id={id}
            rows={2}
            className={`${inputCls} h-auto py-1`}
            value={f.notes}
            onChange={(e) => up({ notes: e.target.value })}
          />
        )}
      </Field>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending}>
          {t('transactions.detailDrawer.saveDetails', 'Save details')}
        </Button>
        {ok && <span className="text-xs text-pos">{t('settings.saved', 'Saved')}</span>}
      </div>
      <ErrorText error={err} />
    </Section>
  );
}

function RawRecord({ id }: { id: string }) {
  const t = useT();
  const { store, profile } = useData();
  const q = useQuery({
    queryKey: qk(profile?.id ?? '', 'raw', id),
    queryFn: async () => {
      // Immutable evidence lives in the local store in both modes (the connected cache too).
      const r = await store.run('readonly', ['imported_raw_records'], (tx) =>
        tx.get<D.ImportedRawRecord & { profileId: string }>('imported_raw_records', id),
      );
      return r && r.profileId === profile?.id ? r : null;
    },
  });
  if (q.isLoading) return <p className="text-sm">{t('common.loading', 'Loading…')}</p>;
  if (!q.data)
    return (
      <p className="text-sm text-muted">
        {t(
          'transactions.detailDrawer.theSourceRecordIs',
          "The source record is not in this device's database (it may not have been synced).",
        )}
      </p>
    );
  const r = q.data;
  const rows: [string, string][] = [
    ['Posting date', r.postingDate],
    ['Value date', r.valueDate ?? ''],
    ['Amount', `${r.amount.amount} ${r.amount.currency} (${r.direction})`],
    [
      'Original amount',
      r.originalAmount ? `${r.originalAmount.amount} ${r.originalAmount.currency}` : '',
    ],
    ['Exchange rate', r.exchangeRate ?? ''],
    [
      'Running balance',
      r.runningBalance ? `${r.runningBalance.amount} ${r.runningBalance.currency}` : '',
    ],
    ['Description', r.sourceDescription],
    ['Counterparty', r.counterparty],
    ['Bank reference', r.bankReference],
    ['Statement', r.statementRef],
    ['Source account', r.sourceAccount],
    ['Row', String(r.rowNumber)],
    ['Importer', `${r.importerId} ${r.importerVersion}`],
    ['Fingerprint', r.dedupeFingerprint],
  ];
  return (
    <div className="text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
      </dl>
      {r.warnings.length > 0 && (
        <p className="mt-2 text-warn">
          {t('transactions.detailDrawer.warningsJoin', 'Warnings: {{join}}', {
            join: r.warnings.join('; '),
          })}
        </p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted">
          {t('transactions.detailDrawer.rawFieldsAsRead', 'Raw fields as read from the file')}
        </summary>
        <pre className="mt-1 max-h-60 overflow-auto rounded bg-surface-2 p-2 text-xs">
          {JSON.stringify(r.raw, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Attachments({ tx }: { tx: D.Transaction }) {
  const t = useT();
  const { ops, profileId } = useLedgerEnv();
  const list = useQuery({
    queryKey: qk(profileId, 'attachments', tx.id),
    queryFn: () => ops.listAttachments(tx.id),
  });
  const add = useWrite((o, file: File) =>
    o.addAttachment({
      file,
      fileName: file.name,
      contentType: file.type,
      transactionId: tx.id,
      purpose: 'receipt',
    }),
  );
  const del = useWrite((o, id: string) => o.removeAttachment(id));
  const [view, setView] = useState<{ url: string; type: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scan, setScan] = useState<D.Attachment | null>(null);
  useEffect(
    () => () => {
      if (view) URL.revokeObjectURL(view.url);
    },
    [view],
  );

  const upload = async (files: FileList | null) => {
    setErr(null);
    for (const f of files ?? []) {
      if (f.size > 25 * 1024 * 1024) {
        setErr(`${f.name} is larger than 25 MB.`);
        continue;
      }
      await add.mutateAsync(f).catch((e) => setErr(describeError(e)));
    }
  };
  const open = async (a: D.Attachment) => {
    try {
      const blob = await ops.attachmentContent(a.id);
      setView({ url: URL.createObjectURL(blob), type: a.contentType, name: a.fileName });
    } catch (e) {
      setErr(describeError(e));
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target only; the file input below is the accessible path
    <div
      className="flex flex-col gap-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        upload(e.dataTransfer.files);
      }}
    >
      <ul className="flex flex-col gap-1 text-sm">
        {(list.data ?? []).map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="truncate text-left text-accent underline"
              onClick={() => open(a)}
            >
              {a.fileName}
            </button>
            <span className="text-xs text-muted">
              {t('transactions.detailDrawer.ceilKb', '{{ceil}} KB', {
                ceil: Math.ceil(a.sizeBytes / 1024),
              })}
            </span>
            {a.contentType.startsWith('image/') && (
              <Button size="sm" variant="ghost" onClick={() => setScan(a)}>
                {t('transactions.detailDrawer.readReceipt', 'Read receipt')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${a.fileName}`}
              onClick={() => window.confirm(`Remove ${a.fileName}?`) && del.mutate(a.id)}
            >
              <Trash2 size={14} aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-line p-3 text-sm text-muted focus-within:ring-2">
        <FileUp size={16} aria-hidden />{' '}
        {add.isPending
          ? t('transactions.detailDrawer.uploading', 'Uploading…')
          : t(
              'transactions.detailDrawer.addReceiptOrDocument',
              'Add receipt or document (drop files here)',
            )}
        <input
          type="file"
          multiple
          className="sr-only"
          accept="image/*,application/pdf,text/plain"
          onChange={(e) => upload(e.target.files)}
        />
      </label>
      <ErrorText error={err} />
      {scan && <ReceiptScan key={scan.id} tx={tx} a={scan} onDone={() => setScan(null)} />}
      {view && (
        <figure className="rounded-md border border-line p-2">
          <figcaption className="mb-2 flex items-center justify-between text-xs">
            {view.name}
            <span className="flex gap-2">
              <a href={view.url} download={view.name} className="text-accent underline">
                {t('backup.downloadOne', 'Download')}
              </a>
              <button type="button" onClick={() => setView(null)} className="underline">
                {t('common.close', 'Close')}
              </button>
            </span>
          </figcaption>
          {view.type.startsWith('image/') ? (
            <img src={view.url} alt={view.name} className="max-h-96 w-full object-contain" />
          ) : view.type === 'application/pdf' ? (
            // The gateway CSP has object-src 'none', so PDFs open in the browser's own viewer.
            <a
              href={view.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-accent underline"
            >
              {t('transactions.detailDrawer.openPdfInA', 'Open PDF in a new tab')}
            </a>
          ) : (
            <p className="text-sm">
              {t(
                'transactions.detailDrawer.noPreviewForType',
                'No preview for {{type}}; use Download.',
                { type: view.type },
              )}
            </p>
          )}
        </figure>
      )}
    </div>
  );
}

function Refunds({ tx, all, refs }: { tx: D.Transaction; all: D.Transaction[]; refs: Refs }) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const total = absMoney(primaryAmount(tx) as D.Money);
  const refunds = all.filter(
    (t) => t.relatedTransactionId === tx.id && t.kind === 'refund' && t.status !== 'void',
  );
  const refunded = refunds.reduce((s, t) => s + toMinor(primaryAmount(t) as D.Money), 0n);
  const left = toMinor(total) - refunded;
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState(tx.postings[0]?.accountId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const create = useWrite((ops, body: Parameters<typeof ops.createRefund>[1]) =>
    ops.createRefund(tx.id, body),
  );
  const sameCurrency = refs.accounts.filter(
    (a) => a.currency === total.currency || a.isMultiCurrency,
  );

  const submit = async () => {
    setErr(null);
    const m = toMoney(amount, total.currency, locale);
    if (!m || toMinor(m) <= 0n) return setErr('Enter a positive amount.');
    if (toMinor(m) > left) return setErr('A refund cannot exceed what is left to refund.');
    try {
      await create.mutateAsync({
        amount: m,
        bookingDate: date,
        accountId,
        description: `Refund: ${tx.description || tx.payee}`.slice(0, 500),
      });
      setAmount('');
    } catch (e) {
      setErr(describeError(e));
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      {refunds.map((r) => (
        <p key={r.id}>
          {r.bookingDate}: <MoneyText value={primaryAmount(r)} locale={locale} />{' '}
          {t('transactions.detailDrawer.toAccountname', 'to {{accountName}}', {
            accountName: refs.accountName(r.postings[0]?.accountId ?? ''),
          })}
        </p>
      ))}
      <p className="text-muted">
        {t('transactions.detailDrawer.refunded', 'Refunded')}{' '}
        <MoneyText value={fromMinor(refunded, total.currency)} locale={locale} />{' '}
        {t('goals.page.of', 'of')} <MoneyText value={total} locale={locale} />
      </p>
      {left > 0n && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={`Refund amount (${total.currency})`}>
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                className={`${inputCls} w-32`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('transaction.date', 'Date')}>
            {(id) => (
              <input
                id={id}
                type="date"
                className={inputCls}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('transactions.detailDrawer.intoAccount', 'Into account')}>
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {sameCurrency.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button size="sm" onClick={submit} disabled={create.isPending}>
            {t('transactions.detailDrawer.recordRefund', 'Record refund')}
          </Button>
        </div>
      )}
      <ErrorText error={err} />
    </div>
  );
}

function PlanMatch({ tx }: { tx: D.Transaction }) {
  const t = useT();
  const { ops, profileId, locale } = useLedgerEnv();
  const plans = useEntities('planned_transactions');
  const from = shift(tx.bookingDate, -31);
  const to = shift(tx.bookingDate, 31);
  const occ = useQuery({
    queryKey: qk(profileId, 'occurrences', from, to),
    queryFn: () => ops.planOccurrences(from, to, true),
  });
  const match = useWrite((o, v: { planId: string; date: string }) =>
    o.setOccurrence(v.planId, v.date, { status: 'matched', matchedTransactionId: tx.id }),
  );
  const [err, setErr] = useState<string | null>(null);
  const byId = new Map((plans.data ?? []).map((p) => [p.id, p]));
  const sugg = matchPlanned(occ.data ?? [], plans.data ?? [], [tx], 10);
  const candidates = (occ.data ?? []).filter((o) => byId.get(o.planId)?.kind === tx.kind);
  if (!plans.data?.length)
    return (
      <p className="text-sm text-muted">
        {t('transactions.detailDrawer.noPlannedTransactions', 'No planned transactions.')}
      </p>
    );
  return (
    <div className="flex flex-col gap-1 text-sm">
      {candidates.length === 0 && (
        <p className="text-muted">
          {t(
            'transactions.detailDrawer.noOpenKindOccurrences',
            'No open {{kind}} occurrences within a month of this date.',
            { kind: tx.kind },
          )}
        </p>
      )}
      {candidates.map((o) => {
        const p = byId.get(o.planId);
        const s = sugg.find(
          (x) => x.plannedTransactionId === o.planId && x.occurrenceDate === o.occurrenceDate,
        );
        return (
          <div
            key={`${o.planId}:${o.occurrenceDate}`}
            className="flex items-center justify-between gap-2"
          >
            <span>
              {o.date} · {p?.description || t('transactions.detailDrawer.plan', 'Plan')} ·{' '}
              <MoneyText value={o.amount} locale={locale} />
              {s && (
                <Badge tone="green">
                  {t('transactions.detailDrawer.suggestedRound', 'suggested {{round}}%', {
                    round: Math.round(Number(s.score) * 100),
                  })}
                </Badge>
              )}
            </span>
            <Button
              size="sm"
              onClick={() =>
                match
                  .mutateAsync({ planId: o.planId, date: o.occurrenceDate })
                  .catch((e) => setErr(describeError(e)))
              }
            >
              {t('transactions.detailDrawer.match', 'Match')}
            </Button>
          </div>
        );
      })}
      <ErrorText error={err} />
    </div>
  );
}

const shift = (d: string, days: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface AuditEntry {
  id: number;
  occurredAt: string;
  actorType: string;
  action: string;
}

function History({ tx }: { tx: D.Transaction }) {
  const t = useT();
  const { api, profileId, syncNow } = useLedgerEnv();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const h = useQuery({
    queryKey: qk(profileId, 'tx-history', tx.id, tx.version),
    enabled: !!api && tx.serverVersion > 0,
    queryFn: () =>
      (api as NonNullable<typeof api>)
        .request<{ items: AuditEntry[] }>('GET', `/api/v1/transactions/${tx.id}/history`)
        .then((r) => r.items),
  });
  if (!api)
    return (
      <p className="text-sm text-muted">
        {t(
          'transactions.detailDrawer.createdSliceLastChanged',
          'Created {{slice}}, last changed {{slice2}} (version {{version}}). The full change history and undo are kept by the server and need connected mode.',
          {
            slice: tx.createdAt.slice(0, 16).replace('T', ' '),
            slice2: tx.updatedAt.slice(0, 16).replace('T', ' '),
            version: tx.version,
          },
        )}
      </p>
    );
  if (tx.serverVersion === 0)
    return (
      <p className="text-sm text-muted">
        {t(
          'transactions.detailDrawer.notSyncedYetHistory',
          'Not synced yet; history appears after the next sync.',
        )}
      </p>
    );
  const undo = async () => {
    setErr(null);
    setBusy(true);
    try {
      await syncNow(); // push local edits first so the server undoes the latest state
      await api.request('POST', `/api/v1/transactions/${tx.id}/undo`);
      await syncNow();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="text-sm">
      <ol className="mb-2 flex flex-col gap-1">
        {(h.data ?? []).map((e) => (
          <li key={e.id} className="flex justify-between gap-2">
            <span>{e.action}</span>
            <span className="text-xs text-muted">
              {e.occurredAt.slice(0, 16).replace('T', ' ')} · {e.actorType}
            </span>
          </li>
        ))}
      </ol>
      {h.error && <ErrorText error={describeError(h.error)} />}
      <Button size="sm" onClick={undo} disabled={busy}>
        <Undo2 size={14} aria-hidden />{' '}
        {t('transactions.detailDrawer.undoLastChange', 'Undo last change')}
      </Button>
      <ErrorText error={err} />
    </div>
  );
}

function Actions({ tx, onClose }: { tx: D.Transaction; onClose: () => void }) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const dup = useWrite((ops) => ops.createTransaction(duplicateInput(tx, today())));
  const setStatus = useWrite((ops, status: 'void' | 'cleared') =>
    ops.updateTransaction(tx.id, { version: tx.version, status }),
  );
  const del = useWrite((ops) => ops.deleteTransaction(tx.id));
  const run = (p: Promise<unknown>, close = false) =>
    p.then(() => close && onClose()).catch((e) => setErr(describeError(e)));
  const canDuplicate = ['expense', 'income', 'transfer', 'fx'].includes(tx.kind);
  return (
    <section className="flex flex-wrap gap-2 border-t border-line pt-4">
      {canDuplicate && (
        <Button size="sm" onClick={() => run(dup.mutateAsync(undefined))}>
          <Copy size={14} aria-hidden />{' '}
          {t('transactions.detailDrawer.duplicateToday', 'Duplicate (today)')}
        </Button>
      )}
      {tx.status !== 'reconciled' &&
        (tx.status === 'void' ? (
          <Button size="sm" onClick={() => run(setStatus.mutateAsync('cleared'))}>
            <RotateCcw size={14} aria-hidden />{' '}
            {t('transactions.detailDrawer.restoreUnvoid', 'Restore (unvoid)')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => run(setStatus.mutateAsync('void'))}>
            <Ban size={14} aria-hidden />{' '}
            {t('transactions.detailDrawer.voidArchive', 'Void / archive')}
          </Button>
        ))}
      <Button
        size="sm"
        variant="danger"
        onClick={() =>
          window.confirm(
            tx.importRecordId
              ? 'Imported transactions are kept as evidence and only excluded from reports. Continue?'
              : 'Delete this transaction?',
          ) && run(del.mutateAsync(undefined), !tx.importRecordId)
        }
      >
        <Trash2 size={14} aria-hidden />{' '}
        {tx.importRecordId
          ? t('transactions.detailDrawer.excludeImported', 'Exclude (imported)')
          : t('common.delete', 'Delete')}
      </Button>
      <ErrorText error={err} />
    </section>
  );
}

type Field3 = 'total' | 'date' | 'merchant';

/** Receipt OCR (feature 79): self-hosted tesseract on this device; every value is shown for the
 * user to correct and approve before anything is written. */
function ReceiptScan({
  tx,
  a,
  onDone,
}: {
  tx: D.Transaction;
  a: D.Attachment;
  onDone: () => void;
}) {
  const t = useT();
  const { ops } = useLedgerEnv();
  const amt = primaryAmount(tx);
  const amountEditable =
    !!amt &&
    !tx.importRecordId &&
    tx.splits.length <= 1 &&
    tx.postings.length === 1 &&
    (tx.kind === 'expense' || tx.kind === 'income');
  const [vals, setVals] = useState<Record<Field3, string> | null>(null);
  const [conf, setConf] = useState<Record<Field3, number | null>>({
    total: null,
    date: null,
    merchant: null,
  });
  const [use, setUse] = useState<Record<Field3, boolean>>({
    total: false,
    date: false,
    merchant: false,
  });
  const [err, setErr] = useState<string | null>(null);
  const save = useWrite((o, p: Parameters<typeof o.updateTransaction>[1]) =>
    o.updateTransaction(tx.id, p),
  );

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const blob = await ops.attachmentContent(a.id);
        const { ocrLines } = await import('@finplat/bank-importers');
        const g = extractReceipt(await ocrLines(inputFromBlob(blob, a.fileName), ocrAssets()));
        if (!live) return;
        setVals({
          total: g.total?.value ?? '',
          date: g.date?.value ?? '',
          merchant: g.merchant?.value ?? '',
        });
        setConf({
          total: g.total?.confidence ?? null,
          date: g.date?.confidence ?? null,
          merchant: g.merchant?.confidence ?? null,
        });
      } catch (e) {
        if (live) setErr(describeError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ops, a.id, a.fileName]);

  const apply = async () => {
    if (!vals) return;
    setErr(null);
    const patch: Parameters<typeof save.mutateAsync>[0] = { version: tx.version };
    try {
      if (use.merchant && vals.merchant.trim()) patch.payee = vals.merchant.trim();
      if (use.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(vals.date)) return setErr('Date must be YYYY-MM-DD.');
        patch.bookingDate = vals.date;
      }
      if (use.total && amountEditable && amt) patch.amount = money(vals.total, amt.currency);
      if (Object.keys(patch).length === 1) return setErr('Select at least one value to apply.');
      await save.mutateAsync(patch);
      onDone();
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const row = (k: Field3, label: string, disabled = false) => (
    <div key={k} className="flex flex-wrap items-center gap-2">
      <label className="flex w-28 items-center gap-1">
        <input
          type="checkbox"
          checked={use[k]}
          disabled={disabled}
          onChange={(e) => setUse((u) => ({ ...u, [k]: e.target.checked }))}
        />
        {label}
      </label>
      <input
        aria-label={`Receipt ${label.toLowerCase()}`}
        className={`${inputCls} flex-1`}
        value={vals?.[k] ?? ''}
        disabled={disabled}
        onChange={(e) => setVals((v) => (v ? { ...v, [k]: e.target.value } : v))}
      />
      <span className="text-xs text-muted">
        {conf[k] === null
          ? t('transactions.detailDrawer.notFound', 'not found')
          : `${Math.round((conf[k] as number) * 100)}% OCR confidence`}
      </span>
    </div>
  );

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
      <legend className="font-medium">
        {t(
          'transactions.detailDrawer.receiptValuesFromFilename',
          'Receipt values from {{fileName}}',
          { fileName: a.fileName },
        )}
      </legend>
      {!vals && !err && (
        <p className="text-muted">
          {t(
            'transactions.detailDrawer.readingTheReceiptOn',
            'Reading the receipt on this device…',
          )}
        </p>
      )}
      {vals && (
        <>
          <p className="text-xs text-muted">
            {t(
              'transactions.detailDrawer.ocrMisreadsDigitsCheck',
              'OCR misreads digits. Check each value and tick the ones to apply.',
            )}
          </p>
          {row('total', 'Total', !amountEditable)}
          {!amountEditable && (
            <p className="text-xs text-muted">
              {t(
                'transactions.detailDrawer.theAmountOfThis',
                'The amount of this transaction is not editable here (imported, split or multi-posting).',
              )}
            </p>
          )}
          {row('date', 'Date')}
          {row('merchant', 'Payee')}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={save.isPending} onClick={apply}>
              {t('transactions.detailDrawer.applySelected', 'Apply selected')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>
              {t('common.close', 'Close')}
            </Button>
          </div>
        </>
      )}
      <ErrorText error={err} />
    </fieldset>
  );
}
