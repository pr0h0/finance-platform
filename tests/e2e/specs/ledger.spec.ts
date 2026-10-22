import { expect, test } from '@playwright/test';
import { addTransaction, onboardLocal, shot } from '../lib/app';

test('local mode: onboarding, accounts, income, expense, transfer, split, analytics, reporting currency', async ({
  page,
}) => {
  await onboardLocal(page, [
    { name: 'Checking', type: 'checking', opening: '1000.00' },
    { name: 'Wallet', type: 'cash', opening: '50.00' },
    { name: 'Euro savings', type: 'savings', currency: 'EUR', opening: '100.00' },
  ]);
  // EUR/BAM is a fixed rate (1.95583): 1000 + 50 + 195.58 = 1,245.58
  await expect(page.getByText('BAM 1,245.58').first()).toBeVisible();

  const today = new Date().toISOString().slice(0, 10);
  await addTransaction(page, {
    kind: 'income',
    account: 'Checking',
    category: 'Salary',
    amount: '2500.00',
    description: 'October salary',
  });
  await addTransaction(page, {
    kind: 'expense',
    account: 'Checking',
    category: 'Groceries',
    amount: '120.40',
    description: 'Konzum',
  });
  await addTransaction(page, {
    kind: 'transfer',
    account: 'Checking',
    to: 'Wallet',
    amount: '200.00',
    description: 'ATM',
  });
  // cross-currency transfer becomes an fx transaction with the bank's received amount
  await addTransaction(page, {
    kind: 'transfer',
    account: 'Checking',
    to: 'Euro savings',
    amount: '195.58',
    received: '100.00',
    description: 'To EUR',
  });

  await page.goto('/accounts');
  const main = page.getByRole('main');
  await expect(main.getByText('BAM 2,984.02')).toBeVisible(); // 1000 + 2500 − 120.40 − 200 − 195.58
  await expect(main.getByText('BAM 3,625.19')).toBeVisible(); // assets incl. €200 × 1.95583
  await expect(main.getByText('BAM 250.00')).toBeVisible(); // wallet 50 + 200
  await expect(main.getByText('€200.00').or(main.getByText('EUR 200.00')).first()).toBeVisible();

  // split the grocery expense into two categories
  await page.goto('/transactions');
  await page
    .getByRole('row', { name: /Konzum/ })
    .first()
    .click();
  const drawer = page.getByRole('dialog', { name: 'Transaction' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Add line' }).click();
  await drawer.getByLabel('Amount of line 1').fill('100.40');
  await drawer.getByLabel('Amount of line 2').fill('20.00');
  const cat2 = drawer.getByLabel('Category of line 2');
  const restaurants = await cat2.evaluate(
    (el) =>
      [...(el as HTMLSelectElement).options].find((o) => o.textContent?.includes('Restaurants'))
        ?.value,
  );
  await cat2.selectOption(restaurants as string);
  await expect(drawer.getByText('Lines match the total')).toBeVisible();
  await drawer.getByRole('button', { name: 'Save splits' }).click();
  await expect(page.getByText('Splits saved')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Merge into one' })).toBeVisible();
  await page.keyboard.press('Escape');

  // analytics shows the real numbers
  await page.goto(`/analytics`);
  const a = page.getByRole('main');
  await expect(a.getByText('BAM 2,500.00').first()).toBeVisible();
  await expect(a.getByText('BAM 120.40').first()).toBeVisible();
  await shot(page, 'analytics-bam');

  // switch the reporting currency to EUR in settings → amounts re-valued at the fixed rate
  await page.goto('/settings');
  const rc = page.getByRole('region', { name: /Reporting currency of/ });
  await rc.getByLabel('Reporting currency', { exact: true }).selectOption('EUR');
  await rc.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Switch profile' })).toContainText('EUR');
  await page.goto('/analytics');
  await expect(
    page
      .getByRole('main')
      .getByText(/€1,278\.23|EUR 1,278\.23/)
      .first(),
  ).toBeVisible(); // 2500 / 1.95583
  await shot(page, 'analytics-eur');
  expect(today).toMatch(/^\d{4}-/);
});
