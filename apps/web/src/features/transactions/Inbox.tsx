// Uncategorized inbox (Feature 126, suggestions = Feature 77). Keyboard first:
// j/k or arrows move, Enter accepts the suggestion, 1–9 pick a listed category, typing in the
// search box narrows the list, s skips. Single-line transactions only; split ones open the drawer.
import type * as D from '@finplat/domain';
import {
  buildCategoryHistory,
  type LedgerTransaction,
  suggestCategory,
} from '@finplat/finance-engine';
import { Inbox as InboxIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.ts';
import { describeError, type Refs, useLedgerEnv, useTransactions, useWrite } from './data.ts';
import { isUncategorized, primaryAmount } from './model.ts';
import { Badge, Button, Empty, ErrorText, inputCls, MoneyText } from './ui.tsx';

export function Inbox({ refs, onOpen }: { refs: Refs; onOpen: (t: D.Transaction) => void }) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const all = useTransactions();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const assign = useWrite((ops, v: { t: D.Transaction; categoryId: string }) =>
    ops.updateTransaction(v.t.id, { version: v.t.version, categoryId: v.categoryId }),
  );

  const items = useMemo(
    () =>
      (all.data ?? [])
        .filter((t) => isUncategorized(t) && !skipped.has(t.id))
        .sort((a, b) => b.bookingDate.localeCompare(a.bookingDate) || b.id.localeCompare(a.id)),
    [all.data, skipped],
  );
  const history = useMemo(
    () => buildCategoryHistory((all.data ?? []) as unknown as LedgerTransaction[]),
    [all.data],
  );
  const cur = items[Math.min(cursor, items.length - 1)];

  const suggestion = useMemo(() => {
    if (!cur) return null;
    const s = suggestCategory(history, cur as unknown as LedgerTransaction);
    if (s && refs.category.has(s.value))
      return { categoryId: s.value, why: s.reason, confidence: s.confidence };
    const m = cur.merchantId ? refs.merchant.get(cur.merchantId) : undefined;
    if (m?.defaultCategoryId)
      return {
        categoryId: m.defaultCategoryId,
        why: `default category of ${m.name}`,
        confidence: '',
      };
    return null;
  }, [cur, history, refs]);

  const kind = cur?.kind === 'income' ? 'income' : 'expense';
  const options = refs.categoryOptions.filter(
    (c) =>
      (c.kind === kind || cur?.kind === 'refund') &&
      (!q || c.label.toLowerCase().includes(q.toLowerCase())),
  );

  const pick = async (categoryId: string) => {
    if (!cur) return;
    setErr(null);
    if (cur.splits.length > 1) return onOpen(cur);
    try {
      await assign.mutateAsync({ t: cur, categoryId });
      setQ('');
    } catch (e) {
      setErr(describeError(e));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement;
      if (typing && e.target !== search.current) return;
      if (e.target === search.current) {
        if (e.key === 'Enter' && options[0]) {
          e.preventDefault();
          pick(options[0].id);
        } else if (e.key === 'Escape') {
          setQ('');
          search.current?.blur();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.key === 'j' || e.key === 'ArrowDown')
        setCursor((c) => Math.min(c + 1, items.length - 1));
      else if (e.key === 'k' || e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
      else if (e.key === 'Enter' && suggestion) pick(suggestion.categoryId);
      else if (e.key === 's' && cur) setSkipped((s) => new Set(s).add(cur.id));
      else if (e.key === 'o' && cur) onOpen(cur);
      else if (e.key === '/') {
        e.preventDefault();
        search.current?.focus();
      } else if (/^[1-9]$/.test(e.key)) {
        const o = options[Number(e.key) - 1];
        if (o) pick(o.id);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (all.isLoading) return <p className="text-sm">{t('common.loading', 'Loading…')}</p>;
  if (!cur)
    return (
      <Empty title={t('transactions.inbox.inboxZero', 'Inbox zero')}>
        {t('transactions.inbox.everyTransactionHasA', 'Every transaction has a category.')}
        {skipped.size > 0 &&
          ` ${t('transactions.inbox.skipped', '{{n}} skipped this session.', { n: skipped.size })}`}
      </Empty>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <ul
        aria-label={t('transactions.inbox.uncategorizedTransactions', 'Uncategorized transactions')}
        className="max-h-[calc(100dvh-14rem)] overflow-auto rounded-lg border border-line"
      >
        {items.slice(0, 500).map((tx, i) => (
          <li key={tx.id}>
            <button
              type="button"
              aria-current={tx.id === cur.id}
              onClick={() => setCursor(i)}
              className={`flex w-full items-center justify-between gap-2 border-b border-line px-3 py-2 text-left text-sm ${tx.id === cur.id ? 'bg-accent/10' : ''}`}
            >
              <span className="min-w-0">
                <span className="block truncate">
                  {tx.description ||
                    tx.payee ||
                    refs.merchantName(tx.merchantId) ||
                    t('transactions.transactionTable.noDescription', 'No description')}
                </span>
                <span className="text-xs text-muted">
                  {tx.bookingDate} · {refs.accountName(tx.postings[0]?.accountId ?? '')}
                </span>
              </span>
              <MoneyText value={primaryAmount(tx)} locale={locale} signed />
            </button>
          </li>
        ))}
      </ul>
      <aside
        aria-label={t('transactions.inbox.categorize', 'Categorize')}
        className="flex flex-col gap-3 rounded-lg border border-line p-3"
      >
        <div className="flex items-center gap-2 text-sm text-muted">
          <InboxIcon size={16} aria-hidden />{' '}
          {t('transactions.inbox.lengthUncategorized', '{{length}} uncategorized', {
            length: items.length,
          })}
        </div>
        <div>
          <p className="font-medium">
            {cur.description ||
              cur.payee ||
              t('transactions.transactionTable.noDescription', 'No description')}
          </p>
          <p className="text-sm">
            <MoneyText value={primaryAmount(cur)} locale={locale} signed /> · {cur.bookingDate}
          </p>
          {cur.payee && cur.payee !== cur.description && (
            <p className="text-xs text-muted">{cur.payee}</p>
          )}
          {cur.splits.length > 1 && (
            <Badge tone="amber">
              {t('transactions.inbox.splitEditInDetails', 'split: edit in details')}
            </Badge>
          )}
        </div>
        {suggestion && (
          <Button variant="primary" onClick={() => pick(suggestion.categoryId)}>
            {t('transactions.inbox.acceptCategorylabel', 'Accept {{categoryLabel}}', {
              categoryLabel: refs.categoryLabel(suggestion.categoryId),
            })}{' '}
            <kbd className="ml-1 text-xs opacity-80">{t('transactions.inbox.enter', 'Enter')}</kbd>
          </Button>
        )}
        {suggestion && (
          <p className="-mt-2 text-xs text-muted">
            {t('transactions.inbox.suggestedFromWhy', 'Suggested from {{why}}', {
              why: suggestion.why,
            })}
          </p>
        )}
        <input
          ref={search}
          type="search"
          aria-label={t('transactions.inbox.findCategory', 'Find category')}
          placeholder={t('transactions.inbox.findCategory2', 'Find category ( / )')}
          className={inputCls}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ol className="flex max-h-72 flex-col gap-1 overflow-auto">
          {options.slice(0, 40).map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => pick(c.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-surface-2"
              >
                {i < 9 && <kbd className="w-4 text-xs text-muted">{i + 1}</kbd>}
                {c.label}
              </button>
            </li>
          ))}
        </ol>
        <ErrorText error={err} />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setSkipped((s) => new Set(s).add(cur.id))}>
            {t('transactions.inbox.skipS', 'Skip (s)')}
          </Button>
          <Button size="sm" onClick={() => onOpen(cur)}>
            {t('transactions.inbox.detailsO', 'Details (o)')}
          </Button>
        </div>
        <p className="text-xs text-muted">
          {t(
            'transactions.inbox.jKMoveEnter',
            'j/k move · Enter accept · 1–9 pick · / search · s skip · o open',
          )}
        </p>
      </aside>
    </div>
  );
}
