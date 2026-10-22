// Possible duplicates among all live transactions, manual entries included (feature 78), using the
// shared engine rule (findDuplicates). Import staging separately flags re-imported rows (fp1).
// "Not a duplicate" is remembered per group in the profile setting duplicates.dismissed.
import type * as D from '@finplat/domain';
import {
  type DuplicateGroup,
  findDuplicates,
  type LedgerTransaction,
} from '@finplat/finance-engine';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { qk, type Refs, useLedgerEnv, useTransactions, useWrite } from './data.ts';
import { primaryAmount } from './model.ts';
import { Button, Empty, MoneyText } from './ui.tsx';

const groupKey = (g: DuplicateGroup) => [...g.transactionIds].sort().join(',');
const SETTING = 'duplicates.dismissed';

export function useDuplicates() {
  const { ops, profileId } = useLedgerEnv();
  const all = useTransactions();
  const dismissed = useQuery({
    queryKey: qk(profileId, 'settings', 'duplicates'),
    queryFn: async () => {
      const v = (await ops.getSettings())[SETTING];
      return new Set(Array.isArray(v) ? (v as string[]) : []);
    },
  });
  const groups = useMemo(
    () =>
      all.data && dismissed.data
        ? findDuplicates(all.data as unknown as LedgerTransaction[]).filter(
            (g) => !dismissed.data.has(groupKey(g)),
          )
        : [],
    [all.data, dismissed.data],
  );
  const dismiss = useWrite(async (o, g: DuplicateGroup) => {
    const v = (await o.getSettings())[SETTING];
    await o.setSetting(SETTING, [...(Array.isArray(v) ? v : []), groupKey(g)]);
  });
  const byId = useMemo(() => new Map((all.data ?? []).map((t) => [t.id, t])), [all.data]);
  return { groups, dismiss, byId };
}

function Members({
  g,
  byId,
  refs,
}: {
  g: DuplicateGroup;
  byId: Map<string, D.Transaction>;
  refs: Refs;
}) {
  const { locale } = useLedgerEnv();
  return (
    <ul className="text-sm">
      {g.transactionIds.map((id) => {
        const t = byId.get(id);
        if (!t) return null;
        return (
          <li key={id}>
            {t.bookingDate} · {t.description || t.payee || '(no description)'} ·{' '}
            <MoneyText value={primaryAmount(t)} locale={locale} signed /> ·{' '}
            {refs.accountName(t.postings[0]?.accountId ?? '')} · {t.source}
          </li>
        );
      })}
    </ul>
  );
}

/** Notice in the details drawer when this transaction looks like another one. */
export function DuplicateNotice({ tx, refs }: { tx: D.Transaction; refs: Refs }) {
  const { groups, dismiss, byId } = useDuplicates();
  const g = groups.find((x) => x.transactionIds.includes(tx.id));
  if (!g) return null;
  return (
    <section
      role="status"
      aria-label="Possible duplicate"
      className="mb-3 rounded-md border border-warn/50 bg-warn/10 p-3 text-sm"
    >
      <p className="font-medium">Possible duplicate ({g.reasons.join(', ')})</p>
      <Members g={g} byId={byId} refs={refs} />
      <Button size="sm" className="mt-2" onClick={() => dismiss.mutate(g)}>
        Not a duplicate
      </Button>
    </section>
  );
}

/** The "Possible duplicates" view of the transactions page. */
export function DuplicatesList({ refs, onOpen }: { refs: Refs; onOpen: (id: string) => void }) {
  const { groups, dismiss, byId } = useDuplicates();
  if (groups.length === 0)
    return (
      <Empty title="No possible duplicates">
        Transactions on the same account with the same amount a few days apart are listed here.
      </Empty>
    );
  return (
    <ul className="flex flex-col gap-2">
      {groups.map((g) => (
        <li key={groupKey(g)} className="rounded-md border border-line p-3">
          <p className="mb-1 text-xs text-muted">
            Score {g.score} · {g.reasons.join(', ')}
          </p>
          <Members g={g} byId={byId} refs={refs} />
          <div className="mt-2 flex flex-wrap gap-2">
            {g.transactionIds.map((id, i) => (
              <Button key={id} size="sm" onClick={() => onOpen(id)}>
                Open #{i + 1}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(g)}>
              Not a duplicate
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
