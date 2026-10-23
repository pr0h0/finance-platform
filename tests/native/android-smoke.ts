// Smoke test of the Android app (debug APK) in a headless emulator, run by
// `scripts/native-test.sh android`. The app's WebView is reached over the Chrome DevTools protocol
// (adb forward to webview_devtools_remote_<pid>; debug builds only) and driven with small in-page
// helpers over Runtime.evaluate (Playwright's connectOverCDP needs browser-context support that a
// WebView does not have). Same scenario as smoke.ts: local onboarding, account with an opening
// balance, force-stop the app, start it again, data restored from SQLite.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { check, checkRestored, onboardLocal, Page, sleep } from './page';

const PKG = 'me.pr0h0.finplat';
const OUT = process.env.OUT ?? '/repo/tests/native/results';
const sh = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim();

class WebView extends Page {
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

  protected async run(code: string): Promise<unknown> {
    const id = ++this.id;
    const res = await new Promise<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      (r) => {
        this.waiting.set(id, r);
        this.ws.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression: code, awaitPromise: true, returnByValue: true },
          }),
        );
      },
    );
    if (res.exceptionDetails)
      throw new Error(`page error: ${JSON.stringify(res.exceptionDetails)}`);
    return res.result?.value;
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
await onboardLocal(a, 'android');
await sleep(1500);
shot('android-1-dashboard');
a.close();

sh(`adb shell am force-stop ${PKG}`);
await sleep(2000);
const b = await launch();
await checkRestored(b);
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
