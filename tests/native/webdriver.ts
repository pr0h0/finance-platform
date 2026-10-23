// Plain W3C WebDriver over fetch for the Linux app smoke tests (tauri-driver + WebKitWebDriver, run by
// scripts/native-test.sh under a virtual display): start the built binary, find elements by XPath,
// click, type, run scripts, take screenshots. No test framework needed for a few scenarios.
import { mkdirSync, writeFileSync } from 'node:fs';

const DRIVER = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4444';
export const APP = process.env.APP ?? '/cache/target/release/finplat-native';
export const OUT = process.env.OUT ?? '/repo/tests/native/results';
export const DATA = `${process.env.HOME}/.local/share/me.pr0h0.finplat`;
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class App {
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
  /** Polls a script (returning a boolean) until it is true. */
  async until(script: string, what: string, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    while (!(await this.exec<boolean>(script))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(300);
    }
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

export const button = (text: string) => `//button[normalize-space(.)='${text}']`;
export const buttonContaining = (text: string) =>
  `//button[contains(normalize-space(.), '${text}')]`;
export const byLabel = (text: string) => `//*[@id=(//label[normalize-space(.)='${text}']/@for)]`;
export const heading = (text: string) => `//*[self::h1 or self::h2][normalize-space(.)='${text}']`;

export function check(cond: unknown, what: string) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}
