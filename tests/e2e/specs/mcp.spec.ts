import { expect, test } from '@playwright/test';
import { addAccounts, finishOnboarding, onboardConnected, shot, uniqueEmail } from '../lib/app';

test('MCP: create a client, grant read access, the token works on /mcp', async ({
  page,
  request,
}) => {
  const meta = await (await request.get('/api/v1/meta')).json();
  test.skip(!meta.mcpEnabled, 'MCP_ENABLED is off on this server');

  await onboardConnected(page, uniqueEmail('mcp'), true);
  await addAccounts(page, [{ name: 'Agent bank', type: 'checking', opening: '777.00' }]);
  await finishOnboarding(page);
  // the opening balance must reach the server before the agent can see it
  await page.goto('/sync', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('main')).toContainText(/Waiting to upload\s*0/);

  await page.goto('/agents', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Name', { exact: true }).fill('E2E agent');
  await page.getByRole('button', { name: 'Create client' }).click();
  const tokenBox = page
    .getByRole('dialog', { name: /Token for/ })
    .locator('code', { hasText: /^fpm_/ })
    .first();
  await expect(tokenBox).toBeVisible();
  const token = (await tokenBox.textContent())?.match(/fpm_[A-Za-z0-9_-]+/)?.[0] as string;
  await shot(page, 'mcp-token');
  await page.keyboard.press('Escape');

  await page
    .getByRole('row', { name: /E2E agent/ })
    .getByRole('button', { name: 'Permissions' })
    .click();
  const dlg = page.getByRole('dialog', { name: /Permissions of/ });
  await dlg
    .getByText('read_aggregates', { exact: true })
    .locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]//input[@type="checkbox"]')
    .check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Permissions saved')).toBeVisible();

  const rpc = async (id: number, method: string, params: unknown = {}) => {
    const r = await request.post('/mcp', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      data: { jsonrpc: '2.0', id, method, params },
    });
    expect(r.status()).toBe(200);
    return r.json();
  };
  const init = await rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1' },
  });
  expect(init.result.serverInfo.name).toBe('finance-platform');
  const overview = await rpc(2, 'tools/call', { name: 'get_financial_overview', arguments: {} });
  expect(JSON.stringify(overview.result.structuredContent.netWorth)).toContain('777.00');
  // a scope that was not granted is refused
  const tx = await rpc(3, 'tools/call', { name: 'list_transactions', arguments: {} });
  expect(JSON.stringify(tx)).toMatch(/not granted|scope|permission|forbidden/i);
  // a wrong token is rejected outright
  const bad = await request.post('/mcp', {
    headers: { Authorization: 'Bearer fpm_wrong', 'Content-Type': 'application/json' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(bad.status()).toBe(401);
});
