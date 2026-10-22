import { expect, test } from '@playwright/test';
import { addTransaction, onboardLocal } from '../lib/app';

const PASS = 'a long backup passphrase 42';

test('encrypted backup export and restore on a fresh device', async ({ browser }) => {
  const a = await browser.newContext();
  const pa = await a.newPage();
  await onboardLocal(pa, [{ name: 'Backup bank', type: 'checking', opening: '321.00' }]);
  await addTransaction(pa, {
    kind: 'expense',
    account: 'Backup bank',
    category: 'Fuel',
    amount: '21.00',
    description: 'Petrol station',
  });
  await pa.goto('/settings?tab=backups');
  const exp = pa.getByRole('region', { name: 'Export encrypted backup' });
  await exp.getByLabel('Backup passphrase').fill(PASS);
  await exp.getByLabel('Repeat').fill(PASS);
  const dl = pa.waitForEvent('download');
  await exp.getByRole('button', { name: 'Create and download' }).click();
  const file = test.info().outputPath('backup.finplat');
  await (await dl).saveAs(file);
  await expect(pa.getByText('No backup yet')).toHaveCount(0);
  await a.close();

  // a new browser profile = an empty device
  const b = await browser.newContext();
  const pb = await b.newPage();
  await onboardLocal(pb, [{ name: 'Other', type: 'cash' }], 'BAM', 'Other device');
  await pb.goto('/settings?tab=backups');
  const res = pb.getByRole('region', { name: 'Restore from backup' });
  await res.locator('input[type=file]').setInputFiles(file);
  await res.getByLabel('Backup passphrase').fill(PASS);
  await res.getByRole('button', { name: 'Restore' }).click();
  await expect(pb.getByText(/Backup restored: 1 profiles/)).toBeVisible();

  await pb.reload();
  await expect(pb.getByRole('button', { name: 'Switch profile' })).toBeVisible();
  await pb.getByRole('button', { name: 'Switch profile' }).click();
  await pb
    .getByRole('menuitem', { name: /Personal/ })
    .first()
    .click();
  await pb.goto('/transactions');
  await expect(pb.getByRole('row', { name: /Petrol station/ })).toBeVisible();
  await pb.goto('/accounts');
  await expect(pb.getByRole('main').getByText('BAM 300.00').first()).toBeVisible();
  await b.close();
});
