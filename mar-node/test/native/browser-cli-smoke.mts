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
import { BrowserAgentAccess } from '../../src/browser/browser-agent-access.js';
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

async function sharedLoginSmoke(url: string, scope: string, otherScope: string): Promise<void> {
  const context = await chromium.launchPersistentContext(join(cwd, 'shared-profile'), {
    channel: 'chromium',
    headless: true
  });
  const lifetime = new AbortController();
  const otherLifetime = new AbortController();
  let allowed = true;
  let actions = 0;
  const execution = { cliScope: scope, signal: lifetime.signal, allowed: async () => allowed };
  const otherExecution = {
    cliScope: otherScope,
    signal: otherLifetime.signal,
    allowed: async () => true
  };
  const errors: unknown[] = [];
  const tabs = new BrowserTabs(context, { limit: 8, failed: (error) => errors.push(error) });
  const access = new BrowserAgentAccess(
    () => context.browser(),
    () => {
      actions++;
      tabs.markAgentActivity();
      return true;
    },
    (error) => errors.push(error)
  );
  try {
    // Playwright opens the listener before publishing its registry descriptor.
    // A publication failure must not poison the next lookup on this browser.
    const owner = context.browser()!;
    const bind = owner.bind.bind(owner);
    const blockedRegistry = join(cwd, 'blocked-registry');
    await writeFile(blockedRegistry, '');
    owner.bind = async (title, options) => {
      const registry = process.env.PWTEST_SERVER_REGISTRY;
      process.env.PWTEST_SERVER_REGISTRY = blockedRegistry;
      try {
        return await bind(title, options);
      } finally {
        process.env.PWTEST_SERVER_REGISTRY = registry;
        owner.bind = bind;
      }
    };
    await assert.rejects(access.describe(execution), /EEXIST|ENOTDIR/u);
    const [first, second] = await Promise.all([
      access.describe(execution),
      access.describe(otherExecution)
    ]);
    assert.deepEqual(await access.describe(execution), first);
    const browser = await chromium.connect(await readFile(second.endpointFile, 'utf8'), {
      timeout: 5_000
    });
    assert.equal(actions, 0, 'Discovery and connection initialization do not renew the lifetime');
    assert.equal(tabs.agentActive, false);
    assert.equal(access.hasClients(), true);
    const flag = `--mar-resource=${first.resourceId}`;
    await Promise.all([cli(scope, flag, 'tab-list'), cli(scope, flag, 'tab-list')]);
    const opened = await cli(scope, flag, 'tab-new', url);
    assert.doesNotMatch(opened, /ws:\/\/127\.0\.0\.1/u);
    const page = context.pages()[1];
    assert(page);
    const loginTab = tabs.agentTabs().tabs.find(({ url: address }) => address === `${url}/`);
    assert(loginTab);
    tabs.select(loginTab.id);
    assert.equal(tabs.snapshot().activeId, loginTab.id);
    await cli(scope, flag, 'tab-select', String(loginTab.pageIndex));
    const sdkPage = browser
      .contexts()[0]!
      .pages()
      .find((candidate) => candidate.url() === `${url}/`);
    assert(sdkPage);
    const cdp = await sdkPage.context().newCDPSession(sdkPage);
    assert.match((await cdp.send('Browser.getVersion')).product, /Chrome/u);
    await cdp.detach();
    // A user and two independent Playwright clients share the same live page.
    await Promise.all([
      page.getByRole('textbox').fill('signed in by the user'),
      sdkPage.locator('button').waitFor(),
      cli(scope, flag, 'snapshot')
    ]);
    await page.getByRole('button', { name: 'Save' }).click();
    assert.equal(
      JSON.parse(await cli(scope, flag, '--raw', 'eval', 'localStorage.getItem("message")')),
      'signed in by the user'
    );
    assert(actions > 0, 'Playwright operations renew the same live browser');
    assert.equal(tabs.agentActive, true);
    await assert.rejects(
      cli(scope, flag, 'snapshot', '--session=isolated'),
      /Put the session flag before/u
    );
    const alsoConnected = await chromium.connect(await readFile(first.endpointFile, 'utf8'), {
      timeout: 5_000
    });
    await cli(scope, flag, 'close');
    assert.equal(alsoConnected.isConnected(), true);
    assert.equal(page.isClosed(), false);
    const disconnected = once(alsoConnected, 'disconnected');
    allowed = false;
    await Promise.race([
      disconnected,
      delay(8_000, undefined, { ref: false }).then(() => {
        throw new Error('Shared Playwright client was not disconnected after revocation');
      })
    ]);
    await assert.rejects(access.describe(execution), /BROWSER_USE_DISABLED/);
    assert.equal(
      await sdkPage.evaluate(() => localStorage.getItem('message')),
      'signed in by the user'
    );
    const otherDisconnected = once(browser, 'disconnected');
    otherLifetime.abort();
    await otherDisconnected;
    assert.equal(page.isClosed(), false);
    assert.deepEqual(errors, []);
  } finally {
    lifetime.abort();
    otherLifetime.abort();
    await access.close();
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
  await sharedLoginSmoke(url, shared, b);
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
    'Verified Run-scoped Playwright cleanup, isolated sessions, and concurrent shared login and revocation.'
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
