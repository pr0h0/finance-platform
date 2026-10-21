import { describe, expect, test } from 'bun:test';
import { loadConformance } from '@finplat/test-fixtures';
import {
  allocate,
  balances,
  convert,
  convertInverse,
  currencyScale,
  type Money,
  money,
  type RoundingMode,
  roundDecimal,
  splitsBalance,
} from './index.ts';

describe('conformance (shared with Go)', () => {
  test('scales', () => {
    for (const c of loadConformance<{ currency: string; scale: number | null }[]>('scales')) {
      expect(currencyScale(c.currency) ?? null).toBe(c.scale);
    }
  });
  test('money_parse', () => {
    for (const c of loadConformance<
      { amount: string; currency: string; expected?: string; error?: boolean }[]
    >('money_parse')) {
      if (c.error) expect(() => money(c.amount, c.currency)).toThrow();
      else expect(money(c.amount, c.currency).amount).toBe(c.expected ?? '');
    }
  });
  test('rounding', () => {
    for (const c of loadConformance<
      { value: string; scale: number; mode: RoundingMode; expected: string }[]
    >('rounding')) {
      expect([c.value, c.mode, roundDecimal(c.value, c.scale, c.mode)]).toEqual([
        c.value,
        c.mode,
        c.expected,
      ]);
    }
  });
  test('fx', () => {
    for (const c of loadConformance<
      {
        amount: string;
        from: string;
        to: string;
        rate: string;
        inverse: boolean;
        mode: RoundingMode;
        expected: string;
      }[]
    >('fx')) {
      const m = money(c.amount, c.from);
      const r = c.inverse
        ? convertInverse(m, c.to, c.rate, c.mode)
        : convert(m, c.to, c.rate, c.mode);
      expect(r).toEqual({ amount: c.expected, currency: c.to });
    }
  });
  test('allocation', () => {
    for (const c of loadConformance<
      { amount: string; currency: string; weights: string[]; expected: string[] }[]
    >('allocation')) {
      expect(allocate(money(c.amount, c.currency), c.weights).map((m) => m.amount)).toEqual(
        c.expected,
      );
    }
  });
  test('splits', () => {
    for (const c of loadConformance<{ total: Money; splits: Money[]; valid: boolean }[]>(
      'splits',
    )) {
      expect(splitsBalance(c.total, c.splits)).toBe(c.valid);
    }
  });
  test('balance', () => {
    for (const c of loadConformance<
      { postings: (Money & { accountId: string })[]; expected: unknown[] }[]
    >('balance')) {
      expect(balances(c.postings)).toEqual(c.expected as never);
    }
  });
});

test('allocate always sums to the total', () => {
  for (const total of ['0.01', '99.99', '-1234.57', '1000000.00']) {
    const parts = allocate(money(total, 'EUR'), ['1', '2', '3', '0.5']);
    const s = parts.reduce((a, p) => a + BigInt(p.amount.replace('.', '')), 0n);
    expect(s).toBe(BigInt(total.replace('.', '')));
  }
});
