// Smoke test of the macOS app and the iOS app (simulator), run on a Mac by
// `bun tests/native/apple-smoke.ts macos|ios` (docs/native/README.md). WKWebView has no WebDriver or CDP, so the debug build
// runs a small driver (src-tauri/src/lib.rs, FINPLAT_DRIVER) that fetches expressions from this
// script's local server, evaluates them in the page and posts the results back. Same scenario as
// the Linux and Android tests: local onboarding, quit, start again, data restored from SQLite.
// With SERVER (a test server, e.g. http://localhost:3811) it runs the connected scenario of
// smoke-connected.ts instead: register, sync, token in the Keychain, still signed in after a restart.
//   macos: the debug binary with a throwaway HOME (the real app data is not touched; the Keychain
//          is the real one: the test removes its item afterwards)
//   ios:   the debug .app installed fresh on a booted simulator (SIM = its udid, APP = the .app)
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, checkRestored, onboardLocal, Page, sleep } from './page';

const target = process.argv[2];
if (target !== 'macos' && target !== 'ios') throw new Error('usage: apple-smoke.ts macos|ios');
const ROOT = join(import.meta.dir, '../..');
const OUT = join(ROOT, 'tests/native/results');
const PKG = 'me.pr0h0.finplat';
const sh = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim();

class DriverPage extends Page {
  private queue: { id: number; expr: string }[] = [];
  private waiting = new Map<number, (r: { value?: unknown; error?: string }) => void>();
  private id = 0;
  readonly url: string;

  constructor() {
    super();
    const cors = { 'access-control-allow-origin': '*' };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/result') {
          const r = (await req.json()) as { id: number; value?: unknown; error?: string };
          this.waiting.get(r.id)?.(r);
          this.waiting.delete(r.id);
          return new Response('', { headers: cors });
        }
        const job = this.queue.shift();
        return job
          ? Response.json(job, { headers: cors })
          : new Response(null, { status: 204, headers: cors });
      },
    });
    this.url = `http://127.0.0.1:${server.port}`;
  }

  protected run(code: string): Promise<unknown> {
    const job = { id: ++this.id, expr: code };
    return new Promise((ok, fail) => {
      // a page that reloads (or an app that quits) never answers: give up and let until() retry
      const t = setTimeout(() => {
        this.waiting.delete(job.id);
        this.queue = this.queue.filter((j) => j !== job);
        fail(new Error('no answer from the page'));
      }, 10_000);
      this.waiting.set(job.id, (r) => {
        clearTimeout(t);
        r.error ? fail(new Error(`page error: ${r.error}`)) : ok(r.value);
      });
      this.queue.push(job);
    });
  }
}

const page = new DriverPage();
mkdirSync(OUT, { recursive: true });

let app: { start: () => void; stop: () => Promise<void>; shot: (name: string) => void };
if (target === 'macos') {
  const bin = join(ROOT, 'apps/native/src-tauri/target/debug/finplat-native');
  if (!existsSync(bin)) throw new Error(`missing ${bin}: bunx tauri build --debug --no-bundle`);
  // HOME and CFFIXED_USER_HOME move both Tauri's app data dir and WebKit's storage
  const home = mkdtempSync(join(tmpdir(), 'finplat-mac-'));
  let proc: ReturnType<typeof spawn> | null = null;
  app = {
    start: () => {
      proc = spawn(bin, [], {
        env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home, FINPLAT_DRIVER: page.url },
        stdio: process.env.DEBUG ? 'inherit' : 'ignore',
      });
    },
    // wait for the exit: a second instance would only focus the first (single-instance) and quit
    stop: async () => {
      const p = proc;
      if (!p || p.exitCode !== null) return;
      const exited = new Promise((r) => p.once('exit', r));
      p.kill('SIGTERM');
      if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])))
        p.kill('SIGKILL');
      await exited;
    },
    // the whole screen; needs Screen Recording permission for the terminal, else no file
    shot: (name) => {
      try {
        execSync(`screencapture -x ${OUT}/${name}.png 2>/dev/null`);
      } catch {}
    },
  };
  process.on('exit', () => {
    proc?.kill('SIGKILL');
    // the token the connected scenario stored (same item the real app uses: service + key)
    if (SERVER)
      execSync('security delete-generic-password -s me.pr0h0.finplat >/dev/null 2>&1 || true');
  });
  console.log(`app data in ${home}`);
} else {
  const sim = process.env.SIM ?? 'booted';
  const appPath = process.env.APP;
  if (!appPath || !existsSync(appPath)) throw new Error('APP must point at the simulator .app');
  sh(`xcrun simctl uninstall ${sim} ${PKG} || true`);
  sh(`xcrun simctl install ${sim} "${appPath}"`);
  app = {
    start: () => sh(`SIMCTL_CHILD_FINPLAT_DRIVER=${page.url} xcrun simctl launch ${sim} ${PKG}`),
    stop: async () => {
      sh(`xcrun simctl terminate ${sim} ${PKG} || true`);
      await sleep(2000);
    },
    shot: (name) => sh(`xcrun simctl io ${sim} screenshot ${OUT}/${name}.png 2>/dev/null`),
  };
}

const SERVER = process.env.SERVER;
const EMAIL = `native-${Date.now()}@e2e.test`;
const PASSWORD = 'correct horse battery staple';
const mainHas = (re: string) =>
  `new RegExp(${JSON.stringify(re)}).test((document.querySelector('main') || document.body).innerText)`;

async function connectedScenario() {
  if (!SERVER) return;
  app.start();
  const p = page;
  await p.until(
    `'__TAURI_INTERNALS__' in window && document.readyState === 'complete'`,
    'app',
    60_000,
  );
  await p.click('^Get started$');
  await p.click('^Next$');
  await p.fill('Reporting currency', 'BAM');
  await p.click('^Next$');
  await p.clickEl('button', 'Connect to server');
  await p.fill('Server URL', SERVER);
  await p.click('^Check server$');
  await p.clickEl('label', 'I trust');
  await p.click('^Continue$');
  await p.clickEl('[role=tab]', '^Create account$');
  await p.fill('Email', EMAIL);
  await p.fill('Password', PASSWORD);
  await p.clickEl('[role=tabpanel] button', '^Create account$');
  await p.heading('Choose a profile');
  check(true, 'registered and signed in through the native HTTP client');
  await p.clickEl('li button', '^Use$');
  await p.heading('Your accounts');
  await p.fill('Name', 'Server wallet');
  await p.fill('Opening balance (optional)', '50.00');
  await p.click('^Add account$');
  await p.until(`el('td', '^Server wallet$')`, 'account row');
  await p.click('^(Next|Skip)$');
  await p.heading('Categories');
  await p.click('^Next$');
  await p.click('[Dd]ashboard|[Ff]inish|[Dd]one');
  await p.heading('Dashboard');
  await p.clickEl('a', '^Sync status$');
  await p.click('^Sync now$');
  await p.until(mainHas('Waiting to upload\\s*0'), 'outbox empty after sync');
  await p.until(`!${mainHas('Never synchronized')}`, 'a completed sync');
  check(true, 'synced from the native app');
  const stored = await p.eval<string>(`localStorage.getItem('finplat:app') || ''`);
  check(
    stored.includes('"connection"') && !stored.includes('"token"'),
    'token kept in the Keychain, not in localStorage',
  );
  app.shot(`${target}-connected-1-sync`);
  await app.stop();

  const login = (await fetch(`${SERVER}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      device: { name: 'native smoke test', platform: 'cli', clientVersion: '0' },
    }),
  }).then((r) => r.json())) as { token: string };
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
    devices.some((d) => d.platform === target),
    `the app is registered as a ${target} device (bearer token)`,
  );

  app.start();
  await p.heading('Dashboard');
  await p.until(mainHas('Server wallet'), 'the account on the dashboard');
  check(
    !(await p.eval<boolean>(`document.body.innerText.includes('Your server session ended')`)),
    'still signed in after a restart (token from the Keychain), server data cached in SQLite',
  );
  app.shot(`${target}-connected-2-restart`);
  await app.stop();
}

try {
  if (SERVER) {
    await connectedScenario();
    console.log(`${target} connected smoke test passed`);
    process.exit(0);
  }
  app.start();
  await onboardLocal(page, target);
  await sleep(1500);
  app.shot(`${target}-1-dashboard`);
  await app.stop();
  app.start();
  await checkRestored(page);
  await sleep(1500);
  app.shot(`${target}-2-after-restart`);
  await app.stop();
} catch (e) {
  const state = await page
    .eval<string>(`location.href + '\\n' + document.body.innerText.slice(0, 600)`)
    .catch(() => '(page not answering)');
  console.error(`page state:\n${state}`);
  app.shot(`${target}-failure`);
  throw e;
}
console.log(`${target} smoke test passed`);
process.exit(0);
