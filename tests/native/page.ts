// Shared by the WebView smoke tests that drive the app page by evaluating expressions in it
// (android-smoke.ts over CDP, apple-smoke.ts over the debug-build driver in src-tauri/src/lib.rs).

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function check(cond: unknown, what: string) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

/** In-page helpers: React-controlled inputs need the native value setter plus an input event. */
const HELPERS = `
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const el = (sel, re) => [...document.querySelectorAll(sel)].find((e) => visible(e) && new RegExp(re).test(norm(e.textContent)));
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

export abstract class Page {
  /** Evaluates `code` (a promise-returning expression) in the page and returns its value. */
  protected abstract run(code: string): Promise<unknown>;

  /** Evaluates an expression (with HELPERS in scope) in the page and returns its value. */
  eval<T>(expr: string): Promise<T> {
    return this.run(`(async () => { ${HELPERS} return (${expr}); })()`) as Promise<T>;
  }

  async until(expr: string, what: string, timeoutMs = 30_000) {
    if (process.env.DEBUG) console.log(`  waiting for ${what}`);
    const end = Date.now() + timeoutMs;
    for (;;) {
      const ok = await this.eval<boolean>(`!!(${expr})`).catch(() => false);
      if (ok) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(300);
    }
  }
  async click(re: string) {
    await this.until(`button(${JSON.stringify(re)})`, `button /${re}/`);
    await this.eval(`button(${JSON.stringify(re)}).click()`);
  }
  /** Clicks the first visible element matching `sel` whose text matches `re`. */
  async clickEl(sel: string, re: string) {
    const e = `el(${JSON.stringify(sel)}, ${JSON.stringify(re)})`;
    await this.until(e, `${sel} /${re}/`);
    await this.eval(`${e}.click()`);
  }
  /** Selects a tab: Radix tabs switch on mousedown, not click. */
  async tab(re: string) {
    const e = `el('[role=tab]', ${JSON.stringify(re)})`;
    await this.until(e, `tab /${re}/`);
    await this.eval(
      `${e}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`,
    );
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
}

/**
 * The onboarding + restart scenario every platform runs: local onboarding with an account and an
 * opening balance, then (after `restart`) the dashboard with the data restored from SQLite.
 */
export async function onboardLocal(p: Page, platform: string) {
  await p.until(
    `'__TAURI_INTERNALS__' in window && document.readyState === 'complete'`,
    'the app page',
    60_000,
  );
  check(true, 'runs inside the Tauri shell');
  await p.click('^Get started$');
  check(
    (await p.eval<string>('document.documentElement.dataset.platform')) === platform,
    `native bridges loaded (platform = ${platform})`,
  );
  await p.click('^Next$');
  await p.fill('Reporting currency', 'BAM');
  await p.click('^Next$');
  await p.click('Local only');
  await p.fill('Profile name', 'Phone');
  await p.click('^Create profile$');
  await p.heading('Your accounts');
  await p.fill('Name', 'Wallet');
  await p.fill('Opening balance (optional)', '77.10');
  await p.click('^Add account$');
  await p.until(
    `[...document.querySelectorAll('td')].some((td) => norm(td.textContent) === 'Wallet')`,
    'account row',
  );
  check(true, 'local profile and account created');
  await p.click('^(Next|Skip)$');
  await p.heading('Categories');
  await p.click('^Next$');
  await p.click('[Dd]ashboard|[Ff]inish|[Dd]one');
  await p.heading('Dashboard');
  check(true, 'onboarding finished on the dashboard');
}

export async function checkRestored(p: Page) {
  await p.heading('Dashboard');
  check(true, 'restart opens the dashboard (onboarding state kept)');
  await p.until(
    `document.querySelector('main') && norm(document.querySelector('main').innerText).includes('77.10')`,
    'balance',
  );
  const text = await p.eval<string>(`document.querySelector('main').innerText`);
  check(
    text.includes('Wallet') && text.includes('77.10'),
    'account and balance restored from SQLite',
  );
}
