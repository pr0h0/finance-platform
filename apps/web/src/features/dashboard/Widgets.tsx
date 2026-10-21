// Dashboard widget bodies. Each reads the shared Snapshot; nothing is hardcoded.
import { addMonths, fromMinor, startOfMonth, toMinor } from '@finplat/finance-engine';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useData } from '../../app/data.tsx';
import { useFormat } from '../../lib/format.ts';
import { type ChartRow, MoneyChart } from '../analytics/chart.tsx';
import { transactionsLink } from '../analytics/drill.ts';
import { useOpsQuery } from '../analytics/hooks.ts';
import type { Snapshot } from '../analytics/snapshot.ts';
import {
  Amount,
  DataBanner,
  Empty,
  ProgressBar,
  SERIES,
  SERIES_OTHER,
  Stat,
} from '../analytics/ui.tsx';
import {
  accountBreakdown,
  categoryDistribution,
  goalProgress,
  importCoverage,
  insights,
  largestExpenses,
  monthEndProjection,
  monthSummary,
  recentTransactions,
  spendingTrend,
  subscriptionCosts,
  upcomingBills,
} from './compute.ts';
import type { WidgetId } from './layout.ts';

export function WidgetBody({ id, snap }: { id: WidgetId; snap: Snapshot }) {
  switch (id) {
    case 'total-balance':
      return <TotalBalance snap={snap} />;
    case 'month-income':
    case 'month-expenses':
    case 'net-cash-flow':
    case 'savings-rate':
      return <MonthFigure snap={snap} which={id} />;
    case 'month-end':
      return <MonthEnd snap={snap} />;
    case 'accounts':
      return <Accounts snap={snap} />;
    case 'upcoming-bills':
      return <Bills snap={snap} />;
    case 'budgets':
      return <Budgets snap={snap} />;
    case 'categories':
      return <Categories snap={snap} />;
    case 'trends':
      return <Trend snap={snap} />;
    case 'recent':
      return <Recent snap={snap} />;
    case 'largest':
      return <Largest snap={snap} />;
    case 'subscriptions':
      return <Subscriptions snap={snap} />;
    case 'goals':
      return <Goals snap={snap} />;
    case 'insights':
      return <Insights snap={snap} />;
    case 'import-coverage':
      return <Coverage snap={snap} />;
    case 'sync-health':
      return <SyncHealth />;
  }
}

function TotalBalance({ snap }: { snap: Snapshot }) {
  const { netWorth: nw } = accountBreakdown(snap);
  return (
    <>
      <Stat
        label={`Net worth (${snap.currency})`}
        value={<Amount value={nw.netWorth} />}
        hint={
          <>
            Assets <Amount value={nw.assets} /> · Liabilities <Amount value={nw.liabilities} />
          </>
        }
      />
      <DataBanner missingRates={nw.missingRates} />
    </>
  );
}

function MonthFigure({ snap, which }: { snap: Snapshot; which: WidgetId }) {
  const f = useFormat();
  const m = monthSummary(snap);
  const from = startOfMonth(snap.today);
  const value =
    which === 'month-income' ? (
      <Link
        className="hover:underline"
        to={transactionsLink({ from, to: snap.today, kind: 'income' })}
      >
        <Amount value={m.income} />
      </Link>
    ) : which === 'month-expenses' ? (
      <Link
        className="hover:underline"
        to={transactionsLink({ from, to: snap.today, kind: 'expense' })}
      >
        <Amount value={m.expense} />
      </Link>
    ) : which === 'net-cash-flow' ? (
      <Amount value={m.net} tone />
    ) : m.savingsRate ? (
      f.percent(m.savingsRate)
    ) : (
      '—'
    );
  return (
    <>
      <Stat
        label={f.month(snap.today.slice(0, 7))}
        value={value}
        hint={which === 'savings-rate' ? '(income − spending) / income' : undefined}
      />
      <DataBanner missingRates={m.missingRates} />
    </>
  );
}

function MonthEnd({ snap }: { snap: Snapshot }) {
  const f = useFormat();
  const p = monthEndProjection(snap);
  return (
    <Stat
      label="Expected, from balances and plans"
      value={<Amount value={p.amount} tone />}
      hint={
        <>
          Lowest <Amount value={p.lowest.amount} tone /> on {f.date(p.lowest.date)}
          {!p.complete && ' · incomplete (missing rates or accounts)'}
        </>
      }
    />
  );
}

function Accounts({ snap }: { snap: Snapshot }) {
  const f = useFormat();
  const { rows } = accountBreakdown(snap);
  if (!rows.length)
    return (
      <Empty>
        No accounts yet.{' '}
        <Link className="underline" to="/accounts">
          Add one
        </Link>
        .
      </Empty>
    );
  return (
    <ul className="divide-y divide-line text-sm">
      {rows.map((r) => (
        <li key={r.account.id} className="flex items-center gap-3 py-1.5">
          <Link
            to={transactionsLink({ accountIds: [r.account.id] })}
            className="min-w-0 flex-1 truncate hover:underline"
          >
            {r.account.name}
            <span className="ml-2 text-xs text-muted">
              {r.account.classification === 'liability' ? 'liability' : r.account.accountType}
            </span>
          </Link>
          <span className="hidden w-24 sm:block">
            {r.share !== null && (
              <ProgressBar
                label={`${(r.share * 100).toFixed(1)}% of assets`}
                parts={[
                  { value: r.share, className: 'bg-accent', title: 'share' },
                  { value: 1 - r.share, className: 'bg-transparent', title: 'rest' },
                ]}
              />
            )}
          </span>
          <span className="w-12 text-right text-xs text-muted">
            {r.share !== null ? f.percent(String(r.share), 0) : ''}
          </span>
          <span className="text-right">
            {r.account.balances.length ? (
              r.account.balances.map((b) => <Amount key={b.currency} value={b} className="block" />)
            ) : (
              <Amount value={fromMinor(0n, r.account.currency)} />
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Bills({ snap }: { snap: Snapshot }) {
  const f = useFormat();
  const bills = upcomingBills(snap).slice(0, 8);
  if (!bills.length) return <Empty>No bills due in the next 30 days.</Empty>;
  return (
    <ul className="space-y-1 text-sm">
      {bills.map((b) => (
        <li key={`${b.planId}|${b.occurrenceDate}`} className="flex justify-between gap-2">
          <span className="truncate">
            <span className={b.overdue ? 'text-neg' : 'text-muted'}>
              {b.overdue ? 'Overdue' : f.date(b.date)}
            </span>{' '}
            {b.plan.description}
          </span>
          <Amount value={b.amount} />
        </li>
      ))}
    </ul>
  );
}

function Budgets({ snap }: { snap: Snapshot }) {
  const active = snap.budgets.filter(
    (b) =>
      !b.isTemplate &&
      !b.isArchived &&
      b.startDate <= snap.today &&
      (!b.endDate || b.endDate >= snap.today),
  );
  const q = useOpsQuery(['budget-status', active.map((b) => b.id).join(','), snap.today], (ops) =>
    Promise.all(
      active.map((b) =>
        ops
          .budgetStatus(b.id, snap.today)
          .then((s) => ({ b, s }))
          .catch(() => null),
      ),
    ),
  );
  if (!active.length)
    return (
      <Empty>
        No active budgets.{' '}
        <Link className="underline" to="/budgets">
          Create one
        </Link>
        .
      </Empty>
    );
  return (
    <ul className="space-y-2 text-sm">
      {(q.data ?? [])
        .filter((x) => x !== null)
        .map(({ b, s }) => {
          const lim = Number(s.totals.limit.amount) || 1;
          return (
            <li key={b.id}>
              <div className="flex justify-between">
                <Link to="/budgets" className="hover:underline">
                  {b.name}
                </Link>
                <span className="text-xs text-muted">
                  <Amount value={s.totals.actual} /> / <Amount value={s.totals.limit} />
                </span>
              </div>
              <ProgressBar
                label="actual, committed, remaining"
                parts={[
                  {
                    value: Number(s.totals.actual.amount) / lim,
                    className: toMinor(s.totals.remaining) < 0n ? 'bg-neg' : 'bg-accent',
                    title: 'actual',
                  },
                  {
                    value: Number(s.totals.planned.amount) / lim,
                    className: 'bg-warn',
                    title: 'committed',
                  },
                  {
                    value: Math.max(0, Number(s.totals.remaining.amount)) / lim,
                    className: 'bg-transparent',
                    title: 'remaining',
                  },
                ]}
              />
            </li>
          );
        })}
    </ul>
  );
}

function Categories({ snap }: { snap: Snapshot }) {
  const r = categoryDistribution(snap);
  if (!r.rows.length) return <Empty>No spending this month.</Empty>;
  const total = Number(r.total.amount) || 1;
  const top = r.rows.slice(0, 6);
  return (
    <>
      <ul className="space-y-1.5 text-sm">
        {top.map((c, i) => (
          <li key={c.key}>
            <div className="flex justify-between gap-2">
              <Link
                className="truncate hover:underline"
                to={transactionsLink({
                  from: r.from,
                  to: r.to,
                  categoryKey: c.key,
                  kind: 'expense',
                })}
              >
                {c.label}
              </Link>
              <Amount value={c.amount} />
            </div>
            <ProgressBar
              label={c.label}
              parts={[
                {
                  value: Number(c.amount.amount) / total,
                  className: '',
                  title: c.label,
                  color: SERIES[i] ?? SERIES_OTHER,
                },
                {
                  value: 1 - Number(c.amount.amount) / total,
                  className: 'bg-transparent',
                  title: 'rest',
                },
              ]}
            />
          </li>
        ))}
      </ul>
      <DataBanner missingRates={r.missingRates} />
    </>
  );
}

function Trend({ snap }: { snap: Snapshot }) {
  const f = useFormat();
  const t = spendingTrend(snap);
  const rows: ChartRow[] = t.periods.map((p) => ({
    x: p.period,
    label: f.month(p.period),
    money: { income: p.income, expense: p.expense },
  }));
  return (
    <MoneyChart
      title="Income and spending, last 6 months"
      rows={rows}
      height={200}
      series={[
        { key: 'income', label: 'Income', color: SERIES[0] as string },
        { key: 'expense', label: 'Spending', color: SERIES[1] as string },
      ]}
    />
  );
}

function TxList({
  items,
  snap,
}: {
  items: {
    id: string;
    date: string;
    label: string;
    amount: { amount: string; currency: string } | null;
  }[];
  snap: Snapshot;
}) {
  const f = useFormat();
  if (!items.length) return <Empty>Nothing yet.</Empty>;
  return (
    <ul className="space-y-1 text-sm">
      {items.map((t) => (
        <li key={t.id} className="flex justify-between gap-2">
          <span className="truncate">
            <span className="text-muted">{f.date(t.date)}</span> {t.label}
          </span>
          <Amount value={t.amount} tone />
        </li>
      ))}
      <li className="pt-1 text-xs">
        <Link className="text-accent hover:underline" to="/transactions">
          All transactions
        </Link>
        <span className="sr-only"> ({snap.transactions.length})</span>
      </li>
    </ul>
  );
}

function Recent({ snap }: { snap: Snapshot }) {
  const items = recentTransactions(snap).map((t) => {
    const p = t.postings[0];
    return {
      id: t.id,
      date: t.bookingDate,
      label: t.description || t.payee || t.kind,
      amount:
        t.kind === 'transfer' || t.kind === 'fx'
          ? p
            ? { ...p.amount, amount: p.amount.amount.replace(/^-/, '') }
            : null
          : p
            ? fromMinor(
                t.postings.reduce((a, x) => a + toMinor(x.amount), 0n),
                p.amount.currency,
              )
            : null,
    };
  });
  return <TxList items={items} snap={snap} />;
}

function Largest({ snap }: { snap: Snapshot }) {
  return (
    <TxList
      snap={snap}
      items={largestExpenses(snap).map((x) => ({
        id: x.t.id,
        date: x.t.bookingDate,
        label: x.t.description || x.t.payee || 'Expense',
        amount: fromMinor(-toMinor(x.native), x.native.currency),
      }))}
    />
  );
}

function Subscriptions({ snap }: { snap: Snapshot }) {
  const f = useFormat();
  const c = subscriptionCosts(snap);
  const live = c.rows.filter((r) => r.sub.status === 'active' || r.sub.status === 'trial');
  if (!live.length)
    return (
      <Empty>
        No subscriptions tracked.{' '}
        <Link className="underline" to="/subscriptions">
          Add one
        </Link>
        .
      </Empty>
    );
  return (
    <>
      <Stat
        label="Monthly equivalent"
        value={<Amount value={c.monthly} />}
        hint={
          <>
            Annual <Amount value={c.annual} />
          </>
        }
      />
      <ul className="mt-2 space-y-1 text-sm">
        {live.slice(0, 5).map((r) => (
          <li key={r.sub.id} className="flex justify-between gap-2">
            <span className="truncate">{r.sub.name}</span>
            <span className="text-xs text-muted">{r.next ? f.date(r.next.date) : '—'}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Goals({ snap }: { snap: Snapshot }) {
  const f = useFormat();
  const g = goalProgress(snap);
  if (!g.length)
    return (
      <Empty>
        No savings goals.{' '}
        <Link className="underline" to="/goals">
          Create one
        </Link>
        .
      </Empty>
    );
  return (
    <ul className="space-y-2 text-sm">
      {g.slice(0, 5).map(({ goal, projection: p }) => (
        <li key={goal.id}>
          <div className="flex justify-between">
            <span>{goal.name}</span>
            <span className="text-xs text-muted">{f.percent(p.progress, 0)}</span>
          </div>
          <ProgressBar
            label={`${goal.name} progress`}
            parts={[
              { value: Number(p.progress), className: 'bg-pos', title: 'saved' },
              {
                value: Math.max(0, 1 - Number(p.progress)),
                className: 'bg-transparent',
                title: 'remaining',
              },
            ]}
          />
        </li>
      ))}
    </ul>
  );
}

function Insights({ snap }: { snap: Snapshot }) {
  const list = insights(snap);
  if (!list.length) return <Empty>No notable changes this month.</Empty>;
  return (
    <ul className="space-y-2 text-sm">
      {list.slice(0, 4).map((i) => (
        <li key={i.id}>
          <p className={i.severity === 'info' ? 'font-medium' : 'font-medium text-warn'}>
            {i.title}
          </p>
          <p className="text-muted">{i.body}</p>
        </li>
      ))}
      <li className="text-xs">
        <Link className="text-accent hover:underline" to="/analytics#insights">
          All insights
        </Link>
      </li>
    </ul>
  );
}

function Coverage({ snap }: { snap: Snapshot }) {
  const f = useFormat();
  const rows = importCoverage(snap);
  if (!rows.length) return <Empty>No accounts.</Empty>;
  return (
    <div className="space-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.account.id} className="flex items-center gap-2">
          <span className="w-24 truncate">{r.account.name}</span>
          <div
            className="flex gap-0.5"
            role="img"
            aria-label={`${r.account.name}: ${r.months.filter((m) => m.imported).length} of 12 months imported`}
          >
            {r.months.map((m) => (
              <span
                key={m.month}
                title={`${f.month(m.month)}: ${m.imported ? 'imported' : 'no import'}`}
                className={`inline-block size-3 rounded-sm ${m.imported ? 'bg-pos' : 'bg-surface-2'}`}
              />
            ))}
          </div>
        </div>
      ))}
      <p className="text-muted">
        Last 12 months from {f.month(addMonths(snap.today, -11).slice(0, 7))}.{' '}
        <Link className="text-accent hover:underline" to="/import">
          Import Center
        </Link>
      </p>
    </div>
  );
}

function SyncHealth() {
  const { mode, engine, profile } = useData();
  const f = useFormat();
  const q = useQuery({
    queryKey: ['profile', profile?.id, 'insights', 'sync-status'],
    queryFn: async () => (await engine()?.status()) ?? null,
    enabled: mode === 'remote',
    refetchInterval: 30_000,
  });
  if (mode !== 'remote')
    return (
      <p className="text-sm text-muted">
        Local-only mode: data stays in this browser.{' '}
        <Link className="text-accent hover:underline" to="/sync">
          Sync settings
        </Link>
      </p>
    );
  const s = q.data;
  if (!s) return <p className="text-sm text-muted">Checking…</p>;
  const ok = !s.lastError && !s.rejected.length && !s.conflicts.length;
  return (
    <div className="text-sm">
      <p className={ok ? 'text-pos' : 'text-warn'}>{ok ? 'Healthy' : 'Needs attention'}</p>
      <p className="text-muted">
        Last sync {s.lastSyncAt ? f.dateTime(s.lastSyncAt) : 'never'} · {s.pending} pending ·{' '}
        {s.rejected.length} rejected · {s.conflicts.length} conflicts
      </p>
      {s.lastError && <p className="text-neg">{s.lastError.message}</p>}
      <Link className="text-xs text-accent hover:underline" to="/sync">
        Sync dashboard
      </Link>
    </div>
  );
}
