// Import settings kept in the profile settings (same in local and connected mode):
// - import.templates: user mapping templates (importer-sdk template JSON, Feature 111/117)
// - import.checks: statement balance check per committed batch (feed for the coverage calendar)
// Connected mode (not e2ee) also keeps each template in the server store (/import-templates, used
// by server imports and MCP) and offers the server's templates, community ones included.
import type { ImportTemplateInput } from '@finplat/importer-sdk';
import { useQuery } from '@tanstack/react-query';
import { qk, useLedgerEnv, useWrite } from '../transactions/data.ts';

import type { BalanceStatus } from './checks.ts';

export type { BalanceStatus };

/** A /import-templates row; `definition` is the importer-sdk template JSON. */
interface ServerTemplate {
  id: string;
  profileId: string | null;
  version: number;
  isCommunity: boolean;
  definition: ImportTemplateInput;
}

type Env = ReturnType<typeof useLedgerEnv>;
const serverStore = (env: Env) =>
  env.mode === 'remote' && env.api && env.profile.privacyMode !== 'e2ee' ? env.api : null;

async function listServerTemplates(env: Env): Promise<ServerTemplate[]> {
  const api = serverStore(env);
  if (!api) return [];
  try {
    const r = await api.request<{ items: ServerTemplate[] }>(
      'GET',
      '/api/v1/import-templates?limit=500',
      undefined,
      { 'X-Profile-ID': env.profileId },
    );
    return r.items.filter((x) => x.definition && typeof x.definition.id === 'string');
  } catch {
    return []; // offline: the synced setting still has this profile's own templates
  }
}

export function useImportSettings() {
  const env = useLedgerEnv();
  const { ops, profileId } = env;
  return useQuery({
    queryKey: qk(profileId, 'settings', 'import'),
    queryFn: async () => {
      const s = await ops.getSettings();
      const own = (
        Array.isArray(s['import.templates']) ? s['import.templates'] : []
      ) as ImportTemplateInput[];
      const server = await listServerTemplates(env);
      const ids = new Set(own.map((t) => t.id));
      return {
        templates: [
          ...own,
          ...server.filter((x) => !ids.has(x.definition.id)).map((x) => x.definition),
        ],
        /** template id -> read-only server-wide (community) template */
        community: new Set(server.filter((x) => x.profileId === null).map((x) => x.definition.id)),
        checks: (s['import.checks'] && typeof s['import.checks'] === 'object'
          ? s['import.checks']
          : {}) as Record<string, BalanceStatus>,
      };
    },
  });
}

const ownServerRow = async (env: Env, id: string) =>
  (await listServerTemplates(env)).find((x) => x.profileId !== null && x.definition.id === id);

/** Replace (by id) or add a template. */
export function useSaveTemplate() {
  const env = useLedgerEnv();
  return useWrite(async (ops, t: ImportTemplateInput) => {
    const s = await ops.getSettings();
    const list = (
      Array.isArray(s['import.templates']) ? s['import.templates'] : []
    ) as ImportTemplateInput[];
    await ops.setSetting('import.templates', [...list.filter((x) => x.id !== t.id), t]);
    const api = serverStore(env);
    if (!api) return;
    const body = {
      importerId: `template-${t.format}`,
      name: t.name,
      bankName: t.bank?.name ?? '',
      format: t.format,
      definition: t,
    };
    const hdr = { 'X-Profile-ID': env.profileId };
    const row = await ownServerRow(env, t.id);
    if (row)
      await api.request(
        'PATCH',
        `/api/v1/import-templates/${row.id}`,
        { ...body, version: row.version },
        hdr,
      );
    else await api.request('POST', '/api/v1/import-templates', body, hdr);
  });
}

export function useDeleteTemplate() {
  const env = useLedgerEnv();
  return useWrite(async (ops, id: string) => {
    const s = await ops.getSettings();
    const list = (
      Array.isArray(s['import.templates']) ? s['import.templates'] : []
    ) as ImportTemplateInput[];
    await ops.setSetting(
      'import.templates',
      list.filter((x) => x.id !== id),
    );
    const row = serverStore(env) && (await ownServerRow(env, id));
    if (row)
      await serverStore(env)?.request('DELETE', `/api/v1/import-templates/${row.id}`, undefined, {
        'X-Profile-ID': env.profileId,
      });
  });
}

export function useRecordCheck() {
  return useWrite(async (ops, v: { batchId: string; status: BalanceStatus }) => {
    const s = await ops.getSettings();
    const checks = (
      s['import.checks'] && typeof s['import.checks'] === 'object' ? s['import.checks'] : {}
    ) as Record<string, BalanceStatus>;
    await ops.setSetting('import.checks', { ...checks, [v.batchId]: v.status });
  });
}
