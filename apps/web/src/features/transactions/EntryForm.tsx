// Create expense / income / transfer (Features 1, 2, 4, 11, 12, 21, 22). Transfers between
// accounts in different currencies record the amount actually received (bank settlement) or a
// manual rate; without either the local rate book is used. Fees become a linked expense.
import type * as D from '@finplat/domain';
import { convert } from '@finplat/finance-engine';
import { BookmarkPlus, Zap } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { useApp } from '../../app/store.ts';
import { useT } from '../../lib/i18n.ts';
import { describeError, type Refs, useEntities, useLedgerEnv, useWrite } from './data.ts';
import { Button, ErrorText, Field, inputCls, MoneyText, today, toMoney } from './ui.tsx';

type Kind = 'expense' | 'income' | 'transfer';

interface Draft {
  kind: Kind;
  accountId: string;
  toAccountId: string;
  currency: string;
  amount: string;
  settle: 'auto' | 'received' | 'rate';
  toAmount: string;
  rate: string;
  fee: string;
  feeCategoryId: string;
  bookingDate: string;
  description: string;
  payee: string;
  merchantId: string;
  categoryId: string;
  tagIds: string[];
  notes: string;
  status: 'cleared' | 'pending';
}

export function EntryForm({
  refs,
  onDone,
  initialKind,
}: {
  refs: Refs;
  onDone: (t: D.Transaction) => void;
  initialKind?: Kind;
}) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const recent = useApp((s) => s.recent);
  const setApp = useApp((s) => s.set);
  const templates = useEntities('transaction_templates');
  const accounts = refs.accounts.filter((a) => !a.isArchived);
  const first = accounts.find((a) => a.id === recent.accountId) ?? accounts[0];
  const [d, setD] = useState<Draft>(() => ({
    kind: initialKind ?? recent.kind ?? 'expense',
    accountId: first?.id ?? '',
    toAccountId: recent.toAccountId ?? '',
    currency: first?.currency ?? '',
    amount: '',
    settle: 'auto',
    toAmount: '',
    rate: '',
    fee: '',
    feeCategoryId: '',
    bookingDate: today(),
    description: '',
    payee: '',
    merchantId: '',
    categoryId: recent.categoryId ?? '',
    tagIds: [],
    notes: '',
    status: 'cleared',
  }));
  const [err, setErr] = useState<string | null>(null);
  const up = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  const src = refs.account.get(d.accountId);
  const dst = refs.account.get(d.toAccountId);
  const crossCurrency = d.kind === 'transfer' && src && dst && dst.currency !== d.currency;
  const amount = toMoney(d.amount, d.currency, locale);
  const toAmount = useMemo(() => {
    if (!crossCurrency || !dst || !amount) return undefined;
    if (d.settle === 'received') return toMoney(d.toAmount, dst.currency, locale) ?? null;
    if (d.settle === 'rate') {
      const r = d.rate.replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(r) || /^0+(\.0+)?$/.test(r)) return null;
      return { ...convert(amount, dst.currency, r) };
    }
    return undefined;
  }, [crossCurrency, dst, amount, d.settle, d.toAmount, d.rate, locale]);

  const create = useWrite((ops, input: Parameters<typeof ops.createTransaction>[0]) =>
    ops.createTransaction(input),
  );
  const saveTpl = useWrite(
    (ops, input: Parameters<typeof ops.create<'transaction_templates'>>[1]) =>
      ops.create('transaction_templates', input),
  );

  const catOpts = refs.categoryOptions.filter(
    (c) => c.kind === (d.kind === 'income' ? 'income' : 'expense'),
  );

  const applyTemplate = (t: D.TransactionTemplate) => {
    const acc = t.accountId ? refs.account.get(t.accountId) : undefined;
    up({
      kind: t.kind,
      accountId: acc?.id ?? d.accountId,
      currency: acc?.currency ?? t.amount?.currency ?? d.currency,
      toAccountId: t.toAccountId ?? '',
      amount: t.amount?.amount ?? '',
      categoryId: t.categoryId ?? '',
      merchantId: t.merchantId ?? '',
      description: t.description,
      tagIds: t.tagIds,
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!src) return setErr('Choose an account.');
    if (!amount || amount.amount.startsWith('-') || /^0+(\.0+)?$/.test(amount.amount))
      return setErr(`Enter a positive amount in ${d.currency} (at most the currency's decimals).`);
    if (d.kind === 'transfer' && !dst) return setErr('Choose the destination account.');
    if (toAmount === null) return setErr('Enter a valid received amount or rate.');
    const fee = d.fee ? toMoney(d.fee, d.currency, locale) : undefined;
    if (d.fee && !fee) return setErr('Invalid fee.');
    try {
      const t = await create.mutateAsync({
        kind: d.kind,
        accountId: src.id,
        amount,
        bookingDate: d.bookingDate,
        description: d.description,
        payee: d.payee,
        notes: d.notes,
        status: d.status,
        tagIds: d.tagIds,
        merchantId: d.merchantId || null,
        ...(d.kind === 'transfer'
          ? {
              toAccountId: d.toAccountId,
              ...(toAmount ? { toAmount } : {}),
              ...(fee ? { fee, feeCategoryId: d.feeCategoryId || null } : {}),
            }
          : { categoryId: d.categoryId || null }),
      });
      setApp({
        recent: {
          kind: d.kind,
          accountId: src.id,
          toAccountId: d.toAccountId || undefined,
          categoryId: d.kind === 'transfer' ? recent.categoryId : d.categoryId || null,
        },
      });
      onDone(t);
    } catch (e2) {
      setErr(describeError(e2));
    }
  };

  const saveAsTemplate = async () => {
    setErr(null);
    const name = window.prompt('Template name', d.description || d.payee || 'Template');
    if (!name) return;
    try {
      await saveTpl.mutateAsync({
        name,
        kind: d.kind,
        accountId: d.accountId || null,
        toAccountId: d.kind === 'transfer' ? d.toAccountId || null : null,
        amount: amount && !/^0+(\.0+)?$/.test(amount.amount) ? amount : null,
        categoryId: d.kind === 'transfer' ? null : d.categoryId || null,
        merchantId: d.merchantId || null,
        description: d.description,
        tagIds: d.tagIds,
      });
    } catch (e2) {
      setErr(describeError(e2));
    }
  };

  if (accounts.length === 0)
    return (
      <p className="text-sm">
        {t(
          'transactions.entryForm.createAnAccountFirst',
          'Create an account first (Accounts page), then record transactions on it.',
        )}
      </p>
    );

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {(templates.data?.length ?? 0) > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted">
            {t('transactions.entryForm.templates', 'Templates')}
          </p>
          <div className="flex flex-wrap gap-1">
            {templates.data
              ?.slice()
              .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
              .map((t) => (
                <Button key={t.id} size="sm" onClick={() => applyTemplate(t)}>
                  <Zap size={12} aria-hidden /> {t.name}
                </Button>
              ))}
          </div>
        </div>
      )}
      <fieldset className="flex gap-1" aria-label={t('account.type', 'Type')}>
        {(['expense', 'income', 'transfer'] as const).map((k) => (
          <label
            key={k}
            className={`flex-1 cursor-pointer rounded-md border px-3 py-1.5 text-center text-sm capitalize has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:focus-visible]:ring-2 ${'border-line'}`}
          >
            <input
              type="radio"
              name="kind"
              value={k}
              checked={d.kind === k}
              onChange={() => up({ kind: k })}
              className="sr-only"
            />
            {k}
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={
            d.kind === 'transfer' ? t('quick.from', 'From account') : t('quick.account', 'Account')
          }
        >
          {(id) => (
            <select
              id={id}
              className={inputCls}
              value={d.accountId}
              onChange={(e) =>
                up({
                  accountId: e.target.value,
                  currency: refs.account.get(e.target.value)?.currency ?? d.currency,
                })
              }
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
          )}
        </Field>
        {d.kind === 'transfer' ? (
          <Field label={t('quick.to', 'To account')}>
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={d.toAccountId}
                onChange={(e) => up({ toAccountId: e.target.value })}
                required
              >
                <option value="">{t('quick.choose', 'Choose…')}</option>
                {accounts
                  .filter((a) => a.id !== d.accountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
              </select>
            )}
          </Field>
        ) : (
          <Field label={t('transaction.category', 'Category')}>
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={d.categoryId}
                onChange={(e) => up({ categoryId: e.target.value })}
              >
                <option value="">{t('transaction.uncategorized', 'Uncategorized')}</option>
                {catOpts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label={t('transaction.amount', 'Amount')}>
          {(id) => (
            <div className="flex gap-1">
              <input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                required
                className={inputCls}
                value={d.amount}
                onChange={(e) => up({ amount: e.target.value })}
                placeholder="0.00"
              />
              {src?.isMultiCurrency ? (
                <input
                  aria-label={t('account.currency', 'Currency')}
                  className={`${inputCls} w-20 uppercase`}
                  maxLength={3}
                  value={d.currency}
                  onChange={(e) => up({ currency: e.target.value.toUpperCase() })}
                />
              ) : (
                <span className="flex items-center px-1 text-sm text-muted">{d.currency}</span>
              )}
            </div>
          )}
        </Field>
        <Field label={t('transaction.date', 'Date')}>
          {(id) => (
            <input
              id={id}
              type="date"
              required
              className={inputCls}
              value={d.bookingDate}
              onChange={(e) => up({ bookingDate: e.target.value })}
            />
          )}
        </Field>
      </div>

      {crossCurrency && dst && (
        <fieldset className="rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-medium">
            {t(
              'transactions.entryForm.currencyExchangeCurrencyCurrency2',
              'Currency exchange {{currency}} → {{currency2}}',
              { currency: d.currency, currency2: dst.currency },
            )}
          </legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {(
              [
                ['auto', 'Use stored rate'],
                ['received', 'Amount received (bank)'],
                ['rate', 'Manual rate'],
              ] as const
            ).map(([v, l]) => (
              <label key={v} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="settle"
                  checked={d.settle === v}
                  onChange={() => up({ settle: v })}
                />{' '}
                {l}
              </label>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {d.settle === 'received' && (
              <Field
                label={t('transactions.entryForm.received', 'Received ({{currency}})', {
                  currency: dst.currency,
                })}
              >
                {(id) => (
                  <input
                    id={id}
                    inputMode="decimal"
                    className={inputCls}
                    value={d.toAmount}
                    onChange={(e) => up({ toAmount: e.target.value })}
                  />
                )}
              </Field>
            )}
            {d.settle === 'rate' && (
              <Field
                label={t('transactions.entryForm.per1', '{{currency}} per 1 {{currency1}}', {
                  currency: dst.currency,
                  currency1: d.currency,
                })}
              >
                {(id) => (
                  <input
                    id={id}
                    inputMode="decimal"
                    className={inputCls}
                    value={d.rate}
                    onChange={(e) => up({ rate: e.target.value })}
                  />
                )}
              </Field>
            )}
            {toAmount && (
              <p className="self-end text-sm">
                {t('transactions.entryForm.receives', 'Receives')}{' '}
                <MoneyText value={toAmount} locale={locale} />
              </p>
            )}
            {d.settle === 'auto' && (
              <p className="text-xs text-muted">
                {t(
                  'transactions.entryForm.theRateForThe',
                  'The rate for the booking date from your exchange rates is used; the save fails if none exists.',
                )}
              </p>
            )}
          </div>
        </fieldset>
      )}

      {d.kind === 'transfer' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={t('transactions.entryForm.feeOptional', 'Fee ({{currency}}, optional)', {
              currency: d.currency,
            })}
            hint={t(
              'transactions.entryForm.recordedAsALinked',
              'Recorded as a linked expense on the source account',
            )}
          >
            {(id, desc) => (
              <input
                id={id}
                aria-describedby={desc}
                inputMode="decimal"
                className={inputCls}
                value={d.fee}
                onChange={(e) => up({ fee: e.target.value })}
              />
            )}
          </Field>
          {d.fee && (
            <Field label={t('transactions.entryForm.feeCategory', 'Fee category')}>
              {(id) => (
                <select
                  id={id}
                  className={inputCls}
                  value={d.feeCategoryId}
                  onChange={(e) => up({ feeCategoryId: e.target.value })}
                >
                  <option value="">{t('transaction.uncategorized', 'Uncategorized')}</option>
                  {refs.categoryOptions
                    .filter((c) => c.kind === 'expense')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('transaction.description', 'Description')}>
          {(id) => (
            <input
              id={id}
              className={inputCls}
              value={d.description}
              onChange={(e) => up({ description: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('transactions.detailDrawer.payee', 'Payee')}>
          {(id) => (
            <input
              id={id}
              className={inputCls}
              value={d.payee}
              onChange={(e) => up({ payee: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('transaction.merchant', 'Merchant')}>
          {(id) => (
            <select
              id={id}
              className={inputCls}
              value={d.merchantId}
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
        <Field label={t('sync.status', 'Status')}>
          {(id) => (
            <select
              id={id}
              className={inputCls}
              value={d.status}
              onChange={(e) => up({ status: e.target.value as Draft['status'] })}
            >
              <option value="cleared">{t('transactions.detailDrawer.cleared', 'Cleared')}</option>
              <option value="pending">{t('transactions.detailDrawer.pending', 'Pending')}</option>
            </select>
          )}
        </Field>
      </div>
      {refs.tags.length > 0 && (
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-muted">
            {t('transaction.tags', 'Tags')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {refs.tags.map((t) => (
              <label key={t.id} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={d.tagIds.includes(t.id)}
                  onChange={(e) =>
                    up({
                      tagIds: e.target.checked
                        ? [...d.tagIds, t.id]
                        : d.tagIds.filter((x) => x !== t.id),
                    })
                  }
                />
                {t.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Field label={t('transaction.notes', 'Notes')}>
        {(id) => (
          <textarea
            id={id}
            rows={2}
            className={`${inputCls} h-auto py-1`}
            value={d.notes}
            onChange={(e) => up({ notes: e.target.value })}
          />
        )}
      </Field>
      <ErrorText error={err} />
      <div className="flex justify-between gap-2">
        <Button onClick={saveAsTemplate} disabled={saveTpl.isPending}>
          <BookmarkPlus size={14} aria-hidden />{' '}
          {t('transactions.entryForm.saveAsTemplate', 'Save as template')}
        </Button>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? t('transactions.entryForm.saving', 'Saving…') : `Add ${d.kind}`}
        </Button>
      </div>
    </form>
  );
}
