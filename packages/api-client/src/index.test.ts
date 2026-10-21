import { expect, test } from 'bun:test';
import { ApiError, checkCompatibility, createApiClient, normalizeServerUrl } from './index.ts';

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
  expect(checkCompatibility({ ...meta, syncProtocolVersion: 2 }).ok).toBe(false);
});

test('server URL must be https (http only for localhost), no credentials', () => {
  expect(normalizeServerUrl('fin.pr0h0.me')).toEqual({ ok: true, url: 'https://fin.pr0h0.me' });
  expect(normalizeServerUrl('https://fin.pr0h0.me/')).toEqual({
    ok: true,
    url: 'https://fin.pr0h0.me',
  });
  expect(normalizeServerUrl('http://127.0.0.1:3811')).toEqual({
    ok: true,
    url: 'http://127.0.0.1:3811',
  });
  expect(normalizeServerUrl('http://example.com').ok).toBe(false);
  expect(normalizeServerUrl('https://u:p@example.com').ok).toBe(false);
  expect(normalizeServerUrl('not a url ::').ok).toBe(false);
});

test('errors are parsed from the API error format', async () => {
  const fake = (async () =>
    new Response(
      JSON.stringify({ error: { code: 'forbidden', message: 'not allowed', requestId: 'r1' } }),
      {
        status: 403,
      },
    )) as unknown as typeof fetch;
  const c = createApiClient({ baseUrl: '', fetch: fake });
  const err = await c.getMeta().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe('forbidden');
  expect((err as ApiError).requestId).toBe('r1');
  expect((err as ApiError).retryable).toBe(false);
});

test('network failures map to retryable ApiError(0)', async () => {
  const c = createApiClient({
    baseUrl: 'http://127.0.0.1:1',
    fetch: (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch,
  });
  const err = (await c.getMeta().catch((e: unknown) => e)) as ApiError;
  expect(err.status).toBe(0);
  expect(err.retryable).toBe(true);
});

test('CSRF token from login is sent on unsafe requests; profile + idempotency headers', async () => {
  const seen: Request[] = [];
  const fake = (async (r: Request) => {
    seen.push(r);
    if (r.url.endsWith('/auth/login'))
      return Response.json({ user: { id: 'u' }, csrfToken: 'csrf-1', deviceId: 'd' });
    return Response.json({ items: [] });
  }) as unknown as typeof fetch;
  let profile = 'p1';
  const c = createApiClient({ baseUrl: 'https://x', fetch: fake, profileId: () => profile });
  await c.login({ email: 'a@b.c', password: 'pw' });
  // typed client
  const r = await c.client.GET('/api/v1/accounts', {
    params: { header: { 'X-Profile-ID': profile } },
  });
  expect(r.data?.items).toEqual([]);
  profile = 'p2';
  await c.request('POST', '/api/v1/tags', { name: 't' });
  const [login, get, post] = seen as [Request, Request, Request];
  expect(login.headers.get('X-CSRF-Token')).toBeNull();
  expect(get.headers.get('X-CSRF-Token')).toBeNull();
  expect(get.headers.get('X-Profile-ID')).toBe('p1');
  expect(post.headers.get('X-CSRF-Token')).toBe('csrf-1');
  expect(post.headers.get('X-Profile-ID')).toBe('p2');
  expect(post.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  expect(post.credentials).toBe('include');
});
