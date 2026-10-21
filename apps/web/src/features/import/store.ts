// Import settings kept in the profile settings (same in local and connected mode):
// - import.templates: user mapping templates (importer-sdk template JSON, Feature 111/117)
// - import.checks: statement balance check per committed batch (feed for the coverage calendar)
import type { ImportTemplateInput } from '@finplat/importer-sdk';
import { useQuery } from '@tanstack/react-query';
import { qk, useLedgerEnv, useWrite } from '../transactions/data.ts';

import type { BalanceStatus } from './checks.ts';

export type { BalanceStatus };

export function useImportSettings() {
  const { ops, profileId } = useLedgerEnv();
  return useQuery({
    queryKey: qk(profileId, 'settings', 'import'),
    queryFn: async () => {
      const s = await ops.getSettings();
      return {
        templates: (Array.isArray(s['import.templates'])
          ? s['import.templates']
          : []) as ImportTemplateInput[],
        checks: (s['import.checks'] && typeof s['import.checks'] === 'object'
          ? s['import.checks']
          : {}) as Record<string, BalanceStatus>,
      };
    },
  });
}

/** Replace (by id) or add a template. */
export function useSaveTemplate() {
  return useWrite(async (ops, t: ImportTemplateInput) => {
    const s = await ops.getSettings();
    const list = (
      Array.isArray(s['import.templates']) ? s['import.templates'] : []
    ) as ImportTemplateInput[];
    await ops.setSetting('import.templates', [...list.filter((x) => x.id !== t.id), t]);
  });
}

export function useDeleteTemplate() {
  return useWrite(async (ops, id: string) => {
    const s = await ops.getSettings();
    const list = (
      Array.isArray(s['import.templates']) ? s['import.templates'] : []
    ) as ImportTemplateInput[];
    await ops.setSetting(
      'import.templates',
      list.filter((x) => x.id !== id),
    );
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
