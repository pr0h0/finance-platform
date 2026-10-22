import { expect, test } from '@playwright/test';
import {
  addAccounts,
  addTransaction,
  attachReceipt,
  finishOnboarding,
  onboardConnected,
  shot,
  startOnboarding,
  syncNow,
  uniqueEmail,
} from '../lib/app';

test('connected mode: register, sync to the server, second device, offline edit then reconnect', async ({
  browser,
}) => {
  const email = uniqueEmail('sync');
  const a = await browser.newContext();
  const pa = await a.newPage();
  await onboardConnected(pa, email, true);
  await addAccounts(pa, [{ name: 'Server bank', type: 'checking', opening: '500.00' }]);
  await finishOnboarding(pa);
  await expect(
    pa
      .getByText('Connected')
      .or(pa.getByText(/Synced|Sync/))
      .first(),
  ).toBeVisible();
  await addTransaction(pa, {
    kind: 'expense',
    account: 'Server bank',
    category: 'Groceries',
    amount: '42.00',
    description: 'Synced groceries',
  });
  await syncNow(pa);
  await shot(pa, 'sync-page');

  // the server has it: ask the API with the browser's own session
  const server = await pa.evaluate(async () => {
    const get = (u: string, pid?: string) =>
      fetch(u, { headers: pid ? { 'X-Profile-ID': pid } : {} }).then((r) => r.json());
    const pid = (await get('/api/v1/profiles')).items[0].id as string;
    return {
      txs: await get('/api/v1/transactions?limit=50', pid),
      bal: await get('/api/v1/balances?currency=BAM', pid),
    };
  });
  expect(server.txs.items.map((t: { description: string }) => t.description)).toContain(
    'Synced groceries',
  );
  expect(JSON.stringify(server.bal)).toContain('458.00');

  // a receipt attached on device A is uploaded to the server (not only kept in this browser)
  await pa.goto('/transactions');
  await pa.getByRole('row', { name: /Synced groceries/ }).click();
  const drawerA = pa.getByRole('dialog', { name: 'Transaction' });
  await attachReceipt(pa, ['KONZUM', 'UKUPNO 42.00', '21.10.2026']);
  await expect(drawerA.getByRole('button', { name: 'receipt.png', exact: true })).toBeVisible();
  await pa.keyboard.press('Escape');
  await syncNow(pa);
  await expect(pa.getByRole('main')).toContainText('Changes the server refused (0)');
  const files = await pa.evaluate(async () => {
    const pid = (await (await fetch('/api/v1/profiles')).json()).items[0].id as string;
    return (await fetch('/api/v1/attachments', { headers: { 'X-Profile-ID': pid } })).json();
  });
  expect(files.items.map((f: { fileName: string }) => f.fileName)).toEqual(['receipt.png']);

  // second device signs in and downloads the profile
  const b = await browser.newContext();
  const pb = await b.newPage();
  await onboardConnected(pb, email, false);
  await finishOnboarding(pb);
  await pb.goto('/transactions');
  await expect(pb.getByRole('row', { name: /Synced groceries/ })).toBeVisible();
  // device B downloads the receipt from the server and reads it with on-device OCR
  await pb.getByRole('row', { name: /Synced groceries/ }).click();
  const drawerB = pb.getByRole('dialog', { name: 'Transaction' });
  await drawerB.getByRole('button', { name: 'Read receipt' }).click();
  await expect(drawerB.getByLabel('Receipt total')).toHaveValue('42.00', { timeout: 60_000 });
  await expect(drawerB.getByLabel('Receipt date')).toHaveValue('2026-10-21');
  await pb.keyboard.press('Escape');

  // device A goes offline, edits, comes back online and syncs
  await pa.goto('/transactions');
  await expect(pa.getByRole('row', { name: /Synced groceries/ })).toBeVisible();
  await a.setOffline(true);
  await pa.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(pa.getByText(/offline/i).first()).toBeVisible();
  await pa.getByRole('row', { name: /Synced groceries/ }).click();
  const drawer = pa.getByRole('dialog', { name: 'Transaction' });
  await drawer.getByLabel('Description', { exact: true }).fill('Edited offline');
  await drawer.getByRole('button', { name: 'Save details' }).click();
  // the drawer re-renders with the saved version (its "Saved" hint can vanish at once): check the list
  await expect(pa.getByRole('row', { name: /Edited offline/ })).toBeVisible();
  await pa.keyboard.press('Escape');
  await expect(pa.getByRole('row', { name: /Edited offline/ })).toBeVisible();
  await a.setOffline(false);
  await pa.evaluate(() => window.dispatchEvent(new Event('online')));
  await syncNow(pa);

  await syncNow(pb);
  await pb.goto('/transactions');
  await expect(pb.getByRole('row', { name: /Edited offline/ })).toBeVisible();
  await a.close();
  await b.close();
});

test('another server address points to that server’s own web app', async ({ page }) => {
  await startOnboarding(page);
  await page.getByRole('button', { name: /Connect to server/ }).click();
  await page.getByLabel('Server URL').fill('https://other.example.org');
  await page.getByRole('button', { name: 'Check server' }).click();
  await expect(
    page.getByRole('link', { name: /Open https:\/\/other\.example\.org/ }),
  ).toBeVisible();
});
