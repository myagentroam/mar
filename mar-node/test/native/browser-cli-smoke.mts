import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { BrowserTabs } from '../../src/browser/browser-tabs.js';

const execute = promisify(execFile);
const { version } = createRequire(import.meta.url)('playwright/package.json') as {
  version: string;
};
const bin = fileURLToPath(new URL('../../scripts/browser-bin', import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), 'mar-pw-'));
const scopes = Array.from({ length: 3 }, () => randomUUID().replaceAll('-', '')) as [
  string,
  string,
  string
];
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' }).end(`
    <label>Message <input /></label>
    <button onclick="localStorage.setItem('message', document.querySelector('input').value)">
      Save
    </button>`);
}).listen(0, '127.0.0.1');

async function cli(scope: string, ...args: string[]): Promise<string> {
  const windows = process.platform === 'win32';
  const { stdout } = await execute(
    windows ? process.execPath : 'playwright-cli',
    windows ? [join(bin, 'playwright-cli'), ...args] : args,
    {
      cwd,
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
        MAR_PLAYWRIGHT_CLI_SCOPE: scope,
        PLAYWRIGHT_CLI_SESSION: 'same-named-session',
        PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:1',
        PWTEST_CLI_GLOBAL_CONFIG: cwd
      }
    }
  );
  return stdout.trim();
}

async function sharedLoginSmoke(url: string, scope: string): Promise<void> {
  const context = await chromium.launchPersistentContext(join(cwd, 'shared-profile'), {
    channel: 'chromium',
    headless: true
  });
  const lifetime = new AbortController();
  let holds = 0;
  let allowed = true;
  const execution = { cliScope: scope, signal: lifetime.signal, allowed: async () => allowed };
  const errors: unknown[] = [];
  const tabs = new BrowserTabs(context, { limit: 8, failed: (error) => errors.push(error) });
  const retain = () => {
    holds++;
    return () => {
      holds--;
    };
  };
  const attach = (id: string) => cli(scope, 'attach', `--mar-resource=${id}`);
  try {
    const id = await tabs.acquireAgent(execution, retain);
    assert.equal(holds, 1);
    const attachOutput = await attach(id);
    assert.doesNotMatch(attachOutput, /ws:\/\/127\.0\.0\.1/u);
    await assert.rejects(tabs.acquireAgent({ ...execution }, retain), /BROWSER_USE_BUSY/);
    assert.equal(await tabs.acquireAgent(execution, retain), id);
    await cli(scope, 'tab-new', url);
    const page = context.pages()[1];
    assert(page);
    const loginTab = tabs.agentTabs().tabs.find(({ url: address }) => address === `${url}/`);
    assert(loginTab);
    tabs.selectForAgent(loginTab.id, execution);
    assert.equal(tabs.snapshot().activeId, loginTab.id);
    await tabs.releaseAgent(execution);
    assert.equal(holds, 0);
    await assert.rejects(attach(id), /Shared access is no longer available/);
    // The simulated user signs in on the same page, without delegating credentials.
    await page.getByRole('textbox').fill('signed in by the user');
    await page.getByRole('button', { name: 'Save' }).click();
    const next = await tabs.acquireAgent(execution, retain);
    assert.notEqual(next, id);
    await attach(next);
    await cli(scope, 'tab-select', String(loginTab.pageIndex));
    assert.equal(
      JSON.parse(await cli(scope, '--raw', 'eval', 'localStorage.getItem("message")')),
      'signed in by the user'
    );
    const registry = join(tmpdir(), `mpw-${scope}`, `shared-${next}`);
    const descriptors = await readdir(registry);
    assert.equal(descriptors.length, 1);
    const { endpoint } = JSON.parse(await readFile(join(registry, descriptors[0]!), 'utf8'));
    assert.equal(typeof endpoint, 'string');
    const client = await chromium.connect(endpoint, { timeout: 5_000 });
    const disconnected = once(client, 'disconnected');
    const releasing = tabs.releaseAgent(execution);
    const reacquiring = assert.rejects(
      tabs.acquireAgent(execution, retain),
      /BROWSER_USE_HUMAN_CONTROL/
    );
    const takeover = tabs.setHumanControl(true);
    assert.equal(tabs.agentControl, 'taking');
    await Promise.all([disconnected, releasing, reacquiring, takeover]);
    assert.equal(tabs.agentControl, 'user');
    await assert.rejects(attach(next), /Shared access is no longer available/);
    await assert.rejects(
      async () => tabs.acquireAgent(execution, retain),
      /BROWSER_USE_HUMAN_CONTROL/
    );
    assert.equal(context.pages().length, 2);
    assert.equal(page.isClosed(), false);
    await tabs.setHumanControl(false);
    const last = await tabs.acquireAgent(execution, retain);
    allowed = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stop();
        reject(new Error('Shared access not revoked'));
      }, 8_000);
      const stop = tabs.observe(() => {
        if (holds !== 0) return;
        stop();
        clearTimeout(timeout);
        resolve();
      });
    });
    await assert.rejects(attach(last), /Shared access is no longer available/);
    assert.equal(page.isClosed(), false);
    allowed = true;

    const failed = await tabs.acquireAgent(execution, retain);
    const owner = context.browser()!;
    const { unbind, close } = owner;
    try {
      const unavailable = async () => {
        throw new Error('Simulated transport failure');
      };
      owner.unbind = unavailable;
      owner.close = unavailable;
      await assert.rejects(tabs.setHumanControl(true), /BROWSER_USE_REVOKE_FAILED/);
      assert.equal(tabs.agentControl, 'taking');
      assert.equal(holds, 1);
      await assert.rejects(attach(failed), /Shared access is no longer available/);
    } finally {
      owner.unbind = unbind;
      owner.close = close;
    }
    await tabs.releaseAgent(execution);
    assert.equal(holds, 0);
    assert.equal(tabs.agentControl, 'user');
    assert.equal(page.isClosed(), false);
    await tabs.setHumanControl(false);
    const terminal = await tabs.acquireAgent(execution, retain);
    lifetime.abort();
    await tabs.releaseAgent(execution);
    assert.equal(holds, 0);
    await assert.rejects(attach(terminal), /Shared access is no longer available/);
    assert.deepEqual(
      errors.map((error) => (error as Error).message),
      ['BROWSER_USE_REVOKE_FAILED']
    );
  } finally {
    lifetime.abort();
    await tabs.releaseAgent();
    await context.close();
  }
}

try {
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const [a, b, shared] = scopes;
  await mkdir(join(cwd, '.playwright'));
  await writeFile(join(cwd, '.playwright', 'cli.config.json'), 'invalid JSON');
  await writeFile(
    join(cwd, 'explicit.json'),
    JSON.stringify({
      browser: {
        browserName: 'chromium',
        launchOptions: { channel: 'chromium' },
        contextOptions: { viewport: { width: 777, height: 444 } }
      }
    })
  );
  assert.equal(await cli(a, '--version'), `Version ${version}`);
  await cli(a, 'open', url);
  const snapshot = await cli(a, '--raw', 'snapshot');
  const ref = /textbox "Message"[^\n]*\[ref=([a-z0-9]+)\]/u.exec(snapshot)?.[1];
  assert(ref, snapshot);
  await cli(a, 'fill', ref, 'kill-all');
  await cli(a, 'click', 'getByRole("button", { name: "Save" })');
  assert.equal(
    JSON.parse(await cli(a, '--raw', 'eval', 'localStorage.getItem("message")')),
    'kill-all'
  );
  await sharedLoginSmoke(url, shared);
  await cli(b, '-s=same-named-session', '--config', 'explicit.json', 'open', url);
  assert.equal(await cli(b, '--raw', 'eval', 'innerWidth'), '777');
  assert.equal(await cli(b, '--raw', 'eval', 'localStorage.getItem("message")'), 'null');
  await assert.rejects(cli(b, '--json', 'kill-all'), /kill-all is not available/u);
  await cli(b, 'close-all');
  assert.equal(
    JSON.parse(await cli(a, '--raw', 'eval', 'localStorage.getItem("message")')),
    'kill-all'
  );
  console.log(
    'Verified isolated Playwright sessions and shared login handoff, takeover, and revocation.'
  );
} finally {
  try {
    await Promise.all(scopes.map((scope) => cli(scope, 'close-all')));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
    await Promise.all(
      scopes.map((scope) => rm(join(tmpdir(), `mpw-${scope}`), { recursive: true }))
    );
  }
}
