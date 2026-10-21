import { expect, test } from 'bun:test';
import { formatMoney } from './index.ts';

test('formats decimal strings without float drift', () => {
  expect(formatMoney({ amount: '1234.50', currency: 'EUR' }, 'en')).toBe('€1,234.50');
  expect(formatMoney({ amount: '9007199254740993.01', currency: 'USD' }, 'en')).toBe(
    '$9,007,199,254,740,993.01',
  );
});
