// Import coverage calendar (Feature 127): per account, months covered by committed statements.
// complete = statement balances verified, unverified = covered but not checkable,
// conflicting = balance mismatch, missing = no statement.
import {
  type CoverageSource,
  computeCoverage,
  monthlyCoverage,
  type PeriodStatus,
} from '@finplat/importer-sdk';
import { useMemo } from 'react';
import { useT } from '../../lib/i18n.ts';
import { type Refs, useImportBatches } from '../transactions/data.ts';
import { Empty, today } from '../transactions/ui.tsx';
import { useImportSettings } from './store.ts';

const TONE: Record<PeriodStatus, string> = {
  complete: 'bg-pos/70',
  unverified: 'bg-accent/40',
  partial: 'bg-warn/40',
  conflicting: 'bg-neg/70',
  missing: 'bg-surface-2',
};
const LABEL: Record<PeriodStatus, string> = {
  complete: 'complete (balance verified)',
  unverified: 'covered, not verifiable',
  partial: 'partly covered',
  conflicting: 'balance mismatch',
  missing: 'missing',
};

export function Coverage({ refs }: { refs: Refs }) {
  const t = useT();
  const batches = useImportBatches();
  const settings = useImportSettings();
  const perAccount = useMemo(() => {
    const out: { accountId: string; months: ReturnType<typeof monthlyCoverage> }[] = [];
    const committed = (batches.data ?? []).filter(
      (b) => b.status === 'committed' && b.accountId && b.coverageStart && b.coverageEnd,
    );
    for (const accountId of new Set(committed.map((b) => b.accountId as string))) {
      const src: CoverageSource[] = committed
        .filter((b) => b.accountId === accountId)
        .map((b) => ({
          start: b.coverageStart as string,
          end: b.coverageEnd as string,
          balance: settings.data?.checks[b.id] ?? 'unverifiable',
          label: b.fileName,
        }));
      const start = `${src
        .map((s) => s.start)
        .sort()[0]
        ?.slice(0, 7)}-01`;
      out.push({ accountId, months: monthlyCoverage(computeCoverage(src, start, today())) });
    }
    return out;
  }, [batches.data, settings.data]);

  if (!perAccount.length)
    return (
      <Empty title={t('import.coverage.noCoverageYet', 'No coverage yet')}>
        {t(
          'import.coverage.commitStatementImportsTo',
          'Commit statement imports to see which months are covered per account.',
        )}
      </Empty>
    );
  return (
    <div className="flex flex-col gap-6">
      <ul
        className="flex flex-wrap gap-3 text-xs"
        aria-label={t('import.coverage.legend', 'Legend')}
      >
        {(Object.keys(LABEL) as PeriodStatus[]).map((s) => (
          <li key={s} className="flex items-center gap-1">
            <span
              aria-hidden
              className={`inline-block size-3 rounded-sm border border-line ${TONE[s]}`}
            />{' '}
            {LABEL[s]}
          </li>
        ))}
      </ul>
      {perAccount.map(({ accountId, months }) => {
        const years = [...new Set(months.map((m) => m.month.slice(0, 4)))];
        const gaps = months.filter((m) => m.status === 'missing' || m.status === 'partial').length;
        return (
          <section
            key={accountId}
            aria-label={t('import.coverage.coverageOf', 'Coverage of {{v0}}', {
              v0: refs.accountName(accountId),
            })}
          >
            <h3 className="mb-2 text-sm font-semibold">
              {refs.accountName(accountId)}{' '}
              <span className="font-normal text-muted">
                ·{' '}
                {gaps
                  ? t('import.coverage.monthsWithGaps', '{{n}} months with gaps', { n: gaps })
                  : t('import.coverage.noGaps', 'no gaps')}
              </span>
            </h3>
            <div className="overflow-x-auto">
              <table className="text-xs">
                <thead>
                  <tr>
                    <th className="sr-only">{t('import.coverage.year', 'Year')}</th>
                    {['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].map((m, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: month letters repeat
                      <th key={i} className="w-7 font-normal text-muted">
                        {m}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {years.map((y) => (
                    <tr key={y}>
                      <th scope="row" className="pr-2 text-left font-normal tabular-nums">
                        {y}
                      </th>
                      {Array.from({ length: 12 }, (_, i) => {
                        const key = `${y}-${String(i + 1).padStart(2, '0')}`;
                        const m = months.find((x) => x.month === key);
                        return (
                          <td key={key} className="p-0.5">
                            {m ? (
                              <span
                                className={`block size-6 rounded-sm border border-line ${TONE[m.status]}`}
                                title={t(
                                  'import.coverage.ofDays',
                                  '{{key}}: {{v1}} ({{v2}} of {{v3}} days)',
                                  {
                                    key: key,
                                    v1: LABEL[m.status],
                                    v2: m.days.complete + m.days.unverified,
                                    v3: Object.values(m.days).reduce((a, b) => a + b, 0),
                                  },
                                )}
                                role="img"
                                aria-label={`${key}: ${LABEL[m.status]}`}
                              />
                            ) : (
                              <span className="block size-6" />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
