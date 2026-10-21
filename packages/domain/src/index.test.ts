import { expect, test } from 'bun:test';
import { MCP_SCOPES, SYNC_PROTOCOL_VERSION, TRANSACTION_KINDS } from './index.ts';

test('transaction kinds cover the ledger model', () => {
  expect([...TRANSACTION_KINDS].sort()).toEqual([
    'adjustment',
    'expense',
    'fx',
    'income',
    'opening_balance',
    'refund',
    'transfer',
  ]);
  expect(MCP_SCOPES).toContain('read_aggregates');
  expect(SYNC_PROTOCOL_VERSION).toBe(1);
});
