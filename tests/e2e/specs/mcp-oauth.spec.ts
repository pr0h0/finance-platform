import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { addAccounts, finishOnboarding, onboardConnected, syncNow, uniqueEmail } from '../lib/app';

// OAuth 2.1 connector flow as claude.ai runs it: discovery, DCR, browser consent in the web app,
// code + PKCE exchange, MCP call with the access token, revocation in the MCP connections page.
test('MCP OAuth: register, consent in the app, token works on /mcp, revoke', async ({
  page,
  request,
}) => {
  const meta = await (await request.get('/api/v1/meta')).json();
  test.skip(!meta.mcpEnabled, 'MCP_ENABLED is off on this server');

  await onboardConnected(page, uniqueEmail('oauth'), true);
  await addAccounts(page, [{ name: 'OAuth bank', type: 'checking', opening: '321.00' }]);
  await finishOnboarding(page);
  await syncNow(page);

  const unauth = await request.post('/mcp', { data: {} });
  expect(unauth.status()).toBe(401);
  expect(unauth.headers()['www-authenticate']).toContain('resource_metadata=');
  const prm = await (await request.get('/.well-known/oauth-protected-resource/mcp')).json();
  const as = await (await request.get('/.well-known/oauth-authorization-server')).json();
  expect(as.code_challenge_methods_supported).toEqual(['S256']);

  const redirect = 'https://agent.example/callback';
  const reg = await request.post(as.registration_endpoint, {
    data: { client_name: 'E2E OAuth agent', redirect_uris: [redirect] },
  });
  expect(reg.status()).toBe(201);
  const clientId = (await reg.json()).client_id as string;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let callback = '';
  await page.route('https://agent.example/**', (route) => {
    callback = route.request().url();
    return route.fulfill({ body: 'connected', contentType: 'text/plain' });
  });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: prm.resource,
  });
  await page.goto(`/oauth/authorize?${q}`);
  await expect(page.getByRole('heading', { name: /Connect “E2E OAuth agent”/ })).toBeVisible();
  // read-only by default: aggregates checked, writes unchecked
  await expect(page.getByRole('checkbox', { name: /Read totals and analytics/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Change categories/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => callback).toContain('code=');
  const cb = new URL(callback);
  expect(cb.searchParams.get('state')).toBe('xyz');

  const tok = await request.post(as.token_endpoint, {
    form: {
      grant_type: 'authorization_code',
      code: cb.searchParams.get('code') as string,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: prm.resource,
    },
  });
  expect(tok.status()).toBe(200);
  const { access_token } = await tok.json();
  const call = () =>
    request.post('/mcp', {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_financial_overview', arguments: {} },
      },
    });
  const r = await call();
  expect(r.status()).toBe(200);
  expect(JSON.stringify((await r.json()).result.structuredContent.netWorth)).toContain('321.00');

  await page.goto('/agents');
  const row = page.getByRole('row', { name: /E2E OAuth agent/ });
  await expect(row.getByText('OAuth', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page
    .getByRole('dialog', { name: /Revoke/ })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(row).toBeHidden();
  expect((await call()).status()).toBe(401);
});
