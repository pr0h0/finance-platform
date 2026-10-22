import { expect, test } from '@playwright/test';
import {
  addAccounts,
  finishOnboarding,
  onboardConnected,
  PASSWORD,
  syncNow,
  uniqueEmail,
} from '../lib/app';

test('sign out keeps local data; an existing account skips setup on a new device', async ({
  browser,
}) => {
  const email = uniqueEmail('signout');
  const a = await browser.newContext();
  const pa = await a.newPage();
  await onboardConnected(pa, email, true);
  await addAccounts(pa, [{ name: 'Kept bank', type: 'checking', opening: '250.00' }]);
  await finishOnboarding(pa);
  await syncNow(pa);

  // sign out from the profile menu: still in the app, data still here, banner offers sign-in
  await pa.getByRole('button', { name: 'Switch profile' }).click();
  await pa.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(pa.getByText('Your server session ended')).toBeVisible();
  await pa.goto('/accounts', { waitUntil: 'domcontentloaded' });
  await expect(pa.getByRole('main')).toContainText('Kept bank');
  expect(await pa.evaluate(() => fetch('/api/v1/auth/session').then((r) => r.status))).toBe(401);

  await pa.getByRole('button', { name: 'Sign in again' }).first().click();
  const dlg = pa.getByRole('dialog', { name: 'Sign in again' });
  await dlg.getByLabel('Password').fill(PASSWORD);
  await dlg.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(pa.getByText('Your server session ended')).toBeHidden();

  // new device: "I already have an account" goes to sign-in, the synced profile opens the dashboard
  const b = await browser.newContext();
  const pb = await b.newPage();
  await pb.goto('/', { waitUntil: 'domcontentloaded' });
  await pb.getByRole('button', { name: 'I already have an account' }).click();
  const panel = pb.getByRole('tabpanel');
  await panel.getByLabel('Email').fill(email);
  await panel.getByLabel('Password').fill(PASSWORD);
  await panel.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(pb.getByRole('heading', { name: 'Choose a profile' })).toBeVisible();
  await pb.getByRole('button', { name: 'Use' }).first().click();
  await expect(pb.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await pb.goto('/accounts', { waitUntil: 'domcontentloaded' });
  await expect(pb.getByRole('main')).toContainText('Kept bank');
  await a.close();
  await b.close();
});
