// Chart data helpers (pure). Money stays exact in `money` fields; `value` numbers exist only for
// plotting positions and must never be summed or displayed as amounts.
import { fromMinor, type Money, toMinor } from '@finplat/finance-engine';

export const CHARTS_PACKAGE = '@finplat/charts';

/** Plot coordinate for a money amount (display only, may lose precision beyond 2^53). */
export const plotValue = (m: Money): number => Number(m.amount);

export interface Slice {
  key: string;
  label: string;
  money: Money;
  value: number;
}

/** Top `n` rows by amount plus one exact "Other" slice for the rest (non-positive rows dropped). */
export function topSlices(
  rows: readonly { key: string; label: string; amount: Money }[],
  n: number,
  otherLabel = 'Other',
): Slice[] {
  const pos = rows
    .filter((r) => toMinor(r.amount) > 0n)
    .sort((a, b) => {
      const d = toMinor(b.amount) - toMinor(a.amount);
      return d !== 0n ? (d > 0n ? 1 : -1) : a.key.localeCompare(b.key);
    });
  const head = pos
    .slice(0, n)
    .map((r) => ({ key: r.key, label: r.label, money: r.amount, value: plotValue(r.amount) }));
  const rest = pos.slice(n);
  if (rest.length === 0) return head;
  const cur = (rest[0] as (typeof rest)[number]).amount.currency;
  const money = fromMinor(
    rest.reduce((s, r) => s + toMinor(r.amount), 0n),
    cur,
  );
  return [...head, { key: '__other__', label: otherLabel, money, value: plotValue(money) }];
}

/** Rows of `{x, [series]: number}` plus the exact money per series for tooltips. */
export function toSeries<T extends Record<string, unknown>>(
  items: readonly T[],
  x: keyof T & string,
  series: readonly (keyof T & string)[],
): { x: string; values: Record<string, number>; money: Record<string, Money> }[] {
  return items.map((it) => {
    const values: Record<string, number> = {};
    const money: Record<string, Money> = {};
    for (const s of series) {
      const m = it[s] as Money;
      values[s] = plotValue(m);
      money[s] = m;
    }
    return { x: String(it[x]), values, money };
  });
}

/** "Nice" axis ticks (1, 2, 5 x 10^k steps) covering [min, max]; display only. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(Number.isFinite(min) && Number.isFinite(max))) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((f) => f * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step / 2; v += step)
    out.push(Number(v.toPrecision(12)));
  if ((out[out.length - 1] ?? 0) < max)
    out.push(Number(((out[out.length - 1] ?? 0) + step).toPrecision(12)));
  return out;
}
