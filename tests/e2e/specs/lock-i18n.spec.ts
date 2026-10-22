import { expect, test } from '@playwright/test';
import { addTransaction, onboardLocal } from '../lib/app';

test('app lock: set a PIN, lock, wrong PIN refused, unlock; survives a reload', async ({
  page,
}) => {
  await onboardLocal(page);
  await page.goto('/settings?tab=security', { waitUntil: 'domcontentloaded' });
  const card = page.getByRole('region', { name: 'App lock' });
  await card.getByLabel('Type').selectOption('pin');
  await card.getByLabel('PIN or password').fill('482915');
  await card.getByLabel('Repeat').fill('482915');
  await card.getByRole('button', { name: 'Enable lock' }).click();
  await expect(page.getByText('App lock enabled')).toBeVisible();

  await page.getByRole('button', { name: 'Lock app' }).click();
  await expect(page.getByRole('heading', { name: 'App locked' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeHidden();
  await page.getByLabel('PIN').fill('000000');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Wrong PIN or password.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'App locked' })).toBeVisible();
  await page.getByLabel('PIN').fill('482915');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'App locked' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

  // reopening the app asks again
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'App locked' })).toBeVisible();
  await page.getByLabel('PIN').fill('482915');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
});

test('Bosnian: switching the language translates the UI and uses bs-BA number format', async ({
  page,
}) => {
  await onboardLocal(page, [{ name: 'Tekući', type: 'checking', opening: '1234.56' }]);
  await addTransaction(page, {
    kind: 'expense',
    account: 'Tekući',
    amount: '0.50',
    description: 'Žvake',
  });
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Language', { exact: true }).selectOption('bs');
  await page.getByLabel('Format brojeva i datuma').selectOption('bs-BA');
  await expect(page.getByLabel('Format brojeva i datuma')).toHaveValue('bs-BA');
  await expect(page.getByText(/-1\.234\.567,89/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Postavke', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation').first()).toContainText('Transakcije');
  await page.goto('/accounts', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Računi', level: 1 })).toBeVisible();
  // 1234.56 − 0.50 = 1.234,06 KM (dot for thousands, comma for decimals)
  await expect(page.getByRole('main')).toContainText(/1\.234,06\s?KM/);
  await page.goto('/transactions', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('row', { name: /Žvake/ })).toContainText(/-0,50\s?KM|−0,50\s?KM/);
  // Data warnings (history starts today, so earlier periods are empty) are Bosnian too.
  for (const path of ['/analytics', '/reports']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('status').filter({ hasText: 'Evidentirana historija počinje' }).first(),
    ).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('Recorded history');
  }
});
