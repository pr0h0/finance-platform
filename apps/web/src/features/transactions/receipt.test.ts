import { expect, test } from 'bun:test';
import { extractReceipt } from './receipt.ts';

const L = (...t: string[]) => t.map((text) => ({ text, confidence: 0.9 }));

test('labelled total, local date and merchant', () => {
  const g = extractReceipt(
    L(
      'KONZUM d.o.o.',
      'Sarajevo',
      'Mlijeko 1,99',
      'Kruh 2.50',
      'Podzbir 4,49',
      'UKUPNO KM 1.234,56',
      '21.10.2026 14:03',
    ),
  );
  expect(g.total?.value).toBe('1234.56');
  expect(g.total?.confidence).toBe(0.9);
  expect(g.date?.value).toBe('2026-10-21');
  expect(g.merchant?.value).toBe('KONZUM d.o.o.');
});

test('no label: largest amount at half confidence; invalid dates ignored', () => {
  const g = extractReceipt(L('Shop', '31.02.2026', 'A 3.10', 'B 12.00', '2026-03-04'));
  expect(g.total).toEqual({ value: '12.00', confidence: 0.45, line: 'B 12.00' });
  expect(g.date?.value).toBe('2026-03-04');
});

test('nothing recognisable', () => {
  expect(extractReceipt(L('', '   '))).toEqual({ total: null, date: null, merchant: null });
});
