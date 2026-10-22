import { defineConfig, devices } from '@playwright/test';

// Runs against the isolated E2E stack (compose project finplat-e2e; the browser shares the e2e
// gateway's network namespace, so http://localhost:8080) — see scripts/e2e.sh. Never point it at
// the public instance: specs register accounts.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
// admin.spec closes registration for a moment: it runs alone, after the browser projects.
const ADMIN = /admin\.spec\.ts/;

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  // Navigations wait for domcontentloaded: under CPU load Firefox (Juggler) sometimes never reports
  // `load` although every resource finished (seen in traces), and the SPA renders after DOMContentLoaded
  // anyway; assertions auto-wait for the UI. One retry in CI; retried tests are reported as flaky.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'Europe/Sarajevo',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: ADMIN },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: ADMIN },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: ADMIN },
    {
      name: 'admin',
      use: { ...devices['Desktop Chrome'] },
      testMatch: ADMIN,
      dependencies: ['chromium', 'firefox', 'webkit'],
    },
  ],
});
