import { expect, test } from 'bun:test';
import { loadConformance } from './index.ts';

test('conformance fixtures are valid non-empty JSON arrays', () => {
  for (const n of ['scales', 'money_parse', 'rounding', 'fx', 'allocation', 'splits', 'balance']) {
    const data = loadConformance<unknown[]>(n);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  }
});
