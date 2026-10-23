// Smoke test of the built Linux desktop app (apps/native) over WebDriver (tests/native/webdriver.ts):
// local-mode onboarding, an account with an opening balance, then quit and start the app again to
// prove the data survived in SQLite (src-tauri/src/store.rs) and the onboarding state too.
import { existsSync, readdirSync } from 'node:fs';
import {
  APP,
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

  // Settings → General → Local MCP server: an MCP client runs `<app> --mcp` (stdio relay, mcp.rs)
  // and reads the account from the running app's local data.
  await second.click(`//label[contains(normalize-space(.), 'Allow AI apps on this computer')]`);
  const ep = `${process.env.HOME}/.config/me.pr0h0.finplat/mcp.json`;
  for (let i = 0; i < 20 && !existsSync(ep); i++) await sleep(250);
  check(existsSync(ep), 'local MCP server turned on (mcp.json written)');
  const rpc = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_accounts', arguments: {} },
    },
  ];
  const relay = Bun.spawn([APP, '--mcp'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  for (const m of rpc) relay.stdin.write(`${JSON.stringify(m)}\n`);
  await relay.stdin.flush();
  const replies: {
    id: number;
    result?: {
      tools?: unknown[];
      structuredContent?: { accounts: { name: string; balances: { amount: string }[] }[] };
    };
  }[] = [];
  const reader = relay.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const deadline = Date.now() + 15_000;
  while (replies.length < 3 && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  }
  relay.stdin.end();
  relay.kill();
  const byId = (id: number) => replies.find((r) => r.id === id)?.result;
  check((byId(2)?.tools?.length ?? 0) >= 19, 'MCP tools/list over the relay (read-only tools)');
  const wallet = byId(3)?.structuredContent?.accounts.find((a) => a.name === 'Wallet');
  check(wallet?.balances[0]?.amount === '123.45', 'MCP list_accounts answered from local data');
} finally {
  await second.quit().catch(() => undefined);
}
console.log('native smoke test passed');
