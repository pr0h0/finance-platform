import { expect, test } from '@playwright/test';
import {
  addAccounts,
  addTransaction,
  finishOnboarding,
  onboardConnected,
  syncNow,
  uniqueEmail,
} from '../lib/app';

test('the two halves of an own-account transfer link into one transfer and sync', async ({
  page,
}) => {
  await onboardConnected(page, uniqueEmail('link'), true);
  await addAccounts(page, [
    { name: 'Visa', type: 'checking', opening: '100.00' },
    { name: 'MC', type: 'checking', opening: '0.00' },
  ]);
  await finishOnboarding(page);
  await addTransaction(page, {
    kind: 'expense',
    account: 'Visa',
    amount: '30.00',
    description: 'Prenos out',
  });
  await addTransaction(page, {
    kind: 'income',
    account: 'MC',
    amount: '30.00',
    description: 'Prenos in',
  });

  await page.goto('/transactions', { waitUntil: 'domcontentloaded' });
  await page.getByRole('row', { name: /Prenos out/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Transaction' });
  await expect(drawer).toContainText('Prenos in');
  await drawer.getByRole('button', { name: 'Link as transfer' }).click();
  await expect(page.getByRole('row', { name: /Prenos in/ })).toBeHidden();
  await syncNow(page);
  await expect(page.getByRole('main')).toContainText('Changes the server refused (0)');

  const server = await page.evaluate(async () => {
    const pid = (await (await fetch('/api/v1/profiles')).json()).items[0].id as string;
    const txs = (
      await (
        await fetch('/api/v1/transactions?limit=50', { headers: { 'X-Profile-ID': pid } })
      ).json()
    ).items as { kind: string; description: string }[];
    return txs.filter((t) => t.description.startsWith('Prenos')).map((t) => t.kind);
  });
  expect(server).toEqual(['transfer']);

  // unlink again: expense and income come back (also on the server)
  await page.goto('/transactions', { waitUntil: 'domcontentloaded' });
  await page.getByRole('row', { name: /Prenos out/ }).click();
  await page
    .getByRole('dialog', { name: 'Transaction' })
    .getByRole('button', { name: 'Unlink into expense and income' })
    .click();
  await expect(page.getByRole('row', { name: /Prenos in/ })).toBeVisible();
  await syncNow(page);
  await expect(page.getByRole('main')).toContainText('Changes the server refused (0)');
});
