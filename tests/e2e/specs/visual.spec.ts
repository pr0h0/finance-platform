import { expect, test } from '@playwright/test';
import { addTransaction, onboardLocal, shot } from '../lib/app';

const PAGES = [
  '/',
  '/transactions',
  '/accounts',
  '/planning',
  '/budgets',
  '/analytics',
  '/import',
  '/settings',
  '/goals',
  '/subscriptions',
  '/rules',
  '/reports',
  '/converter',
  '/notifications',
  '/sync',
  '/household',
  '/devices',
  '/agents',
];

for (const v of [
  { name: 'mobile-dark', viewport: { width: 360, height: 780 }, colorScheme: 'dark' as const },
  { name: 'desktop-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' as const },
]) {
  test(`layout: ${v.name}, no horizontal page scroll, no page errors`, async ({
    browser,
    browserName,
  }) => {
    const mobile = v.viewport.width < 500 && browserName !== 'firefox'; // Firefox has no isMobile
    const ctx = await browser.newContext({
      viewport: v.viewport,
      colorScheme: v.colorScheme,
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await onboardLocal(page, [{ name: 'Checking', type: 'checking', opening: '1000.00' }]);
    await addTransaction(page, {
      kind: 'expense',
      account: 'Checking',
      category: 'Groceries',
      amount: '64.20',
      description: 'Groceries',
    });
    for (const p of PAGES) {
      await page.goto(p, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      const culprits =
        overflow > 1
          ? await page.evaluate(() =>
              [...document.querySelectorAll('body *')]
                .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
                .slice(-5)
                .map((e) => `${e.tagName}.${e.className}`.slice(0, 120)),
            )
          : [];
      expect(overflow, `horizontal overflow on ${p}: ${culprits.join(' | ')}`).toBeLessThanOrEqual(
        1,
      );
      await shot(page, `${v.name}${p.replace(/\//g, '_') || '_'}`);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  });
}
