import { expect, test } from '@playwright/test';
import {
  addAccounts,
  csrf,
  finishOnboarding,
  onboardConnected,
  syncNow,
  uniqueEmail,
} from '../lib/app';

test('household: invite, accept, shared profile visible to the member, viewer cannot write', async ({
  browser,
}) => {
  const ownerEmail = uniqueEmail('hh-owner');
  const memberEmail = uniqueEmail('hh-member');

  const a = await browser.newContext();
  const pa = await a.newPage();
  await onboardConnected(pa, ownerEmail, true);
  await addAccounts(pa, [{ name: 'Family account', type: 'checking', opening: '2500.00' }]);
  await finishOnboarding(pa);
  await syncNow(pa);

  const b = await browser.newContext();
  const pb = await b.newPage();
  await onboardConnected(pb, memberEmail, true);
  await finishOnboarding(pb);

  // owner: create the household, invite the member, share the profile with the household
  await pa.goto('/household', { waitUntil: 'domcontentloaded' });
  await pa.getByRole('region', { name: 'New household' }).getByLabel('Name').fill('Home');
  await pa
    .getByRole('region', { name: 'New household' })
    .getByRole('button', { name: 'Add' })
    .click();
  const home = pa.getByRole('region', { name: 'Home' });
  await expect(home).toBeVisible();
  await home.getByLabel('Invite by email').fill(memberEmail);
  await home.getByLabel('Role').last().selectOption('member');
  await home.getByRole('button', { name: 'Invite' }).click();
  const token = (await home.locator('code').first().textContent())?.trim() as string;
  expect(token.length).toBeGreaterThan(10);
  await pa.getByLabel('Share with household').selectOption({ label: 'Home' });
  await expect(pa.getByText(/Shared within “Home”/)).toBeVisible();

  // member: accept the invitation
  await pb.goto('/household', { waitUntil: 'domcontentloaded' });
  await pb.getByLabel('Invitation token').fill(token);
  await pb.getByRole('button', { name: 'Join' }).click();
  await expect(pb.getByText('You joined the household')).toBeVisible();
  await expect(pb.getByRole('region', { name: 'Home' })).toBeVisible();

  // owner: the member is active; give them viewer access to the shared profile
  await pa.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    pa.getByRole('region', { name: 'Home' }).getByRole('row', { name: new RegExp(memberEmail) }),
  ).toContainText('active');
  await pa.getByRole('button', { name: /access \(viewer\)/ }).click();
  await expect(pa.getByRole('row', { name: new RegExp(memberEmail) }).last()).toContainText(
    'viewer',
  );

  // member: the shared profile shows up with the owner's data
  // The row already says "viewer" in its own button label, so wait for the grant on the server.
  const viewerProfile = () =>
    pb.evaluate(async () => {
      const r = await (await fetch('/api/v1/profiles')).json();
      return r.items.find((p: { role: string }) => p.role === 'viewer') as
        | { id: string }
        | undefined;
    });
  await expect.poll(viewerProfile).toBeTruthy();
  const shared = (await viewerProfile()) as { id: string };
  await pb.reload({ waitUntil: 'domcontentloaded' });
  await pb.getByRole('button', { name: 'Switch profile' }).click();
  await pb.getByRole('menuitem').filter({ hasText: 'viewer' }).click();
  await syncNow(pb);
  await pb.goto('/accounts', { waitUntil: 'domcontentloaded' });
  await expect(pb.getByRole('main').getByText('Family account')).toBeVisible();

  // role limits: a viewer cannot change the shared profile, and cannot manage the household
  const token2 = await csrf(pb);
  const write = await pb.request.post('/api/v1/accounts', {
    headers: { 'X-Profile-ID': shared.id, 'X-CSRF-Token': token2 },
    data: { name: 'Sneaky', accountType: 'cash', currency: 'BAM' },
  });
  expect(write.status()).toBe(403);
  const hh = await (await pb.request.get('/api/v1/households')).json();
  const invite = await pb.request.post(`/api/v1/households/${hh.items[0].id}/invitations`, {
    headers: { 'X-CSRF-Token': token2 },
    data: { email: uniqueEmail('hh-third'), role: 'member' },
  });
  expect(invite.status()).toBe(403);
  await a.close();
  await b.close();
});
