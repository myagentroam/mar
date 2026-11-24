import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { browserCliRoot, openBrowserCliScope } from '../../src/browser/browser-cli-scope.js';
import { BrowserTabs } from '../../src/browser/browser-tabs.js';

const execute = promisify(execFile);
const { version } = createRequire(import.meta.url)('playwright/package.json') as {
  version: string;
};
const bin = fileURLToPath(new URL('../../scripts/browser-bin', import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), 'mar-pw-'));
const scopes = Array.from({ length: 5 }, () => randomUUID().replaceAll('-', '')) as [
  string,
  string,
  string,
  string,
  string
];
const lifetimes = new Map<string, Awaited<ReturnType<typeof openBrowserCliScope>>>();
let observeCdpRequest: ((response: ServerResponse) => void) | undefined;
const server = createServer((request, response) => {
  if (request.url?.startsWith('/json/version')) {
    observeCdpRequest?.(response);
    return;
  }
  if (request.url === '/pending') return;
  response.writeHead(200, { 'Content-Type': 'text/html' }).end(`
    <label>Message <input /></label>
    <button onclick="localStorage.setItem('message', document.querySelector('input').value)">
      Save
    </button>`);
}).listen(0, '127.0.0.1');

async function cli(scope: string, ...args: string[]): Promise<string> {
  return cliIn(cwd, scope, ...args);
}

async function cliIn(directory: string, scope: string, ...args: string[]): Promise<string> {
  const windows = process.platform === 'win32';
  const { stdout } = await execute(
    windows ? process.execPath : 'playwright-cli',
    windows ? [join(bin, 'playwright-cli'), ...args] : args,
    {
      cwd: directory,
      timeout: 10_000,
      env: cliEnvironment(scope)
    }
  );
  return stdout.trim();
}

function cliEnvironment(scope: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    MAR_PLAYWRIGHT_CLI_ROOT: browserCliRoot(scope),
    PLAYWRIGHT_CLI_SESSION: 'same-named-session',
    PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:1',
    PWTEST_CLI_GLOBAL_CONFIG: cwd
  };
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
    const registry = join(browserCliRoot(scope), `shared-${next}`);
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
    await tabs.setHumanControl(false);
    assert.equal(tabs.agentControl, 'taking');
    assert.equal(holds, 1);
    await tabs.setHumanControl(true);
    assert.equal(holds, 0);
    assert.equal(tabs.agentControl, 'user');
    assert.equal(page.isClosed(), false);
    await tabs.setHumanControl(false);
    const terminal = await tabs.acquireAgent(execution, retain);
    await attach(terminal);
    await lifetimes.get(scope)!.close();
    assert.equal(page.isClosed(), false);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('message')),
      'signed in by the user'
    );
    lifetime.abort();
    await tabs.releaseAgent(execution);
    assert.equal(holds, 0);
    await assert.rejects(attach(terminal), /requires an active MAR Browser Use environment/);
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
  const [a, b, shared, cancelled, pending] = scopes;
  for (const scope of scopes) lifetimes.set(scope, await openBrowserCliScope(scope));
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
  // close-all only sees sessions associated with the current working directory.
  const other = join(cwd, 'other');
  const profiles = [join(cwd, 'explicit-profile-a'), join(cwd, 'explicit-profile-b')];
  await mkdir(join(other, '.playwright'), { recursive: true });
  await Promise.all(
    profiles.map((profile) => cliIn(other, b, 'open', url, `--profile=${profile}`))
  );
  const dashboard = cli(b, 'show', '--port=0').then(
    (output) => ({ output }),
    (error: unknown) => ({ error })
  );
  const deadline = Date.now() + 5_000;
  while (!(await readdir(browserCliRoot(b))).includes('dashboard-used')) {
    assert(Date.now() < deadline, 'The dashboard command did not start');
    await delay(20);
  }
  await lifetimes.get(b)!.close();
  const result = await dashboard;
  assert('output' in result, 'Run cleanup did not stop the Playwright dashboard');
  await assert.rejects(access(browserCliRoot(b)), { code: 'ENOENT' });
  await assert.rejects(cli(b, 'open', url), /requires an active MAR Browser Use environment/);
  // Both profiles must be free even if concurrent commands used the same session name.
  for (const profile of profiles) {
    const reopened = await chromium.launchPersistentContext(profile, { channel: 'chromium' });
    await reopened.close();
  }
  const reached = once(server, 'request', { signal: AbortSignal.timeout(10_000) });
  const starting = spawn(
    process.execPath,
    [join(bin, 'playwright-cli'), 'open', `${url}/pending`],
    {
      cwd,
      env: cliEnvironment(cancelled),
      stdio: 'ignore'
    }
  );
  const stopped = once(starting, 'exit');
  await reached;
  starting.kill('SIGKILL');
  await stopped;
  const startedClose = Date.now();
  await lifetimes.get(cancelled)!.close();
  assert(Date.now() - startedClose < 10_000, 'A dead launcher delayed Run cleanup');
  await assert.rejects(access(browserCliRoot(cancelled)), { code: 'ENOENT' });
  // A daemon cannot register until its CDP connection completes. Ending the
  // Run must cancel startup, not merely wait for a registry entry to appear.
  const cdpClosed = new Promise<void>((resolve) => {
    observeCdpRequest = (response) => response.once('close', resolve);
  });
  const cdpStarted = once(server, 'request', { signal: AbortSignal.timeout(10_000) });
  const attachment = cli(pending, 'attach', `--cdp=${url}`).then(
    () => 'completed',
    () => 'cancelled'
  );
  await cdpStarted;
  const registryFiles = await readdir(join(browserCliRoot(pending), 'd'), { recursive: true });
  assert(!registryFiles.some((name) => name.endsWith('.session')));
  const cancelling = Date.now();
  await lifetimes.get(pending)!.close();
  assert(Date.now() - cancelling < 8_000, 'A pending attach delayed Run cleanup');
  await cdpClosed;
  assert.equal(await attachment, 'cancelled');
  await assert.rejects(access(browserCliRoot(pending)), { code: 'ENOENT' });
  assert.equal(
    JSON.parse(await cli(a, '--raw', 'eval', 'localStorage.getItem("message")')),
    'kill-all'
  );
  console.log(
    'Verified Run-scoped Playwright cleanup, isolated sessions, and shared login handoff and takeover.'
  );
} finally {
  try {
    await Promise.all([...lifetimes.values()].map((lifetime) => lifetime.close()));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}
