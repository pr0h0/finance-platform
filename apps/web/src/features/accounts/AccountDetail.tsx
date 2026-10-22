// Account detail: balance history chart, reconciliation against a statement balance (Feature 116)
// and archive/delete. A reconciliation difference is booked as an `adjustment` entry that
// corrects the latest transaction on/before the statement date (or as the opening balance).

import { plotValue } from '@finplat/charts';
import type * as D from '@finplat/domain';
import {
  balanceHistory,
  fromMinor,
  type LedgerTransaction,
  toMinor,
} from '@finplat/finance-engine';
import { formatMoney, intlLocale } from '@finplat/localization';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useT } from '../../lib/i18n.ts';
import { describeError, useLedgerEnv, useTransactions, useWrite } from '../transactions/data.ts';
import {
  Button,
  ErrorText,
  Field,
  inputCls,
  MoneyText,
  today,
  toMoney,
} from '../transactions/ui.tsx';

const RANGES = [
  ['3M', 90],
  ['1Y', 365],
  ['5Y', 1825],
] as const;

const shift = (d: string, days: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function AccountDetail({
  account,
  onEdit,
  onClose,
}: {
  account: D.Account;
  onEdit: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const txs = useTransactions();
  const currencies = account.balances.length
    ? account.balances.map((b) => b.currency)
    : [account.currency];
  const [currency, setCurrency] = useState(
    currencies.includes(account.currency) ? account.currency : (currencies[0] as string),
  );
  const [range, setRange] = useState<number>(365);
  const to = today();
  const from = shift(to, -range);
  const points = useMemo(() => {
    const h = balanceHistory(
      (txs.data ?? []) as unknown as LedgerTransaction[],
      account.id,
      currency,
      from,
      to,
    );
    // one point per ~120 steps keeps the SVG light for long ranges; the last day is always kept
    const step = Math.max(1, Math.ceil(h.length / 120));
    return h
      .filter((_, i) => i % step === 0 || i === h.length - 1)
      .map((p) => ({ date: p.date, value: plotValue(p.balance), label: p.balance }));
  }, [txs.data, account.id, currency, from, to]);

  const archive = useWrite((ops, isArchived: boolean) =>
    ops.update('accounts', account.id, { isArchived, version: account.version } as never),
  );
  const remove = useWrite((ops) => ops.remove('accounts', account.id, account.version));
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          {account.balances.length === 0 ? (
            <MoneyText
              value={fromMinor(0n, account.currency)}
              locale={locale}
              className="text-2xl font-semibold"
            />
          ) : (
            account.balances.map((b) => (
              <MoneyText
                key={b.currency}
                value={b}
                locale={locale}
                className="mr-3 text-2xl font-semibold"
              />
            ))
          )}
          <p className="text-sm text-muted">
            {account.institution}{' '}
            {account.accountNumberMasked && `· ${account.accountNumberMasked}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            className="inline-flex h-9 items-center rounded-md border border-line px-3 text-sm"
            to={`/transactions?accountId=${account.id}`}
          >
            {t('nav.transactions', 'Transactions')}
          </Link>
          <Button onClick={onEdit}>{t('common.edit', 'Edit')}</Button>
          <Button
            onClick={() =>
              archive.mutateAsync(!account.isArchived).catch((e) => setErr(describeError(e)))
            }
          >
            {account.isArchived
              ? t('accounts.accountDetail.unarchive', 'Unarchive')
              : t('accounts.accountDetail.archive', 'Archive')}
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              window.confirm(
                `Delete ${account.name}? Only accounts without transactions can be deleted.`,
              ) &&
              remove
                .mutateAsync(undefined)
                .then(onClose)
                .catch((e) => setErr(describeError(e)))
            }
          >
            {t('common.delete', 'Delete')}
          </Button>
        </div>
      </div>
      <ErrorText error={err} />

      <section aria-label={t('accounts.accountDetail.balanceHistory', 'Balance history')}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {t('accounts.accountDetail.balanceHistory', 'Balance history')}
          </h3>
          <div className="flex gap-1">
            {currencies.length > 1 && (
              <select
                aria-label={t('account.currency', 'Currency')}
                className={`${inputCls} h-7 w-auto text-xs`}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            )}
            {RANGES.map(([l, d]) => (
              <Button
                key={l}
                size="sm"
                variant={range === d ? 'primary' : 'secondary'}
                aria-pressed={range === d}
                onClick={() => setRange(d)}
              >
                {l}
              </Button>
            ))}
          </div>
        </div>
        <div className="h-56">
          {txs.isLoading ? (
            <p role="status" className="text-sm text-muted">
              {t('common.loading', 'Loading…')}
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'var(--muted)' }}
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--muted)' }}
                  width={70}
                  tickFormatter={(v: number) =>
                    new Intl.NumberFormat(intlLocale(locale), { notation: 'compact' }).format(v)
                  }
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    fontSize: 12,
                  }}
                  formatter={(_v, _n, item) => [
                    formatMoney((item.payload as { label: D.Money }).label, locale),
                    'Balance',
                  ]}
                />
                <Area
                  type="stepAfter"
                  dataKey="value"
                  stroke="var(--accent)"
                  fill="var(--accent)"
                  fillOpacity={0.12}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <p className="sr-only">
          {t('accounts.accountDetail.balanceOnFrom', 'Balance on {{from}}:', { from: from })}{' '}
          {points[0] && formatMoney(points[0].label, locale)}
          {t('accounts.accountDetail.onTo', '; on {{to}}:', { to: to })}{' '}
          {points.at(-1) && formatMoney((points.at(-1) as { label: D.Money }).label, locale)}.
        </p>
      </section>

      {txs.data && <Reconcile account={account} txs={txs.data} />}
    </div>
  );
}

function Reconcile({ account, txs }: { account: D.Account; txs: D.Transaction[] }) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const [date, setDate] = useState(today());
  const [currency, setCurrency] = useState(account.currency);
  const [stmt, setStmt] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const statement = toMoney(stmt, currency, locale);
  const ledgerBal = useMemo(() => {
    const h = balanceHistory(
      txs as unknown as LedgerTransaction[],
      account.id,
      currency,
      date,
      date,
    );
    return h[0]?.balance ?? fromMinor(0n, currency);
  }, [txs, account.id, currency, date]);
  const diff = statement ? fromMinor(toMinor(statement) - toMinor(ledgerBal), currency) : null;

  // The entry the adjustment corrects: latest live transaction on this account up to the date.
  const target = useMemo(
    () =>
      txs
        .filter(
          (t) =>
            t.status !== 'void' &&
            t.bookingDate <= date &&
            t.postings.some((p) => p.accountId === account.id && p.amount.currency === currency),
        )
        .sort(
          (a, b) =>
            b.bookingDate.localeCompare(a.bookingDate) || b.createdAt.localeCompare(a.createdAt),
        )[0],
    [txs, account.id, currency, date],
  );

  const book = useWrite(async (ops, d: D.Money) => {
    if (target)
      return ops.createAdjustment(target.id, {
        amount: d,
        bookingDate: date,
        reason: `Reconciliation adjustment (statement ${date}: ${statement?.amount} ${currency})`,
        accountId: account.id,
      });
    return ops.createTransaction({
      kind: 'opening_balance',
      accountId: account.id,
      amount: d.amount.startsWith('-') ? { ...d, amount: d.amount.slice(1) } : d,
      bookingDate: date,
      description: 'Opening balance (reconciliation)',
    });
  });

  const submit = async () => {
    setErr(null);
    setDone(null);
    if (!diff) return setErr('Enter the statement balance.');
    if (toMinor(diff) === 0n)
      return setDone('The ledger matches the statement. Nothing to adjust.');
    if (!target && toMinor(diff) < 0n)
      return setErr(
        'The account has no transactions yet; record a negative opening balance via a new liability account or add transactions first.',
      );
    try {
      await book.mutateAsync(diff);
      setDone('Adjustment recorded; the balance now matches the statement.');
    } catch (e) {
      setErr(describeError(e));
    }
  };

  return (
    <section
      aria-label={t('accounts.accountDetail.reconcile', 'Reconcile')}
      className="rounded-md border border-line p-3"
    >
      <h3 className="mb-2 text-sm font-semibold">
        {t('accounts.accountDetail.reconcileWithAStatement', 'Reconcile with a statement')}
      </h3>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('accounts.accountDetail.statementDate', 'Statement date')}>
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
        {account.isMultiCurrency && (
          <Field label={t('account.currency', 'Currency')}>
            {(id) => (
              <input
                id={id}
                maxLength={3}
                className={`${inputCls} w-20 uppercase`}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            )}
          </Field>
        )}
        <Field
          label={t('accounts.accountDetail.statementBalance', 'Statement balance ({{currency}})', {
            currency: currency,
          })}
        >
          {(id) => (
            <input
              id={id}
              inputMode="decimal"
              className={`${inputCls} w-36`}
              value={stmt}
              onChange={(e) => setStmt(e.target.value)}
            />
          )}
        </Field>
        <Button onClick={submit} disabled={book.isPending}>
          {t('accounts.accountDetail.reconcile', 'Reconcile')}
        </Button>
      </div>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 text-sm">
        <dt className="text-muted">
          {t('accounts.accountDetail.ledgerBalance', 'Ledger balance')}
        </dt>
        <dd>
          <MoneyText value={ledgerBal} locale={locale} />
        </dd>
        {diff && (
          <>
            <dt className="text-muted">{t('accounts.accountDetail.difference', 'Difference')}</dt>
            <dd>
              <MoneyText value={diff} locale={locale} signed />
            </dd>
          </>
        )}
      </dl>
      {done && (
        <p role="status" className="mt-2 text-sm text-pos">
          {done}
        </p>
      )}
      <ErrorText error={err} />
    </section>
  );
}
