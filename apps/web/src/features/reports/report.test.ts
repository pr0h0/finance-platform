import { expect, test } from 'bun:test';
import { translate } from '../../lib/i18n.ts';
import { seed } from '../analytics/fixture.test-util.ts';
import { buildReport, reportCsv, reportRange } from './report.ts';

const tr = (lang: string) => (k: string, en: string, v?: Record<string, string | number>) =>
  translate(lang, k, en, v);

test('reportRange', () => {
  expect(reportRange('monthly', '2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  expect(reportRange('quarterly', '2026-05-14')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
  expect(reportRange('annual', '2026-05-14')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  expect(reportRange('custom', '2026-01-03', '2026-02-01')).toEqual({
    from: '2026-01-03',
    to: '2026-02-01',
  });
});

test('monthly report totals come from real ledger data', async () => {
  const f = await seed();
  const r = buildReport(await f.snap(), '2026-03-01', '2026-03-31');
  expect(r.totals.income).toEqual({ amount: '2000.00', currency: 'BAM' });
  expect(r.totals.expense).toEqual({ amount: '200.00', currency: 'BAM' });
  expect(r.totals.net.amount).toBe('1800.00');
  expect(r.totals.savingsRate).toBe('0.9000');
  expect(r.categories.map((c) => [c.label, c.amount.amount])).toEqual([
    ['Food', '150.00'],
    ['Uncategorized', '50.00'],
  ]);
  // opening balance 1000 on 2026-01-01 -> net worth 1000 before, 2800 after
  expect(r.netWorth.start.netWorth.amount).toBe('1000.00');
  expect(r.netWorth.end.netWorth.amount).toBe('2800.00');
  expect(r.complete).toBe(true);
  expect(reportCsv(r, tr('en'))[1]).toEqual(['Income', '2000.00']);
  expect(reportCsv(r, tr('bs'))[1]).toEqual(['Prihod', '2000.00']);
});

test('report before recorded history is flagged incomplete', async () => {
  const f = await seed();
  const r = buildReport(await f.snap(), '2025-01-01', '2025-12-31');
  expect(r.complete).toBe(false);
  expect(r.warnings[0]?.vars?.date).toBe('2026-01-01');
  const bsCsv = reportCsv(r, tr('bs')).at(-1) ?? [];
  expect(String(bsCsv[1])).toContain('2026-01-01');
  expect(String(bsCsv[1])).not.toContain('Recorded history');
});
