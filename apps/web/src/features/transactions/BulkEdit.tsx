// Bulk edit (Feature 83): category, merchant, tags, status, report exclusion for many rows at once.
// Amounts never change; a category set replaces the splits with one line of the full amount.
import type * as D from '@finplat/domain';
import { useState } from 'react';
import { useT } from '../../lib/i18n.ts';
import { describeError, type Refs, useLedgerEnv, useWrite } from './data.ts';
import { totalsByCurrency } from './model.ts';
import { Button, ErrorText, Field, inputCls, MoneyText } from './ui.tsx';

export function BulkEdit({
  rows,
  refs,
  onDone,
}: {
  rows: D.Transaction[];
  refs: Refs;
  onDone: () => void;
}) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const [category, setCategory] = useState('');
  const [merchant, setMerchant] = useState('');
  const [addTag, setAddTag] = useState('');
  const [removeTag, setRemoveTag] = useState('');
  const [status, setStatus] = useState('');
  const [exclude, setExclude] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bulk = useWrite((ops, body: Parameters<typeof ops.bulkEdit>[0]) => ops.bulkEdit(body));

  const submit = async () => {
    setErr(null);
    const set: Parameters<typeof bulk.mutateAsync>[0]['set'] = {};
    if (category === '__clear') set.clearCategory = true;
    else if (category) set.categoryId = category;
    if (merchant === '__clear') set.clearMerchant = true;
    else if (merchant) set.merchantId = merchant;
    if (addTag) set.addTagIds = [addTag];
    if (removeTag) set.removeTagIds = [removeTag];
    if (status) set.status = status as 'pending' | 'cleared' | 'void';
    if (exclude) set.excludeFromReports = exclude === 'yes';
    if (Object.keys(set).length === 0)
      return setErr(t('transactions.bulkEdit.chooseChange', 'Choose at least one change.'));
    try {
      const ids = rows.map((r) => r.id);
      let updated = 0;
      const failed: { id: string; message: string }[] = [];
      for (let i = 0; i < ids.length; i += 1000) {
        const r = await bulk.mutateAsync({ transactionIds: ids.slice(i, i + 1000), set });
        updated += r.updated;
        failed.push(...r.failed);
      }
      setResult(
        `${updated} updated${failed.length ? `, ${failed.length} skipped (${[...new Set(failed.map((f) => f.message))].slice(0, 3).join('; ')})` : ''}.`,
      );
      if (!failed.length) onDone();
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const sel = (
    label: string,
    v: string,
    on: (v: string) => void,
    opts: { id: string; label: string }[],
    extra?: { id: string; label: string },
  ) => (
    <Field label={label}>
      {(id) => (
        <select id={id} className={inputCls} value={v} onChange={(e) => on(e.target.value)}>
          <option value="">{t('transactions.bulkEdit.noChange', 'No change')}</option>
          {extra && <option value={extra.id}>{extra.label}</option>}
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {t(
          'transactions.bulkEdit.lengthTransactionsSelectedTotals',
          '{{length}} transactions selected, totals',
          { length: rows.length },
        )}{' '}
        {totalsByCurrency(rows).map((m) => (
          <MoneyText key={m.currency} value={m} locale={locale} className="mr-2" />
        ))}
        {t('transactions.bulkEdit.stayUnchanged', 'stay unchanged.')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {sel(t('transaction.category', 'Category'), category, setCategory, refs.categoryOptions, {
          id: '__clear',
          label: t('transactions.bulkEdit.clearCategory', 'Clear (uncategorized)'),
        })}
        {sel(
          t('transaction.merchant', 'Merchant'),
          merchant,
          setMerchant,
          refs.merchants.map((m) => ({ id: m.id, label: m.name })),
          { id: '__clear', label: t('transactions.bulkEdit.clearMerchant', 'Clear merchant') },
        )}
        {sel(
          t('rules.ruleEditor.addTag', 'Add tag'),
          addTag,
          setAddTag,
          refs.tags.map((x) => ({ id: x.id, label: x.name })),
        )}
        {sel(
          t('transactions.bulkEdit.removeTag', 'Remove tag'),
          removeTag,
          setRemoveTag,
          refs.tags.map((x) => ({ id: x.id, label: x.name })),
        )}
        {sel(t('common.status', 'Status'), status, setStatus, [
          { id: 'cleared', label: t('transaction.status.cleared', 'Cleared') },
          { id: 'pending', label: t('transaction.status.pending', 'Pending') },
          { id: 'void', label: t('transactions.bulkEdit.voidArchive', 'Void (archive)') },
        ])}
        {sel(t('transactions.bulkEdit.reports', 'Reports'), exclude, setExclude, [
          { id: 'yes', label: t('rules.ruleEditor.excludeFromReports', 'Exclude from reports') },
          { id: 'no', label: t('transactions.bulkEdit.includeInReports', 'Include in reports') },
        ])}
      </div>
      <p className="text-xs text-muted">
        {t(
          'transactions.bulkEdit.transfersOpeningBalancesAnd',
          'Transfers, opening balances and adjustments have no category and are skipped for category changes.',
        )}
      </p>
      {result && (
        <p role="status" className="text-sm">
          {result}
        </p>
      )}
      <ErrorText error={err} />
      <div className="flex justify-end">
        <Button variant="primary" onClick={submit} disabled={bulk.isPending}>
          {t('transactions.bulkEdit.applyToLength', 'Apply to {{length}}', { length: rows.length })}
        </Button>
      </div>
    </div>
  );
}
