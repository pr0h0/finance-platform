// Accounts page (Features 3, 16, 17, 21, 49, 52, 116, 129): accounts grouped by assets and
// liabilities, balances per currency, group totals in the profile's reporting currency.
import type * as D from '@finplat/domain';
import { LIABILITY_ACCOUNT_TYPES } from '@finplat/domain';
import { createRateBook, fromMinor, reportingConverter, toMinor } from '@finplat/finance-engine';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AccountDetail } from '../../features/accounts/AccountDetail.tsx';
import { AccountForm, TYPE_LABEL } from '../../features/accounts/AccountForm.tsx';
import { qk, useEntities, useLedgerEnv } from '../../features/transactions/data.ts';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorText,
  MoneyText,
  PageHeader,
  today,
} from '../../features/transactions/ui.tsx';
import { useT } from '../../lib/i18n.ts';

export default function AccountsPage() {
  const t = useT();
  const { ops, profile, profileId, locale } = useLedgerEnv();
  const accounts = useEntities('accounts');
  const rates = useQuery({ queryKey: qk(profileId, 'rates'), queryFn: () => ops.rateSnapshots() });
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<D.Account | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const base = profile.baseCurrency;

  const groups = useMemo(() => {
    const conv = reportingConverter(createRateBook(rates.data ?? []), base);
    const list = (accounts.data ?? [])
      .filter((a) => showArchived || !a.isArchived)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return (['asset', 'liability'] as const).map((cls) => {
      const items = list.filter(
        (a) => (LIABILITY_ACCOUNT_TYPES.includes(a.accountType) ? 'liability' : 'asset') === cls,
      );
      let total = 0n;
      const missing = new Set<string>();
      for (const a of items) {
        if (a.isArchived || !a.includeInNetWorth) continue;
        for (const b of a.balances) {
          const c = conv(b, today());
          if (c) total += toMinor(c);
          else missing.add(b.currency);
        }
      }
      return { cls, items, total: fromMinor(total, base), missing: [...missing] };
    });
  }, [accounts.data, rates.data, base, showArchived]);

  const open = accounts.data?.find((a) => a.id === openId);
  const archivedCount = (accounts.data ?? []).filter((a) => a.isArchived).length;

  return (
    <div>
      <PageHeader
        title={t('nav.accounts', 'Accounts')}
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus size={14} aria-hidden /> {t('accounts.page.newAccount', 'New account')}
          </Button>
        }
      >
        {t(
          'accounts.page.totalsInBaseBalances',
          'Totals in {{base}}; balances are computed from transactions.',
          { base: base },
        )}
      </PageHeader>
      {accounts.error && <ErrorText error={String(accounts.error)} />}
      {accounts.data?.length === 0 && (
        <Empty title={t('accounts.page.noAccountsYet', 'No accounts yet')}>
          {t(
            'accounts.page.addYourBankAccounts',
            'Add your bank accounts, cash, cards and loans to start tracking.',
          )}
        </Empty>
      )}
      {groups.map(
        (g) =>
          g.items.length > 0 && (
            <section key={g.cls} aria-labelledby={`grp-${g.cls}`} className="mb-6">
              <div className="mb-2 flex items-baseline justify-between">
                <h2
                  id={`grp-${g.cls}`}
                  className="text-sm font-semibold tracking-wide text-muted uppercase"
                >
                  {g.cls === 'asset'
                    ? t('reports.page.assets', 'Assets')
                    : t('reports.page.liabilities', 'Liabilities')}
                </h2>
                <span className="text-sm">
                  <MoneyText value={g.total} locale={locale} className="font-semibold" />
                  {g.missing.length > 0 && (
                    <span className="ml-2 text-xs text-warn">
                      {t('accounts.page.excludesJoinNoRate', 'excludes {{join}} (no rate)', {
                        join: g.missing.join(', '),
                      })}
                    </span>
                  )}
                </span>
              </div>
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                {g.items.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(a.id)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2"
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 font-medium">
                          {a.color && (
                            <span
                              aria-hidden
                              className="inline-block size-2.5 rounded-full"
                              style={{ background: a.color }}
                            />
                          )}
                          <span className="truncate">{a.name}</span>
                          {a.isArchived && <Badge>{t('accounts.page.archived', 'archived')}</Badge>}
                          {a.isMultiCurrency && (
                            <Badge tone="blue">
                              {t('accounts.page.multiCurrency', 'multi-currency')}
                            </Badge>
                          )}
                          {!a.includeInNetWorth && (
                            <Badge>{t('accounts.page.notInNetWorth', 'not in net worth')}</Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted">
                          {TYPE_LABEL[a.accountType]} · {a.currency}
                          {a.institution && ` · ${a.institution}`}
                        </span>
                      </span>
                      <span className="text-right">
                        {a.balances.length === 0 ? (
                          <MoneyText value={fromMinor(0n, a.currency)} locale={locale} />
                        ) : (
                          a.balances.map((b) => (
                            <span key={b.currency} className="block">
                              <MoneyText value={b} locale={locale} />
                            </span>
                          ))
                        )}
                        {a.creditLimit && (
                          <span className="block text-xs text-muted">
                            {t('accounts.page.limit', 'limit')}{' '}
                            <MoneyText value={a.creditLimit} locale={locale} />
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
      {archivedCount > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />{' '}
          {t('accounts.page.showArchivedcountArchived', 'Show {{archivedCount}} archived', {
            archivedCount: archivedCount,
          })}
        </label>
      )}

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={
          editing === 'new'
            ? t('accounts.page.newAccount', 'New account')
            : t('accounts.page.editAccount', 'Edit account')
        }
      >
        {editing && (
          <AccountForm
            account={editing === 'new' ? undefined : editing}
            onDone={(a) => {
              setEditing(null);
              setOpenId(a.id);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={!!open && !editing}
        onClose={() => setOpenId(null)}
        title={open?.name ?? t('quick.account', 'Account')}
        side
      >
        {open && (
          <AccountDetail
            account={open}
            onEdit={() => setEditing(open)}
            onClose={() => setOpenId(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
