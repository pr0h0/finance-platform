// Recurrence exceptions for one occurrence: skip, mark paid, move, change amount, match to a
// recorded transaction (counted once), or reset to pending.
import { addDays, toMinor } from '@finplat/finance-engine';
import { useState } from 'react';
import { useFormat } from '../../lib/format.ts';
import { useOpsMutation } from '../analytics/hooks.ts';
import type { Snapshot } from '../analytics/snapshot.ts';
import {
  Amount,
  Button,
  ErrorText,
  Field,
  Input,
  parseMoneyInput,
  Select,
} from '../analytics/ui.tsx';
import { CONFIDENCE_LABEL, PRIORITY_LABEL } from './labels.ts';
import type { OccRow } from './occurrences.ts';
import { describeRRule } from './rrule.ts';

export function OccurrenceDetail({
  snap,
  row,
  onEditPlan,
  onDone,
}: {
  snap: Snapshot;
  row: OccRow;
  onEditPlan: () => void;
  onDone: () => void;
}) {
  const f = useFormat();
  const [amount, setAmount] = useState(row.amount.amount);
  const [date, setDate] = useState(row.date);
  const [match, setMatch] = useState(row.stored?.matchedTransactionId ?? '');
  const [err, setErr] = useState<unknown>(null);
  const set = useOpsMutation((ops, v: Parameters<typeof ops.setOccurrence>[2]) =>
    ops.setOccurrence(row.plan.id, row.occurrenceDate, v),
  );
  const go = (v: Parameters<typeof set.mutate>[0]) =>
    set.mutate(v, { onSuccess: onDone, onError: setErr });
  const schedule = snap.schedules.find((s) => s.id === row.plan.recurrenceId);
  const sign = row.plan.kind === 'income' ? 1n : -1n;
  const candidates = snap.transactions
    .filter(
      (t) =>
        (t.kind === 'expense' || t.kind === 'income') &&
        t.bookingDate >= addDays(row.occurrenceDate, -20) &&
        t.bookingDate <= addDays(row.occurrenceDate, 20) &&
        t.postings.some(
          (p) =>
            (!row.plan.accountId || p.accountId === row.plan.accountId) &&
            toMinor(p.amount) * sign > 0n,
        ),
    )
    .slice(0, 50);

  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted">Plan</dt>
        <dd>{row.plan.description}</dd>
        <dt className="text-muted">Date</dt>
        <dd>
          {f.date(row.date)}
          {row.date !== row.occurrenceDate && (
            <span className="text-muted"> (scheduled {f.date(row.occurrenceDate)})</span>
          )}
        </dd>
        <dt className="text-muted">Amount</dt>
        <dd>
          <Amount value={row.amount} />
          {row.plan.amountMin && row.plan.amountMax && (
            <span className="text-muted">
              {' '}
              (<Amount value={row.plan.amountMin} />–<Amount value={row.plan.amountMax} />)
            </span>
          )}
        </dd>
        <dt className="text-muted">Status</dt>
        <dd>{row.overdue ? 'overdue' : row.status.replace('_', ' ')}</dd>
        <dt className="text-muted">Priority / confidence</dt>
        <dd>
          {PRIORITY_LABEL[row.plan.priority]} · {CONFIDENCE_LABEL[row.plan.confidence]}
        </dd>
        {schedule && (
          <>
            <dt className="text-muted">Repeats</dt>
            <dd>{describeRRule(schedule.rrule)}</dd>
          </>
        )}
        {row.installmentNo && (
          <>
            <dt className="text-muted">Installment</dt>
            <dd>
              {row.installmentNo} of {row.plan.installmentTotal}
            </dd>
          </>
        )}
      </dl>

      <fieldset className="grid grid-cols-2 gap-3 rounded-md border border-line p-3">
        <legend className="px-1 font-medium">Change this occurrence only</legend>
        <Field label={`Amount (${row.amount.currency})`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Button
            onClick={() => {
              const m = parseMoneyInput(amount, row.amount.currency, f.parseDecimal);
              if (!m) return setErr(new Error('Enter a valid amount'));
              go({
                status: 'pending',
                amountOverride: m.amount === row.plan.amount.amount ? null : m,
                dateOverride: date === row.occurrenceDate ? null : date,
                matchedTransactionId: null,
              });
            }}
          >
            Save change
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border border-line p-3">
        <legend className="px-1 font-medium">Match to a recorded transaction</legend>
        <Select value={match} onChange={(e) => setMatch(e.target.value)} className="w-full">
          <option value="">Choose…</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.bookingDate} · {t.description || t.payee || t.kind} ·{' '}
              {t.postings[0]?.amount.amount} {t.postings[0]?.amount.currency}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted">
          A matched occurrence is no longer counted as planned, so the payment counts once.
        </p>
        <Button
          disabled={!match}
          onClick={() => go({ status: 'matched', matchedTransactionId: match })}
        >
          Match
        </Button>
      </fieldset>

      <ErrorText error={err} />
      <div className="flex flex-wrap justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => go({ status: 'paid_manual', matchedTransactionId: null })}>
            Mark paid
          </Button>
          <Button onClick={() => go({ status: 'skipped', matchedTransactionId: null })}>
            Skip
          </Button>
          {row.stored && (
            <Button
              onClick={() =>
                go({
                  status: 'pending',
                  amountOverride: null,
                  dateOverride: null,
                  matchedTransactionId: null,
                })
              }
            >
              Reset
            </Button>
          )}
        </div>
        <Button variant="ghost" onClick={onEditPlan}>
          Edit whole series…
        </Button>
      </div>
    </div>
  );
}
