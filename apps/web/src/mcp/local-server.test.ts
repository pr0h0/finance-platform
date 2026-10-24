import { expect, test } from 'bun:test';
import { seed } from '../features/analytics/fixture.test-util.ts';
import { handleMessage } from './local-server.ts';

const noCtx = () => {
  throw new Error('no data needed');
};
const rpc = async (m: object) => {
  const out = await handleMessage(noCtx, JSON.stringify(m));
  return out === null ? null : JSON.parse(out);
};

test('local MCP protocol: initialize, tools/list, notifications, errors', async () => {
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  expect(init.result.protocolVersion).toBe('2025-06-18');
  expect(init.result.capabilities).toEqual({ tools: {} });
  const old = await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  });
  expect(old.result.protocolVersion).toBe('2025-11-25');

  expect(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();

  const list = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const names = list.result.tools.map((t: { name: string }) => t.name);
  expect(names).toHaveLength(19);
  expect(names).toContain('get_financial_overview');
  expect(names).not.toContain('preview_changes');
  expect(names).not.toContain('update_transaction_category');

  expect((await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).error.code).toBe(-32601);
  expect(JSON.parse((await handleMessage(noCtx, '{nope')) ?? '').error.code).toBe(-32700);
});

test('write tools exist only while changes are allowed; rejection is an isError result', async () => {
  const f = await seed();
  const ctx = () => ({ ds: f.ds, profile: f.profile, today: '2026-03-31' });
  const no = async () => 'rejected' as const;
  const list = async (approve?: typeof no) =>
    JSON.parse(
      (await handleMessage(
        ctx,
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        approve,
      )) ?? '',
    ).result.tools.map((t: { name: string }) => t.name);
  const writes = await list(no);
  expect(writes).toHaveLength(29);
  expect(writes).toContain('split_transaction');
  expect(writes).not.toContain('apply_approved_changes');
  expect(writes).not.toContain('preview_changes');

  const tx = (await f.ops.searchTransactions({})).items[0];
  const call = (approve?: typeof no) =>
    handleMessage(
      ctx,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'update_transaction_category',
          arguments: { transactionId: tx?.id, categoryId: null },
        },
      }),
      approve,
    ).then((o) => JSON.parse(o ?? '').result);
  expect((await call()).structuredContent.error.code).toBe('unknown_tool'); // switched off
  const r = await call(no);
  expect(r.isError).toBe(true);
  expect(r.structuredContent.error.code).toBe('rejected');
});
