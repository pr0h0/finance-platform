// Categorization rule editor (Feature 76): declarative conditions (AND) and actions, a live test
// against existing transactions, and retroactive application.
import type * as D from '@finplat/domain';
import { evaluateRules } from '@finplat/finance-engine';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type TFn, useT } from '../../lib/i18n.ts';
import {
  describeError,
  type Refs,
  useEntities,
  useLedgerEnv,
  useTransactions,
  useWrite,
} from '../transactions/data.ts';
import { isUncategorized, primaryAmount, SPLIT_KINDS } from '../transactions/model.ts';
import { Button, ErrorText, Field, inputCls, MoneyText } from '../transactions/ui.tsx';

type Cond = D.RuleCondition;
type Act = D.RuleAction;

const FIELDS = [
  'description',
  'payee',
  'counterparty',
  'amount',
  'direction',
  'accountId',
  'merchantId',
] as const;
const fieldLabel = (t: TFn): Record<(typeof FIELDS)[number], string> => ({
  description: t('transaction.description', 'Description'),
  payee: t('transactions.detailDrawer.payee', 'Payee'),
  counterparty: t('common.counterparty', 'Counterparty'),
  amount: t('rules.ruleEditor.amountAbsolute', 'Amount (absolute)'),
  direction: t('rules.ruleEditor.direction', 'Direction'),
  accountId: t('transactions.transactionTable.account', 'Account'),
  merchantId: t('transaction.merchant', 'Merchant'),
});
const TEXT_OPS = ['contains', 'equals', 'starts_with', 'regex'] as const;
const AMOUNT_OPS = ['eq', 'lt', 'lte', 'gt', 'gte'] as const;
const ACTIONS = [
  'set_category',
  'set_merchant',
  'add_tag',
  'set_description',
  'apply_split_template',
  'exclude_from_reports',
] as const;
const actionLabel = (t: TFn): Record<(typeof ACTIONS)[number], string> => ({
  set_category: t('rules.ruleEditor.setCategory', 'Set category'),
  set_merchant: t('rules.ruleEditor.setMerchant', 'Set merchant'),
  add_tag: t('rules.ruleEditor.addTag', 'Add tag'),
  set_description: t('rules.ruleEditor.setDescription', 'Set description'),
  apply_split_template: t('rules.ruleEditor.applySplitTemplate', 'Apply split template'),
  exclude_from_reports: t('rules.ruleEditor.excludeFromReports', 'Exclude from reports'),
});
const opLabel = (t: TFn, op: string): string =>
  ({
    contains: t('rules.op.contains', 'contains'),
    equals: t('rules.op.equals', 'equals'),
    starts_with: t('rules.op.startsWith', 'starts with'),
    regex: t('rules.op.regex', 'regex'),
  })[op] ?? op;

const newCond = (field: (typeof FIELDS)[number]): Cond => {
  if (field === 'amount') return { field, op: 'gte', value: '' };
  if (field === 'direction') return { field, op: 'equals', value: 'debit' };
  if (field === 'accountId' || field === 'merchantId') return { field, op: 'equals', value: '' };
  return { field, op: 'contains', value: '' };
};
const newAct = (type: (typeof ACTIONS)[number]): Act => {
  switch (type) {
    case 'set_category':
      return { type, categoryId: '' };
    case 'set_merchant':
      return { type, merchantId: '' };
    case 'add_tag':
      return { type, tagId: '' };
    case 'set_description':
      return { type, value: '' };
    case 'apply_split_template':
      return { type, splitTemplateId: '' };
    default:
      return { type: 'exclude_from_reports' };
  }
};

export function RuleEditor({
  rule,
  refs,
  onDone,
}: {
  rule?: D.CategorizationRule;
  refs: Refs;
  onDone: (msg?: string) => void;
}) {
  const t = useT();
  const { locale } = useLedgerEnv();
  const txs = useTransactions();
  const splitTemplates = useEntities('split_templates');
  const [name, setName] = useState(rule?.name ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [stop, setStop] = useState(rule?.stopProcessing ?? false);
  const [conds, setConds] = useState<Cond[]>(rule?.conditions ?? [newCond('description')]);
  const [acts, setActs] = useState<Act[]>(rule?.actions ?? [newAct('set_category')]);
  const [onlyUncat, setOnlyUncat] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const save = useWrite(async (ops, body: Record<string, unknown>) =>
    rule
      ? ops.update('categorization_rules', rule.id, { ...body, version: rule.version })
      : ops.create('categorization_rules', body as never),
  );
  const apply = useWrite((ops, ids: string[]) => ops.applyRules(ids));

  const matches = useMemo(() => {
    const draft = {
      id: rule?.id ?? 'draft',
      priority: 0,
      enabled: true,
      stopProcessing: false,
      conditions: conds,
      actions: acts,
    };
    const out: D.Transaction[] = [];
    for (const t of txs.data ?? []) {
      const p0 = t.postings[0];
      if (!p0 || !SPLIT_KINDS.has(t.kind) || t.status === 'void') continue;
      const o = evaluateRules([draft as never], {
        description: t.description,
        payee: t.payee,
        amount: p0.amount,
        accountId: p0.accountId,
        merchantId: t.merchantId,
      });
      if (o.matchedRuleIds.length) out.push(t);
    }
    return out;
  }, [txs.data, conds, acts, rule?.id]);
  const target = onlyUncat ? matches.filter(isUncategorized) : matches;

  const body = () => ({
    name,
    priority: Number(priority) || 0,
    enabled,
    stopProcessing: stop,
    conditions: conds,
    actions: acts,
  });
  const submit = async (andApply: boolean) => {
    setErr(null);
    setMsg(null);
    try {
      await save.mutateAsync(body());
      if (andApply && target.length) {
        const ids = target.map((t) => t.id);
        let n = 0;
        for (let i = 0; i < ids.length; i += 500)
          n += (await apply.mutateAsync(ids.slice(i, i + 500))).matched;
        return onDone(
          t(
            'rules.ruleEditor.savedApplied',
            'Rule saved and applied: {{n}} transactions changed.',
            { n },
          ),
        );
      }
      onDone();
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const setC = (i: number, c: Cond) => setConds((cs) => cs.map((x, j) => (j === i ? c : x)));
  const setA = (i: number, a: Act) => setActs((as) => as.map((x, j) => (j === i ? a : x)));
  const sel = (
    label: string,
    value: string,
    on: (v: string) => void,
    opts: { id: string; label: string }[],
  ) => (
    <select
      aria-label={label}
      className={`${inputCls} min-w-40 flex-1`}
      value={value}
      onChange={(e) => on(e.target.value)}
    >
      <option value="">{t('quick.choose', 'Choose…')}</option>
      {opts.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
        <Field label={t('rules.ruleEditor.ruleName', 'Rule name')}>
          {(id) => (
            <input
              id={id}
              required
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('goals.page.priority', 'Priority')}
          hint={t('rules.ruleEditor.lowerRunsFirst', 'Lower runs first')}
        >
          {(id, d) => (
            <input
              id={id}
              aria-describedby={d}
              type="number"
              className={inputCls}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{' '}
          {t('mcp.enabled', 'Enabled')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} />{' '}
          {t('rules.ruleEditor.stopProcessingLaterRules', 'Stop processing later rules')}
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">
          {t('rules.ruleEditor.whenAllOfThese', 'When all of these match')}
        </legend>
        {conds.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
          <div key={i} className="flex flex-wrap items-center gap-1">
            <select
              aria-label={t('sync.field', 'Field')}
              className={`${inputCls} w-40`}
              value={c.field}
              onChange={(e) => setC(i, newCond(e.target.value as (typeof FIELDS)[number]))}
            >
              {FIELDS.map((f) => (
                <option key={f} value={f}>
                  {fieldLabel(t)[f]}
                </option>
              ))}
            </select>
            {(c.field === 'description' || c.field === 'payee' || c.field === 'counterparty') && (
              <>
                <select
                  aria-label={t('rules.ruleEditor.operator', 'Operator')}
                  className={`${inputCls} w-32`}
                  value={c.op}
                  onChange={(e) =>
                    setC(i, { ...c, op: e.target.value as (typeof TEXT_OPS)[number] })
                  }
                >
                  {TEXT_OPS.map((o) => (
                    <option key={o} value={o}>
                      {opLabel(t, o)}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={t('rules.ruleEditor.value', 'Value')}
                  className={`${inputCls} min-w-40 flex-1`}
                  maxLength={256}
                  value={c.value}
                  onChange={(e) => setC(i, { ...c, value: e.target.value })}
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={!!c.caseSensitive}
                    onChange={(e) => setC(i, { ...c, caseSensitive: e.target.checked })}
                  />{' '}
                  Aa
                </label>
              </>
            )}
            {c.field === 'amount' && (
              <>
                <select
                  aria-label={t('rules.ruleEditor.operator', 'Operator')}
                  className={`${inputCls} w-24`}
                  value={c.op}
                  onChange={(e) =>
                    setC(i, { ...c, op: e.target.value as (typeof AMOUNT_OPS)[number] })
                  }
                >
                  {AMOUNT_OPS.map((o) => (
                    <option key={o} value={o}>
                      {{ eq: '=', lt: '<', lte: '≤', gt: '>', gte: '≥' }[o]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={t('transaction.amount', 'Amount')}
                  inputMode="decimal"
                  className={`${inputCls} w-32`}
                  value={c.value}
                  onChange={(e) => setC(i, { ...c, value: e.target.value.replace(',', '.') })}
                />
              </>
            )}
            {c.field === 'direction' && (
              <select
                aria-label={t('rules.ruleEditor.direction', 'Direction')}
                className={`${inputCls} w-40`}
                value={c.value}
                onChange={(e) => setC(i, { ...c, value: e.target.value as 'debit' | 'credit' })}
              >
                <option value="debit">
                  {t('rules.ruleEditor.moneyOutDebit', 'Money out (debit)')}
                </option>
                <option value="credit">
                  {t('rules.ruleEditor.moneyInCredit', 'Money in (credit)')}
                </option>
              </select>
            )}
            {c.field === 'accountId' &&
              sel(
                t('transactions.transactionTable.account', 'Account'),
                c.value,
                (v) => setC(i, { ...c, value: v }),
                refs.accounts.map((a) => ({ id: a.id, label: a.name })),
              )}
            {c.field === 'merchantId' &&
              sel(
                t('transaction.merchant', 'Merchant'),
                c.value,
                (v) => setC(i, { ...c, value: v }),
                refs.merchants.map((m) => ({ id: m.id, label: m.name })),
              )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('rules.ruleEditor.removeCondition', 'Remove condition')}
              disabled={conds.length === 1}
              onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} aria-hidden />
            </Button>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            onClick={() => setConds((cs) => [...cs, newCond('description')])}
            disabled={conds.length >= 20}
          >
            <Plus size={12} aria-hidden /> {t('rules.ruleEditor.condition', 'Condition')}
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">{t('rules.ruleEditor.then', 'Then')}</legend>
        {acts.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
          <div key={i} className="flex flex-wrap items-center gap-1">
            <select
              aria-label={t('mcp.action', 'Action')}
              className={`${inputCls} w-48`}
              value={a.type}
              onChange={(e) => setA(i, newAct(e.target.value as (typeof ACTIONS)[number]))}
            >
              {ACTIONS.map((x) => (
                <option key={x} value={x}>
                  {actionLabel(t)[x]}
                </option>
              ))}
            </select>
            {a.type === 'set_category' &&
              sel(
                t('transaction.category', 'Category'),
                a.categoryId,
                (v) => setA(i, { ...a, categoryId: v }),
                refs.categoryOptions,
              )}
            {a.type === 'set_merchant' &&
              sel(
                t('transaction.merchant', 'Merchant'),
                a.merchantId,
                (v) => setA(i, { ...a, merchantId: v }),
                refs.merchants.map((m) => ({ id: m.id, label: m.name })),
              )}
            {a.type === 'add_tag' &&
              sel(
                t('common.tag', 'Tag'),
                a.tagId,
                (v) => setA(i, { ...a, tagId: v }),
                refs.tags.map((t) => ({ id: t.id, label: t.name })),
              )}
            {a.type === 'apply_split_template' &&
              sel(
                t('rules.ruleEditor.splitTemplate', 'Split template'),
                a.splitTemplateId,
                (v) => setA(i, { ...a, splitTemplateId: v }),
                (splitTemplates.data ?? []).map((t) => ({ id: t.id, label: t.name })),
              )}
            {a.type === 'set_description' && (
              <input
                aria-label={t('rules.ruleEditor.newDescription', 'New description')}
                className={`${inputCls} min-w-40 flex-1`}
                value={a.value}
                onChange={(e) => setA(i, { ...a, value: e.target.value })}
              />
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('rules.ruleEditor.removeAction', 'Remove action')}
              disabled={acts.length === 1}
              onClick={() => setActs((as) => as.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} aria-hidden />
            </Button>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            onClick={() => setActs((as) => [...as, newAct('add_tag')])}
            disabled={acts.length >= 20}
          >
            <Plus size={12} aria-hidden /> {t('mcp.action', 'Action')}
          </Button>
        </div>
      </fieldset>

      <section
        aria-label={t('rules.ruleEditor.test', 'Test')}
        className="rounded-md border border-line p-3"
      >
        <h3 className="mb-1 text-sm font-semibold">
          {t(
            'rules.ruleEditor.testAgainstExistingTransactions',
            'Test against existing transactions',
          )}
        </h3>
        <p className="text-sm" role="status">
          {txs.isLoading
            ? t('rules.ruleEditor.loadingTransactions', 'Loading transactions…')
            : t('rules.ruleEditor.matches', 'Matches {{n}} transactions ({{u}} uncategorized).', {
                n: matches.length,
                u: matches.filter(isUncategorized).length,
              })}
        </p>
        <ul className="mt-2 max-h-48 overflow-auto text-sm">
          {matches.slice(0, 50).map((t) => (
            <li key={t.id} className="flex justify-between gap-2 border-b border-line py-1">
              <span className="truncate">
                {t.bookingDate} · {t.description || t.payee}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {refs.categoryLabel(t.splits[0]?.categoryId ?? null)}
              </span>
              <MoneyText value={primaryAmount(t)} locale={locale} signed />
            </li>
          ))}
        </ul>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyUncat}
            onChange={(e) => setOnlyUncat(e.target.checked)}
          />{' '}
          {t(
            'rules.ruleEditor.whenApplyingChangeOnly',
            'When applying, change only uncategorized transactions (otherwise existing categories are overwritten)',
          )}
        </label>
      </section>
      {msg && (
        <p role="status" className="text-sm">
          {msg}
        </p>
      )}
      <ErrorText error={err} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => submit(false)} disabled={save.isPending}>
          {t('rules.ruleEditor.saveRule', 'Save rule')}
        </Button>
        <Button
          variant="primary"
          onClick={() => submit(true)}
          disabled={save.isPending || apply.isPending || target.length === 0}
        >
          {t('rules.ruleEditor.saveAndApplyTo', 'Save and apply to {{length}}', {
            length: target.length,
          })}
        </Button>
      </div>
      <p className="text-xs text-muted">
        {t(
          'rules.ruleEditor.applyingRunsAllEnabled',
          'Applying runs all enabled rules (by priority) on the chosen transactions, so the result matches what new transactions get.',
        )}
      </p>
    </div>
  );
}
