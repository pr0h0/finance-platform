import { expect, test } from '@playwright/test';
import { addTransaction, onboardLocal, selectByText, shot } from '../lib/app';

const iso = (d: Date) => d.toISOString().slice(0, 10);

test('local mode: budgets, planned expenses and forecast simulation', async ({ page }) => {
  await onboardLocal(page, [{ name: 'Checking', type: 'checking', opening: '1000.00' }]);
  await addTransaction(page, {
    kind: 'expense',
    account: 'Checking',
    category: 'Groceries',
    amount: '150.00',
    description: 'Market',
  });

  // budget: Food limit 400 for the current month → 150 spent, 250 remaining
  const now = new Date();
  const monthStart = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  await page.goto('/budgets');
  await page.getByRole('button', { name: 'New budget' }).click();
  const bd = page.getByRole('dialog', { name: 'New budget' });
  await bd.getByLabel('Name', { exact: true }).fill('Household');
  await bd.getByLabel('Starts', { exact: true }).fill(monthStart);
  if ((await bd.getByLabel('Limit (BAM)').count()) === 0)
    await bd.getByRole('button', { name: 'Add limit' }).click();
  const cat = bd.getByLabel('Category', { exact: true }).first();
  const food = await cat.evaluate(
    (el) => [...(el as HTMLSelectElement).options].find((o) => o.textContent === 'Food')?.value,
  );
  await cat.selectOption(food as string);
  await bd.getByLabel('Limit (BAM)').first().fill('400.00');
  await bd.getByRole('button', { name: 'Save' }).click();
  await expect(bd).toBeHidden();
  const row = page.getByRole('row', { name: /Food/ });
  await expect(row).toContainText('BAM 150.00');
  await expect(row).toContainText('BAM 250.00');
  await expect(row).toContainText('BAM 400.00');
  await shot(page, 'budgets');

  // planned monthly rent from the 1st of next month
  const next = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
  await page.goto('/planning');
  await page.getByRole('button', { name: 'Plan transaction' }).click();
  const pd = page.getByRole('dialog', { name: 'New planned transaction' });
  await pd.getByLabel('Description').fill('Rent');
  await selectByText(page, 'Category', 'Rent');
  await pd.getByLabel('Amount (BAM)').fill('500.00');
  await pd.getByLabel('Due date (first occurrence)').fill(next);
  await pd.getByLabel('Frequency').selectOption('MONTHLY');
  await pd.getByRole('button', { name: 'Save' }).click();
  await expect(pd).toBeHidden();
  await page.getByRole('tab', { name: 'List' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('main').getByText('Rent').first()).toBeVisible();
  await expect(page.getByRole('main').getByText('BAM 500.00').first()).toBeVisible();

  // forecast: 1000 − 150 = 850 now; rent makes the balance go negative within 2 months
  const fc = page.getByRole('region', { name: 'Forecast balance' });
  await expect(fc).toContainText('the expected balance goes negative');

  // what-if: a 3,000 purchase is simulated only
  const wi = page.getByRole('region', { name: /What-if/ });
  await wi.getByLabel('Change').selectOption('purchase');
  await wi.getByLabel('Description').fill('New laptop');
  await wi.getByLabel('Amount').fill('3000.00');
  await wi.getByRole('button', { name: 'Add to scenario' }).click();
  await expect(wi.getByText('Lowest balance')).toBeVisible();
  await expect(wi.getByText(/−BAM|-BAM/).first()).toBeVisible();
  await shot(page, 'planning');

  // nothing was saved by the simulation
  await page.goto('/transactions');
  await expect(page.getByText('New laptop')).toHaveCount(0);
});
