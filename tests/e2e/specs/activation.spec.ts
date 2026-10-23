import { expect, type Page, test } from '@playwright/test';
import {
  addTransaction,
  currentProfileId,
  finishOnboarding,
  onboardConnected,
  onboardLocal,
  PASSWORD,
  startActivation,
  syncNow,
  uniqueEmail,
} from '../lib/app';

async function serverState(page: Page) {
  const pid = await currentProfileId(page);
  return page.evaluate(async (pid) => {
    const h = { 'X-Profile-ID': pid };
    const j = (u: string) => fetch(u, { headers: h }).then((r) => r.json());
    return {
      accounts: (await j('/api/v1/accounts')).items.map((a: { name: string }) => a.name),
      txs: (await j('/api/v1/transactions?limit=50')).items.map(
        (t: { description: string }) => t.description,
      ),
      balances: JSON.stringify(await j('/api/v1/balances?currency=BAM')),
    };
  }, pid);
}

test('activate a local profile: dedupe preview, merge, upload, verify, connected mode', async ({
  page,
}) => {
  await onboardLocal(page, [{ name: 'Checking', type: 'checking', opening: '1000.00' }]);
  await addTransaction(page, {
    kind: 'expense',
    account: 'Checking',
    category: 'Groceries',
    amount: '25.00',
    description: 'Local groceries',
  });

  // The server already holds this profile with an account of the same name (e.g. made on another
  // device): register, create both through the API, then activate by signing in.
  const email = uniqueEmail('activate');
  const pid = await currentProfileId(page);
  // in-page fetches: the browser's own cookie jar holds the session for the activation
  const statuses = await page.evaluate(
    async ({ email, password, pid }) => {
      const post = (u: string, body: unknown, h: Record<string, string> = {}) =>
        fetch(u, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...h },
          body: JSON.stringify(body),
        });
      const reg = await post('/api/v1/auth/register', { email, password });
      const login = await post('/api/v1/auth/login', { email, password });
      const csrf = (await login.json()).csrfToken as string;
      const prof = await post(
        '/api/v1/profiles',
        { id: pid, name: 'Personal', baseCurrency: 'BAM' },
        { 'X-CSRF-Token': csrf },
      );
      const acc = await post(
        '/api/v1/accounts',
        { name: 'Checking', accountType: 'checking', currency: 'BAM' },
        { 'X-CSRF-Token': csrf, 'X-Profile-ID': pid },
      );
      return [reg.status, prof.status, acc.status];
    },
    { email, password: PASSWORD, pid },
  );
  expect(statuses).toEqual([201, 201, 201]);

  await startActivation(page, email, false);
  await page.getByRole('button', { name: 'Preview upload' }).click();
  const dup = page.getByRole('group', { name: 'These look like records already on the server' });
  await expect(dup).toBeVisible();
  const merge = dup.getByRole('checkbox', { name: /accounts: Checking/ });
  await merge.check();
  await expect(page.getByRole('row', { name: /^transactions/ })).toBeVisible();
  await page.getByRole('button', { name: 'Upload and verify' }).click();
  await expect(page.getByText(/: verified/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Switch to connected mode' }).click();
  await expect(page.getByText('Connected').first()).toBeVisible();

  const s = await serverState(page);
  expect(s.accounts).toEqual(['Checking']); // merged, not uploaded twice
  expect(s.txs).toContain('Local groceries');
  expect(s.balances).toContain('975.00');
  await page.goto('/transactions', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('row', { name: /Local groceries/ })).toBeVisible();
});

test('connect a device with local data to an account that has data: nothing uploaded by default', async ({
  page,
}) => {
  await onboardLocal(page, [{ name: 'Test wallet', type: 'cash', opening: '5.00' }]);
  const email = uniqueEmail('connect-only');
  // the account already has its own profile (another id: made on another device)
  const statuses = await page.evaluate(
    async ({ email, password }) => {
      const post = (u: string, body: unknown, h: Record<string, string> = {}) =>
        fetch(u, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...h },
          body: JSON.stringify(body),
        });
      const reg = await post('/api/v1/auth/register', { email, password });
      const login = await post('/api/v1/auth/login', { email, password });
      const csrf = (await login.json()).csrfToken as string;
      const prof = await post(
        '/api/v1/profiles',
        { name: 'From server', baseCurrency: 'BAM' },
        { 'X-CSRF-Token': csrf },
      );
      return [reg.status, prof.status];
    },
    { email, password: PASSWORD },
  );
  expect(statuses).toEqual([201, 201]);

  await startActivation(page, email, false);
  const local = page.getByRole('checkbox', { name: /Personal/ });
  await expect(local).not.toBeChecked();
  await page.getByRole('button', { name: 'Connect without uploading' }).click();
  await expect(page.getByText('Connected').first()).toBeVisible();
  await expect(page.getByText('From server').first()).toBeVisible();
  const accounts = await page.evaluate(async () => {
    const profiles = (await (await fetch('/api/v1/profiles')).json()).items as { id: string }[];
    return (
      await (
        await fetch('/api/v1/accounts', { headers: { 'X-Profile-ID': profiles[0].id } })
      ).json()
    ).items.length;
  });
  expect(accounts).toBe(0); // the local "Test wallet" was not uploaded
});

test('E2EE profile: encrypt on device A, enroll and decrypt on B (passphrase) and C (recovery code)', async ({
  browser,
}) => {
  const email = uniqueEmail('e2ee');
  const a = await browser.newContext();
  const pa = await a.newPage();
  await onboardLocal(pa, [{ name: 'Secret bank', type: 'checking', opening: '640.00' }]);
  await addTransaction(pa, {
    kind: 'expense',
    account: 'Secret bank',
    amount: '12.00',
    description: 'Encrypted lunch',
  });
  await startActivation(pa, email);
  await pa.getByRole('checkbox', { name: /End-to-end encrypt new server profiles/ }).check();
  const passphrase = 'long secret passphrase 42';
  await pa.getByLabel('Encryption passphrase').fill(passphrase);
  await pa.getByLabel('Repeat').fill(passphrase);
  await pa.getByRole('button', { name: 'Preview upload' }).click();
  const notice = pa.getByRole('alert').filter({ hasText: 'Recovery code' });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  const recovery = ((await notice.locator('li').first().textContent()) ?? '')
    .split(': ')
    .pop()
    ?.trim() as string;
  expect(recovery.length).toBeGreaterThan(10);
  await pa.getByRole('button', { name: 'Upload and verify' }).click();
  await expect(pa.getByText(/: verified/)).toBeVisible({ timeout: 60_000 });
  await pa.getByRole('button', { name: 'Switch to connected mode' }).click();
  await expect(pa.getByText('Connected').first()).toBeVisible();

  // the server stores ciphertext only
  const pid = await currentProfileId(pa);
  const raw = await pa.evaluate(async (pid) => {
    const p = (await (await fetch('/api/v1/profiles')).json()).items.find(
      (x: { id: string }) => x.id === pid,
    );
    const pull = await (
      await fetch('/api/v1/sync/pull?since=0&limit=500', { headers: { 'X-Profile-ID': p.id } })
    ).text();
    return { mode: p.privacyMode as string, pull };
  }, pid);
  expect(raw.mode).toBe('e2ee');
  expect(raw.pull).not.toContain('Encrypted lunch');
  expect(raw.pull).not.toContain('Secret bank');

  async function device(secretKind: 'passphrase' | 'recoveryCode', secret: string) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await onboardConnected(p, email, false, /E2EE/);
    await finishOnboarding(p).catch(() => undefined);
    await p.goto('/sync', { waitUntil: 'domcontentloaded' });
    const card = p.getByRole('region', { name: /^Unlock/ });
    await expect(card).toBeVisible();
    await card.getByLabel('Unlock with').selectOption(secretKind);
    await card.getByLabel('Secret').fill('wrong secret value');
    await card.getByRole('button', { name: 'Unlock' }).click();
    await expect(p.getByText('Wrong passphrase or recovery code.')).toBeVisible();
    await card.getByLabel('Secret').fill(secret);
    await card.getByRole('button', { name: 'Unlock' }).click();
    await expect(p.getByText('Profile unlocked on this device')).toBeVisible({ timeout: 30_000 });
    await syncNow(p);
    await p.goto('/transactions', { waitUntil: 'domcontentloaded' });
    await expect(p.getByRole('row', { name: /Encrypted lunch/ })).toBeVisible();
    return { ctx, p };
  }

  const b = await device('passphrase', passphrase);
  // enrolled: B unlocks by itself after a reload
  await b.p.reload({ waitUntil: 'domcontentloaded' });
  await b.p.goto('/sync', { waitUntil: 'domcontentloaded' });
  await expect(b.p.getByRole('region', { name: /^Unlock/ })).toBeHidden();

  // new data encrypted on A is decrypted on B
  await addTransaction(pa, {
    kind: 'expense',
    account: 'Secret bank',
    amount: '3.30',
    description: 'Second secret',
  });
  await syncNow(pa);
  await syncNow(b.p);
  await b.p.goto('/transactions', { waitUntil: 'domcontentloaded' });
  await expect(b.p.getByRole('row', { name: /Second secret/ })).toBeVisible();

  const c = await device('recoveryCode', recovery);
  await expect(c.p.getByRole('row', { name: /Second secret/ })).toBeVisible();
  await a.close();
  await b.ctx.close();
  await c.ctx.close();
});
