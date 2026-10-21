import { expect, test } from 'bun:test';
import * as mod from './index.ts';

test('module loads', () => {
  expect(mod).toBeDefined();
});
