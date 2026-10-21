import { expect, test } from 'bun:test';
import { ApiError, checkCompatibility, createApiClient } from './index.ts';

const meta = {
  name: 'finance-platform',
  apiVersion: '1.2.0',
  schemaVersion: 1,
  syncProtocolVersion: 1,
  publicUrl: '',
  registrationPolicy: 'open',
  mcpEnabled: false,
} as const;

test('compatibility check', () => {
  expect(checkCompatibility(meta).ok).toBe(true);
  expect(checkCompatibility({ ...meta, apiVersion: '2.0.0' }).ok).toBe(false);
  expect(checkCompatibility({ ...meta, name: 'evil' }).ok).toBe(false);
});

test('errors are parsed from the API error format', async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ error: { code: 'forbidden', message: 'not allowed' } }), {
      status: 403,
    })) as unknown as typeof fetch;
  const c = createApiClient({ baseUrl: '', fetch: fake });
  const err = await c.getMeta().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe('forbidden');
});
