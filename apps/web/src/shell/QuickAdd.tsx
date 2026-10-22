// Feature 11 quick expense entry / feature 53 quick actions: a minimal form available
// everywhere (N / I / T or the + button). Remembers the last kind, account and category;
// templates (feature 12) prefill it in one click.
import type * as D from '@finplat/domain';
import { money } from '@finplat/finance-engine';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { qk, useData, useFinance, useInvalidate } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import { Button, cx, Dialog, ErrorBox, Field, Input, Select } from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { todayIso, useFormat } from '../lib/format.ts';
import { tNow, useT } from '../lib/i18n.ts';
import { type QuickKind, useShell } from './shell-state.ts';

export interface QuickForm {
  kind: QuickKind;
  accountId: string;
  toAccountId: string;
  amount: string;
  toAmount: string;
  categoryId: string;
  bookingDate: string;
  description: string;
  merchantId: string | null;
}

/** Turn the form into a TransactionInput. Throws a message for the first invalid field. */
export function buildInput(
  f: QuickForm,
  accounts: Pick<D.Account, 'id' | 'currency'>[],
  parse: (s: string) => string | null,
) {
  const acc = accounts.find((a) => a.id === f.accountId);
  if (!acc) throw new Error(tNow('quick.err.account', 'Choose an account.'));
  const raw = parse(f.amount);
  if (!raw || /^-|^0*(\.0*)?$/.test(raw))
    throw new Error(tNow('quick.err.amount', 'Enter an amount greater than zero.'));
  let amount: D.Money;
  try {
    amount = money(raw, acc.currency);
  } catch {
    throw new Error(
      tNow('quick.err.decimals', 'Too many decimal places for {{c}}.', { c: acc.currency }),
    );
  }
  const input: Record<string, unknown> = {
    kind: f.kind,
    accountId: acc.id,
    amount,
    bookingDate: f.bookingDate,
    description: f.description.trim(),
    merchantId: f.merchantId,
  };
  if (f.kind === 'transfer') {
    const to = accounts.find((a) => a.id === f.toAccountId);
    if (!to || to.id === acc.id)
      throw new Error(tNow('quick.err.destination', 'Choose a different destination account.'));
    input.toAccountId = to.id;
    if (to.currency !== acc.currency) {
      const r = parse(f.toAmount);
      if (!r || /^-|^0*(\.0*)?$/.test(r))
        throw new Error(
          tNow('quick.err.received', 'Enter the amount received in {{c}}.', { c: to.currency }),
        );
      try {
        input.toAmount = money(r, to.currency);
      } catch {
        throw new Error(
          tNow('quick.err.decimals', 'Too many decimal places for {{c}}.', { c: to.currency }),
        );
      }
      input.kind = 'fx';
    }
  } else input.categoryId = f.categoryId || null;
  return input as unknown as Parameters<ReturnType<typeof useFinance>['createTransaction']>[0];
}

export function QuickAdd() {
  const kind = useShell((s) => s.quickAdd);
  const close = useShell((s) => s.closeQuickAdd);
  const { profile } = useData();
  if (!kind || !profile) return null;
  return <QuickAddDialog key={kind} initialKind={kind} onClose={close} profileId={profile.id} />;
}

function QuickAddDialog({
  initialKind,
  onClose,
  profileId,
}: {
  initialKind: QuickKind;
  onClose: () => void;
  profileId: string;
}) {
  const t = useT();
  const fmt = useFormat();
  const ops = useFinance();
  const invalidate = useInvalidate();
  const recent = useApp((s) => s.recent);
  const setApp = useApp((s) => s.set);

  const accounts = useQuery({
    queryKey: qk(profileId, 'accounts'),
    queryFn: () => ops.list('accounts'),
  });
  const categories = useQuery({
    queryKey: qk(profileId, 'categories'),
    queryFn: () => ops.list('categories'),
  });
  const templates = useQuery({
    queryKey: qk(profileId, 'transaction_templates'),
    queryFn: () => ops.list('transaction_templates'),
  });
  const live = useMemo(
    () => (accounts.data ?? []).filter((a) => !a.deletedAt && !a.isArchived),
    [accounts.data],
  );

  const [f, setF] = useState<QuickForm>({
    kind: initialKind,
    accountId: recent.accountId ?? '',
    toAccountId: recent.toAccountId ?? '',
    amount: '',
    toAmount: '',
    categoryId: (initialKind === recent.kind ? recent.categoryId : '') ?? '',
    bookingDate: todayIso(),
    description: '',
    merchantId: null,
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<QuickForm>) => setF((x) => ({ ...x, ...p }));

  useEffect(() => {
    if (live.length && !live.some((a) => a.id === f.accountId))
      setF((x) => ({ ...x, accountId: live[0]?.id ?? '' }));
  }, [live, f.accountId]);

  const acc = live.find((a) => a.id === f.accountId);
  const to = live.find((a) => a.id === f.toAccountId);
  const cats = (categories.data ?? []).filter(
    (c) => !c.deletedAt && !c.isArchived && c.kind === (f.kind === 'income' ? 'income' : 'expense'),
  );
  const catLabel = (c: D.Category) => {
    const parent = c.parentId ? cats.find((p) => p.id === c.parentId) : null;
    return parent ? `${parent.name} › ${c.name}` : c.name;
  };

  const save = useMutation({
    mutationFn: async () => ops.createTransaction(buildInput(f, live, fmt.parseDecimal)),
    onSuccess: async () => {
      setApp({
        recent: {
          kind: f.kind,
          accountId: f.accountId,
          toAccountId: f.toAccountId || undefined,
          categoryId: f.categoryId || null,
        },
      });
      await invalidate();
      toast(t('quick.saved', 'Transaction saved'));
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      buildInput(f, live, fmt.parseDecimal);
    } catch (x) {
      setErr((x as Error).message);
      return;
    }
    save.mutate();
  }

  function applyTemplate(id: string) {
    const tp = templates.data?.find((x) => x.id === id);
    if (!tp) return;
    set({
      kind: tp.kind,
      accountId: tp.accountId ?? f.accountId,
      toAccountId: tp.toAccountId ?? '',
      amount: tp.amount ? fmt.decimal(tp.amount.amount) : '',
      categoryId: tp.categoryId ?? '',
      description: tp.description,
      merchantId: tp.merchantId,
    });
  }

  const kinds: [QuickKind, string][] = [
    ['expense', t('transaction.kind.expense', 'Expense')],
    ['income', t('transaction.kind.income', 'Income')],
    ['transfer', t('transaction.kind.transfer', 'Transfer')],
  ];
  const liveTemplates = (templates.data ?? []).filter((x) => !x.deletedAt);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('quick.title', 'Quick entry')}>
      {live.length === 0 && !accounts.isLoading ? (
        <p className="text-sm text-muted">
          {t('quick.noAccounts', 'Create an account first (Accounts section).')}
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <fieldset className="grid grid-cols-3 gap-1 rounded-md bg-surface-2 p-1">
            <legend className="sr-only">{t('quick.kind', 'Type')}</legend>
            {kinds.map(([k, label]) => (
              <label
                key={k}
                className={cx(
                  'flex h-8 cursor-pointer items-center justify-center rounded text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]',
                  f.kind === k ? 'bg-surface font-medium shadow-sm' : 'text-muted',
                )}
              >
                <input
                  type="radio"
                  name="quick-kind"
                  className="sr-only"
                  checked={f.kind === k}
                  onChange={() => set({ kind: k, categoryId: '' })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {liveTemplates.length > 0 && (
            <Field label={t('quick.template', 'Template')}>
              <Select value="" onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">{t('quick.templateNone', 'Start from a template…')}</option>
                {liveTemplates.map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={`${t('transaction.amount', 'Amount')}${acc ? ` (${acc.currency})` : ''}`}>
              <Input
                inputMode="decimal"
                autoFocus
                required
                value={f.amount}
                onChange={(e) => set({ amount: e.target.value })}
              />
            </Field>
            <Field label={t('transaction.date', 'Date')}>
              <Input
                type="date"
                required
                value={f.bookingDate}
                onChange={(e) => set({ bookingDate: e.target.value })}
              />
            </Field>
          </div>
          <Field
            label={
              f.kind === 'transfer'
                ? t('quick.from', 'From account')
                : t('quick.account', 'Account')
            }
          >
            <Select value={f.accountId} onChange={(e) => set({ accountId: e.target.value })}>
              {live.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </Select>
          </Field>
          {f.kind === 'transfer' ? (
            <>
              <Field label={t('quick.to', 'To account')}>
                <Select
                  value={f.toAccountId}
                  onChange={(e) => set({ toAccountId: e.target.value })}
                >
                  <option value="">{t('quick.choose', 'Choose…')}</option>
                  {live
                    .filter((a) => a.id !== f.accountId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.currency})
                      </option>
                    ))}
                </Select>
              </Field>
              {acc && to && to.currency !== acc.currency && (
                <Field
                  label={t('quick.received', 'Amount received ({{cur}})', { cur: to.currency })}
                  hint={t(
                    'quick.receivedHint',
                    'The exact amount credited; the exchange rate is derived from it.',
                  )}
                >
                  <Input
                    inputMode="decimal"
                    required
                    value={f.toAmount}
                    onChange={(e) => set({ toAmount: e.target.value })}
                  />
                </Field>
              )}
            </>
          ) : (
            <Field label={t('transaction.category', 'Category')}>
              <Select value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
                <option value="">{t('transaction.uncategorized', 'Uncategorized')}</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {catLabel(c)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('transaction.description', 'Description')}>
            <Input
              value={f.description}
              maxLength={500}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          {err && (
            <p role="alert" className="text-sm text-neg">
              {err}
            </p>
          )}
          <ErrorBox error={save.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
            <Button type="submit" variant="primary" busy={save.isPending}>
              {t('common.save', 'Save')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
