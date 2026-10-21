// Calendar-date helpers on "YYYY-MM-DD" strings. Dates are local calendar dates (invariant 17):
// never derived from instants, so timezones and DST cannot shift them. Internally a date is an
// epoch-day number (days since 1970-01-01), computed with Date.UTC which has no DST.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export interface Ymd {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

export function parseDate(s: string): Ymd {
  const r = DATE_RE.exec(s);
  if (!r) throw new Error(`invalid date: ${JSON.stringify(s)}`);
  const ymd = { y: Number(r[1]), m: Number(r[2]), d: Number(r[3]) };
  if (ymd.m < 1 || ymd.m > 12 || ymd.d < 1 || ymd.d > daysInMonth(ymd.y, ymd.m)) {
    throw new Error(`invalid date: ${s}`);
  }
  return ymd;
}

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

export function formatDate(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

export function toEpochDay(s: string): number {
  const { y, m, d } = parseDate(s);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export function fromEpochDay(n: number): string {
  const t = new Date(n * DAY_MS);
  return formatDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export const addDays = (s: string, n: number): string => fromEpochDay(toEpochDay(s) + n);
export const diffDays = (a: string, b: string): number => toEpochDay(a) - toEpochDay(b);

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(s: string): number {
  return ((((toEpochDay(s) + 3) % 7) + 7) % 7) + 1; // 1970-01-01 was a Thursday
}

/** Day `d` of the month `months` after (y, m), clamped to that month's last day. */
export function clampedDate(y: number, m: number, d: number, months = 0): string {
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return formatDate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Add calendar months keeping the day, clamped to month end (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(s: string, n: number): string {
  const { y, m, d } = parseDate(s);
  return clampedDate(y, m, d, n);
}

export const monthKey = (s: string): string => s.slice(0, 7);
export const startOfMonth = (s: string): string => `${s.slice(0, 7)}-01`;
export function endOfMonth(s: string): string {
  const { y, m } = parseDate(s);
  return formatDate(y, m, daysInMonth(y, m));
}

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Period label: day "2026-10-21", week = ISO Monday "2026-10-19", "2026-10", "2026-Q4", "2026". */
export function periodKey(s: string, g: Granularity): string {
  switch (g) {
    case 'day':
      return s;
    case 'week':
      return addDays(s, 1 - isoWeekday(s));
    case 'month':
      return s.slice(0, 7);
    case 'quarter':
      return `${s.slice(0, 4)}-Q${Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1}`;
    case 'year':
      return s.slice(0, 4);
  }
}

export const minDate = (a: string, b: string): string => (a < b ? a : b);
export const maxDate = (a: string, b: string): string => (a > b ? a : b);

/** Every date from `from` to `to` inclusive (empty when to < from). */
export function dateRange(from: string, to: string): string[] {
  const a = toEpochDay(from);
  const b = toEpochDay(to);
  const out: string[] = [];
  for (let n = a; n <= b; n++) out.push(fromEpochDay(n));
  return out;
}
