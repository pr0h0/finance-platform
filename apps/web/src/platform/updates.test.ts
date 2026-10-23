import { expect, test } from 'bun:test';
import { newer } from './updates.ts';

test('newer compares versions numerically', () => {
  expect(newer('0.2.0', '0.1.0')).toBe(true);
  expect(newer('1.10.0', '1.9.2')).toBe(true);
  expect(newer('v1.0.0', '1.0.0')).toBe(false);
  expect(newer('1.0.0', '1.0.1')).toBe(false);
  expect(newer('2.0.0-beta.1', '1.9.9')).toBe(true);
});
