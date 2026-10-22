import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { onboardLocal, selectByText, shot } from '../lib/app';

const FIX = '../../packages/test-fixtures/imports';

async function importFile(page: Page, account: string, file: string, template?: string) {
  await page.goto('/import');
  await selectByText(page, 'Account', account);
  if (template) await selectByText(page, 'Mapping template', template);
  await page.locator('input[type=file][multiple]').setInputFiles(`${FIX}/${file}`);
  await page.getByRole('button', { name: 'Parse files' }).click();
  const card = page.getByRole('article', { name: file.split('/').pop() });
  await card.getByRole('button', { name: 'Stage for review' }).click();
  const commit = card.getByRole('button', { name: /^Commit \d+ transactions$/ });
  await expect(commit).toBeEnabled();
  const n = Number((await commit.textContent())?.match(/\d+/)?.[0]);
  await shot(page, `import-${file.replace(/\W/g, '_')}`);
  await commit.click();
  await expect(card.getByText('committed', { exact: true })).toBeVisible();
  return n;
}

test('import synthetic CSV (with a mapping template) and OFX statements', async ({ page }) => {
  await onboardLocal(page, [
    { name: 'CSV bank', type: 'checking', currency: 'BAM' },
    { name: 'OFX bank', type: 'checking', currency: 'EUR' },
  ]);

  // CSV needs a mapping template: load the synthetic one as JSON and save it
  await page.goto('/import?tab=mapping');
  await page.getByText('Import template JSON').click();
  await page
    .getByLabel('Template JSON')
    .fill(readFileSync(`${FIX}/templates/primjer-banka-csv.json`, 'utf8'));
  await page.getByRole('button', { name: 'Load' }).click();
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Primjer Banka CSV (synthetic example)').first()).toBeVisible();

  const csv = await importFile(page, 'CSV bank', 'csv/primjer-banka-utf8.csv', 'Primjer Banka CSV');
  expect(csv).toBe(4);
  const ofx = await importFile(page, 'OFX bank', 'ofx/statement-v1.ofx');
  expect(ofx).toBe(3);

  await page.goto('/transactions');
  await expect(page.getByRole('row', { name: /Uplata plate/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Employer Ltd/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Ćevapi/ })).toBeVisible();
  await page.goto('/accounts');
  await expect(page.getByRole('main').getByText('€2,450.50')).toBeVisible(); // −3.50 + 2500 − (USD 50 × 0.92)
  await expect(page.getByRole('main').getByText('BAM 2,319.30')).toBeVisible(); // 2500 − 180.70

  // re-importing the same OFX file finds only duplicates
  await page.goto('/import');
  await selectByText(page, 'Account', 'OFX bank');
  await page.locator('input[type=file][multiple]').setInputFiles(`${FIX}/ofx/statement-v1.ofx`);
  await page.getByRole('button', { name: 'Parse files' }).click();
  const card = page.getByRole('article', { name: 'statement-v1.ofx' });
  await card.getByRole('button', { name: 'Stage for review' }).click();
  await expect(card.getByRole('button', { name: 'Commit 0 transactions' })).toBeDisabled();
});
