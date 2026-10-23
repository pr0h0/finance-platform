// Connected-mode smoke test of the built Linux app against the isolated E2E server stack
// (scripts/native-test.sh linux-connected): the native app reaches the server through
// tauri-plugin-http (no CORS), registers, signs in as a *native device* (bearer token, not a cookie),
// adds an account, syncs; the test then checks the server side with its own API session, and starts
// the app again to prove the token and the server cache (SQLite) survive a restart.
import { App, button, buttonContaining, byLabel, check, heading } from './webdriver.ts';

const SERVER = process.env.SERVER ?? 'http://localhost:8080';
const EMAIL = `native-${Date.now()}@e2e.test`;
const PASSWORD = 'correct horse battery staple';
const mainHas = (re: string) =>
  `return new RegExp(${JSON.stringify(re)}).test((document.querySelector('main') || document.body).innerText)`;

const app = await App.start();
try {
  await app.click(button('Get started'));
  await app.click(button('Next'));
  await app.click(`${byLabel('Reporting currency')}/option[@value='BAM']`);
  await app.click(button('Next'));
  await app.click(buttonContaining('Connect to server'));
  await app.type(byLabel('Server URL'), SERVER);
  await app.click(button('Check server'));
  await app.click(`//label[contains(normalize-space(.), 'I trust')]`);
  await app.click(button('Continue'));
  await app.click(`//*[@role='tab'][normalize-space(.)='Create account']`);
  await app.type(byLabel('Email'), EMAIL);
  await app.type(byLabel('Password'), PASSWORD);
  await app.click(`//*[@role='tabpanel']//button[normalize-space(.)='Create account']`);
  await app.find(heading('Choose a profile'), 30_000);
  check(true, 'registered and signed in through the native HTTP client');
  await app.click(`(//li//button[normalize-space(.)='Use'])[1]`);
  await app.find(heading('Your accounts'));
  await app.type(byLabel('Name'), 'Server wallet');
  await app.type(byLabel('Opening balance (optional)'), '50.00');
  await app.click(button('Add account'));
  await app.find(`//td[normalize-space(.)='Server wallet']`);
  await app.click(`//button[normalize-space(.)='Next' or normalize-space(.)='Skip']`);
  await app.find(heading('Categories'));
  await app.click(button('Next'));
  await app.click(
    `//button[contains(., 'ashboard') or contains(., 'Finish') or contains(., 'Done')]`,
  );
  await app.find(`//h1[normalize-space(.)='Dashboard']`);
  await app.click(`//a[normalize-space(.)='Sync status']`);
  await app.click(button('Sync now'));
  await app.until(mainHas('Waiting to upload\\s*0'), 'outbox empty after sync', 30_000);
  await app.until(`return !${mainHas('Never synchronized').slice(7)}`, 'a completed sync', 30_000);
  check(true, 'synced from the native app');
  await app.shot('connected-1-sync');
} finally {
  await app.quit().catch(() => undefined);
}

// The server side, with the test's own session.
const login = await fetch(`${SERVER}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: EMAIL,
    password: PASSWORD,
    device: { name: 'native smoke test', platform: 'cli', clientVersion: '0' },
  }),
}).then((r) => r.json() as Promise<{ token: string }>);
const api = (path: string, pid?: string) =>
  fetch(`${SERVER}${path}`, {
    headers: { Authorization: `Bearer ${login.token}`, ...(pid ? { 'X-Profile-ID': pid } : {}) },
  }).then((r) => r.json());
const pid = (await api('/api/v1/profiles')).items[0].id as string;
const accounts = (await api('/api/v1/accounts', pid)).items as { name: string }[];
check(
  accounts.some((a) => a.name === 'Server wallet'),
  'the account reached the server',
);
const devices = (await api('/api/v1/devices')).items as { platform: string }[];
check(
  devices.some((d) => d.platform === 'linux'),
  'the app is registered as a linux device (bearer token)',
);

const again = await App.start();
try {
  await again.find(`//h1[normalize-space(.)='Dashboard']`, 20_000);
  await again.until(mainHas('Server wallet'), 'the account on the dashboard');
  const banner = await again.exec<boolean>(
    `return document.body.innerText.includes('Your server session ended')`,
  );
  check(!banner, 'still signed in after a restart (token kept), server data cached in SQLite');
  await again.shot('connected-2-restart');
} finally {
  await again.quit().catch(() => undefined);
}
console.log('native connected smoke test passed');
