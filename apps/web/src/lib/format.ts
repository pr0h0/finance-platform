// Formatting hooks bound to the user's region preference. Money is never converted to a float.
import {
  formatDate,
  formatDateTime,
  formatDecimal,
  formatMoney,
  formatMonth,
  formatPercent,
  type MoneyLike,
  parseDecimalInput,
} from '@finplat/localization';
import { useMemo } from 'react';
import { useApp } from '../app/store.ts';

export function useFormat() {
  const region = useApp((s) => s.prefs.region);
  const dateStyle = useApp((s) => s.prefs.dateStyle);
  return useMemo(
    () => ({
      locale: region,
      money: (m: MoneyLike, o?: Parameters<typeof formatMoney>[2]) => formatMoney(m, region, o),
      decimal: (v: string, min = 0) => formatDecimal(v, region, min),
      percent: (f: string, digits = 1) => formatPercent(f, region, digits),
      date: (d: string) => formatDate(d, region, dateStyle),
      dateTime: (i: string, tz?: string) =>
        formatDateTime(i, region, tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
      month: (ym: string) => formatMonth(ym, region),
      parseDecimal: (s: string) => parseDecimalInput(s, region),
    }),
    [region, dateStyle],
  );
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Local calendar date YYYY-MM-DD (not UTC). */
export function todayIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function downloadBlob(
  data: Blob | Uint8Array | string,
  fileName: string,
  type = 'application/octet-stream',
) {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
