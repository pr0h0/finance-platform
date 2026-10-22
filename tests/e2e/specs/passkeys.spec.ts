import { expect, test } from '@playwright/test';
import { finishOnboarding, onboardConnected, startOnboarding, uniqueEmail } from '../lib/app';

// Chromium's virtual authenticator (CDP WebAuthn domain) stands in for a platform authenticator.
test('passkeys: add in settings, sign out, sign in with the passkey, remove it', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the CDP virtual authenticator exists only in Chromium');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const email = uniqueEmail('passkey');
  await onboardConnected(page, email, true);
  await finishOnboarding(page);

  await page.goto('/settings?tab=security');
  await page.getByLabel('Name for the new passkey').fill('E2E key');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByRole('cell', { name: /^E2E key/ })).toBeVisible();
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  expect(credentials[0]?.isResidentCredential).toBe(true);

  // rename
  await page.getByRole('button', { name: 'Rename E2E key' }).click();
  const rename = page.getByRole('textbox', { name: 'Passkey name' });
  await rename.fill('Laptop key');
  await rename.press('Enter');
  await expect(page.getByRole('cell', { name: /^Laptop key/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Never' })).toBeVisible();

  // sign out, forget this browser's app state, then sign in from onboarding with the passkey
  // (after sign-out the app shows onboarding again: there is no stored profile list to fall back on)
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect
    .poll(() => page.evaluate(() => fetch('/api/v1/auth/session').then((r) => r.status)))
    .toBe(401);
  await page.evaluate(async () => {
    localStorage.clear();
    for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
  });
  await startOnboarding(page);
  await page.getByRole('button', { name: /Connect to server/ }).click();
  await page.getByLabel('Server URL').fill(new URL(page.url()).origin);
  await page.getByRole('button', { name: 'Check server' }).click();
  await page.getByLabel(/I trust .* with my financial data/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  // Conditional mediation (autofill): the virtual authenticator answers the pending request without a
  // click on "Sign in with passkey", so reaching the next step proves the autofill path.
  await expect(
    page.getByRole('tabpanel').getByRole('button', { name: 'Sign in with passkey' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose a profile' })).toBeVisible();
  const session = await page.evaluate(() => fetch('/api/v1/auth/session').then((r) => r.json()));
  expect(session.user.email).toBe(email);
  await page.getByRole('button', { name: 'Use' }).first().click();
  await finishOnboarding(page);

  // last used is recorded; remove the passkey (the password still signs in)
  await page.goto('/settings?tab=security');
  await expect(page.getByRole('cell', { name: /^Laptop key/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Never' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove Laptop key' }).click();
  await page
    .getByRole('dialog', { name: 'Remove passkey?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByRole('cell', { name: /^Laptop key/ })).toHaveCount(0);
  const list = await page.evaluate(() => fetch('/api/v1/auth/passkeys').then((r) => r.json()));
  expect(list.items).toEqual([]);
});
