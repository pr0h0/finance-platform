import { expect, test } from '@playwright/test';
import {
  addAccounts,
  addTransaction,
  csrf,
  currentProfileId,
  finishOnboarding,
  onboardConnected,
  syncNow,
  uniqueEmail,
} from '../lib/app';

const MAILPIT = 'http://mailpit:8025'; // SMTP sink of the e2e stack (docker-compose.e2e.yml)

test('PDF report export keeps Bosnian letters (č ć đ š ž, Č Ć Đ Š Ž)', async ({ page }) => {
  await onboardConnected(page, uniqueEmail('pdf'), true);
  await addAccounts(page, [{ name: 'Tekući račun', type: 'checking', opening: '500.00' }]);
  await finishOnboarding(page);
  const pid = await currentProfileId(page);
  const name = 'Čevapi, ćufte, đuveč, šljive i žito ČĆĐŠŽ';
  const cat = await page.request.post('/api/v1/categories', {
    headers: { 'X-Profile-ID': pid, 'X-CSRF-Token': await csrf(page) },
    data: { name, kind: 'expense' },
  });
  expect(cat.status()).toBe(201);
  await syncNow(page);
  const today = new Date().toISOString().slice(0, 10);
  await addTransaction(page, {
    kind: 'expense',
    account: 'Tekući',
    category: 'Čevapi',
    amount: '23.40',
    date: today,
    description: 'Ručak',
  });
  await syncNow(page);

  const res = await page.request.get(
    `/api/v1/reports/monthly?format=pdf&from=${today.slice(0, 8)}01`,
    {
      headers: { 'X-Profile-ID': pid },
    },
  );
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.body()) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    text += c.items.map((x) => ('str' in x ? x.str : '')).join(' ');
  }
  expect(text).toContain(name);
  expect(text).toContain('23.40');
});

test('notification preferences: email channel on, test email arrives in the mailbox', async ({
  page,
}) => {
  const email = uniqueEmail('mail');
  await onboardConnected(page, email, true);
  await finishOnboarding(page);
  await page.goto('/settings?tab=notifications', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(`Sent to ${email}`)).toBeVisible();
  await page.getByRole('switch', { name: 'Email notifications' }).click();
  await page.getByRole('checkbox', { name: /Budget alerts.* — email/ }).check();
  await page.getByRole('checkbox', { name: /Sync conflicts — email/ }).uncheck();
  await page.getByLabel('From').fill('22:00');
  await page.getByLabel('Until').fill('07:00');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved').first()).toBeVisible();

  const prefs = await (await page.request.get('/api/v1/notifications/preferences')).json();
  expect(prefs.email.enabled).toBe(true);
  expect(prefs.email.budgets).toBe(true);
  expect(prefs.email.sync).toBe(false);
  expect(prefs.quietHoursStart).toBe('22:00');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('switch', { name: 'Email notifications' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.getByRole('button', { name: 'Send test email' }).click();
  await expect(page.getByText('Test notification sent')).toBeVisible();
  await expect
    .poll(
      async () => {
        const r = await page.request.get(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
        );
        return r.ok() ? ((await r.json()).messages ?? []).length : -1;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  const msg = (
    await (
      await page.request.get(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
      )
    ).json()
  ).messages[0];
  const full = await (await page.request.get(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
  expect(full.From.Address).toBe('finance@e2e.test');
  expect(full.Text.length).toBeGreaterThan(10);
});
