import { expect, test } from '@playwright/test';
import {
  addAccounts,
  addTransaction,
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
  // typed in by hand before the statement arrived: the import links it instead of duplicating
  await addTransaction(page, {
    kind: 'expense',
    account: 'Card',
    amount: '4.50',
    date: '2025-03-04',
    description: 'Bakery (typed in)',
  });
  await page.goto('/import', { waitUntil: 'domcontentloaded' });
  await selectByText(page, 'Account', 'Card');
  await page
    .locator('input[type=file][multiple]')
    .setInputFiles(`${FIX}/raiffeisen-bih/izvod-synthetic.pdf`);
  await page.getByRole('button', { name: 'Parse files' }).click();
  const card = page.getByRole('article', { name: 'izvod-synthetic.pdf' });
  await card.getByRole('button', { name: 'Stage for review' }).click();
  await expect(card.getByText('matches your entry: linked')).toBeVisible();
  await card.getByRole('button', { name: /^Commit \d+ transactions$/ }).click();
  await expect(card.getByText('committed', { exact: true })).toBeVisible();
  await expect(card).toContainText('1 linked to transactions you entered by hand');
  await syncNow(page);
  await expect(page.getByRole('main')).toContainText('Changes the server refused (0)');
  const server = await page.evaluate(async () => {
    const pid = (await (await fetch('/api/v1/profiles')).json()).items[0].id as string;
    const h = { headers: { 'X-Profile-ID': pid } };
    return {
      txs: (await (await fetch('/api/v1/transactions?limit=50', h)).json()).items as {
        description: string;
        importRecordId: string | null;
        kind: string;
      }[],
      imports: (await (await fetch('/api/v1/imports', h)).json()).items?.length,
    };
  });
  expect(server.imports).toBe(1);
  const nonOpening = server.txs.filter((t) => t.kind !== 'opening_balance');
  expect(nonOpening).toHaveLength(11); // 11 statement rows, the typed-in one among them
  const typed = server.txs.find((t) => t.description === 'Bakery (typed in)');
  expect(typed?.importRecordId).toBeTruthy();
});
