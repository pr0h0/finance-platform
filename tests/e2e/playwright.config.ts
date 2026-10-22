import { defineConfig, devices } from '@playwright/test';

// Runs against the isolated E2E stack (compose project finplat-e2e; the browser shares the e2e
// gateway's network namespace, so http://localhost:8080) — see scripts/e2e.sh. Never point it at
// the public instance: specs register accounts.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

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
    baseURL,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'Europe/Sarajevo',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
