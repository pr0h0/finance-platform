// Local MCP server (desktop, PLAN §131): the Settings card that turns it on and shows how to add it
// to an MCP client, and the listener (mounted in Layout) that answers requests while the app is open
// and asks the user to approve each change an AI app proposes (when allowed on this device).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import { Button, Card, Checkbox, Dialog, ErrorBox } from '../components/ui/index.tsx';
import { todayIso, useFormat } from '../lib/format.ts';
import { type TFn, tNow, useT } from '../lib/i18n.ts';
import {
  bringToFront,
  localMcp,
  nativeNotify,
  serveLocalMcp,
  setLocalMcp,
} from '../platform/native.ts';
import { handleMessage } from './local-server.ts';
import type { Approve, ChangeRequest, Val, Verdict } from './local-write.ts';

const APPROVAL_MS = 5 * 60_000;

interface Pending {
  req: ChangeRequest;
  done: (v: Verdict) => void;
}

/** Answers MCP clients from the open profile (requests made while the app is locked get an error). */
export function LocalMcpListener() {
  const { ds, profile } = useData();
  const qc = useQueryClient();
  const ctx = useRef({ ds, profile });
  ctx.current = { ds, profile };
  // one dialog at a time; the rest wait in order (each with its own 5-minute limit)
  const [queue, setQueue] = useState<Pending[]>([]);
  const approve = useCallback<Approve>(
    (req) =>
      new Promise((resolve) => {
        const item: Pending = {
          req,
          done: (v) => {
            clearTimeout(timer);
            setQueue((q) => q.filter((x) => x !== item));
            resolve(v);
          },
        };
        const timer = setTimeout(() => item.done('timeout'), APPROVAL_MS);
        setQueue((q) => [...q, item]);
        void bringToFront()
          .then((focused) =>
            focused
              ? undefined
              : nativeNotify(
                  tNow('localMcp.approveTitle', 'An AI app wants to change your data'),
                  tNow('localMcp.approveBody', 'Open Finance Platform to approve or reject it.'),
                ),
          )
          .catch(() => {});
      }),
    [],
  );
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void serveLocalMcp(async (line) => {
      const { ds, profile } = ctx.current;
      if (!ds || !profile) throw new Error('no profile open');
      let changed = false;
      const ask: Approve | undefined = useApp.getState().localMcpWrite
        ? async (r) => {
            const v = await approve(r);
            changed ||= v === 'approved';
            return v;
          }
        : undefined;
      const out = await handleMessage(() => ({ ds, profile, today: todayIso() }), line, ask);
      if (changed) void qc.invalidateQueries({ queryKey: ['profile'] });
      return out;
    }).then((un) => {
      if (gone) un();
      else stop = un;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [approve, qc]);
  const cur = queue[0];
  return cur ? <ChangeDialog p={cur} waiting={queue.length - 1} /> : null;
}

/** Labels of the dialog rows and titles (literal keys so the catalog check sees them). */
const fieldLabels = (t: TFn): Record<string, string> => ({
  transaction: t('localMcp.field.transaction', 'Transaction'),
  transactions: t('localMcp.field.transactions', 'Transactions'),
  count: t('localMcp.field.count', 'Count'),
  amount: t('localMcp.field.amount', 'Amount'),
  category: t('localMcp.field.category', 'Category'),
  splits: t('localMcp.field.splits', 'Splits'),
  description: t('localMcp.field.description', 'Description'),
  notes: t('localMcp.field.notes', 'Notes'),
  tags: t('localMcp.field.tags', 'Tags'),
  merchant: t('localMcp.field.merchant', 'Merchant'),
  plan: t('localMcp.field.plan', 'Plan'),
  dueDate: t('localMcp.field.dueDate', 'Due date'),
  rrule: t('localMcp.field.rrule', 'Repeats'),
  account: t('localMcp.field.account', 'Account'),
  priority: t('localMcp.field.priority', 'Priority'),
  confidence: t('localMcp.field.confidence', 'Confidence'),
  status: t('localMcp.field.status', 'Status'),
  name: t('localMcp.field.name', 'Name'),
  budget: t('localMcp.field.budget', 'Budget'),
  periodType: t('localMcp.field.periodType', 'Period'),
  startDate: t('localMcp.field.startDate', 'Start'),
  allocations: t('localMcp.field.allocations', 'Allocations'),
  targetAmount: t('localMcp.field.targetAmount', 'Target amount'),
  targetDate: t('localMcp.field.targetDate', 'Target date'),
  match: t('localMcp.field.match', 'Condition'),
});
const toolTitles = (t: TFn): Record<string, string> => ({
  update_transaction_category: t(
    'localMcp.tool.update_transaction_category',
    'Change a transaction’s category',
  ),
  split_transaction: t('localMcp.tool.split_transaction', 'Split a transaction'),
  bulk_categorize_transactions: t(
    'localMcp.tool.bulk_categorize_transactions',
    'Categorize several transactions',
  ),
  update_transaction_metadata: t(
    'localMcp.tool.update_transaction_metadata',
    'Edit description, notes, tags or merchant',
  ),
  create_planned_expense: t('localMcp.tool.create_planned_expense', 'New planned expense'),
  update_planned_expense: t('localMcp.tool.update_planned_expense', 'Change a planned expense'),
  create_budget: t('localMcp.tool.create_budget', 'New budget'),
  update_budget: t('localMcp.tool.update_budget', 'Change a budget'),
  create_savings_goal: t('localMcp.tool.create_savings_goal', 'New savings goal'),
  create_categorization_rule: t(
    'localMcp.tool.create_categorization_rule',
    'New categorization rule',
  ),
});

function ChangeDialog({ p, waiting }: { p: Pending; waiting: number }) {
  const t = useT();
  const fmt = useFormat();
  const val = (v: Val | undefined) => {
    if (v === null || v === undefined || v === '') return t('localMcp.none', '(none)');
    if (typeof v === 'string') return v;
    if (Array.isArray(v))
      return v.length === 0
        ? t('localMcp.none', '(none)')
        : v
            .map(
              (x) =>
                `${x.label ?? t('localMcp.uncategorized', 'Uncategorized')}: ${fmt.money(x.amount)}`,
            )
            .join('\n');
    return fmt.money(v);
  };
  const labels = fieldLabels(t);
  const compare = p.req.rows.some((r) => 'before' in r);
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && p.done('rejected')}
      title={toolTitles(t)[p.req.tool] ?? p.req.tool}
      description={t(
        'localMcp.approveIntro',
        'An AI app on this computer wants to make this change in “{{profile}}”. Nothing changes unless you approve.',
        { profile: p.req.profile },
      )}
      footer={
        <>
          <Button onClick={() => p.done('rejected')}>{t('mcp.reject', 'Reject')}</Button>
          <Button variant="primary" onClick={() => p.done('approved')}>
            {t('mcp.approve', 'Approve and apply')}
          </Button>
        </>
      }
    >
      <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_td]:whitespace-pre-line [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted [&_tbody_tr]:border-t [&_tbody_tr]:border-line">
        {compare && (
          <thead>
            <tr>
              <th />
              <th>{t('localMcp.before', 'Now')}</th>
              <th>{t('localMcp.after', 'After')}</th>
            </tr>
          </thead>
        )}
        <tbody>
          {p.req.rows.map((r) => (
            <tr key={r.field}>
              <th scope="row">{labels[r.field] ?? r.field}</th>
              {compare && <td className="text-muted">{'before' in r ? val(r.before) : ''}</td>}
              <td>{val(r.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-accent">
          {t('mcp.preview', 'What would change')}
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-surface-2 p-2 text-xs">
          {JSON.stringify(p.req.preview, null, 2)}
        </pre>
      </details>
      {waiting > 0 && (
        <p className="mt-3 text-sm text-muted">
          {t('localMcp.waiting', '{{n}} more change(s) waiting', { n: waiting })}
        </p>
      )}
    </Dialog>
  );
}

export function LocalMcpCard() {
  const t = useT();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ['native', 'mcp'], queryFn: localMcp });
  const write = useApp((s) => s.localMcpWrite);
  const setApp = useApp((s) => s.set);
  const toggle = useMutation({
    mutationFn: setLocalMcp,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['native', 'mcp'] }),
  });
  const cmd = st.data?.command ?? '';
  const json = JSON.stringify(
    { mcpServers: { 'finance-local': { command: cmd, args: ['--mcp'] } } },
    null,
    2,
  );
  return (
    <Card title={t('localMcp.title', 'Local MCP server')}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'localMcp.intro',
          'Lets AI apps on this computer (Claude Desktop, Claude Code, …) read your finances from this app, without a server. Changes only if you allow them below, and each one waits for your approval. Works while the app is running and unlocked; what an agent reads goes to its AI provider.',
        )}
      </p>
      <Checkbox
        label={t('localMcp.enable', 'Allow AI apps on this computer to read my data')}
        checked={st.data?.on ?? false}
        disabled={!st.data || toggle.isPending}
        onChange={(e) => toggle.mutate(e.target.checked)}
      />
      {st.data?.on && (
        <Checkbox
          label={t(
            'localMcp.enableWrite',
            'Also let AI apps propose changes (you approve each one)',
          )}
          checked={write}
          onChange={(e) => setApp({ localMcpWrite: e.target.checked })}
        />
      )}
      <ErrorBox error={toggle.error} />
      {st.data?.on && (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <p>{t('localMcp.claudeCode', 'Claude Code:')}</p>
          <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 text-xs">
            {`claude mcp add finance-local -- "${cmd}" --mcp`}
          </pre>
          <p>
            {t(
              'localMcp.config',
              'Other clients (e.g. claude_desktop_config.json in Claude Desktop):',
            )}
          </p>
          <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 text-xs">{json}</pre>
        </div>
      )}
    </Card>
  );
}
