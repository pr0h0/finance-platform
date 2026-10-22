import { expect, test } from '@playwright/test';
import { addTransaction, onboardLocal } from '../lib/app';

test('manual duplicates are flagged; G shortcuts navigate', async ({ page }) => {
  await onboardLocal(page);
  for (let i = 0; i < 2; i++)
    await addTransaction(page, {
      kind: 'expense',
      account: 'Checking',
      amount: '19.99',
      description: 'Coffee beans',
    });
  await page.goto('/transactions', { waitUntil: 'domcontentloaded' });
  const tab = page.getByRole('tab', { name: 'Possible duplicates (1)' });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByText(/same account and amount, same date/)).toBeVisible();
  await page.getByRole('button', { name: 'Open #1' }).click();
  const drawer = page.getByRole('dialog', { name: 'Transaction' });
  await expect(drawer.getByRole('status', { name: 'Possible duplicate' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Not a duplicate' }).click();
  await expect(drawer.getByRole('status', { name: 'Possible duplicate' })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: 'Possible duplicates' })).toBeVisible();

  await page.locator('body').click();
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await expect(page).toHaveURL(/\/budgets$/);
  await expect(page.getByRole('heading', { name: 'Budgets', level: 1 })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
});
