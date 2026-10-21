// Recurrence expansion: an RFC 5545 RRULE subset over local calendar dates. The Go recurrence engine
// must implement the same rules; shared cases: packages/test-fixtures/conformance/recurrence.json.
//
// Supported parts: FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, COUNT, UNTIL (date part),
// BYDAY (WEEKLY: MO..SU; MONTHLY or YEARLY+BYMONTH: optional ordinal, e.g. 1MO, -1FR),
// BYMONTHDAY (1..31, -1..-31), BYMONTH (1..12), WKST=MO. Anything else is rejected.
//
// Rules (deliberate deviations from RFC 5545 are marked *):
// - Occurrences are rule dates >= startDate; startDate itself only when it matches the rule.
// - * A month day past the month's end clamps to the last day (Jan 31 monthly -> Feb 28/29, Mar 31);
//   always computed from the anchor, never from the previous occurrence. Clamped duplicates collapse.
// - Negative BYMONTHDAY counts from the end (-1 = last day); out of range -> skipped.
// - An ordinal BYDAY that does not exist in a month (5MO) is skipped (RFC behaviour).
// - BYMONTHDAY and BYDAY together intersect (RFC). DAILY treats BYDAY/BYMONTHDAY/BYMONTH as filters.
// - COUNT / occurrenceCount and UNTIL / endDate both apply (the stricter wins) to nominal dates.
// - Business-day adjustment moves Saturday/Sunday to Friday ("previous") or Monday ("next") AFTER
//   expansion; the nominal date stays the occurrence identity, `dueDate` is the adjusted date.
//   No holiday calendar.
// - Timezone and DST never matter: everything is a calendar date.
import {
  addDays,
  clampedDate,
  daysInMonth,
  formatDate,
  isoWeekday,
  parseDate,
  toEpochDay,
} from './dates.ts';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export interface ByDay {
  weekday: number; // 1 = MO … 7 = SU
  ordinal: number | null;
}

export interface RRule {
  freq: Freq;
  interval: number;
  count: number | null;
  until: string | null;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
}

export interface RecurrenceSpec {
  rrule: string;
  startDate: string;
  endDate?: string | null;
  occurrenceCount?: number | null;
  businessDayAdjustment?: 'none' | 'previous' | 'next';
}

export interface Occurrence {
  date: string; // nominal rule date (occurrence identity)
  dueDate: string; // after business-day adjustment
}

function intList(v: string, min: number, max: number, part: string): number[] {
  return v.split(',').map((x) => {
    if (!/^[+-]?\d+$/.test(x)) throw new Error(`rrule: invalid ${part} value ${x}`);
    const n = Number(x);
    if (n === 0 || Math.abs(n) < min || Math.abs(n) > max)
      throw new Error(`rrule: ${part} out of range: ${x}`);
    return n;
  });
}

export function parseRRule(input: string): RRule {
  const s = input.trim().replace(/^RRULE:/i, '');
  const r: RRule = {
    freq: 'MONTHLY',
    interval: 1,
    count: null,
    until: null,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
  };
  let freq: Freq | null = null;
  for (const part of s.split(';').filter(Boolean)) {
    const [k, v] = part.split('=') as [string, string | undefined];
    if (!v) throw new Error(`rrule: malformed part ${part}`);
    switch (k.toUpperCase()) {
      case 'FREQ':
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(v.toUpperCase()))
          throw new Error(`rrule: unsupported FREQ ${v}`);
        freq = v.toUpperCase() as Freq;
        break;
      case 'INTERVAL':
        r.interval = intList(v, 1, 10_000, 'INTERVAL')[0] ?? 1;
        if (r.interval < 1) throw new Error('rrule: INTERVAL must be positive');
        break;
      case 'COUNT':
        r.count = intList(v, 1, 100_000, 'COUNT')[0] ?? null;
        if ((r.count ?? 0) < 1) throw new Error('rrule: COUNT must be positive');
        break;
      case 'UNTIL': {
        const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(v);
        if (!m) throw new Error(`rrule: invalid UNTIL ${v}`);
        r.until = `${m[1]}-${m[2]}-${m[3]}`;
        parseDate(r.until);
        break;
      }
      case 'BYDAY':
        r.byDay = v.split(',').map((x) => {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(x);
          if (!m) throw new Error(`rrule: invalid BYDAY ${x}`);
          const ordinal = m[1] ? Number(m[1]) : null;
          if (ordinal !== null && (ordinal === 0 || Math.abs(ordinal) > 5))
            throw new Error(`rrule: BYDAY ordinal out of range: ${x}`);
          return { weekday: WEEKDAYS.indexOf((m[2] ?? '').toUpperCase()) + 1, ordinal };
        });
        break;
      case 'BYMONTHDAY':
        r.byMonthDay = intList(v, 1, 31, 'BYMONTHDAY');
        break;
      case 'BYMONTH':
        r.byMonth = intList(v, 1, 12, 'BYMONTH');
        if (r.byMonth.some((n) => n < 0)) throw new Error('rrule: BYMONTH must be positive');
        break;
      case 'WKST':
        if (v.toUpperCase() !== 'MO') throw new Error('rrule: only WKST=MO is supported');
        break;
      default:
        throw new Error(`rrule: unsupported part ${k}`);
    }
  }
  if (!freq) throw new Error('rrule: FREQ is required');
  r.freq = freq;
  const ordinals = r.byDay.some((b) => b.ordinal !== null);
  if (ordinals && (freq === 'DAILY' || freq === 'WEEKLY'))
    throw new Error('rrule: BYDAY ordinals need FREQ=MONTHLY or YEARLY');
  if (freq === 'YEARLY' && r.byDay.length > 0 && r.byMonth.length === 0)
    throw new Error('rrule: YEARLY BYDAY requires BYMONTH');
  if (freq === 'WEEKLY' && r.byMonthDay.length > 0)
    throw new Error('rrule: BYMONTHDAY is not valid with FREQ=WEEKLY');
  return r;
}

/** Candidate dates of one month (sorted, unique). defaultDay = the anchor day when no BY* rule. */
function monthCandidates(r: RRule, y: number, m: number, defaultDay: number): string[] {
  const dim = daysInMonth(y, m);
  let days: number[];
  if (r.byDay.length > 0) {
    const firstWd = isoWeekday(formatDate(y, m, 1));
    const set = new Set<number>();
    for (const b of r.byDay) {
      const first = 1 + ((b.weekday - firstWd + 7) % 7);
      const all: number[] = [];
      for (let d = first; d <= dim; d += 7) all.push(d);
      if (b.ordinal === null) for (const d of all) set.add(d);
      else {
        const d = b.ordinal > 0 ? all[b.ordinal - 1] : all[all.length + b.ordinal];
        if (d !== undefined) set.add(d);
      }
    }
    days = [...set];
    if (r.byMonthDay.length > 0) {
      const md = new Set(monthDays(r.byMonthDay, dim));
      days = days.filter((d) => md.has(d));
    }
  } else if (r.byMonthDay.length > 0) {
    days = monthDays(r.byMonthDay, dim);
  } else {
    days = [Math.min(defaultDay, dim)];
  }
  return [...new Set(days)].sort((a, b) => a - b).map((d) => formatDate(y, m, d));
}

function monthDays(byMonthDay: number[], dim: number): number[] {
  const out: number[] = [];
  for (const n of byMonthDay) {
    if (n > 0) out.push(Math.min(n, dim));
    else if (dim + n + 1 >= 1) out.push(dim + n + 1);
  }
  return out;
}

function adjust(date: string, mode: RecurrenceSpec['businessDayAdjustment']): string {
  const wd = isoWeekday(date);
  if (wd < 6 || !mode || mode === 'none') return date;
  if (mode === 'previous') return addDays(date, wd === 6 ? -1 : -2);
  return addDays(date, wd === 6 ? 2 : 1);
}

/**
 * Expand a schedule. Returns occurrences whose adjusted `dueDate` lies in [from, to] (inclusive),
 * in order. COUNT is always counted from the schedule start, not from `from`.
 */
export function expandRecurrence(
  spec: RecurrenceSpec,
  from: string,
  to: string,
  limit = 100_000,
): Occurrence[] {
  const r = parseRRule(spec.rrule);
  const start = parseDate(spec.startDate);
  let end = spec.endDate ?? null;
  if (r.until && (!end || r.until < end)) end = r.until;
  const counts = [r.count, spec.occurrenceCount ?? null].filter((n): n is number => n !== null);
  const maxCount = counts.length ? Math.min(...counts) : Number.POSITIVE_INFINITY;
  const horizon = addDays(to, 3); // adjustment moves dates by at most 2 days
  const lower = addDays(from, -3);
  const out: Occurrence[] = [];
  let emitted = 0;

  const startDay = toEpochDay(spec.startDate);
  const weekStart = startDay - (isoWeekday(spec.startDate) - 1);
  for (let k = 0; ; k++) {
    let periodStart: string;
    let cands: string[];
    switch (r.freq) {
      case 'DAILY': {
        periodStart = addDays(spec.startDate, k * r.interval);
        const p = parseDate(periodStart);
        const wd = isoWeekday(periodStart);
        const ok =
          (r.byMonth.length === 0 || r.byMonth.includes(p.m)) &&
          (r.byDay.length === 0 || r.byDay.some((b) => b.weekday === wd)) &&
          (r.byMonthDay.length === 0 ||
            monthDays(r.byMonthDay, daysInMonth(p.y, p.m)).includes(p.d));
        cands = ok ? [periodStart] : [];
        break;
      }
      case 'WEEKLY': {
        const ws = weekStart + 7 * k * r.interval;
        periodStart = addDays(spec.startDate, ws - startDay);
        const wds = r.byDay.length ? r.byDay.map((b) => b.weekday) : [isoWeekday(spec.startDate)];
        cands = [...new Set(wds)]
          .sort((a, b) => a - b)
          .map((wd) => addDays(periodStart, wd - 1))
          .filter((d) => r.byMonth.length === 0 || r.byMonth.includes(parseDate(d).m));
        break;
      }
      case 'MONTHLY': {
        periodStart = clampedDate(start.y, start.m, 1, k * r.interval);
        const p = parseDate(periodStart);
        cands =
          r.byMonth.length === 0 || r.byMonth.includes(p.m)
            ? monthCandidates(r, p.y, p.m, start.d)
            : [];
        break;
      }
      case 'YEARLY': {
        const y = start.y + k * r.interval;
        periodStart = formatDate(y, 1, 1);
        const months = r.byMonth.length ? [...new Set(r.byMonth)].sort((a, b) => a - b) : [start.m];
        cands = months.flatMap((m) => monthCandidates(r, y, m, start.d));
        break;
      }
    }
    if (periodStart > horizon || (end && periodStart > end && periodStart > spec.startDate)) break;
    for (const date of cands) {
      if (date < spec.startDate) continue;
      if ((end && date > end) || date > horizon || emitted >= maxCount) return out;
      emitted++;
      if (date < lower) continue;
      const dueDate = adjust(date, spec.businessDayAdjustment);
      if (dueDate >= from && dueDate <= to) {
        out.push({ date, dueDate });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** First occurrence with dueDate >= `from`, searching up to `maxYears` ahead. */
export function nextOccurrence(
  spec: RecurrenceSpec,
  from: string,
  maxYears = 10,
): Occurrence | null {
  const p = parseDate(from);
  return expandRecurrence(spec, from, formatDate(p.y + maxYears, p.m, 1), 1)[0] ?? null;
}
