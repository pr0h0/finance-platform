// MCP connections (features 133, 141–144): clients with per-client tokens (shown once), grants
// per profile and capability with account/period restrictions and approval mode, the review
// queue for proposed changes (per change and batch), audit history, disable and revoke. Also the
// OAuth consent screen (/agents/authorize) that the API's /oauth/authorize sends the browser to.
import type { Schemas } from '@finplat/api-client';
import { MCP_SCOPES, type McpScope } from '@finplat/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { qk, useData, useFinance, useProfile } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Switch,
  Tabs,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { useFormat } from '../lib/format.ts';
import { type TFn, useT } from '../lib/i18n.ts';

type Client = Schemas['McpClient'];
type Grant = Schemas['McpGrant'];
type Proposal = Schemas['McpProposal'];

/** Only these scopes may run without per-change approval (enforced by the server too). */
export const AUTO_SCOPES: McpScope[] = ['edit_categories', 'edit_metadata'];

const scopeLabel = (t: TFn, s: string): string =>
  ({
    read_aggregates: t('mcp.s.read_aggregates', 'Read totals and analytics'),
    read_transactions: t('mcp.s.read_transactions', 'Read individual transactions'),
    read_merchants: t('mcp.s.read_merchants', 'Read merchant information'),
    read_attachments: t('mcp.s.read_attachments', 'Read attachments'),
    edit_categories: t('mcp.s.edit_categories', 'Change categories'),
    edit_splits: t('mcp.s.edit_splits', 'Change splits'),
    edit_metadata: t('mcp.s.edit_metadata', 'Edit tags and descriptions'),
    create_planned: t('mcp.s.create_planned', 'Create planned transactions'),
    edit_budgets: t('mcp.s.edit_budgets', 'Edit budgets'),
    edit_goals: t('mcp.s.edit_goals', 'Edit savings goals'),
    edit_rules: t('mcp.s.edit_rules', 'Create automation rules'),
  })[s] ?? s;

export interface GrantDraft {
  enabled: boolean;
  approval: 'required' | 'auto';
}

/** Build the PUT body: drafts for `profileId` replace that profile's grants; others are kept. */
export function buildGrants(
  existing: Grant[],
  profileId: string,
  drafts: Record<string, GrantDraft>,
  restrict: { accountIds: string[] | null; dateFrom: string | null; dateTo: string | null },
): Grant[] {
  const keep = existing.filter((g) => g.profileId !== profileId).map(({ id: _id, ...g }) => g);
  const mine = Object.entries(drafts)
    .filter(([, d]) => d.enabled)
    .map(([scope, d]) => ({
      profileId,
      scope: scope as Grant['scope'],
      approval: AUTO_SCOPES.includes(scope as McpScope) ? d.approval : ('required' as const),
      accountIds: restrict.accountIds?.length ? restrict.accountIds : null,
      dateFrom: restrict.dateFrom || null,
      dateTo: restrict.dateTo || null,
    }));
  return [...keep, ...mine];
}

function GrantsDialog({ client, onClose }: { client: Client; onClose: () => void }) {
  const t = useT();
  const { api } = useData();
  const profile = useProfile();
  const ops = useFinance();
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: qk(profile.id, 'accounts'),
    queryFn: () => ops.list('accounts'),
  });
  const mine = (client.grants ?? []).filter((g) => g.profileId === profile.id);
  const [drafts, setDrafts] = useState<Record<string, GrantDraft>>(() =>
    Object.fromEntries(
      MCP_SCOPES.map((s) => {
        const g = mine.find((x) => x.scope === s);
        return [s, { enabled: !!g, approval: g?.approval ?? 'required' }];
      }),
    ),
  );
  const first = mine[0];
  const [accountIds, setAccountIds] = useState<string[]>(first?.accountIds ?? []);
  const [dateFrom, setDateFrom] = useState(first?.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(first?.dateTo ?? '');
  const e2ee = profile.privacyMode === 'e2ee';
  const save = useMutation({
    mutationFn: () =>
      api?.request('PUT', `/api/v1/mcp/clients/${client.id}/grants`, {
        grants: buildGrants(client.grants ?? [], profile.id, drafts, {
          accountIds,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
        }),
      }) ?? Promise.resolve(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['server', 'mcp-clients'] });
      toast(t('mcp.grantsSaved', 'Permissions saved'));
      onClose();
    },
  });
  const write = MCP_SCOPES.filter((s) => !s.startsWith('read_'));
  const read = MCP_SCOPES.filter((s) => s.startsWith('read_'));
  const row = (s: McpScope) => (
    <div key={s} className="flex flex-wrap items-center justify-between gap-2 py-1">
      <Checkbox
        checked={drafts[s]?.enabled ?? false}
        onChange={(e) =>
          setDrafts({
            ...drafts,
            [s]: { approval: drafts[s]?.approval ?? 'required', enabled: e.target.checked },
          })
        }
        label={scopeLabel(t, s)}
        hint={<code>{s}</code>}
      />
      {!s.startsWith('read_') && drafts[s]?.enabled && (
        <Select
          aria-label={t('mcp.approvalFor', 'Approval for {{s}}', { s })}
          className="h-8 w-56"
          value={drafts[s]?.approval}
          disabled={!AUTO_SCOPES.includes(s)}
          onChange={(e) =>
            setDrafts({
              ...drafts,
              [s]: { enabled: true, approval: e.target.value as 'required' | 'auto' },
            })
          }
        >
          <option value="required">{t('mcp.approvalRequired', 'I approve each change')}</option>
          {AUTO_SCOPES.includes(s) && (
            <option value="auto">{t('mcp.approvalAuto', 'Apply automatically (low risk)')}</option>
          )}
        </Select>
      )}
    </div>
  );
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={t('mcp.grantsTitle', 'Permissions of “{{name}}” on “{{profile}}”', {
        name: client.name ?? '',
        profile: profile.name,
      })}
      description={t(
        'mcp.grantsText',
        'Nothing is allowed unless checked. Write capabilities create proposals you review, unless marked automatic.',
      )}
    >
      {e2ee && (
        <Notice tone="warn" title={t('mcp.e2eeTitle', 'End-to-end encrypted profile')}>
          {t(
            'mcp.e2eeText',
            'The server only stores ciphertext for this profile, so AI agents cannot read it or propose changes to it.',
          )}
        </Notice>
      )}
      <fieldset>
        <legend className="text-sm font-semibold">{t('mcp.read', 'Read')}</legend>
        {read.map(row)}
      </fieldset>
      <fieldset className="mt-3">
        <legend className="text-sm font-semibold">{t('mcp.write', 'Propose changes')}</legend>
        {write.map(row)}
      </fieldset>
      <fieldset className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
        <legend className="sr-only">{t('mcp.scope', 'Restrictions')}</legend>
        <div className="sm:col-span-2">
          <p className="text-sm font-semibold">{t('mcp.accounts', 'Accounts')}</p>
          <p className="mb-1 text-xs text-muted">
            {t(
              'mcp.accountsHint',
              'None selected = all accounts. Restricted clients cannot use tools that span every account.',
            )}
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {(accounts.data ?? [])
              .filter((a) => !a.deletedAt)
              .map((a) => (
                <Checkbox
                  key={a.id}
                  checked={accountIds.includes(a.id)}
                  onChange={(e) =>
                    setAccountIds(
                      e.target.checked
                        ? [...accountIds, a.id]
                        : accountIds.filter((x) => x !== a.id),
                    )
                  }
                  label={`${a.name} (${a.currency})`}
                />
              ))}
          </div>
        </div>
        <Field label={t('mcp.from', 'Data from (optional)')}>
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </Field>
        <Field label={t('mcp.to', 'Data until (optional)')}>
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </Field>
      </fieldset>
      <ErrorBox error={save.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
        <Button
          variant="primary"
          disabled={e2ee && Object.values(drafts).some((d) => d.enabled)}
          busy={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('common.save', 'Save')}
        </Button>
      </div>
    </Dialog>
  );
}

function Clients() {
  const t = useT();
  const fmt = useFormat();
  const { api } = useData();
  const profile = useProfile();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['server', 'mcp-clients'] });
  const list = useQuery({
    queryKey: ['server', 'mcp-clients'],
    enabled: !!api,
    queryFn: () =>
      api?.request<{ items: Client[] }>('GET', '/api/v1/mcp/clients').then((r) => r.items) ?? [],
  });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [expires, setExpires] = useState('');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [grants, setGrants] = useState<Client | null>(null);
  const [revoke, setRevoke] = useState<Client | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api?.request<Client & { token: string }>('POST', '/api/v1/mcp/clients', {
        name: name.trim(),
        description: description.trim() || undefined,
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      }) ?? Promise.reject(new Error('not connected')),
    onSuccess: (c) => {
      setCreated({ name: c.name ?? '', token: c.token });
      setName('');
      setDescription('');
      setExpires('');
      refresh();
    },
  });
  const patch = useMutation({
    mutationFn: (p: { id: string; enabled: boolean }) =>
      api?.request('PATCH', `/api/v1/mcp/clients/${p.id}`, { enabled: p.enabled }) ??
      Promise.resolve(),
    onSuccess: refresh,
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      api?.request('DELETE', `/api/v1/mcp/clients/${id}`) ?? Promise.resolve(),
    onSuccess: () => {
      setRevoke(null);
      refresh();
    },
  });
  const serverUrl = useApp((s) => s.connection?.serverUrl ?? '');
  const endpoint = `${serverUrl || location.origin}/mcp`;
  const clients = (list.data ?? []).filter((c) => !c.revokedAt);
  return (
    <div className="flex flex-col gap-4">
      {clients.length === 0 && !list.isLoading && (
        <EmptyState title={t('mcp.none', 'No MCP clients')}>
          {t(
            'mcp.noneText',
            'Create a client for each AI tool you connect; each gets its own token and permissions.',
          )}
        </EmptyState>
      )}
      {clients.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>{t('mcp.client', 'Client')}</th>
                  <th>{t('mcp.permissions', 'Permissions here')}</th>
                  <th>{t('mcp.lastUsed', 'Last used')}</th>
                  <th>{t('mcp.enabled', 'Enabled')}</th>
                  <th>
                    <span className="sr-only">{t('common.actions', 'Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => {
                  const here = (c.grants ?? []).filter((g) => g.profileId === profile.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        <span className="font-medium">{c.name}</span>{' '}
                        {c.kind === 'oauth' ? (
                          <Badge tone="accent">{t('mcp.mcpPage.oauth', 'OAuth')}</Badge>
                        ) : (
                          <code className="text-xs text-muted">{c.tokenPrefix}…</code>
                        )}
                        {c.description && (
                          <span className="block text-xs text-muted">{c.description}</span>
                        )}
                        {c.expiresAt && (
                          <span className="block text-xs text-muted">
                            {t('mcp.expires', 'Expires {{when}}', {
                              when: fmt.dateTime(c.expiresAt),
                            })}
                          </span>
                        )}
                      </td>
                      <td className="max-w-72">
                        {here.length === 0 ? (
                          <span className="text-muted">{t('mcp.noAccess', 'No access')}</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {here.map((g) => (
                              <Badge
                                key={g.scope}
                                tone={g.scope?.startsWith('read_') ? 'neutral' : 'warn'}
                              >
                                {g.scope}
                                {g.approval === 'auto' ? ` ${t('mcp.mcpPage.auto', '· auto')}` : ''}
                              </Badge>
                            ))}
                            {here.some((g) => g.accountIds?.length || g.dateFrom || g.dateTo) && (
                              <Badge tone="accent">{t('mcp.restricted', 'restricted')}</Badge>
                            )}
                          </span>
                        )}
                      </td>
                      <td>{c.lastUsedAt ? fmt.dateTime(c.lastUsedAt) : '—'}</td>
                      <td>
                        <Switch
                          checked={!!c.enabled}
                          label={t('mcp.enableClient', 'Enable {{name}}', { name: c.name ?? '' })}
                          onChange={(v) => c.id && patch.mutate({ id: c.id, enabled: v })}
                        />
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <Button size="sm" onClick={() => setGrants(c)}>
                          {t('mcp.edit', 'Permissions')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-neg"
                          onClick={() => setRevoke(c)}
                        >
                          {t('mcp.revoke', 'Revoke')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ErrorBox error={list.error ?? patch.error} />
        </Card>
      )}
      <Card title={t('mcp.new', 'New client')}>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('mcp.name', 'Name')}>
            <Input
              required
              maxLength={200}
              placeholder={t('mcp.mcpPage.claudeDesktop', 'Claude Desktop')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t('mcp.expiresAt', 'Expires (optional)')}>
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          <Field label={t('mcp.description', 'Description (optional)')} className="sm:col-span-2">
            <Input
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            busy={create.isPending}
            className="self-start justify-self-start"
          >
            {t('mcp.create', 'Create client')}
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted">
          {t('mcp.newNote', 'New clients have no permissions until you grant them.')}
        </p>
        <ErrorBox error={create.error} />
      </Card>
      {created && (
        <Dialog
          open
          onOpenChange={(o) => !o && setCreated(null)}
          title={t('mcp.tokenTitle', 'Token for “{{name}}”', { name: created.name })}
          wide
        >
          <Notice
            tone="warn"
            role="alert"
            title={t('mcp.tokenOnce', 'Copy it now: it is shown only once.')}
          >
            {t(
              'mcp.tokenText',
              'Anyone with this token can use the permissions you grant. Revoke the client if it leaks.',
            )}
          </Notice>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded bg-surface-2 p-2 text-sm break-all">
              {created.token}
            </code>
            <Button
              size="sm"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(created.token)
                  .then(() => toast(t('common.copied', 'Copied')))
              }
            >
              {t('common.copy', 'Copy')}
            </Button>
          </div>
          <p className="mt-3 text-sm font-medium">{t('mcp.configure', 'Client configuration')}</p>
          <pre className="mt-1 overflow-x-auto rounded bg-surface-2 p-2 text-xs">
            {JSON.stringify(
              {
                mcpServers: {
                  finance: {
                    command: 'npx',
                    args: [
                      'mcp-remote',
                      endpoint,
                      '--header',
                      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env placeholder for mcp-remote
                      'Authorization:Bearer ${FINPLAT_MCP_TOKEN}',
                    ],
                    env: { FINPLAT_MCP_TOKEN: '<token>' },
                  },
                },
              },
              null,
              2,
            )}
          </pre>
          <p className="mt-1 text-xs text-muted">
            {t(
              'mcp.endpoint',
              'Endpoint: {{url}} (Streamable HTTP, Bearer token). See docs/mcp for other clients.',
              { url: endpoint },
            )}
          </p>
        </Dialog>
      )}
      {grants && <GrantsDialog client={grants} onClose={() => setGrants(null)} />}
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title={t('mcp.revokeTitle', 'Revoke “{{name}}”?', { name: revoke?.name ?? '' })}
        confirmLabel={t('mcp.revoke', 'Revoke')}
        danger
        busy={del.isPending}
        onConfirm={() => revoke?.id && del.mutate(revoke.id)}
      >
        {t(
          'mcp.revokeText',
          'The token stops working immediately. Pending proposals of this client can no longer be applied by it.',
        )}
        <ErrorBox error={del.error} />
      </ConfirmDialog>
    </div>
  );
}

function Proposals() {
  const t = useT();
  const fmt = useFormat();
  const { api } = useData();
  const profile = useProfile();
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const clients = useQuery({
    queryKey: ['server', 'mcp-clients'],
    enabled: !!api,
    queryFn: () =>
      api?.request<{ items: Client[] }>('GET', '/api/v1/mcp/clients').then((r) => r.items) ?? [],
  });
  const list = useQuery({
    queryKey: ['server', 'mcp-proposals', profile.id, status],
    enabled: !!api,
    queryFn: () =>
      api
        ?.request<{ items: Proposal[] }>(
          'GET',
          `/api/v1/mcp/proposals?status=${status}&limit=100`,
          undefined,
          { 'X-Profile-ID': profile.id },
        )
        .then((r) => r.items) ?? [],
  });
  const refresh = async () => {
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ['server', 'mcp-proposals'] });
    await qc.invalidateQueries({ queryKey: ['profile', profile.id] });
  };
  const hdr = { 'X-Profile-ID': profile.id };
  const approve = useMutation({
    mutationFn: (id: string) =>
      api?.request('POST', `/api/v1/mcp/proposals/${id}/approve?apply=true`, undefined, hdr) ??
      Promise.resolve(),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: (id: string) =>
      api?.request('POST', `/api/v1/mcp/proposals/${id}/reject`, undefined, hdr) ??
      Promise.resolve(),
    onSuccess: refresh,
  });
  const batch = useMutation({
    mutationFn: () =>
      api?.request('POST', '/api/v1/mcp/proposals/approve-batch', { ids: [...selected] }, hdr) ??
      Promise.resolve(),
    onSuccess: refresh,
  });
  const name = new Map((clients.data ?? []).map((c) => [c.id, c.name]));
  const items = list.data ?? [];
  return (
    <Card
      title={t('mcp.queue', 'Proposed changes for “{{name}}”', { name: profile.name })}
      actions={
        <>
          <Select
            aria-label={t('mcp.status', 'Status')}
            className="h-8 w-36"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {['pending', 'approved', 'applied', 'rejected', 'failed', 'expired'].map((s) => (
              <option key={s} value={s}>
                {t(`mcp.proposalStatus.${s}`, s)}
              </option>
            ))}
          </Select>
          {status === 'pending' && (
            <Button
              size="sm"
              variant="primary"
              disabled={selected.size === 0}
              busy={batch.isPending}
              onClick={() => batch.mutate()}
            >
              {t('mcp.approveSelected', 'Approve selected ({{n}})', { n: selected.size })}
            </Button>
          )}
        </>
      }
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted">{t('mcp.noProposals', 'Nothing here.')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {status === 'pending' && p.id && (
                  <input
                    type="checkbox"
                    aria-label={t('mcp.select', 'Select proposal')}
                    className="size-4"
                    checked={selected.has(p.id)}
                    onChange={(e) => {
                      const s = new Set(selected);
                      e.target.checked ? s.add(p.id as string) : s.delete(p.id as string);
                      setSelected(s);
                    }}
                  />
                )}
                <code className="font-medium">{p.tool}</code>
                <span className="text-muted">
                  {t('mcp.by', 'by {{client}}', {
                    client: name.get(p.mcpClientId) ?? p.mcpClientId ?? '',
                  })}{' '}
                  · {p.createdAt ? fmt.dateTime(p.createdAt) : ''}
                </span>
                <Badge
                  tone={
                    p.status === 'pending'
                      ? 'warn'
                      : p.status === 'applied'
                        ? 'pos'
                        : p.status === 'failed'
                          ? 'neg'
                          : 'neutral'
                  }
                >
                  {p.status && t(`mcp.proposalStatus.${p.status}`, p.status)}
                </Badge>
              </div>
              <details>
                <summary className="cursor-pointer text-sm text-accent">
                  {t('mcp.preview', 'What would change')}
                </summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded bg-surface-2 p-2 text-xs">
                  {JSON.stringify(p.preview ?? p.input, null, 2)}
                </pre>
              </details>
              {p.error && <p className="text-sm text-neg">{p.error}</p>}
              {p.status === 'pending' && p.id && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    busy={approve.isPending}
                    onClick={() => approve.mutate(p.id as string)}
                  >
                    {t('mcp.approve', 'Approve and apply')}
                  </Button>
                  <Button
                    size="sm"
                    busy={reject.isPending}
                    onClick={() => reject.mutate(p.id as string)}
                  >
                    {t('mcp.reject', 'Reject')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorBox error={list.error ?? approve.error ?? reject.error ?? batch.error} />
    </Card>
  );
}

function Audit() {
  const t = useT();
  const fmt = useFormat();
  const { api } = useData();
  const profile = useProfile();
  const list = useQuery({
    queryKey: ['server', 'mcp-audit', profile.id],
    enabled: !!api,
    queryFn: () =>
      api
        ?.request<{ items: Schemas['AuditEntry'][] }>('GET', '/api/v1/audit?limit=200', undefined, {
          'X-Profile-ID': profile.id,
        })
        .then((r) =>
          r.items.filter((e) => e.actorType === 'mcp' || e.action?.startsWith('mcp.')),
        ) ?? [],
  });
  return (
    <Card title={t('mcp.audit', 'MCP activity in “{{name}}”', { name: profile.name })}>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{t('mcp.when', 'When')}</th>
              <th>{t('mcp.action', 'Action')}</th>
              <th>{t('mcp.actor', 'Actor')}</th>
              <th>{t('mcp.entity', 'Record')}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap">
                  {e.occurredAt ? fmt.dateTime(e.occurredAt) : ''}
                </td>
                <td>
                  <code className="text-xs">{e.action}</code>
                </td>
                <td>{e.actorType}</td>
                <td className="text-xs text-muted">{e.entityType ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.length === 0 && (
          <p className="py-2 text-sm text-muted">
            {t('mcp.noAudit', 'No MCP activity recorded yet (latest 200 audit entries checked).')}
          </p>
        )}
      </div>
      <ErrorBox error={list.error} />
    </Card>
  );
}

/** Read-only by default (PLAN §29); write capabilities must be ticked explicitly. */
const CONSENT_DEFAULTS: McpScope[] = ['read_aggregates', 'read_transactions', 'read_merchants'];

type OAuthRequest = Schemas['McpOAuthRequest'];

function OAuthConsent() {
  const t = useT();
  const { api, profiles } = useData();
  const current = useProfile();
  const search = useLocation().search;
  // the server holds only ciphertext for e2ee profiles, so they cannot be shared with an agent
  const eligible = profiles.filter((p) => p.privacyMode !== 'e2ee');
  const [profileId, setProfileId] = useState(
    eligible.some((p) => p.id === current.id) ? current.id : (eligible[0]?.id ?? ''),
  );
  const info = useQuery({
    queryKey: ['server', 'mcp-oauth', search],
    enabled: !!api,
    retry: false,
    queryFn: () =>
      api?.request<OAuthRequest>('GET', `/api/v1/mcp/oauth/authorize${search}`) ??
      Promise.reject(new Error('not connected')),
  });
  if (!api)
    return (
      <Notice tone="warn" title={t('mcp.oauthLocal', 'Sign in to your server first')}>
        {t(
          'mcp.oauthLocalText',
          'AI agents connect to the server. Open this link again after signing in to a server account.',
        )}
      </Notice>
    );
  if (info.isLoading) return null;
  if (!info.data) return <ErrorBox error={info.error} />;
  if (!eligible.length)
    return (
      <Notice tone="warn" title={t('mcp.e2eeTitle', 'End-to-end encrypted profile')}>
        {t(
          'mcp.oauthE2ee',
          'All your profiles are end-to-end encrypted. The server only stores their ciphertext, so an AI agent cannot be connected to them.',
        )}
      </Notice>
    );
  return (
    <ConsentForm
      key={profileId}
      req={info.data}
      search={search}
      profileId={profileId}
      profiles={eligible.map((p) => ({ id: p.id, name: p.name }))}
      onProfile={setProfileId}
    />
  );
}

function ConsentForm({
  req,
  search,
  profileId,
  profiles,
  onProfile,
}: {
  req: OAuthRequest;
  search: string;
  profileId: string;
  profiles: { id: string; name: string }[];
  onProfile: (id: string) => void;
}) {
  const t = useT();
  const { api } = useData();
  const existing = req.connection?.grants ?? [];
  const mine = existing.filter((g) => g.profileId === profileId);
  const [drafts, setDrafts] = useState<Record<string, GrantDraft>>(() =>
    Object.fromEntries(
      MCP_SCOPES.map((s) => {
        const g = mine.find((x) => x.scope === s);
        const on = mine.length ? !!g : CONSENT_DEFAULTS.includes(s);
        return [s, { enabled: on, approval: g?.approval ?? 'required' }];
      }),
    ),
  );
  const [accountIds, setAccountIds] = useState<string[]>(mine[0]?.accountIds ?? []);
  const [dateFrom, setDateFrom] = useState(mine[0]?.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(mine[0]?.dateTo ?? '');
  const accounts = useQuery({
    queryKey: ['server', 'accounts', profileId],
    queryFn: () =>
      api
        ?.request<{ items: Schemas['Account'][] }>('GET', '/api/v1/accounts?limit=500', undefined, {
          'X-Profile-ID': profileId,
        })
        .then((r) => r.items.filter((a) => !a.deletedAt)) ?? [],
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api?.request<{ redirectUrl: string }>('POST', `/api/v1/mcp/oauth/authorize${search}`, {
        approve,
        grants: approve
          ? buildGrants(existing, profileId, drafts, { accountIds, dateFrom, dateTo })
          : undefined,
      }) ?? Promise.reject(new Error('not connected')),
    onSuccess: (r) => window.location.assign(r.redirectUrl),
  });
  const toggle = (s: McpScope, enabled: boolean) =>
    setDrafts({ ...drafts, [s]: { approval: drafts[s]?.approval ?? 'required', enabled } });
  const group = (title: string, scopes: McpScope[]) => (
    <fieldset className="mt-3">
      <legend className="text-sm font-semibold">{title}</legend>
      {scopes.map((s) => (
        <div key={s} className="flex flex-wrap items-center justify-between gap-2 py-1">
          <Checkbox
            checked={drafts[s]?.enabled ?? false}
            onChange={(e) => toggle(s, e.target.checked)}
            label={scopeLabel(t, s)}
            hint={<code>{s}</code>}
          />
          {AUTO_SCOPES.includes(s) && drafts[s]?.enabled && (
            <Select
              aria-label={t('mcp.approvalFor', 'Approval for {{s}}', { s })}
              className="h-8 w-56"
              value={drafts[s]?.approval}
              onChange={(e) =>
                setDrafts({
                  ...drafts,
                  [s]: { enabled: true, approval: e.target.value as 'required' | 'auto' },
                })
              }
            >
              <option value="required">{t('mcp.approvalRequired', 'I approve each change')}</option>
              <option value="auto">
                {t('mcp.approvalAuto', 'Apply automatically (low risk)')}
              </option>
            </Select>
          )}
        </div>
      ))}
    </fieldset>
  );
  const none = !Object.values(drafts).some((d) => d.enabled);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <PageHeader
        title={t('mcp.oauthTitle', 'Connect “{{name}}”', { name: req.clientName })}
        description={t(
          'mcp.oauthText',
          '{{host}} asks for access to your finances through MCP. After you approve, it is sent back to {{host}}.',
          { host: req.redirectHost },
        )}
      />
      <Notice
        tone="warn"
        title={t('mcp.privacy', 'Data you expose to an AI agent leaves your control')}
      >
        {t(
          'mcp.oauthPrivacy',
          'Only approve if you started this connection. What the agent reads is sent to its AI provider. You can change or revoke this connection any time in MCP connections.',
        )}
      </Notice>
      <Card>
        <p className="text-sm text-muted">
          {t('mcp.oauthRedirect', 'Redirects to')}{' '}
          <code className="break-all">{req.redirectUri}</code>
        </p>
        {req.connection && (
          <p className="mt-1 text-sm text-muted">
            {t(
              'mcp.oauthExisting',
              'Already connected: approving replaces its permissions on this profile.',
            )}
          </p>
        )}
        <Field label={t('mcp.oauthProfile', 'Profile')} className="mt-3">
          <Select value={profileId} onChange={(e) => onProfile(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {group(
          t('mcp.read', 'Read'),
          MCP_SCOPES.filter((s) => s.startsWith('read_')),
        )}
        {group(
          t('mcp.write', 'Propose changes'),
          MCP_SCOPES.filter((s) => !s.startsWith('read_')),
        )}
        <fieldset className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
          <legend className="sr-only">{t('mcp.scope', 'Restrictions')}</legend>
          <div className="sm:col-span-2">
            <p className="text-sm font-semibold">{t('mcp.accounts', 'Accounts')}</p>
            <p className="mb-1 text-xs text-muted">
              {t(
                'mcp.accountsHint',
                'None selected = all accounts. Restricted clients cannot use tools that span every account.',
              )}
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {(accounts.data ?? []).map((a) => (
                <Checkbox
                  key={a.id}
                  checked={accountIds.includes(a.id)}
                  onChange={(e) =>
                    setAccountIds(
                      e.target.checked
                        ? [...accountIds, a.id]
                        : accountIds.filter((x) => x !== a.id),
                    )
                  }
                  label={`${a.name} (${a.currency})`}
                />
              ))}
            </div>
          </div>
          <Field label={t('mcp.from', 'Data from (optional)')}>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </Field>
          <Field label={t('mcp.to', 'Data until (optional)')}>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </Field>
        </fieldset>
        <ErrorBox error={decide.error ?? accounts.error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button
            busy={decide.isPending && decide.variables === false}
            onClick={() => decide.mutate(false)}
          >
            {t('mcp.oauthDeny', 'Deny')}
          </Button>
          <Button
            variant="primary"
            disabled={none}
            busy={decide.isPending && decide.variables === true}
            onClick={() => decide.mutate(true)}
          >
            {t('mcp.oauthApprove', 'Approve')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function McpPage() {
  const t = useT();
  const { api } = useData();
  const [tab, setTab] = useState('clients');
  const consent = useLocation().pathname.replace(/\/$/, '') === '/agents/authorize';
  const meta = useQuery({
    queryKey: ['server', 'meta'],
    queryFn: () => api?.getMeta() ?? null,
    enabled: !!api,
  });
  if (consent) return <OAuthConsent />;
  return (
    <>
      <PageHeader
        title={t('nav.mcp', 'MCP connections')}
        description={t(
          'mcp.text',
          'Let AI assistants read your finances or propose changes through the Model Context Protocol.',
        )}
      />
      <div className="mb-4 flex flex-col gap-2">
        <Notice
          tone="warn"
          title={t('mcp.privacy', 'Data you expose to an AI agent leaves your control')}
        >
          {t(
            'mcp.privacyText',
            'An MCP client sends what it reads to its AI provider. Grant only what is needed, restrict accounts and periods, and keep approval on for changes. Nothing is sent to any AI provider by this app itself.',
          )}
        </Notice>
        {meta.data && !meta.data.mcpEnabled && (
          <Notice tone="neutral" title={t('mcp.disabled', 'MCP is disabled on this server')}>
            {t(
              'mcp.disabledText',
              'You can prepare clients here, but the /mcp endpoint answers only after an administrator sets MCP_ENABLED=true.',
            )}
          </Notice>
        )}
      </div>
      <Tabs
        label={t('nav.mcp', 'MCP connections')}
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'clients', label: t('mcp.clients', 'Clients'), content: <Clients /> },
          { value: 'proposals', label: t('mcp.proposals', 'Approvals'), content: <Proposals /> },
          { value: 'audit', label: t('mcp.history', 'History'), content: <Audit /> },
        ]}
      />
    </>
  );
}
