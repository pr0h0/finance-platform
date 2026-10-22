import { expect, test } from '@playwright/test';
import {
  ADMIN_EMAIL,
  addTransaction,
  finishOnboarding,
  onboardConnected,
  onboardLocal,
  seriousA11yViolations,
} from '../lib/app';

// Every main page, scanned by axe-core after it rendered: no serious or critical WCAG A/AA issue.
const LOCAL_PAGES = [
  '/',
  '/transactions',
  '/transactions?tab=inbox',
  '/planning',
  '/budgets',
  '/analytics',
  '/accounts',
  '/goals',
  '/subscriptions',
  '/import',
  '/import?tab=mapping',
  '/rules',
  '/reports',
  '/converter',
  '/settings',
  '/settings?tab=security',
  '/notifications',
  '/sync',
];
const SERVER_PAGES = ['/household', '/devices', '/agents', '/admin', '/settings?tab=notifications'];

async function scan(page: import('@playwright/test').Page, paths: string[]) {
  const found: string[] = [];
  for (const p of paths) {
    await page.goto(p);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    for (const v of await seriousA11yViolations(page)) found.push(`${p}: ${v}`);
  }
  return found;
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`accessibility (${colorScheme}): local-mode pages have no serious/critical axe violations`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ colorScheme });
    const page = await ctx.newPage();
    await onboardLocal(page);
    await addTransaction(page, {
      kind: 'expense',
      account: 'Checking',
      category: 'Groceries',
      amount: '12.30',
      description: 'Market',
    });
    expect(await scan(page, LOCAL_PAGES)).toEqual([]);
    await ctx.close();
  });
}

test('accessibility: server pages (household, devices, agents, admin) as the admin', async ({
  page,
}) => {
  await onboardConnected(page, ADMIN_EMAIL, false);
  await finishOnboarding(page);
  expect(await scan(page, SERVER_PAGES)).toEqual([]);
});
