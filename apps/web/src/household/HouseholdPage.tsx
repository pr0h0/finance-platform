// Feature 93: households (members, invitations, roles) and sharing profiles with members.
// Invitations are single-use tokens bound to the invitee's email; the server sends no email,
// so the token is shown once to hand over.
import type { Schemas } from '@finplat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useData, useProfile } from '../app/data.tsx';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  tableClass,
} from '../components/ui/index.tsx';
import { toast } from '../components/ui/toast.tsx';
import { useT } from '../lib/i18n.ts';

type Household = Schemas['Household'];
type Member = Schemas['HouseholdMember'];

const HROLES = ['owner', 'admin', 'member', 'viewer'] as const;
const PROLES = ['owner', 'editor', 'viewer'] as const;

function useHouseholds() {
  const { api } = useData();
  return useQuery({
    queryKey: ['server', 'households'],
    enabled: !!api,
    queryFn: async () => {
      const list =
        (await api?.request<{ items: Household[] }>('GET', '/api/v1/households'))?.items ?? [];
      // the list may omit members; fetch each household for its member list
      return Promise.all(
        list.map((h) => api?.request<Household>('GET', `/api/v1/households/${h.id}`) ?? h),
      );
    },
  });
}

function HouseholdCard({ h, myUserId }: { h: Household; myUserId?: string }) {
  const t = useT();
  const { api } = useData();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['server', 'households'] });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof HROLES)[number]>('member');
  const [token, setToken] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [deleting, setDeleting] = useState(false);
  const me = h.members?.find((m) => m.userId === myUserId);
  const manage = me?.role === 'owner' || me?.role === 'admin';

  const invite = useMutation({
    mutationFn: () =>
      api?.request<{ inviteToken: string }>('POST', `/api/v1/households/${h.id}/invitations`, {
        email,
        role,
      }) ?? Promise.resolve({ inviteToken: '' }),
    onSuccess: (r) => {
      setToken(r.inviteToken);
      setEmail('');
      refresh();
    },
  });
  const setMemberRole = useMutation({
    mutationFn: (p: { id: string; role: string }) =>
      api?.request('PATCH', `/api/v1/households/${h.id}/members/${p.id}`, { role: p.role }) ??
      Promise.resolve(),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api?.request('DELETE', `/api/v1/households/${h.id}/members/${id}`) ?? Promise.resolve(),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: () => api?.request('DELETE', `/api/v1/households/${h.id}`) ?? Promise.resolve(),
    onSuccess: () => {
      setDeleting(false);
      refresh();
    },
  });

  const members = (h.members ?? []).filter((m) => m.status !== 'removed');
  return (
    <Card
      title={h.name}
      actions={
        me?.role === 'owner' && (
          <Button size="sm" variant="ghost" className="text-neg" onClick={() => setDeleting(true)}>
            {t('common.delete', 'Delete')}
          </Button>
        )
      }
    >
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{t('household.member', 'Member')}</th>
              <th>{t('household.role', 'Role')}</th>
              <th>{t('household.status', 'Status')}</th>
              <th>
                <span className="sr-only">{t('common.actions', 'Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.invitedEmail ?? m.userId}{' '}
                  {m.userId === myUserId && (
                    <Badge tone="accent">{t('household.you', 'you')}</Badge>
                  )}
                </td>
                <td>
                  {manage && m.userId !== myUserId && m.id ? (
                    <Select
                      aria-label={t('household.role', 'Role')}
                      className="h-8 w-32"
                      value={m.role}
                      onChange={(e) =>
                        setMemberRole.mutate({ id: m.id as string, role: e.target.value })
                      }
                    >
                      {HROLES.map((r) => (
                        <option key={r} value={r}>
                          {t(`role.${r}`, r)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    t(`role.${m.role}`, m.role ?? '')
                  )}
                </td>
                <td>
                  <Badge tone={m.status === 'active' ? 'pos' : 'warn'}>{m.status}</Badge>
                </td>
                <td className="text-right">
                  {(manage || m.userId === myUserId) && m.id && (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                      {m.userId === myUserId
                        ? t('household.leave', 'Leave')
                        : t('household.remove', 'Remove')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBox error={setMemberRole.error} />
      {manage && (
        <form
          className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <Field label={t('household.inviteEmail', 'Invite by email')}>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t('household.role', 'Role')}>
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as (typeof HROLES)[number])}
            >
              {HROLES.filter((r) => r !== 'owner').map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`, r)}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" busy={invite.isPending}>
            {t('household.invite', 'Invite')}
          </Button>
        </form>
      )}
      {token && (
        <div className="mt-3">
          <Notice
            tone="warn"
            title={t('household.token', 'Invitation token (shown once, valid 7 days)')}
          >
            <p>
              {t(
                'household.tokenText',
                'Send this token to the invitee yourself; they accept it on this page after signing in with the invited email.',
              )}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="break-all text-fg">{token}</code>
              <Button
                size="sm"
                onClick={() =>
                  navigator.clipboard
                    ?.writeText(token)
                    .then(() => toast(t('common.copied', 'Copied')))
                }
              >
                {t('common.copy', 'Copy')}
              </Button>
            </div>
          </Notice>
        </div>
      )}
      <ErrorBox error={invite.error} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('household.removeTitle', 'Remove from household?')}
        confirmLabel={t('household.remove', 'Remove')}
        danger
        busy={remove.isPending}
        onConfirm={() => removing?.id && remove.mutate(removing.id)}
      >
        {t(
          'household.removeText',
          'Access to profiles shared through this household ends immediately. Data already on their devices stays there.',
        )}
        <ErrorBox error={remove.error} />
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('household.deleteTitle', 'Delete household “{{name}}”?', { name: h.name ?? '' })}
        confirmLabel={t('common.delete', 'Delete')}
        danger
        busy={del.isPending}
        onConfirm={() => del.mutate()}
      >
        {t(
          'household.deleteText',
          'Members lose access to shared profiles. The profiles themselves are not deleted.',
        )}
        <ErrorBox error={del.error} />
      </ConfirmDialog>
    </Card>
  );
}

function SharedProfile({ households }: { households: Household[] }) {
  const t = useT();
  const { api, refreshProfiles } = useData();
  const profile = useProfile();
  const qc = useQueryClient();
  const isOwner = profile.role === 'owner';
  const members = useQuery({
    queryKey: ['server', 'profile-members', profile.id],
    enabled: !!api,
    queryFn: () =>
      api
        ?.request<{ items: Schemas['ProfileMember'][] }>(
          'GET',
          `/api/v1/profiles/${profile.id}/members`,
        )
        .then((r) => r.items) ?? [],
  });
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['server', 'profile-members', profile.id] });
  const attach = useMutation({
    mutationFn: async (householdId: string) => {
      await api?.request('PATCH', `/api/v1/profiles/${profile.id}`, {
        name: profile.name,
        householdId,
      });
      await refreshProfiles();
    },
  });
  const setRole = useMutation({
    mutationFn: (p: { userId: string; role: string }) =>
      api?.request('PUT', `/api/v1/profiles/${profile.id}/members/${p.userId}`, { role: p.role }) ??
      Promise.resolve(),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api?.request('DELETE', `/api/v1/profiles/${profile.id}/members/${userId}`) ??
      Promise.resolve(),
    onSuccess: refresh,
  });
  const household = households.find((h) => h.id === profile.householdId);
  const memberIds = new Set((members.data ?? []).map((m) => m.userId));
  const candidates = (household?.members ?? []).filter(
    (m) => m.status === 'active' && m.userId && !memberIds.has(m.userId),
  );

  return (
    <Card title={t('household.sharing', 'Sharing “{{name}}”', { name: profile.name })}>
      {!household ? (
        isOwner && households.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('household.attach', 'Share with household')} className="min-w-56">
              <Select
                defaultValue=""
                onChange={(e) => e.target.value && attach.mutate(e.target.value)}
              >
                <option value="">{t('quick.choose', 'Choose…')}</option>
                {households.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </Select>
            </Field>
            <ErrorBox error={attach.error} />
          </div>
        ) : (
          <p className="text-sm text-muted">
            {isOwner
              ? t('household.noneToShare', 'Create a household first to share this profile.')
              : t('household.notOwner', 'Only the profile owner can share it.')}
          </p>
        )
      ) : (
        <p className="mb-2 text-sm text-muted">
          {t(
            'household.sharedIn',
            'Shared within “{{name}}”. Members need a role on the profile to see it.',
            { name: household.name ?? '' },
          )}
        </p>
      )}
      {(members.data?.length ?? 0) > 0 && (
        <div className="overflow-x-auto">
          <table className={`${tableClass} mt-2`}>
            <thead>
              <tr>
                <th>{t('household.member', 'Member')}</th>
                <th>{t('household.profileRole', 'Profile role')}</th>
                <th>
                  <span className="sr-only">{t('common.actions', 'Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.data?.map((m) => (
                <tr key={m.userId}>
                  <td>{m.email}</td>
                  <td>
                    {isOwner && m.userId ? (
                      <Select
                        aria-label={t('household.profileRole', 'Profile role')}
                        className="h-8 w-32"
                        value={m.role}
                        onChange={(e) =>
                          setRole.mutate({ userId: m.userId as string, role: e.target.value })
                        }
                      >
                        {PROLES.map((r) => (
                          <option key={r} value={r}>
                            {t(`role.${r}`, r)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      m.role
                    )}
                  </td>
                  <td className="text-right">
                    {isOwner && m.role !== 'owner' && m.userId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => remove.mutate(m.userId as string)}
                      >
                        {t('household.remove', 'Remove')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isOwner && household && candidates.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {candidates.map((c) => (
            <Button
              key={c.id}
              size="sm"
              onClick={() => c.userId && setRole.mutate({ userId: c.userId, role: 'viewer' })}
            >
              {t('household.grant', 'Give {{who}} access (viewer)', {
                who: c.invitedEmail ?? c.userId ?? '',
              })}
            </Button>
          ))}
        </div>
      )}
      <ErrorBox error={members.error ?? setRole.error ?? remove.error} />
    </Card>
  );
}

export default function HouseholdPage() {
  const t = useT();
  const { api, user } = useData();
  const qc = useQueryClient();
  const list = useHouseholds();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const create = useMutation({
    mutationFn: () => api?.request('POST', '/api/v1/households', { name }) ?? Promise.resolve(),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['server', 'households'] });
    },
  });
  const accept = useMutation({
    mutationFn: () =>
      api?.request('POST', '/api/v1/household-invitations/accept', { token: token.trim() }) ??
      Promise.resolve(),
    onSuccess: () => {
      setToken('');
      toast(t('household.joined', 'You joined the household'));
      qc.invalidateQueries({ queryKey: ['server', 'households'] });
    },
  });
  const households = (list.data ?? []) as Household[];
  return (
    <>
      <PageHeader
        title={t('nav.household', 'Household')}
        description={t(
          'household.text',
          'Share profiles and budgets with the people you live with.',
        )}
      />
      <div className="flex flex-col gap-4">
        {households.length === 0 && !list.isLoading && (
          <EmptyState title={t('household.none', 'You are not in a household yet')}>
            {t(
              'household.noneText',
              'Create one and invite members, or accept an invitation token you received.',
            )}
          </EmptyState>
        )}
        {households.map((h) => (
          <HouseholdCard key={h.id} h={h} myUserId={user?.id} />
        ))}
        <ErrorBox error={list.error} />
        <SharedProfile households={households} />
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={t('household.create', 'New household')}>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <Field label={t('household.name', 'Name')} className="flex-1">
                <Input
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Button type="submit" busy={create.isPending}>
                {t('common.add', 'Add')}
              </Button>
            </form>
            <ErrorBox error={create.error} />
          </Card>
          <Card title={t('household.accept', 'Accept an invitation')}>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                accept.mutate();
              }}
            >
              <Field label={t('household.tokenLabel', 'Invitation token')} className="flex-1">
                <Input
                  required
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
              <Button type="submit" busy={accept.isPending}>
                {t('household.join', 'Join')}
              </Button>
            </form>
            <ErrorBox error={accept.error} />
          </Card>
        </div>
      </div>
    </>
  );
}
