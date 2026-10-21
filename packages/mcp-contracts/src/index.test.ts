import { expect, test } from 'bun:test';
import { READ_TOOLS, TOOLS, toolJsonSchemas, WRITE_TOOLS } from './index.ts';

test('all PLAN §28/§29 tools are defined', () => {
  expect(READ_TOOLS.length).toBe(19); // 18 read tools + preview_changes
  expect(WRITE_TOOLS.length).toBe(11);
});

test('json schemas render', () => {
  const s = toolJsonSchemas();
  expect(s.length).toBe(Object.keys(TOOLS).length);
  expect(s.find((t) => t.name === 'split_transaction')?.inputSchema).toHaveProperty(
    'properties.splits',
  );
});

test('split tool rejects float amounts', () => {
  const r = TOOLS.split_transaction.input.safeParse({
    transactionId: '0190f1c2-0000-7000-8000-000000000001',
    splits: [{ categoryId: null, amount: { amount: 1.5, currency: 'EUR' } }],
  });
  expect(r.success).toBe(false);
});
