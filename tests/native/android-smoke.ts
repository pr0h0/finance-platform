// Smoke test of the Android app (debug APK) in a headless emulator, run by
// `scripts/native-test.sh android`. The app's WebView is reached over the Chrome DevTools protocol
// (adb forward to webview_devtools_remote_<pid>; debug builds only) and driven with small in-page
// helpers over Runtime.evaluate (Playwright's connectOverCDP needs browser-context support that a
// WebView does not have). Same scenario as smoke.ts: local onboarding, account with an opening
// balance, force-stop the app, start it again, data restored from SQLite.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PKG = 'me.pr0h0.finplat';
const OUT = process.env.OUT ?? '/repo/tests/native/results';
const sh = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(cond: unknown, what: string) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

/** In-page helpers: React-controlled inputs need the native value setter plus an input event. */
const HELPERS = `
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const button = (re) => [...document.querySelectorAll('button')].find((b) => visible(b) && new RegExp(re).test(norm(b.textContent)));
  const byLabel = (text) => {
    const l = [...document.querySelectorAll('label')].find((x) => norm(x.textContent) === text);
    return l && (l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input,select,textarea'));
  };
  const setValue = (el, v) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`;

class WebView {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<
    number,
    (v: { result?: { value?: unknown }; exceptionDetails?: unknown }) => void
  >();

  static async attach(): Promise<WebView> {
    const v = new WebView();
    let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 30 && !targets.length; i++) {
      targets = (
        (await (await fetch('http://127.0.0.1:9222/json')).json()) as typeof targets
      ).filter((t) => t.type === 'page');
      if (!targets.length) await sleep(500);
    }
    if (!targets[0]) throw new Error('no WebView page');
    v.ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      v.ws.onopen = ok;
      v.ws.onerror = fail;
    });
    v.ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      v.waiting.get(msg.id)?.(msg.result ?? {});
      v.waiting.delete(msg.id);
    };
    return v;
  }

  /** Evaluates an expression (with HELPERS in scope) in the page and returns its value. */
  async eval<T>(expr: string): Promise<T> {
    const id = ++this.id;
    const res = await new Promise<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      (r) => {
        this.waiting.set(id, r);
        this.ws.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
              expression: `(async () => { ${HELPERS} return (${expr}); })()`,
              awaitPromise: true,
              returnByValue: true,
            },
          }),
        );
      },
    );
    if (res.exceptionDetails)
      throw new Error(`page error: ${JSON.stringify(res.exceptionDetails)}`);
    return res.result?.value as T;
  }

  async until(expr: string, what: string, timeoutMs = 30_000) {
    if (process.env.DEBUG) console.log(`  waiting for ${what}`);
    const end = Date.now() + timeoutMs;
    while (!(await this.eval<boolean>(`!!(${expr})`))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(300);
    }
  }
  async click(re: string) {
    await this.until(`button(${JSON.stringify(re)})`, `button /${re}/`);
    await this.eval(`button(${JSON.stringify(re)}).click()`);
  }
  async fill(label: string, value: string) {
    await this.until(`byLabel(${JSON.stringify(label)})`, `field "${label}"`);
    await this.eval(`setValue(byLabel(${JSON.stringify(label)}), ${JSON.stringify(value)})`);
  }
  heading(text: string) {
    return this.until(
      `[...document.querySelectorAll('h1,h2')].some((h) => norm(h.textContent) === ${JSON.stringify(text)})`,
      `heading "${text}"`,
    );
  }
  close() {
    this.ws.close();
  }
}

async function launch(): Promise<WebView> {
  sh(`adb shell monkey -p ${PKG} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
  let pid = '';
  for (let i = 0; i < 60 && !pid; i++) {
    await sleep(1000);
    pid = sh(`adb shell pidof ${PKG} || true`);
  }
  check(pid, `app process started (pid ${pid})`);
  let socket = '';
  for (let i = 0; i < 60 && !socket; i++) {
    await sleep(1000);
    socket = sh(
      `adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_${pid}' | head -1 || true`,
    );
  }
  check(socket, 'WebView debugging socket available');
  sh('adb forward --remove-all');
  sh(`adb forward tcp:9222 localabstract:${socket}`);
  return WebView.attach();
}

function shot(name: string) {
  mkdirSync(OUT, { recursive: true });
  sh(`adb exec-out screencap -p > ${OUT}/${name}.png`);
}

process.on('uncaughtException', (e) => {
  shot('android-failure');
  console.error(e);
  process.exit(1);
});

const a = await launch();
// the WebView exists before it has loaded the app
await a.until(
  `'__TAURI_INTERNALS__' in window && document.readyState === 'complete'`,
  'the app page',
  60_000,
);
check(true, 'runs inside the Tauri shell');
await a.click('^Get started$');
check(
  (await a.eval<string>('document.documentElement.dataset.platform')) === 'android',
  'native bridges loaded (platform = android)',
);
await a.click('^Next$');
await a.fill('Reporting currency', 'BAM');
await a.click('^Next$');
await a.click('Local only');
await a.fill('Profile name', 'Phone');
await a.click('^Create profile$');
await a.heading('Your accounts');
await a.fill('Name', 'Wallet');
await a.fill('Opening balance (optional)', '77.10');
await a.click('^Add account$');
await a.until(
  `[...document.querySelectorAll('td')].some((td) => norm(td.textContent) === 'Wallet')`,
  'account row',
);
check(true, 'local profile and account created');
await a.click('^(Next|Skip)$');
await a.heading('Categories');
await a.click('^Next$');
await a.click('[Dd]ashboard|[Ff]inish|[Dd]one');
await a.heading('Dashboard');
check(true, 'onboarding finished on the dashboard');
await sleep(1500);
shot('android-1-dashboard');
a.close();

sh(`adb shell am force-stop ${PKG}`);
await sleep(2000);
const b = await launch();
await b.heading('Dashboard');
check(true, 'restart opens the dashboard (onboarding state kept)');
await b.until(
  `document.querySelector('main') && norm(document.querySelector('main').innerText).includes('77.10')`,
  'balance',
);
const text = await b.eval<string>(`document.querySelector('main').innerText`);
check(
  text.includes('Wallet') && text.includes('77.10'),
  'account and balance restored from SQLite',
);
await sleep(1500);
shot('android-2-after-restart');

// Android back button: back inside the app (not closing it)
await b.eval(
  `[...document.querySelectorAll('nav a')].find((l) => norm(l.textContent) === 'Transactions').click()`,
);
await b.heading('Transactions');
b.close();
sh('adb shell input keyevent KEYCODE_BACK');
await sleep(2000);
shot('android-3-after-back');
check(sh(`adb shell pidof ${PKG} || true`), 'back button keeps the app open');
const c = await WebView.attach();
await c.heading('Dashboard');
check(true, 'back button goes back inside the app (Transactions -> Dashboard)');
c.close();
console.log('android smoke test passed');
