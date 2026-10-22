// Smoke test of the built Linux desktop app (apps/native) over WebDriver (tauri-driver + WebKitWebDriver),
// run by scripts/native-test.sh under a virtual display. It drives the real binary with its bundled
// web app: local-mode onboarding, an account with an opening balance, then quits and starts the app
// again to prove the data survived in SQLite (src-tauri/src/store.rs) and the onboarding state too.
// Plain W3C WebDriver over fetch: no test framework needed for one scenario.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const DRIVER = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4444';
const APP = process.env.APP ?? '/cache/target/release/finplat-native';
const OUT = process.env.OUT ?? '/repo/tests/native/results';
const DATA = `${process.env.HOME}/.local/share/me.pr0h0.finplat`;
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

async function wd<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(DRIVER + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json()) as { value: T & { error?: string; message?: string } };
  if (!r.ok) throw new Error(`${method} ${path}: ${j.value?.error} ${j.value?.message}`);
  return j.value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class App {
  constructor(readonly id: string) {}
  static async start() {
    const s = await wd<{ sessionId: string }>('POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } },
    });
    return new App(s.sessionId);
  }
  private p = (path: string) => `/session/${this.id}${path}`;
  async find(xpath: string, timeoutMs = 15_000): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const e = await wd<Record<string, string>>('POST', this.p('/element'), {
          using: 'xpath',
          value: xpath,
        });
        return e[ELEMENT] as string;
      } catch (err) {
        if (Date.now() > end) throw new Error(`not found: ${xpath} (${(err as Error).message})`);
        await sleep(250);
      }
    }
  }
  async click(xpath: string) {
    await wd('POST', this.p(`/element/${await this.find(xpath)}/click`), {});
  }
  async type(xpath: string, text: string) {
    const id = await this.find(xpath);
    await wd('POST', this.p(`/element/${id}/clear`), {});
    await wd('POST', this.p(`/element/${id}/value`), { text });
  }
  exec<T>(script: string, args: unknown[] = []) {
    return wd<T>('POST', this.p('/execute/sync'), { script, args });
  }
  async shot(name: string) {
    await sleep(1500); // WebKitGTK repaints the virtual display a moment after the DOM changes
    const b64 = await wd<string>('GET', this.p('/screenshot'));
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(b64, 'base64'));
  }
  quit() {
    return wd('DELETE', this.p(''));
  }
}

const button = (text: string) => `//button[normalize-space(.)='${text}']`;
const buttonContaining = (text: string) => `//button[contains(normalize-space(.), '${text}')]`;
const byLabel = (text: string) => `//*[@id=(//label[normalize-space(.)='${text}']/@for)]`;
const heading = (text: string) => `//*[self::h1 or self::h2][normalize-space(.)='${text}']`;

function check(cond: unknown, what: string) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

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
} finally {
  await second.quit().catch(() => undefined);
}
console.log('native smoke test passed');
