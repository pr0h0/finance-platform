import { expect, test } from 'bun:test';
import {
  bs,
  en,
  errorMessage,
  formatDate,
  formatDecimal,
  formatMoney,
  formatMonth,
  parseDecimalInput,
  resolveLanguage,
  t,
} from './index.ts';

test('translations: bs, plurals and interpolation', () => {
  expect(t('mode.local', 'bs-BA')).toBe('Samo lokalno');
  expect(t('mode.connect.description', 'bs').startsWith('Prijavite se')).toBe(true);
  expect(t('sync.pending', 'en', { count: 1 })).toBe('1 change waiting to upload');
  expect(t('sync.pending', 'en', { count: 3 })).toBe('3 changes waiting to upload');
  expect(t('sync.pending', 'bs', { count: 1 })).toBe('1 promjena čeka slanje');
  expect(t('sync.pending', 'bs', { count: 3 })).toBe('3 promjene čekaju slanje');
  expect(t('sync.pending', 'bs', { count: 5 })).toBe('5 promjena čeka slanje');
  expect(t('sync.pending', 'bs', { count: 21 })).toBe('21 promjena čeka slanje');
  expect(resolveLanguage('de-DE')).toBe('en');
  expect(errorMessage('conflict')).toContain('changed elsewhere');
  expect(errorMessage('conflict', 'bs')).toContain('promijenjen');
  expect(errorMessage('weird_code')).toBe('Something went wrong.');
});

test('bs has every en key, translated, with the same {{placeholders}} (no English fallback)', () => {
  const vars = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join();
  const same = new Set(['sync.status']); // "Status" is the Bosnian word too
  const b = bs as Record<string, string>;
  for (const [k, v] of Object.entries(en)) {
    expect(b[k], k).toBeString();
    expect(vars(b[k] as string), k).toBe(vars(v));
    if (!same.has(k)) expect(b[k], k).not.toBe(v);
  }
  for (const k of Object.keys(bs)) expect(k in en || k.endsWith('_few'), k).toBe(true);
});

// For values a double represents exactly, Intl's own output is the reference.
const ref = (n: number, currency: string, locale: string, o: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency, ...o }).format(n);

test('money formatting is exact and locale aware', () => {
  expect(formatMoney({ amount: '1234.56', currency: 'BAM' }, 'bs-BA')).toBe(
    ref(1234.56, 'BAM', 'bs-BA'),
  );
  expect(formatMoney({ amount: '1234.56', currency: 'BAM' }, 'bs-BA').replace(/\s/g, ' ')).toBe(
    '1.234,56 KM',
  );
  expect(formatMoney({ amount: '-0.05', currency: 'EUR' }, 'en-US')).toBe(
    ref(-0.05, 'EUR', 'en-US'),
  );
  expect(formatMoney({ amount: '-1234.50', currency: 'CHF' }, 'de-CH')).toBe(
    ref(-1234.5, 'CHF', 'de-CH'),
  );
  // beyond double precision: digits come from the string, not a float
  expect(formatMoney({ amount: '12345678901234567.89', currency: 'USD' }, 'en-US')).toBe(
    '$12,345,678,901,234,567.89',
  );
  expect(formatMoney({ amount: '100', currency: 'JPY' }, 'ja-JP')).toBe(ref(100, 'JPY', 'ja-JP'));
  expect(formatMoney({ amount: '1.250', currency: 'KWD' }, 'en', { display: 'code' })).toBe(
    ref(1.25, 'KWD', 'en', { currencyDisplay: 'code', minimumFractionDigits: 3 }),
  );
  expect(formatMoney({ amount: '-0.00', currency: 'EUR' }, 'en-US')).toBe('€0.00');
  expect(formatDecimal('1234.5678', 'de-DE')).toBe('1.234,5678');
  expect(formatDecimal('1234.56', 'bs-BA')).toBe('1.234,56');
  expect(formatMoney({ amount: '-0.50', currency: 'BAM' }, 'bs-BA').replace(/\s/g, ' ')).toBe(
    '-0,50 KM',
  );
});

test('dates never shift with the timezone', () => {
  expect(formatDate('2026-01-01', 'en-US')).toBe('Jan 1, 2026');
  expect(formatDate('2026-12-31', 'bs-BA', 'short')).toBe('31.12.2026');
  expect(formatDate('2026-03-05', 'bs', 'short')).toBe('05.03.2026');
  expect(formatMonth('2026-03', 'en-US')).toBe('Mar 2026');
});

test('parses localized number input', () => {
  expect(parseDecimalInput('1.234,56', 'bs-BA')).toBe('1234.56');
  expect(parseDecimalInput('1,234.56', 'en-US')).toBe('1234.56');
  expect(parseDecimalInput('-12', 'en')).toBe('-12');
  expect(parseDecimalInput('12abc', 'en')).toBeNull();
});

test('a misplaced group separator is a decimal point, never dropped (no silent 100x)', () => {
  expect(parseDecimalInput('12,50', 'en-US')).toBe('12.50');
  expect(parseDecimalInput('12.50', 'bs-BA')).toBe('12.50');
  expect(parseDecimalInput('12.50', 'hr-HR')).toBe('12.50');
  expect(parseDecimalInput('12,50', 'bs-BA')).toBe('12.50');
  expect(parseDecimalInput('1.234', 'bs-BA')).toBe('1234');
  expect(parseDecimalInput('1,234', 'en-US')).toBe('1234');
  expect(parseDecimalInput('1.234.567,8', 'bs-BA')).toBe('1234567.8');
  expect(parseDecimalInput('-1,5', 'en-US')).toBe('-1.5');
  expect(parseDecimalInput('1,234,56', 'en-US')).toBeNull();
  expect(parseDecimalInput('1.234,56', 'en-US')).toBeNull();
  expect(parseDecimalInput('12,', 'en-US')).toBeNull();
});
