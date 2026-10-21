// Create / edit an account (Features 3, 16, 21). Currency is fixed after creation; the opening
// balance becomes an opening_balance transaction (Feature 129).
import type * as D from '@finplat/domain';
import { ACCOUNT_TYPES, LIABILITY_ACCOUNT_TYPES } from '@finplat/domain';
import { type FormEvent, useState } from 'react';
import { describeError, useLedgerEnv, useWrite } from '../transactions/data.ts';
import { Button, ErrorText, Field, inputCls, toMoney } from '../transactions/ui.tsx';

export const TYPE_LABEL: Record<D.AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  wallet: 'Wallet',
  prepaid: 'Prepaid card',
  investment: 'Investment',
  other_asset: 'Other asset',
  credit_card: 'Credit card',
  loan: 'Loan',
  mortgage: 'Mortgage',
  other_liability: 'Other liability',
};

export function AccountForm({
  account,
  onDone,
}: {
  account?: D.Account;
  onDone: (a: D.Account) => void;
}) {
  const { profile, locale } = useLedgerEnv();
  const [f, setF] = useState({
    name: account?.name ?? '',
    accountType: account?.accountType ?? ('checking' as D.AccountType),
    currency: account?.currency ?? profile.baseCurrency,
    isMultiCurrency: account?.isMultiCurrency ?? false,
    institution: account?.institution ?? '',
    accountNumberMasked: account?.accountNumberMasked ?? '',
    openingDate: account?.openingDate ?? '',
    openingBalance: '',
    creditLimit: account?.creditLimit?.amount ?? '',
    includeInNetWorth: account?.includeInNetWorth ?? true,
    includeInSafeToSpend: account?.includeInSafeToSpend ?? true,
    color: account?.color ?? '',
    notes: account?.notes ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const up = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = useWrite(async (ops, body: Record<string, unknown>) =>
    account
      ? ops.update('accounts', account.id, { ...body, version: account.version })
      : ops.create('accounts', body as never),
  );
  const liability = LIABILITY_ACCOUNT_TYPES.includes(f.accountType);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const cur = f.currency.trim().toUpperCase();
    let creditLimit: D.Money | null = null;
    if (f.creditLimit) {
      creditLimit = toMoney(f.creditLimit, cur, locale);
      if (!creditLimit) return setErr('Invalid credit limit.');
    }
    let openingBalance: D.Money | undefined;
    if (!account && f.openingBalance) {
      const m = toMoney(f.openingBalance, cur, locale);
      if (!m) return setErr(`Invalid opening balance for ${cur}.`);
      openingBalance = m;
    }
    try {
      const a = await save.mutateAsync({
        name: f.name,
        accountType: f.accountType,
        currency: cur,
        isMultiCurrency: f.isMultiCurrency,
        institution: f.institution,
        accountNumberMasked: f.accountNumberMasked,
        openingDate: f.openingDate || null,
        creditLimit,
        includeInNetWorth: f.includeInNetWorth,
        includeInSafeToSpend: f.includeInSafeToSpend,
        color: f.color,
        notes: f.notes,
        ...(openingBalance ? { openingBalance } : {}),
      });
      onDone(a as D.Account);
    } catch (e2) {
      setErr(describeError(e2));
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              required
              className={inputCls}
              value={f.name}
              onChange={(e) => up({ name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <select
              id={id}
              className={inputCls}
              value={f.accountType}
              onChange={(e) => up({ accountType: e.target.value as D.AccountType })}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Currency"
          hint={account ? 'Cannot change after creation' : 'ISO code, e.g. BAM, EUR, USD'}
        >
          {(id, d) => (
            <input
              id={id}
              aria-describedby={d}
              required
              maxLength={3}
              pattern="[A-Za-z]{3}"
              disabled={!!account}
              className={`${inputCls} uppercase`}
              value={f.currency}
              onChange={(e) => up({ currency: e.target.value.toUpperCase() })}
            />
          )}
        </Field>
        <Field label="Institution">
          {(id) => (
            <input
              id={id}
              className={inputCls}
              value={f.institution}
              onChange={(e) => up({ institution: e.target.value })}
            />
          )}
        </Field>
        <Field label="Account number (masked)" hint="Store only the last digits">
          {(id, d) => (
            <input
              id={id}
              aria-describedby={d}
              maxLength={40}
              className={inputCls}
              value={f.accountNumberMasked}
              onChange={(e) => up({ accountNumberMasked: e.target.value })}
            />
          )}
        </Field>
        <Field label="Opening date">
          {(id) => (
            <input
              id={id}
              type="date"
              className={inputCls}
              value={f.openingDate}
              onChange={(e) => up({ openingDate: e.target.value })}
            />
          )}
        </Field>
        {!account && (
          <Field
            label={`Opening balance (${f.currency || '…'})`}
            hint={
              liability
                ? 'Amount owed as a negative number, e.g. -250.00'
                : 'Balance on the opening date'
            }
          >
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                inputMode="decimal"
                className={inputCls}
                value={f.openingBalance}
                onChange={(e) => up({ openingBalance: e.target.value })}
              />
            )}
          </Field>
        )}
        {liability && (
          <Field label="Credit limit">
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                className={inputCls}
                value={f.creditLimit}
                onChange={(e) => up({ creditLimit: e.target.value })}
              />
            )}
          </Field>
        )}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={f.isMultiCurrency}
            onChange={(e) => up({ isMultiCurrency: e.target.checked })}
          />{' '}
          Holds several currencies (multi-currency account)
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={f.includeInNetWorth}
            onChange={(e) => up({ includeInNetWorth: e.target.checked })}
          />{' '}
          Include in net worth
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={f.includeInSafeToSpend}
            onChange={(e) => up({ includeInSafeToSpend: e.target.checked })}
          />{' '}
          Include in safe-to-spend
        </label>
      </div>
      <Field label="Notes">
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
      <ErrorText error={err} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {account ? 'Save account' : 'Create account'}
        </Button>
      </div>
    </form>
  );
}
