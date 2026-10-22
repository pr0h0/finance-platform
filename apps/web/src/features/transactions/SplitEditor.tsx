// Category split editor (Features 8, 124, 125): any number of lines, reorder, live remainder; the
// save button stays disabled until the lines add up exactly to the transaction amount.
import type * as D from '@finplat/domain';
import { fromMinor, toMinor } from '@finplat/finance-engine';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from '../../components/ui/toast.tsx';
import { useT } from '../../lib/i18n.ts';
import { describeError, type Refs, useEntities, useLedgerEnv, useWrite } from './data.ts';
import { absMoney, type SplitDraft, splitRemainder } from './model.ts';
import { Button, ErrorText, inputCls, MoneyText } from './ui.tsx';

let seq = 0;
const key = () => `l${++seq}`;

export function SplitEditor({ tx, refs }: { tx: D.Transaction; refs: Refs }) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const total = absMoney(tx.postings[0]?.amount ?? { amount: '0', currency: 'XXX' });
  const init = (): SplitDraft[] =>
    tx.splits.length
      ? [...tx.splits]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => ({
            key: key(),
            categoryId: s.categoryId,
            amount: s.amount.amount,
            description: s.description,
          }))
      : [{ key: key(), categoryId: null, amount: total.amount, description: '' }];
  const [lines, setLines] = useState<SplitDraft[]>(init);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const templates = useEntities('split_templates');
  const save = useWrite((ops, body: Parameters<typeof ops.replaceSplits>[1]) =>
    ops.replaceSplits(tx.id, body),
  );
  const saveTpl = useWrite((ops, body: Parameters<typeof ops.create<'split_templates'>>[1]) =>
    ops.create('split_templates', body),
  );

  const remainder = splitRemainder(total, lines);
  const balanced = remainder !== null && toMinor(remainder) === 0n;
  const kind = tx.kind === 'income' ? 'income' : 'expense';
  const opts = refs.categoryOptions.filter((c) => c.kind === kind || tx.kind === 'refund');
  const merchantTemplates = (templates.data ?? []).filter(
    (t) => !t.merchantId || t.merchantId === tx.merchantId,
  );

  const set = (i: number, p: Partial<SplitDraft>) => {
    setSaved(false);
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  };
  const move = (i: number, d: number) =>
    setLines((ls) => {
      const n = [...ls];
      const [x] = n.splice(i, 1);
      if (x) n.splice(i + d, 0, x);
      return n;
    });

  const submit = async () => {
    setErr(null);
    try {
      await save.mutateAsync({
        version: tx.version,
        splits: lines.map((l) => ({
          categoryId: l.categoryId,
          amount: { amount: l.amount.trim(), currency: total.currency },
          description: l.description,
        })),
      });
      setSaved(true);
      toast(t('transactions.splitEditor.saved', 'Splits saved')); // the editor re-mounts with the new version, so also announce it
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const applyTemplate = async (id: string) => {
    setErr(null);
    try {
      await save.mutateAsync({ version: tx.version, splitTemplateId: id });
      setSaved(true);
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const asTemplate = async () => {
    setErr(null);
    const name = window.prompt(
      t('transactions.splitEditor.templateName', 'Split template name'),
      refs.merchantName(tx.merchantId) || tx.description || 'Split',
    );
    if (!name) return;
    // Weights keep the proportions, so the template fits any future amount.
    try {
      await saveTpl.mutateAsync({
        name,
        merchantId: tx.merchantId,
        lines: lines.map((l) => ({
          categoryId: l.categoryId,
          weight: l.amount.trim(),
          description: l.description,
        })),
      });
    } catch (e) {
      setErr(describeError(e));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {lines.map((l, i) => (
          <li key={l.key} className="flex flex-wrap items-center gap-1">
            <select
              aria-label={t('transactions.splitEditor.categoryOfLine', 'Category of line {{v0}}', {
                v0: i + 1,
              })}
              className={`${inputCls} min-w-40 flex-[2]`}
              value={l.categoryId ?? ''}
              onChange={(e) => set(i, { categoryId: e.target.value || null })}
            >
              <option value="">{t('transaction.uncategorized', 'Uncategorized')}</option>
              {opts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              aria-label={t('transactions.splitEditor.amountOfLine', 'Amount of line {{v0}}', {
                v0: i + 1,
              })}
              inputMode="decimal"
              className={`${inputCls} w-28 text-right tabular-nums`}
              value={l.amount}
              onChange={(e) => set(i, { amount: e.target.value.replace(',', '.') })}
            />
            <input
              aria-label={t('transactions.splitEditor.noteOfLine', 'Note of line {{v0}}', {
                v0: i + 1,
              })}
              placeholder={t('transactions.splitEditor.note', 'Note')}
              className={`${inputCls} min-w-24 flex-1`}
              value={l.description}
              onChange={(e) => set(i, { description: e.target.value })}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('transactions.splitEditor.moveUp', 'Move up')}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <ArrowUp size={14} aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('transactions.splitEditor.moveDown', 'Move down')}
              disabled={i === lines.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown size={14} aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('transactions.splitEditor.removeLine', 'Remove line')}
              disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} aria-hidden />
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Button
          size="sm"
          onClick={() =>
            setLines((ls) => [
              ...ls,
              {
                key: key(),
                categoryId: null,
                amount: remainder && toMinor(remainder) > 0n ? remainder.amount : '',
                description: '',
              },
            ])
          }
        >
          <Plus size={14} aria-hidden /> {t('transactions.splitEditor.addLine', 'Add line')}
        </Button>
        <p aria-live="polite" className={balanced ? 'text-pos' : 'text-warn'}>
          {remainder === null ? (
            t(
              'transactions.splitEditor.eachLineNeedsA',
              'Each line needs a positive amount with at most the currency decimals',
            )
          ) : balanced ? (
            t('transactions.splitEditor.linesMatchTheTotal', 'Lines match the total')
          ) : (
            <>
              {t('goals.page.remaining', 'Remaining')}{' '}
              <MoneyText value={remainder} locale={locale} /> {t('goals.page.of', 'of')}{' '}
              <MoneyText value={total} locale={locale} />
            </>
          )}
        </p>
      </div>
      <ErrorText error={err} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={!balanced || save.isPending} onClick={submit}>
          <Save size={14} aria-hidden /> {t('transactions.splitEditor.saveSplits', 'Save splits')}
        </Button>
        {lines.length > 1 && (
          <Button
            size="sm"
            onClick={() =>
              setLines([
                {
                  key: key(),
                  categoryId: lines[0]?.categoryId ?? null,
                  amount: total.amount,
                  description: '',
                },
              ])
            }
          >
            {t('transactions.splitEditor.mergeIntoOne', 'Merge into one')}
          </Button>
        )}
        <Button size="sm" disabled={!balanced || saveTpl.isPending} onClick={asTemplate}>
          {t('transactions.splitEditor.saveAs', 'Save as')}{' '}
          {tx.merchantId ? t('transactions.splitEditor.merchant', 'merchant') : ''}
          {t('transactions.splitEditor.splitTemplate', 'split template')}
        </Button>
        {merchantTemplates.length > 0 && (
          <select
            aria-label={t('transactions.splitEditor.applySplitTemplate', 'Apply split template')}
            className={`${inputCls} h-7 w-auto text-xs`}
            value=""
            onChange={(e) => e.target.value && applyTemplate(e.target.value)}
          >
            <option value="">
              {t('transactions.splitEditor.applyTemplate', 'Apply template…')}
            </option>
            {merchantTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {saved && <span className="text-xs text-pos">{t('settings.saved', 'Saved')}</span>}
      </div>
      {remainder && toMinor(remainder) < 0n && (
        <p className="text-xs text-neg">
          {t('transactions.splitEditor.linesExceedTheTotal', 'Lines exceed the total by')}{' '}
          <MoneyText value={fromMinor(-toMinor(remainder), total.currency)} locale={locale} />.
        </p>
      )}
    </div>
  );
}
