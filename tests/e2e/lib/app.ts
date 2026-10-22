import { expect, type Page } from '@playwright/test';

export interface AccountSpec {
  name: string;
  type?: string; // account type code, e.g. checking, cash, credit_card
  currency?: string;
  opening?: string; // decimal as typed by a user (en-US format)
}

export async function startOnboarding(page: Page, currency = 'BAM') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('button', { name: 'Next' }).click(); // language & region (en-US)
  await page.getByLabel('Reporting currency').selectOption(currency);
  await page.getByRole('button', { name: 'Next' }).click();
}

export async function addAccounts(page: Page, accounts: AccountSpec[]) {
  await expect(page.getByRole('heading', { name: 'Your accounts' })).toBeVisible();
  for (const a of accounts) {
    await page.getByLabel('Name', { exact: true }).fill(a.name);
    if (a.type) await page.getByLabel('Type').selectOption(a.type);
    if (a.currency) await page.getByLabel('Currency').selectOption(a.currency);
    await page.getByLabel('Opening balance (optional)').fill(a.opening ?? '');
    await page.getByRole('button', { name: 'Add account' }).click();
    await expect(page.getByRole('cell', { name: a.name, exact: true })).toBeVisible();
  }
}

/** Categories → import → dashboard. */
export async function finishOnboarding(page: Page) {
  await page.getByRole('button', { name: /^(Next|Skip)$/ }).click(); // accounts
  await expect(page.getByRole('heading', { name: 'Categories' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: /Import bank statements/ })).toBeVisible();
  await page.getByRole('button', { name: /dashboard|finish|done/i }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

export async function onboardLocal(
  page: Page,
  accounts: AccountSpec[] = [{ name: 'Checking', type: 'checking', opening: '1000.00' }],
  currency = 'BAM',
  profileName = 'Personal',
) {
  await startOnboarding(page, currency);
  await page.getByRole('button', { name: /Local only/ }).click();
  await page.getByLabel('Profile name').fill(profileName);
  await page.getByRole('button', { name: 'Create profile' }).click();
  await addAccounts(page, accounts);
  await finishOnboarding(page);
}

/** Aria snapshot without huge option lists, for debugging. */
export async function snapshot(page: Page) {
  const s = await page.locator('body').ariaSnapshot();
  return s.replace(/(\n\s*- option [^\n]*){6,}/g, '\n      - option …');
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
}

export function uniqueEmail(tag: string) {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

/** Select the first option whose text contains `text` (option labels carry extra context). */
export async function selectByText(page: Page, label: string, text: string) {
  const sel = page.getByLabel(label, { exact: true });
  const value = await sel.evaluate(
    (el, t) =>
      [...(el as HTMLSelectElement).options].find((o) => o.textContent?.includes(t as string))
        ?.value,
    text,
  );
  if (value === undefined) throw new Error(`no option containing "${text}" in ${label}`);
  await sel.selectOption(value);
}

export interface EntrySpec {
  kind: 'expense' | 'income' | 'transfer';
  account: string;
  to?: string;
  category?: string;
  amount: string;
  date?: string;
  description?: string;
  received?: string; // cross-currency transfer: amount received in the destination currency
}

/** Adds a transaction through the transactions page entry dialog. */
export async function addTransaction(page: Page, e: EntrySpec) {
  await page.goto(`/transactions?new=${e.kind}`);
  const dlg = page.getByRole('dialog', { name: 'New transaction' });
  await expect(dlg).toBeVisible();
  await selectByText(page, e.kind === 'transfer' ? 'From account' : 'Account', e.account);
  if (e.to) await selectByText(page, 'To account', e.to);
  if (e.category) await selectByText(page, 'Category', e.category);
  await dlg.getByLabel('Amount', { exact: true }).fill(e.amount);
  if (e.date) await dlg.getByLabel('Date', { exact: true }).fill(e.date);
  if (e.received) {
    await dlg.getByLabel('Amount received (bank)').check();
    await dlg.getByLabel(/^Received \(/).fill(e.received);
  }
  if (e.description) await dlg.getByLabel('Description', { exact: true }).fill(e.description);
  await dlg.getByRole('button', { name: `Add ${e.kind}` }).click();
  await expect(dlg).toBeHidden();
}

export const PASSWORD = 'correct horse battery staple';

/** Onboarding in connected mode against the app's own origin. register=false signs in. */
export async function onboardConnected(page: Page, email: string, register: boolean) {
  await startOnboarding(page);
  await page.getByRole('button', { name: /Connect to server/ }).click();
  const url = page.getByLabel('Server URL');
  await url.fill(new URL(page.url()).origin);
  await page.getByRole('button', { name: 'Check server' }).click();
  await page.getByLabel(/I trust .* with my financial data/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  if (register) await page.getByRole('tab', { name: 'Create account' }).click();
  const panel = page.getByRole('tabpanel');
  await panel.getByLabel('Email').fill(email);
  if (register) await panel.getByLabel('Display name (optional)').fill('E2E user');
  await panel.getByLabel('Password').fill(PASSWORD);
  await panel.getByRole('button', { name: register ? 'Create account' : 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a profile' })).toBeVisible();
  await page.getByRole('button', { name: 'Use' }).first().click();
}

/** Opens the sync page and runs a sync; returns when nothing is waiting to upload. */
export async function syncNow(page: Page) {
  await page.goto('/sync');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('main')).toContainText(/Waiting to upload\s*0/);
}
