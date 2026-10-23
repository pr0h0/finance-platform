// Smoke test of the built Linux desktop app (apps/native) over WebDriver (tests/native/webdriver.ts):
// local-mode onboarding, an account with an opening balance, then quit and start the app again to
// prove the data survived in SQLite (src-tauri/src/store.rs) and the onboarding state too.
import { existsSync, readdirSync } from 'node:fs';
import {
  App,
  button,
  buttonContaining,
  byLabel,
  check,
  DATA,
  heading,
  sleep,
} from './webdriver.ts';

const first = await App.start();
try {
  check(
    await first.exec<boolean>('return "__TAURI_INTERNALS__" in window'),
    'runs inside the Tauri shell',
  );
  check(
    (await first.exec<string>('return document.documentElement.dataset.platform')) === 'linux',
    'native bridges loaded (platform = linux)',
  );
  await first.click(button('Get started'));
  await first.click(button('Next'));
  await first.click(`${byLabel('Reporting currency')}/option[@value='BAM']`);
  await first.click(button('Next'));
  await first.click(buttonContaining('Local only'));
  await first.type(byLabel('Profile name'), 'Native');
  await first.click(button('Create profile'));
  await first.find(heading('Your accounts'));
  await first.type(byLabel('Name'), 'Wallet');
  await first.type(byLabel('Opening balance (optional)'), '123.45');
  await first.click(button('Add account'));
  await first.find(`//td[normalize-space(.)='Wallet']`);
  check(true, 'local profile and account created');
  await first.click(`//button[normalize-space(.)='Next' or normalize-space(.)='Skip']`);
  await first.find(heading('Categories'));
  await first.click(button('Next'));
  await first.click(
    `//button[contains(translate(., 'DFNIOSHABRDE', 'dfniosshabrde'), 'dashboard') or contains(., 'Finish') or contains(., 'Done')]`,
  );
  await first.find(`//h1[normalize-space(.)='Dashboard']`);
  check(true, 'onboarding finished on the dashboard');
  await first.shot('1-dashboard');
} finally {
  await first.quit().catch(() => undefined);
}

check(existsSync(`${DATA}/finplat.sqlite3`), `SQLite database written (${DATA}/finplat.sqlite3)`);
await sleep(1000);

// Start the app again: still onboarded, the account and its balance come back from SQLite.
const second = await App.start();
try {
  await second.find(`//h1[normalize-space(.)='Dashboard']`, 20_000);
  check(true, 'restart opens the dashboard (onboarding state kept)');
  await second.click(`//a[normalize-space(.)='Accounts']`);
  await second.find(`//h1[normalize-space(.)='Accounts']`);
  await second.find(`//main//*[normalize-space(.)='Wallet']`);
  const body = await second.exec<string>('return document.body.innerText');
  check(body.includes('123.45'), 'account and opening balance restored from SQLite after restart');
  await second.shot('2-accounts-after-restart');

  // Settings → General → Desktop app → start at login (tauri-plugin-autostart writes an XDG entry)
  await second.click(`//a[normalize-space(.)='Settings']`);
  const box = `//label[contains(normalize-space(.), 'Start Finance Platform when I sign in')]`;
  await second.click(box);
  const entry = `${process.env.HOME}/.config/autostart`;
  for (let i = 0; i < 20 && !(existsSync(entry) && readdirSync(entry).length); i++)
    await sleep(250);
  check(
    existsSync(entry) && readdirSync(entry).length > 0,
    'start at login turned on (XDG autostart entry)',
  );
  await second.click(box);
  for (let i = 0; i < 20 && readdirSync(entry).length; i++) await sleep(250);
  check(readdirSync(entry).length === 0, 'start at login turned off again');
} finally {
  await second.quit().catch(() => undefined);
}
console.log('native smoke test passed');
