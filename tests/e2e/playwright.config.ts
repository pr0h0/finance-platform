import { defineConfig, devices } from '@playwright/test';

// Runs against the production-like stack (gateway on 127.0.0.1:3810) — see scripts/e2e.sh.
export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3810',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'Europe/Sarajevo',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
