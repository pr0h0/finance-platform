import { expect, type Page } from '@playwright/test';

export interface AccountSpec {
  name: string;
  type?: string; // account type code, e.g. checking, cash, credit_card
  currency?: string;
  opening?: string; // decimal as typed by a user (en-US format)
}

export async function startOnboarding(page: Page, currency = 'BAM') {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
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
  const browser = page.context().browser()?.browserType().name() ?? 'browser';
  await page.screenshot({ path: `screenshots/${browser}/${name}.png`, fullPage: true });
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
  await page.goto(`/transactions?new=${e.kind}`, { waitUntil: 'domcontentloaded' });
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
export async function onboardConnected(
  page: Page,
  email: string,
  register: boolean,
  profile?: RegExp, // which profile to use (default: the first)
) {
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
  await panel
    .getByRole('button', { name: register ? 'Create account' : 'Sign in', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Choose a profile' })).toBeVisible();
  const rows = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Use' }) });
  await (profile ? rows.filter({ hasText: profile }) : rows)
    .first()
    .getByRole('button', { name: 'Use' })
    .click();
}

/** Opens the sync page and runs a sync; returns when nothing is waiting to upload. */
export async function syncNow(page: Page) {
  await page.goto('/sync', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('main')).toContainText(/Waiting to upload\s*0/);
  await expect(page.getByRole('main')).not.toContainText('Never synchronized', { timeout: 30_000 });
}

/** Draws a receipt image in the page and attaches it through the open drawer's file input. */
export async function attachReceipt(page: Page, lines: string[]) {
  const input = page.locator('dialog[open] input[type=file]');
  await input.waitFor({ state: 'attached' });
  const png = await page.evaluate(async (ls) => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 80 + ls.length * 70;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    g.font = 'bold 44px sans-serif';
    ls.forEach((l, i) => {
      g.fillText(l, 30, 80 + i * 70);
    });
    return c.toDataURL('image/png').split(',')[1] as string;
  }, lines);
  await input.setInputFiles({
    name: 'receipt.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
}

/** axe-core WCAG 2.x A/AA scan of the current page; returns serious/critical violations. */
export async function seriousA11yViolations(page: Page) {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 5)
          .join(' | ')}`,
    );
}

export const ADMIN_EMAIL = 'admin@e2e.test'; // registered first by scripts/e2e.sh

/** CSRF token of the page's cookie session, for page.request mutations. */
export async function csrf(page: Page): Promise<string> {
  const s = await (await page.request.get('/api/v1/auth/session')).json();
  return s.csrfToken as string;
}

/** Settings → Connect to server: server check and account step of the activation flow. */
export async function startActivation(page: Page, email: string, register = true) {
  await page.goto('/settings?tab=connection', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect to server' }).last().click();
  await page.getByLabel('Server URL').fill(new URL(page.url()).origin);
  await page.getByRole('button', { name: 'Check server' }).click();
  await page.getByLabel(/I trust .* with my financial data/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  if (register) await page.getByRole('tab', { name: 'Create account' }).click();
  const panel = page.getByRole('tabpanel').last();
  await panel.getByLabel('Email').fill(email);
  await panel.getByLabel('Password').fill(PASSWORD);
  await panel
    .getByRole('button', { name: register ? 'Create account' : 'Sign in', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Preview upload' })).toBeVisible();
}

/** Profile currently selected in the app (persisted app state). */
export async function currentProfileId(page: Page): Promise<string> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('finplat:app') ?? '{}').state.profileId,
  );
}
