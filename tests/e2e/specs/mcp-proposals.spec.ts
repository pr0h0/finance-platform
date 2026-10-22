import { expect, type Page, test } from '@playwright/test';
import {
  addAccounts,
  addTransaction,
  finishOnboarding,
  onboardConnected,
  syncNow,
  uniqueEmail,
} from '../lib/app';

async function serverTx(page: Page, description: string) {
  return page.evaluate(async (d) => {
    const pid = (await (await fetch('/api/v1/profiles')).json()).items[0].id as string;
    const h = { 'X-Profile-ID': pid };
    const txs = await (await fetch('/api/v1/transactions?limit=50', { headers: h })).json();
    const cats = await (await fetch('/api/v1/categories?limit=200', { headers: h })).json();
    const tx = txs.items.find((t: { description: string }) => t.description === d);
    return {
      id: tx.id as string,
      categoryIds: (tx.splits as { categoryId: string }[]).map((s) => s.categoryId),
      cat: Object.fromEntries(
        (cats.items as { id: string; name: string }[]).map((c) => [c.name, c.id]),
      ) as Record<string, string>,
    };
  }, description);
}

test('MCP proposal: an agent proposes, the user approves one and rejects another in the app', async ({
  page,
  request,
}) => {
  const meta = await (await request.get('/api/v1/meta')).json();
  test.skip(!meta.mcpEnabled, 'MCP_ENABLED is off on this server');

  await onboardConnected(page, uniqueEmail('mcp-prop'), true);
  await addAccounts(page, [{ name: 'Agent bank', type: 'checking', opening: '300.00' }]);
  await finishOnboarding(page);
  await addTransaction(page, {
    kind: 'expense',
    account: 'Agent bank',
    category: 'Groceries',
    amount: '18.40',
    description: 'Corner cafe',
  });
  await syncNow(page);

  await page.goto('/agents');
  await page.getByLabel('Name', { exact: true }).fill('Proposing agent');
  await page.getByRole('button', { name: 'Create client' }).click();
  const tokenBox = page
    .getByRole('dialog', { name: /Token for/ })
    .locator('code', { hasText: /^fpm_/ })
    .first();
  const token = (await tokenBox.textContent())?.match(/fpm_[A-Za-z0-9_-]+/)?.[0] as string;
  await page.keyboard.press('Escape');
  await page
    .getByRole('row', { name: /Proposing agent/ })
    .getByRole('button', { name: 'Permissions' })
    .click();
  const dlg = page.getByRole('dialog', { name: /Permissions of/ });
  await dlg.getByRole('checkbox', { name: /Read individual transactions/ }).check();
  await dlg.getByRole('checkbox', { name: /Change categories/ }).check();
  await expect(dlg.getByLabel('Approval for edit_categories')).toHaveValue('required');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Permissions saved')).toBeVisible();

  const call = async (name: string, args: unknown) => {
    const r = await request.post('/mcp', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    expect(r.status()).toBe(200);
    return (await r.json()).result;
  };

  const before = await serverTx(page, 'Corner cafe');
  expect(before.categoryIds).toEqual([before.cat.Groceries]);
  const restaurants = before.cat.Restaurants;
  const transport = before.cat.Fuel;
  expect(restaurants && transport).toBeTruthy();

  // 1st proposal: approved in the app -> applied
  const p1 = await call('update_transaction_category', {
    transactionId: before.id,
    categoryId: restaurants,
  });
  expect(JSON.stringify(p1)).toMatch(/pending|approval/i);
  expect((await serverTx(page, 'Corner cafe')).categoryIds).toEqual([before.cat.Groceries]);
  await page.getByRole('tab', { name: 'Approvals' }).click();
  const item = page.getByRole('listitem').filter({ hasText: 'update_transaction_category' });
  await expect(item).toHaveCount(1);
  await item.getByRole('button', { name: 'Approve and apply' }).click();
  await expect(page.getByText('Nothing here.')).toBeVisible();
  await expect
    .poll(async () => (await serverTx(page, 'Corner cafe')).categoryIds)
    .toEqual([restaurants]);

  // 2nd proposal: rejected -> nothing changes
  await call('update_transaction_category', { transactionId: before.id, categoryId: transport });
  await page.reload();
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'update_transaction_category' })
    .getByRole('button', { name: 'Reject' })
    .click();
  await expect(page.getByText('Nothing here.')).toBeVisible();
  await page.getByLabel('Status').selectOption('rejected');
  await expect(
    page.getByRole('listitem').filter({ hasText: 'update_transaction_category' }),
  ).toContainText('rejected');
  expect((await serverTx(page, 'Corner cafe')).categoryIds).toEqual([restaurants]);

  // the synced device shows the applied category
  await syncNow(page);
  await page.goto('/transactions');
  await expect(page.getByRole('row', { name: /Corner cafe/ })).not.toContainText('Groceries');
});
