// Quick actions (feature 53): expense, income, transfer and planned transaction from the dashboard.
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CalendarPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useApp } from '../../app/store.ts';
import { useFormat } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { useOpsMutation } from '../analytics/hooks.ts';
import { type Snapshot, todayIso } from '../analytics/snapshot.ts';
import {
  Button,
  Dialog,
  ErrorText,
  Field,
  Input,
  parseMoneyInput,
  Select,
} from '../analytics/ui.tsx';
import { PlanEditor } from '../planning/PlanEditor.tsx';

type Kind = 'expense' | 'income' | 'transfer';

export function QuickActions({ snap }: { snap: Snapshot }) {
  const t = useT();
  const [open, setOpen] = useState<Kind | 'planned' | null>(null);
  const items = [
    { k: 'expense', label: t('transaction.kind.expense', 'Expense'), Icon: ArrowUpRight },
    { k: 'income', label: t('transaction.kind.income', 'Income'), Icon: ArrowDownLeft },
    { k: 'transfer', label: t('transaction.kind.transfer', 'Transfer'), Icon: ArrowLeftRight },
    { k: 'planned', label: t('dashboard.quickActions.planned', 'Planned'), Icon: CalendarPlus },
  ] as const;
  return (
    <>
      {items.map(({ k, label, Icon }) => (
        <Button
          key={k}
          onClick={() => setOpen(k)}
          disabled={!snap.accounts.length && k !== 'planned'}
        >
          <Icon aria-hidden className="size-4" />
          {label}
        </Button>
      ))}
      <Dialog
        open={open === 'planned'}
        onClose={() => setOpen(null)}
        title={t('cmd.newPlanned', 'New planned transaction')}
      >
        <PlanEditor snap={snap} onDone={() => setOpen(null)} />
      </Dialog>
      {open && open !== 'planned' && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={t('dashboard.quickActions.new', 'New {{open}}', { open: open })}
        >
          <EntryForm snap={snap} kind={open} onDone={() => setOpen(null)} />
        </Dialog>
      )}
    </>
  );
}

function EntryForm({ snap, kind, onDone }: { snap: Snapshot; kind: Kind; onDone: () => void }) {
  const t = useT();
  const f = useFormat();
  const recent = useApp((s) => s.recent);
  const setApp = useApp((s) => s.set);
  const accounts = snap.accounts.filter((a) => !a.isArchived);
  const [accountId, setAccountId] = useState(
    accounts.some((a) => a.id === recent.accountId)
      ? (recent.accountId as string)
      : (accounts[0]?.id ?? ''),
  );
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const from = accounts.find((a) => a.id === accountId);
  const to = accounts.find((a) => a.id === toAccountId);
  const cross = kind === 'transfer' && from && to && from.currency !== to.currency;
  const save = useOpsMutation((ops, input: Parameters<typeof ops.createTransaction>[0]) =>
    ops.createTransaction(input),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!from) return setErr(new Error('Choose an account'));
    const amt = parseMoneyInput(amount, from.currency, f.parseDecimal);
    if (!amt) return setErr(new Error(`Enter a valid ${from.currency} amount`));
    const toAmt = cross && to ? parseMoneyInput(toAmount, to.currency, f.parseDecimal) : null;
    if (cross && !toAmt) return setErr(new Error(`Enter the ${to?.currency} amount received`));
    save.mutate(
      {
        kind,
        accountId,
        amount: amt,
        bookingDate: date,
        description,
        ...(kind === 'transfer'
          ? { toAccountId, ...(toAmt ? { toAmount: toAmt } : {}) }
          : { categoryId: categoryId || null }),
      },
      {
        onSuccess: () => {
          setApp({ recent: { kind, accountId, toAccountId, categoryId: categoryId || null } });
          onDone();
        },
        onError: setErr,
      },
    );
  };
  const cats = snap.categories.filter(
    (c) => !c.isArchived && c.kind === (kind === 'income' ? 'income' : 'expense'),
  );
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field
        label={
          kind === 'transfer' ? t('quick.from', 'From account') : t('quick.account', 'Account')
        }
      >
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.currency})
            </option>
          ))}
        </Select>
      </Field>
      {kind === 'transfer' ? (
        <Field label={t('quick.to', 'To account')}>
          <Select required value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
            <option value="">{t('quick.choose', 'Choose…')}</option>
            {accounts
              .filter((a) => a.id !== accountId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
          </Select>
        </Field>
      ) : (
        <Field label={t('transaction.category', 'Category')}>
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t('transaction.uncategorized', 'Uncategorized')}</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label={t('dashboard.quickActions.amount', 'Amount ({{v0}})', { v0: from?.currency ?? '' })}
      >
        <Input
          autoFocus
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      {cross && (
        <Field
          label={t('dashboard.quickActions.received', 'Received ({{currency}})', {
            currency: to?.currency,
          })}
        >
          <Input
            required
            inputMode="decimal"
            value={toAmount}
            onChange={(e) => setToAmount(e.target.value)}
          />
        </Field>
      )}
      <Field label={t('transaction.date', 'Date')}>
        <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label={t('transaction.description', 'Description')}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="col-span-full">
        <ErrorText error={err} />
      </div>
      <div className="col-span-full flex justify-end gap-2">
        <Button onClick={onDone}>{t('common.cancel', 'Cancel')}</Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {t('common.save', 'Save')}
        </Button>
      </div>
    </form>
  );
}
