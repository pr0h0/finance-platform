import { expect, test } from '@playwright/test';
import {
  addAccounts,
  addTransaction,
  finishOnboarding,
  onboardConnected,
  shot,
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

  // the server has it: ask the API with the browser's own session (the cookie is Secure, so only
  // the browser sends it to 127.0.0.1 over plain http)
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

  // second device signs in and downloads the profile
  const b = await browser.newContext();
  const pb = await b.newPage();
  await onboardConnected(pb, email, false);
  await finishOnboarding(pb);
  await pb.goto('/transactions');
  await expect(pb.getByRole('row', { name: /Synced groceries/ })).toBeVisible();

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
  await expect(drawer.getByText('Saved')).toBeVisible();
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
