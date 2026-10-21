import { expect, test } from 'bun:test';
import { registerCatalog, t } from './index.ts';

test('falls back to base language then English', () => {
  registerCatalog('bs', { 'mode.local': 'Samo lokalno' });
  expect(t('mode.local', 'bs-BA')).toBe('Samo lokalno');
  expect(t('mode.connect', 'bs')).toBe('Connect to server');
});
