// Transaction export (Feature 15): CSV, JSON (full API shape, lossless) and XLSX.
// Amounts stay decimal strings in every format, so nothing is rounded through floats.
import type * as D from '@finplat/domain';
import type { Refs } from './data.ts';
import { EXPORT_COLUMNS, exportRows, toCsv } from './model.ts';
import { download, today } from './ui.tsx';

export async function exportTransactions(
  format: 'csv' | 'json' | 'xlsx',
  rows: D.Transaction[],
  refs: Refs,
) {
  const name = `transactions-${today()}`;
  if (format === 'json') {
    download(
      `${name}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), transactions: rows }, null, 2),
      'application/json',
    );
    return;
  }
  const table = exportRows(rows, {
    account: refs.accountName,
    category: refs.categoryLabel,
    merchant: refs.merchantName,
    tag: refs.tagName,
  });
  if (format === 'csv') {
    download(`${name}.csv`, `﻿${toCsv(EXPORT_COLUMNS, table)}`, 'text/csv;charset=utf-8');
    return;
  }
  const XLSX = await import('xlsx'); // loaded on demand (large)
  // Amount column as text keeps every decimal exactly as stored.
  const ws = XLSX.utils.aoa_to_sheet([[...EXPORT_COLUMNS], ...table]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  download(
    `${name}.xlsx`,
    out,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}
