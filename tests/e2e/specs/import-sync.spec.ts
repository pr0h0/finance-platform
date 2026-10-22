import { expect, test } from '@playwright/test';
import {
  addAccounts,
  finishOnboarding,
  onboardConnected,
  selectByText,
  syncNow,
  uniqueEmail,
} from '../lib/app';

const FIX = '../../packages/test-fixtures/imports';

test('connected mode: an imported statement reaches the server', async ({ page }) => {
  await onboardConnected(page, uniqueEmail('impsync'), true);
  await addAccounts(page, [{ name: 'Card', type: 'checking', opening: '0.00' }]);
  await finishOnboarding(page);
  await page.goto('/import', { waitUntil: 'domcontentloaded' });
  await selectByText(page, 'Account', 'Card');
  await page
    .locator('input[type=file][multiple]')
    .setInputFiles(`${FIX}/raiffeisen-bih/izvod-synthetic.pdf`);
  await page.getByRole('button', { name: 'Parse files' }).click();
  const card = page.getByRole('article', { name: 'izvod-synthetic.pdf' });
  await card.getByRole('button', { name: 'Stage for review' }).click();
  await card.getByRole('button', { name: /^Commit \d+ transactions$/ }).click();
  await expect(card.getByText('committed', { exact: true })).toBeVisible();
  await syncNow(page);
  await expect(page.getByRole('main')).toContainText('Changes the server refused (0)');
  const server = await page.evaluate(async () => {
    const pid = (await (await fetch('/api/v1/profiles')).json()).items[0].id as string;
    const h = { headers: { 'X-Profile-ID': pid } };
    return {
      txs: (await (await fetch('/api/v1/transactions?limit=50', h)).json()).items.length,
      imports: (await (await fetch('/api/v1/imports', h)).json()).items?.length,
    };
  });
  expect(server.imports).toBe(1);
  expect(server.txs).toBeGreaterThan(1);
});
