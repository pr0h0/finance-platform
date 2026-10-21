import { expect, test } from 'bun:test';
import {
  convertMoney,
  createRateBook,
  currencyExposure,
  formatMoney,
  reportingConverter,
} from './index.ts';

test('formats decimal strings without float drift', () => {
  expect(formatMoney({ amount: '1234.50', currency: 'EUR' }, 'en')).toBe('€1,234.50');
  expect(formatMoney({ amount: '9007199254740993.01', currency: 'USD' }, 'en')).toBe(
    '$9,007,199,254,740,993.01',
  );
});

const book = createRateBook([
  {
    baseCurrency: 'EUR',
    quoteCurrency: 'USD',
    rate: '1.08',
    rateDate: '2026-10-01',
    source: 'provider',
  },
]);

test('converter: fixed parity, cross rate, manual bank rate override, missing rate', () => {
  expect(convertMoney(book, { amount: '100.00', currency: 'EUR' }, 'BAM', '2026-10-22')).toEqual({
    from: { amount: '100.00', currency: 'EUR' },
    to: { amount: '195.58', currency: 'BAM' },
    rate: '1.95583',
    rateDate: '2026-10-22',
    source: 'fixed',
    inverse: false,
  });
  expect(
    convertMoney(book, { amount: '100.00', currency: 'BAM' }, 'USD', '2026-10-22')?.to,
  ).toEqual({
    amount: '55.22',
    currency: 'USD',
  });
  const bank = convertMoney(book, { amount: '100.00', currency: 'USD' }, 'BAM', '2026-10-22', {
    rate: '1.7901',
  });
  expect(bank?.to).toEqual({ amount: '179.01', currency: 'BAM' });
  expect(bank?.source).toBe('manual');
  expect(convertMoney(book, { amount: '1.00', currency: 'GBP' }, 'BAM', '2026-10-22')).toBeNull();
});

test('currency exposure shares', () => {
  const r = currencyExposure(
    [
      { amount: '1000.00', currency: 'BAM' },
      { amount: '511.29', currency: 'EUR' },
      { amount: '5.00', currency: 'GBP' },
    ],
    'BAM',
    reportingConverter(book, 'BAM'),
    '2026-10-22',
  );
  expect(r.total).toEqual({ amount: '2000.00', currency: 'BAM' });
  expect(r.rows.map((x) => [x.currency, x.share])).toEqual([
    ['BAM', '0.5000'],
    ['EUR', '0.5000'],
  ]);
  expect(r.missing).toEqual(['GBP']);
});
