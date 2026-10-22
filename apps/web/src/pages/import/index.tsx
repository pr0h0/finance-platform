// Import center (PLAN §23–25, Features 101, 110–130 UI).
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Adapters } from '../../features/import/Adapters.tsx';
import { Coverage } from '../../features/import/Coverage.tsx';
import { History } from '../../features/import/History.tsx';
import { ImportWizard, MANIFESTS } from '../../features/import/ImportWizard.tsx';
import { MappingEditor } from '../../features/import/MappingEditor.tsx';
import { useRefs } from '../../features/transactions/data.ts';
import { Badge, PageHeader, Tabs } from '../../features/transactions/ui.tsx';

const TABS = [
  { id: 'import', label: 'Import' },
  { id: 'history', label: 'History' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'mapping', label: 'Mapping editor' },
  { id: 'importers', label: 'Importers' },
  { id: 'adapters', label: 'Custom adapters' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function ImportPage() {
  const refs = useRefs();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'import') as Tab;
  const [reprocess, setReprocess] = useState<{ file: File; accountId?: string; n: number } | null>(
    null,
  );
  const setTab = (t: Tab) => {
    const p = new URLSearchParams(params);
    p.set('tab', t);
    setParams(p, { replace: true });
  };

  return (
    <div>
      <PageHeader title="Import center">
        Statements are parsed in your browser. Original records are kept unchanged; transactions can
        be rolled back per import.
      </PageHeader>
      <Tabs label="Import center" value={tab} onChange={setTab} tabs={TABS} />
      {tab === 'import' && !refs.loading && (
        <ImportWizard
          key={reprocess?.n ?? 0}
          refs={refs}
          initialFiles={reprocess ? [reprocess.file] : undefined}
          initialAccountId={reprocess?.accountId}
        />
      )}
      {tab === 'history' && (
        <History
          refs={refs}
          onReprocess={(file, b) => {
            setReprocess({ file, accountId: b.accountId ?? undefined, n: Date.now() });
            setTab('import');
          }}
        />
      )}
      {tab === 'coverage' && <Coverage refs={refs} />}
      {tab === 'mapping' && <MappingEditor />}
      {tab === 'adapters' && <Adapters />}
      {tab === 'importers' && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {MANIFESTS.map((m) => (
            <li key={m.id} className="px-3 py-2.5 text-sm">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {m.name} <span className="text-xs text-muted">{m.version}</span>
                {m.status === 'blocked_external' ? (
                  <Badge tone="amber">awaiting format</Badge>
                ) : m.status === 'beta' ? (
                  <Badge tone="blue">beta</Badge>
                ) : (
                  <Badge tone="green">stable</Badge>
                )}
                {m.requiresTemplate && <Badge>needs mapping template</Badge>}
              </p>
              <p className="text-xs text-muted">
                {m.formats.length ? m.formats.join(', ') : 'format not yet known'}
              </p>
              {m.limitations?.map((l) => (
                <p key={l} className="text-xs text-muted">
                  {l}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
