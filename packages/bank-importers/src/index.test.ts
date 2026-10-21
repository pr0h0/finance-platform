import { expect, test } from 'bun:test';
import { blockedImporters } from './index.ts';

test('raiffeisen is blocked, not faked', () => {
  expect(blockedImporters.find((i) => i.id === 'raiffeisen-bih')?.status).toBe('blocked_external');
});
