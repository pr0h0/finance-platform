import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, finishOnboarding, onboardConnected, PASSWORD, uniqueEmail } from '../lib/app';

// Runs in its own Playwright project after the browser projects: it closes registration for a
// moment, which would break specs that register accounts in parallel.
test('admin: users (create, disable, enable), registration policy, diagnostics, audit', async ({
  page,
  playwright,
}) => {
  await onboardConnected(page, ADMIN_EMAIL, false);
  await finishOnboarding(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible();

  // users
  const email = uniqueEmail('admin-made');
  const create = page.getByRole('region', { name: 'Create account' });
  await create.getByLabel('Email').fill(email);
  await create.getByLabel('Initial password (12+)').fill(PASSWORD);
  await create.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Account created; hand the password to the user.')).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(email) });
  await expect(row).toContainText('active');
  await expect(page.getByRole('row', { name: new RegExp(ADMIN_EMAIL) })).toContainText('admin');

  const api = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
  const login = () => api.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  expect((await login()).status()).toBe(200);
  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(row).toContainText('disabled');
  expect((await login()).status()).toBeGreaterThanOrEqual(400);
  await row.getByRole('button', { name: 'Enable' }).click();
  await expect(row).toContainText('active');
  expect((await login()).status()).toBe(200);

  // registration policy: closed refuses sign-ups, open allows them again
  await page.getByRole('tab', { name: 'Server' }).click();
  const policy = page.getByLabel('Registration');
  const register = (tag: string) =>
    api.post('/api/v1/auth/register', { data: { email: uniqueEmail(tag), password: PASSWORD } });
  try {
    await policy.selectOption('closed');
    await expect(page.getByText('Saved')).toBeVisible();
    await expect
      .poll(async () => (await (await api.get('/api/v1/meta')).json()).registrationPolicy)
      .toBe('closed');
    expect((await register('closed')).status()).toBe(403);
  } finally {
    await policy.selectOption('open');
  }
  await expect
    .poll(async () => (await (await api.get('/api/v1/meta')).json()).registrationPolicy)
    .toBe('open');
  expect((await register('open')).status()).toBe(201);

  // diagnostics: database reachable, versions shown
  const diag = page.getByRole('region', { name: 'Diagnostics' });
  await expect(diag.getByText('OK').first()).toBeVisible();
  await expect(diag).toContainText(/sync v1/);
  await expect(page.getByRole('region', { name: 'Statistics' })).toBeVisible();

  // the server-wide audit log records the admin's changes
  await page.getByRole('tab', { name: 'Audit log' }).click();
  await expect(page.getByRole('main')).toContainText(/admin\.|user/);
  await api.dispose();
});
