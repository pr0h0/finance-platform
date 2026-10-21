import { expect, test } from 'bun:test';
import { fetchServerStatus } from './server-status.ts';

const ok = {
  name: 'finance-platform',
  apiVersion: '1.0.0',
  schemaVersion: 1,
  syncProtocolVersion: 1,
  publicUrl: '',
  registrationPolicy: 'first_user',
  mcpEnabled: false,
};

test('reports ok / incompatible / unreachable', async () => {
  const respond = (body: unknown) =>
    (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  expect((await fetchServerStatus('', respond(ok))).state).toBe('ok');
  expect((await fetchServerStatus('', respond({ ...ok, apiVersion: '9.0.0' }))).state).toBe(
    'incompatible',
  );
  const down = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  expect((await fetchServerStatus('', down)).state).toBe('unreachable');
});
