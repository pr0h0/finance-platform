// Automation rules page (Features 76, 77): list, enable/disable, edit, delete, run on everything.
import type * as D from '@finplat/domain';
import { Play, Plus } from 'lucide-react';
import { useState } from 'react';
import { RuleEditor } from '../../features/rules/RuleEditor.tsx';
import { describeError, useEntities, useRefs, useWrite } from '../../features/transactions/data.ts';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorText,
  PageHeader,
} from '../../features/transactions/ui.tsx';

function summary(r: D.CategorizationRule, refs: ReturnType<typeof useRefs>) {
  const c = r.conditions
    .map((x) => {
      if (x.field === 'accountId') return `account is ${refs.accountName(x.value)}`;
      if (x.field === 'merchantId') return `merchant is ${refs.merchantName(x.value)}`;
      return `${x.field} ${x.op.replace('_', ' ')} “${x.value}”`;
    })
    .join(' and ');
  const a = r.actions
    .map((x) => {
      switch (x.type) {
        case 'set_category':
          return `category → ${refs.categoryLabel(x.categoryId)}`;
        case 'set_merchant':
          return `merchant → ${refs.merchantName(x.merchantId)}`;
        case 'add_tag':
          return `tag + ${refs.tagName(x.tagId)}`;
        case 'set_description':
          return `description → “${x.value}”`;
        case 'apply_split_template':
          return 'apply split template';
        default:
          return 'exclude from reports';
      }
    })
    .join(', ');
  return `If ${c}: ${a}`;
}

export default function RulesPage() {
  const refs = useRefs();
  const rules = useEntities('categorization_rules');
  const [editing, setEditing] = useState<D.CategorizationRule | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = useWrite((ops, r: D.CategorizationRule) =>
    ops.update('categorization_rules', r.id, { enabled: !r.enabled, version: r.version }),
  );
  const del = useWrite((ops, r: D.CategorizationRule) =>
    ops.remove('categorization_rules', r.id, r.version),
  );
  const runAll = useWrite((ops) => ops.applyRules());
  const list = [...(rules.data ?? [])].sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  );

  return (
    <div>
      <PageHeader
        title="Automation rules"
        actions={
          <>
            <Button
              disabled={runAll.isPending || list.length === 0}
              onClick={() =>
                runAll
                  .mutateAsync(undefined)
                  .then((r) =>
                    setMsg(
                      `Rules categorized ${r.matched} uncategorized or imported transactions.`,
                    ),
                  )
                  .catch((e) => setErr(describeError(e)))
              }
            >
              <Play size={14} aria-hidden /> Run on uncategorized
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={14} aria-hidden /> New rule
            </Button>
          </>
        }
      >
        Rules run automatically on new uncategorized transactions and imports (on this device and on
        the server), and on demand, in priority order. User-chosen categories are never changed
        automatically.
      </PageHeader>
      {msg && (
        <p role="status" className="mb-2 text-sm">
          {msg}
        </p>
      )}
      <ErrorText error={err} />
      {list.length === 0 && !rules.isLoading && (
        <Empty title="No rules yet">
          Create a rule, e.g. “description contains KONZUM → Groceries”.
        </Empty>
      )}
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {list.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium">
                {r.name} <Badge>#{r.priority}</Badge>{' '}
                {!r.enabled && <Badge tone="amber">disabled</Badge>}{' '}
                {r.stopProcessing && <Badge>stops</Badge>}
              </p>
              <p className="truncate text-xs text-muted">{summary(r, refs)}</p>
              <p className="text-xs text-muted">
                {r.matchCount} matches{r.lastMatchedAt && `, last ${r.lastMatchedAt.slice(0, 10)}`}
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                onClick={() => toggle.mutateAsync(r).catch((e) => setErr(describeError(e)))}
              >
                {r.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="sm" onClick={() => setEditing(r)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  window.confirm(`Delete rule ${r.name}?`) &&
                  del.mutateAsync(r).catch((e) => setErr(describeError(e)))
                }
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New rule' : 'Edit rule'}
        wide
      >
        {editing && (
          <RuleEditor
            rule={editing === 'new' ? undefined : editing}
            refs={refs}
            onDone={(m) => {
              setEditing(null);
              setMsg(m ?? null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
