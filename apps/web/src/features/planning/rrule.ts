// Recurrence editor model <-> RFC 5545 RRULE (the subset the engine supports).
import { parseRRule } from '@finplat/finance-engine';

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

export interface RecurrenceForm {
  freq: 'none' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay: string[]; // weekly: MO..SU
  byMonthDay: number | null; // monthly: 1..31 or -1 (last day)
}

export const emptyRecurrence = (): RecurrenceForm => ({
  freq: 'none',
  interval: 1,
  byDay: [],
  byMonthDay: null,
});

export function buildRRule(f: RecurrenceForm): string | null {
  if (f.freq === 'none') return null;
  const parts = [`FREQ=${f.freq}`];
  if (f.interval > 1) parts.push(`INTERVAL=${Math.floor(f.interval)}`);
  if (f.freq === 'WEEKLY' && f.byDay.length)
    parts.push(`BYDAY=${WEEKDAYS.filter((d) => f.byDay.includes(d)).join(',')}`);
  if (f.freq === 'MONTHLY' && f.byMonthDay) parts.push(`BYMONTHDAY=${f.byMonthDay}`);
  const s = parts.join(';');
  parseRRule(s); // throws on anything the engine would reject
  return s;
}

/** Best-effort form for an existing rule; `custom` keeps rules the form cannot represent. */
export function parseRecurrence(
  rrule: string | null | undefined,
): RecurrenceForm & { custom?: string } {
  if (!rrule) return emptyRecurrence();
  const r = parseRRule(rrule);
  const f: RecurrenceForm = {
    freq: r.freq,
    interval: r.interval,
    byDay: r.byDay.filter((d) => d.ordinal === null).map((d) => WEEKDAYS[d.weekday - 1] as string),
    byMonthDay: r.byMonthDay[0] ?? null,
  };
  const rebuilt = buildRRule(f);
  return rebuilt === rrule.replace(/^RRULE:/, '') ? f : { ...f, custom: rrule };
}

export function describeRRule(rrule: string): string {
  const r = parseRRule(rrule);
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  let s = r.interval > 1 ? `Every ${r.interval} ${unit}s` : `Every ${unit}`;
  if (r.byDay.length)
    s += ` on ${r.byDay.map((d) => `${d.ordinal ? `${d.ordinal}. ` : ''}${WEEKDAYS[d.weekday - 1]}`).join(', ')}`;
  if (r.byMonthDay.length)
    s += ` on day ${r.byMonthDay.map((d) => (d === -1 ? 'last' : d)).join(', ')}`;
  if (r.count) s += `, ${r.count} times`;
  if (r.until) s += ` until ${r.until}`;
  return s;
}
