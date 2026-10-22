// Feature 120: self-hosted administration (users, registration policy, statistics,
// diagnostics, server-wide audit). Shown only to server admins; the API enforces it.
import type { Schemas } from '@finplat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useData } from '../app/data.tsx';
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  ErrorBox,
  Field,
  Input,
  PageHeader,
  Select,
  Tabs,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { formatBytes, useFormat } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';

type User = Schemas['User'];
interface Diagnostics {
  checks?: { name?: string; ok?: boolean; detail?: string }[];
  apiVersion?: string;
  syncProtocolVersion?: number;
  schemaVersion?: number;
  registrationPolicy?: string;
  lastScheduledBackupAt?: string | null;
  openSyncConflicts?: number;
  activeSessions?: number;
}

function Users() {
  const t = useT();
  const fmt = useFormat();
  const { api, user: me } = useData();
  const qc = useQueryClient();
  const [cursor, setCursor] = useState<string | undefined>();
  const list = useQuery({
    queryKey: ['server', 'admin-users', cursor],
    enabled: !!api,
    queryFn: () =>
      api?.request<{ items: User[]; nextCursor?: string }>(
        'GET',
        `/api/v1/admin/users?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ) ?? null,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['server', 'admin-users'] });
  const patch = useMutation({
    mutationFn: (p: { id: string; body: { status?: string; isAdmin?: boolean } }) =>
      api?.request('PATCH', `/api/v1/admin/users/${p.id}`, p.body) ?? Promise.resolve(),
    onSuccess: refresh,
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api?.request('POST', '/api/v1/admin/users', { email, password }) ?? Promise.resolve(),
    onSuccess: () => {
      setEmail('');
      setPassword('');
      toast(t('admin.userCreated', 'Account created; hand the password to the user.'));
      refresh();
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th>{t('auth.email', 'Email')}</th>
                <th>{t('admin.status', 'Status')}</th>
                <th>{t('admin.role', 'Role')}</th>
                <th>{t('admin.created', 'Created')}</th>
                <th>
                  <span className="sr-only">{t('common.actions', 'Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.email}{' '}
                    {u.displayName && <span className="text-muted">({u.displayName})</span>}
                  </td>
                  <td>
                    <Badge tone={u.status === 'active' ? 'pos' : 'warn'}>{u.status}</Badge>
                  </td>
                  <td>
                    {u.isAdmin ? (
                      <Badge tone="accent">{t('settings.securityTab.admin', 'admin')}</Badge>
                    ) : (
                      t('admin.adminPage.user', 'user')
                    )}
                  </td>
                  <td>{u.createdAt ? fmt.dateTime(u.createdAt) : ''}</td>
                  <td className="text-right whitespace-nowrap">
                    {u.id && u.id !== me?.id && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            patch.mutate({
                              id: u.id as string,
                              body: { status: u.status === 'active' ? 'disabled' : 'active' },
                            })
                          }
                        >
                          {u.status === 'active'
                            ? t('admin.disable', 'Disable')
                            : t('admin.enable', 'Enable')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            patch.mutate({ id: u.id as string, body: { isAdmin: !u.isAdmin } })
                          }
                        >
                          {u.isAdmin
                            ? t('admin.demote', 'Remove admin')
                            : t('admin.promote', 'Make admin')}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex gap-2">
          {cursor && (
            <Button size="sm" onClick={() => setCursor(undefined)}>
              {t('admin.first', 'First page')}
            </Button>
          )}
          {list.data?.nextCursor && (
            <Button size="sm" onClick={() => setCursor(list.data?.nextCursor)}>
              {t('admin.next', 'Next page')}
            </Button>
          )}
        </div>
        <ErrorBox error={list.error ?? patch.error} />
      </Card>
      <Card title={t('admin.createUser', 'Create account')}>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('auth.email', 'Email')}>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t('admin.initialPw', 'Initial password (12+)')}>
            <Input
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" busy={create.isPending}>
            {t('common.add', 'Add')}
          </Button>
        </form>
        <ErrorBox error={create.error} />
      </Card>
    </div>
  );
}

function ServerSettings() {
  const t = useT();
  const fmt = useFormat();
  const { api } = useData();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['server', 'admin-settings'],
    enabled: !!api,
    queryFn: () => api?.request<Schemas['AdminSettings']>('GET', '/api/v1/admin/settings') ?? null,
  });
  const stats = useQuery({
    queryKey: ['server', 'admin-stats'],
    enabled: !!api,
    queryFn: () => api?.request<Schemas['AdminStats']>('GET', '/api/v1/admin/stats') ?? null,
  });
  const diag = useQuery({
    queryKey: ['server', 'admin-diagnostics'],
    enabled: !!api,
    queryFn: () => api?.request<Diagnostics>('GET', '/api/v1/admin/diagnostics') ?? null,
  });
  const save = useMutation({
    mutationFn: (registrationPolicy: string) =>
      api?.request('PUT', '/api/v1/admin/settings', { registrationPolicy }) ?? Promise.resolve(),
    onSuccess: () => {
      toast(t('settings.saved', 'Saved'));
      qc.invalidateQueries({ queryKey: ['server', 'admin-settings'] });
    },
  });
  const s = settings.data;
  const st = stats.data;
  const d = diag.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t('admin.settings', 'Server settings')}>
        {s && (
          <div className="flex flex-col gap-3">
            <Field
              label={t('admin.registration', 'Registration')}
              hint={t(
                'admin.registrationHint',
                'invite_only: admins create accounts. first_user: only the first sign-up is allowed.',
              )}
            >
              <Select value={s.registrationPolicy} onChange={(e) => save.mutate(e.target.value)}>
                {['open', 'invite_only', 'first_user', 'closed'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </Field>
            <DefinitionList
              items={[
                [
                  t('admin.mcp', 'MCP endpoint'),
                  s.mcpEnabled ? (
                    <Badge key="m" tone="pos">
                      {t('admin.adminPage.enabled', 'enabled')}
                    </Badge>
                  ) : (
                    <Badge key="m">{t('admin.adminPage.disabled', 'disabled')}</Badge>
                  ),
                ],
                [t('admin.fx', 'Exchange-rate providers'), (s.fxProviders ?? []).join(', ') || '—'],
                [t('admin.backupSchedule', 'Server backup schedule'), s.backupSchedule || 'off'],
              ]}
            />
            <p className="text-xs text-muted">
              {t(
                'admin.envNote',
                'MCP, providers and the backup schedule are set in the server environment (.env).',
              )}
            </p>
          </div>
        )}
        <ErrorBox error={settings.error ?? save.error} />
      </Card>
      <Card title={t('admin.stats', 'Statistics')}>
        {st && (
          <DefinitionList
            items={[
              [
                t('admin.version', 'Version'),
                `${st.version ?? '—'} · schema ${st.schemaVersion ?? '—'}`,
              ],
              [t('admin.users', 'Users'), String(st.users ?? 0)],
              [t('admin.profiles', 'Profiles'), String(st.profiles ?? 0)],
              [t('admin.transactions', 'Transactions'), String(st.transactions ?? 0)],
              [t('admin.db', 'Database'), formatBytes(st.databaseBytes)],
              [t('admin.attachments', 'Attachments'), formatBytes(st.attachmentsBytes)],
              [t('admin.backups', 'Backups'), formatBytes(st.backupsBytes)],
            ]}
          />
        )}
        <ErrorBox error={stats.error} />
      </Card>
      <Card title={t('admin.diagnostics', 'Diagnostics')} className="lg:col-span-2">
        {d && (
          <>
            <ul className="mb-3 flex flex-col gap-1">
              {(d.checks ?? []).map((c) => (
                <li key={c.name} className="flex items-start gap-2 text-sm">
                  <Badge tone={c.ok ? 'pos' : 'neg'}>
                    {c.ok ? 'OK' : t('admin.fail', 'problem')}
                  </Badge>
                  <span className="font-medium">{c.name}</span>
                  {c.detail && <span className="text-muted">{c.detail}</span>}
                </li>
              ))}
            </ul>
            <DefinitionList
              items={[
                [
                  'API',
                  `${d.apiVersion ?? '—'} · sync v${d.syncProtocolVersion ?? '—'} · schema ${d.schemaVersion ?? '—'}`,
                ],
                [
                  t('admin.lastBackup', 'Last scheduled backup'),
                  d.lastScheduledBackupAt ? fmt.dateTime(d.lastScheduledBackupAt) : '—',
                ],
                [t('admin.conflicts', 'Open sync conflicts'), String(d.openSyncConflicts ?? 0)],
                [t('admin.sessions', 'Active sessions'), String(d.activeSessions ?? 0)],
              ]}
            />
          </>
        )}
        <ErrorBox error={diag.error} />
      </Card>
    </div>
  );
}

function AdminAudit() {
  const t = useT();
  const fmt = useFormat();
  const { api } = useData();
  const [action, setAction] = useState('');
  const list = useQuery({
    queryKey: ['server', 'admin-audit', action],
    enabled: !!api,
    queryFn: () =>
      api
        ?.request<{ items: Schemas['AuditEntry'][] }>(
          'GET',
          `/api/v1/admin/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`,
        )
        .then((r) => r.items) ?? [],
  });
  return (
    <Card
      title={t('admin.audit', 'Audit log')}
      actions={
        <Input
          aria-label={t('admin.filterAction', 'Filter by action')}
          placeholder="auth.login"
          className="h-8 w-48"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
      }
    >
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{t('mcp.when', 'When')}</th>
              <th>{t('mcp.action', 'Action')}</th>
              <th>{t('mcp.actor', 'Actor')}</th>
              <th>{t('mcp.entity', 'Record')}</th>
              <th>{t('admin.request', 'Request')}</th>
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
                <td className="text-xs">
                  {e.actorType} {e.actorId?.slice(0, 8)}
                </td>
                <td className="text-xs text-muted">{e.entityType ?? ''}</td>
                <td className="text-xs text-muted">{e.requestId ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBox error={list.error} />
    </Card>
  );
}

export default function AdminPage() {
  const t = useT();
  const [tab, setTab] = useState('users');
  return (
    <>
      <PageHeader title={t('nav.admin', 'Administration')} />
      <Tabs
        label={t('nav.admin', 'Administration')}
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'users', label: t('admin.users', 'Users'), content: <Users /> },
          { value: 'server', label: t('admin.server', 'Server'), content: <ServerSettings /> },
          { value: 'audit', label: t('admin.audit', 'Audit log'), content: <AdminAudit /> },
        ]}
      />
    </>
  );
}
