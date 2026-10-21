// Historical completeness per account (Feature 127).
import { checkStatementBalance } from './reconcile.ts';
import type { ImportResult } from './types.ts';

export type DayStatus = 'complete' | 'unverified' | 'conflicting' | 'missing';
export type PeriodStatus = DayStatus | 'partial';

export interface CoverageSource {
  start: string; // YYYY-MM-DD inclusive
  end: string;
  /** balanced → complete; mismatch → conflicting; unverifiable → unverified. */
  balance: 'balanced' | 'mismatch' | 'unverifiable';
  label?: string;
}

export interface CoverageSegment {
  start: string;
  end: string;
  status: DayStatus;
}

export interface MonthCoverage {
  month: string; // YYYY-MM
  status: PeriodStatus;
  days: Record<DayStatus, number>;
}

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const RANK: Record<DayStatus, number> = { missing: 0, unverified: 1, complete: 2, conflicting: 3 };

/** Coverage sources from one parse: each statement period, or the record date span if none. */
export function coverageSources(result: ImportResult): CoverageSource[] {
  const out: CoverageSource[] = [];
  for (const s of result.statements) {
    const rs = result.records.filter((r) => !s.ref || r.statementRef === s.ref);
    const dates = rs.map((r) => r.postingDate).sort();
    const start = s.periodStart ?? dates[0];
    const end = s.periodEnd ?? dates[dates.length - 1];
    if (!start || !end) continue;
    const b = checkStatementBalance(s, rs);
    out.push({ start, end, balance: b.status, label: s.ref });
  }
  if (out.length === 0 && result.records.length > 0) {
    const dates = result.records.map((r) => r.postingDate).sort();
    out.push({
      start: dates[0] as string,
      end: dates[dates.length - 1] as string,
      balance: 'unverifiable',
    });
  }
  return out;
}

/** Day-level status merged into contiguous segments over [from, to]. */
export function computeCoverage(
  sources: readonly CoverageSource[],
  from: string,
  to: string,
): CoverageSegment[] {
  const a = toMs(from);
  const b = toMs(to);
  const n = Math.floor((b - a) / DAY) + 1;
  if (!(n > 0)) return [];
  const days = new Array<DayStatus>(n).fill('missing');
  for (const s of sources) {
    const st: DayStatus =
      s.balance === 'balanced'
        ? 'complete'
        : s.balance === 'mismatch'
          ? 'conflicting'
          : 'unverified';
    const i0 = Math.max(0, Math.round((toMs(s.start) - a) / DAY));
    const i1 = Math.min(n - 1, Math.round((toMs(s.end) - a) / DAY));
    for (let i = i0; i <= i1; i++) if (RANK[st] > RANK[days[i] as DayStatus]) days[i] = st;
  }
  const segs: CoverageSegment[] = [];
  days.forEach((st, i) => {
    const day = toDay(a + i * DAY);
    const last = segs[segs.length - 1];
    if (last && last.status === st) last.end = day;
    else segs.push({ start: day, end: day, status: st });
  });
  return segs;
}

/** Month roll-up: one status everywhere → that status; any conflict → conflicting; mixed → partial. */
export function monthlyCoverage(segments: readonly CoverageSegment[]): MonthCoverage[] {
  const months = new Map<string, Record<DayStatus, number>>();
  for (const s of segments) {
    for (let t = toMs(s.start); t <= toMs(s.end); t += DAY) {
      const m = toDay(t).slice(0, 7);
      const c = months.get(m) ?? { complete: 0, unverified: 0, conflicting: 0, missing: 0 };
      c[s.status]++;
      months.set(m, c);
    }
  }
  return [...months.entries()].map(([month, days]) => {
    const present = (Object.keys(days) as DayStatus[]).filter((k) => days[k] > 0);
    const status: PeriodStatus =
      days.conflicting > 0
        ? 'conflicting'
        : present.length === 1
          ? (present[0] as DayStatus)
          : 'partial';
    return { month, status, days };
  });
}
