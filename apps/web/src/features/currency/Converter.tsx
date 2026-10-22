// Built-in currency converter (Features 19, 20, 23, 25): historical rate by date from the local
// rate book (fixed EUR/BAM included), optional manual rate, server lookup in connected mode when
// no local rate exists, and "create planned expense" from the result.

import { type ConvertResult, convertMoney } from '@finplat/currency';
import type * as D from '@finplat/domain';
import { createRateBook } from '@finplat/finance-engine';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../lib/i18n.ts';
import { describeError, qk, useEntities, useLedgerEnv, useWrite } from '../transactions/data.ts';
import {
  Button,
  ErrorText,
  Field,
  inputCls,
  MoneyText,
  today,
  toMoney,
} from '../transactions/ui.tsx';

type Result = ConvertResult & { origin: 'local' | 'server' | 'manual'; stale?: boolean };

export function Converter() {
  const t = useT();
  const { ops, profile, profileId, locale, api } = useLedgerEnv();
  const rates = useQuery({ queryKey: qk(profileId, 'rates'), queryFn: () => ops.rateSnapshots() });
  const [amount, setAmount] = useState('100');
  const [from, setFrom] = useState(profile.baseCurrency === 'EUR' ? 'BAM' : 'EUR');
  const [to, setTo] = useState(profile.baseCurrency);
  const [date, setDate] = useState(today());
  const [manual, setManual] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saveRate = useWrite((o, r: Result) =>
    o.addExchangeRate({
      baseCurrency: r.from.currency,
      quoteCurrency: r.to.currency,
      rate: r.rate,
      rateDate: r.rateDate,
    }),
  );

  const run = async () => {
    setErr(null);
    setRes(null);
    const f = from.trim().toUpperCase();
    const t = to.trim().toUpperCase();
    const m = toMoney(amount, f, locale);
    if (!m) return setErr(`Enter a valid amount in ${f}.`);
    const rate = manual.replace(',', '.').trim();
    if (rate && !/^\d+(\.\d+)?$/.test(rate))
      return setErr('The manual rate must be a positive decimal.');
    try {
      const local = convertMoney(
        createRateBook(rates.data ?? []),
        m,
        t,
        date,
        rate ? { rate } : {},
      );
      if (local) return setRes({ ...local, origin: rate ? 'manual' : 'local' });
      if (!api)
        return setErr(
          `No ${f}/${t} rate on or before ${date}. Add the rate below (e.g. from your bank) to convert offline.`,
        );
      setBusy(true);
      const r = await api.request<ConvertResult & { stale?: boolean }>('POST', '/api/v1/convert', {
        amount: m,
        to: t,
        date,
      });
      setRes({ ...r, origin: 'server' });
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section
        aria-label={t('currency.converter.convert', 'Convert')}
        className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('transaction.amount', 'Amount')}>
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                className={`${inputCls} w-36`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('reports.page.from', 'From')}>
            {(id) => (
              <input
                id={id}
                maxLength={3}
                className={`${inputCls} w-20 uppercase`}
                value={from}
                onChange={(e) => setFrom(e.target.value.toUpperCase())}
              />
            )}
          </Field>
          <Button
            variant="ghost"
            aria-label={t('currency.converter.swapCurrencies', 'Swap currencies')}
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
          >
            <ArrowLeftRight size={16} aria-hidden />
          </Button>
          <Field label={t('reports.page.to', 'To')}>
            {(id) => (
              <input
                id={id}
                maxLength={3}
                className={`${inputCls} w-20 uppercase`}
                value={to}
                onChange={(e) => setTo(e.target.value.toUpperCase())}
              />
            )}
          </Field>
          <Field label={t('currency.converter.rateDate', 'Rate date')}>
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
        </div>
        <Field
          label={t(
            'currency.converter.manualRatePer1',
            'Manual rate ({{to}} per 1 {{from}}, optional)',
            { to: to, from: from },
          )}
          hint={t('currency.converter.eGTheRate', 'e.g. the rate your bank actually applied')}
        >
          {(id, d) => (
            <input
              id={id}
              aria-describedby={d}
              inputMode="decimal"
              className={`${inputCls} w-48`}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
          )}
        </Field>
        <div>
          <Button variant="primary" onClick={run} disabled={busy}>
            {t('currency.converter.convert', 'Convert')}
          </Button>
        </div>
        <ErrorText error={err} />
        {res && (
          <div role="status" className="rounded-md bg-surface-2 p-3">
            <p className="text-2xl font-semibold">
              <MoneyText value={res.to} locale={locale} />
            </p>
            <p className="text-sm text-muted">
              <MoneyText value={res.from} locale={locale} />{' '}
              {t(
                'currency.converter.atRateCurrencyCurrency2',
                'at {{rate}} {{currency}}/{{currency2}} ({{source}}',
                {
                  rate: res.rate,
                  currency: res.to.currency,
                  currency2: res.from.currency,
                  source: res.source,
                },
              )}
              {res.inverse && t('currency.converter.inverse', ', inverse')}, {res.rateDate}
              {res.origin === 'server' && t('currency.converter.fromServer', ', from server')}
              {res.stale &&
                t('currency.converter.staleProviderUnreachable', ', stale: provider unreachable')}
              )
            </p>
            {res.origin === 'server' && (
              <Button
                size="sm"
                className="mt-2"
                onClick={() => saveRate.mutateAsync(res).catch((e) => setErr(describeError(e)))}
              >
                {t('currency.converter.saveThisRateOn', 'Save this rate on this profile')}
              </Button>
            )}
            <PlanFromResult result={res.to} />
          </div>
        )}
      </section>
      <AddRate />
    </div>
  );
}

function PlanFromResult({ result }: { result: D.Money }) {
  const t = useT();
  const accounts = useEntities('accounts');
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const [due, setDue] = useState(today());
  const [accountId, setAccountId] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = useWrite((o, body: Parameters<typeof o.create<'planned_transactions'>>[1]) =>
    o.create('planned_transactions', body),
  );
  const usable = (accounts.data ?? []).filter(
    (a) => !a.isArchived && (a.currency === result.currency || a.isMultiCurrency),
  );
  if (result.amount.startsWith('-') || /^0+(\.0+)?$/.test(result.amount)) return null;
  if (!open)
    return (
      <Button size="sm" className="mt-2 ml-2" onClick={() => setOpen(true)}>
        {t('currency.converter.createPlannedExpense', 'Create planned expense')}
      </Button>
    );
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
      <Field label={t('transaction.description', 'Description')}>
        {(id) => (
          <input
            id={id}
            className={inputCls}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        )}
      </Field>
      <Field label={t('currency.converter.dueDate', 'Due date')}>
        {(id) => (
          <input
            id={id}
            type="date"
            className={inputCls}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        )}
      </Field>
      <Field label={t('currency.converter.payFrom', 'Pay from')}>
        {(id) => (
          <select
            id={id}
            className={inputCls}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">{t('currency.converter.noAccountYet', 'No account yet')}</option>
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Button
        size="sm"
        variant="primary"
        disabled={create.isPending}
        onClick={() =>
          create
            .mutateAsync({
              kind: 'expense',
              amount: result,
              dueDate: due,
              description: desc,
              accountId: accountId || null,
            })
            .then(() => setDone(true))
            .catch((e) => setErr(describeError(e)))
        }
      >
        {t('currency.converter.savePlan', 'Save plan')}
      </Button>
      {done && (
        <span className="text-sm text-pos">
          {t('currency.converter.plannedExpenseSavedSee', 'Planned expense saved (see Planning).')}
        </span>
      )}
      <ErrorText error={err} />
    </div>
  );
}

function AddRate() {
  const t = useT();
  const { ops, profileId } = useLedgerEnv();
  const rates = useQuery({ queryKey: qk(profileId, 'rates'), queryFn: () => ops.rateSnapshots() });
  const [base, setBase] = useState('EUR');
  const [quote, setQuote] = useState('USD');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(today());
  const [err, setErr] = useState<string | null>(null);
  const add = useWrite((o, body: Parameters<typeof o.addExchangeRate>[0]) =>
    o.addExchangeRate(body),
  );
  const recent = [...(rates.data ?? [])]
    .sort((a, b) => b.rateDate.localeCompare(a.rateDate))
    .slice(0, 30);
  return (
    <section
      aria-label={t('currency.converter.exchangeRates', 'Exchange rates')}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h2 className="text-sm font-semibold">
        {t('currency.converter.exchangeRatesOnThis', 'Exchange rates on this profile')}
      </h2>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('currency.converter.base', 'Base')}>
          {(id) => (
            <input
              id={id}
              maxLength={3}
              className={`${inputCls} w-20 uppercase`}
              value={base}
              onChange={(e) => setBase(e.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field label={t('currency.converter.quote', 'Quote')}>
          {(id) => (
            <input
              id={id}
              maxLength={3}
              className={`${inputCls} w-20 uppercase`}
              value={quote}
              onChange={(e) => setQuote(e.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field label={`1 ${base} =`}>
          {(id) => (
            <input
              id={id}
              inputMode="decimal"
              className={`${inputCls} w-32`}
              value={rate}
              onChange={(e) => setRate(e.target.value.replace(',', '.'))}
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
        <Button
          onClick={() => {
            setErr(null);
            add
              .mutateAsync({ baseCurrency: base, quoteCurrency: quote, rate, rateDate: date })
              .then(() => setRate(''))
              .catch((e) => setErr(describeError(e)));
          }}
        >
          {t('currency.converter.addRate', 'Add rate')}
        </Button>
      </div>
      <ErrorText error={err} />
      <p className="text-xs text-muted">
        {t(
          'currency.converter.eurBamUsesThe',
          'EUR/BAM uses the fixed 1.95583 parity automatically. Manual rates win over provider rates on the same day.',
        )}
      </p>
      {recent.length > 0 && (
        <table className="text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-medium">{t('transaction.date', 'Date')}</th>
              <th className="font-medium">{t('currency.converter.pair', 'Pair')}</th>
              <th className="text-right font-medium">{t('currency.converter.rate', 'Rate')}</th>
              <th className="font-medium">{t('currency.converter.source', 'Source')}</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr
                key={`${r.baseCurrency}${r.quoteCurrency}${r.rateDate}${r.source}`}
                className="border-t border-line"
              >
                <td className="py-1 tabular-nums">{r.rateDate}</td>
                <td>
                  {r.baseCurrency}/{r.quoteCurrency}
                </td>
                <td className="text-right tabular-nums">{r.rate}</td>
                <td>{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
