import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { NodeConnector } from '../../src/connector.js';
import { unavailableCapabilities } from '../../src/capabilities.js';

const [directory, productRoot, databaseUrl] = process.argv.slice(2);
if (!directory || !productRoot || !databaseUrl) throw new Error('Missing private test arguments.');
const { createServerApp } = await import(
  pathToFileURL(join(productRoot, 'ee/server/src/app.ts')).href
);
const { INITIAL_ADMIN_PASSWORD } = await import(
  pathToFileURL(join(productRoot, 'packages/server-core/src/password.ts')).href
);
const webRoot = process.env.MAR_TEST_WEB_ROOT;
const trace = (step: string) => {
  if (process.env.MAR_TEST_TRACE === '1') console.error(`PRODUCT_DESKTOP_STEP ${step}`);
};
trace('creating server');
const { app } = await createServerApp({
  databaseUrl,
  dataDirectory: join(directory, 'server'),
  secureCookies: false,
  logger: false,
  ...(webRoot ? { webRoot } : {})
});
let connector: NodeConnector | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const cookie = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.split(';')[0] ?? '';
const run = promisify(execFile);
const keyProbe = `import ctypes, os
x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ctypes.c_void_p
x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
d = x.XOpenDisplay(os.environ['DISPLAY'].encode())
assert d
code = x.XKeysymToKeycode(d, ord('a'))
keys = ctypes.create_string_buffer(32)
x.XQueryKeymap(d, keys)
print(1 if keys.raw[code // 8] & (1 << (code % 8)) else 0)
x.XCloseDisplay(d)`;
async function waitForKey(down: boolean): Promise<void> {
  const receipt = down
    ? (process.env.MAR_TEST_KEY_DOWN_RECEIPT ?? process.env.MAR_DESKTOP_KEY_RECEIPT)
    : (process.env.MAR_TEST_KEY_UP_RECEIPT ?? process.env.MAR_DESKTOP_KEY_UP_RECEIPT);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (receipt) {
      const value = await readFile(receipt, 'utf8').catch(() => '');
      if (value.trim() === (down ? 'key-a' : 'key-up')) return;
    } else {
      const { stdout } = await run('python3', ['-c', keyProbe]);
      if (stdout.trim() === (down ? '1' : '0')) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Native key did not become ${down ? 'pressed' : 'released'}.`);
}
try {
  trace('starting server');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = app.listeningOrigin;
  assert(origin);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
  });
  assert.equal(login.statusCode, 200, login.body);
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: {
      cookie: cookie(login.headers['set-cookie']),
      'x-csrf-token': login.json().csrfToken
    },
    payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'isolated-desktop-test-password' }
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const headers = {
    cookie: cookie(changed.headers['set-cookie']),
    'x-csrf-token': changed.json().csrfToken
  };
  const registration = await app.inject({
    method: 'POST',
    url: '/api/node-registration-tokens',
    headers,
    payload: { displayName: 'Private Desktop Probe' }
  });
  assert.equal(registration.statusCode, 200, registration.body);
  trace('starting connector');
  connector = new NodeConnector({
    reconnect: false,
    capabilities: unavailableCapabilities(),
    configPath: join(directory, 'node.json'),
    config: {
      serverUrl: origin,
      allowedRoots: [],
      dataDirectory: join(directory, 'node'),
      registrationToken: registration.json().token,
      computerUse: { enabled: false }
    }
  });
  await connector.start();
  let nodeId: string | undefined;
  for (let i = 0; i < 100; i++) {
    const response = await app.inject({ url: '/api/nodes', headers });
    const node = response.json().nodes?.find((item: { connected: boolean }) => item.connected);
    if (node) {
      nodeId = node.id;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(nodeId, 'Node did not register.');
  const discovery = await app.inject({ url: `/api/nodes/${nodeId}/desktop`, headers });
  assert.equal(discovery.statusCode, 200, discovery.body);
  assert.equal(discovery.json().capability.available, true);
  trace('discovery ready');
  const displays = discovery.json().description.displays as { name: string; primary: boolean }[];
  if (process.env.MAR_TEST_MULTIDISPLAY === '1') {
    assert.equal(displays.length, 2);
    assert.equal(displays.filter((display) => display.primary).length, 1);
  }
  if (webRoot) {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    if (process.env.MAR_TEST_TRANSPORT === 'RELAY')
      await context.addInitScript(() => {
        (globalThis as any).RTCPeerConnection = undefined;
      });
    const session = headers.cookie;
    const separator = session.indexOf('=');
    assert(separator > 0);
    await context.addCookies([
      { name: session.slice(0, separator), value: session.slice(separator + 1), url: origin }
    ]);
    const page = await context.newPage();
    const controlFrames: string[] = [];
    page.on('websocket', (socket) => {
      socket.on('framesent', ({ payload }) => {
        if (
          typeof payload === 'string' &&
          (payload.includes('desktop.direct.') || payload.includes('desktop.relay.'))
        )
          controlFrames.push(payload);
      });
    });
    await page.goto(`${origin}/console?remoteDesktop=1&nodeId=${encodeURIComponent(nodeId)}`);
    trace('browser loaded');
    try {
      await page.waitForFunction(
        () => {
          const control = document.querySelector<HTMLButtonElement>(
            '[data-testid="desktop-control"]'
          );
          return (
            !!document.querySelector('.remote-desktop-target canvas') &&
            !!control &&
            !control.disabled
          );
        },
        { timeout: 30_000 }
      );
      trace('first frame ready');
      if (process.env.MAR_TEST_RED_FRAME === '1') {
        await page.waitForFunction(
          () => {
            const canvas = document.querySelector<HTMLCanvasElement>(
              '.remote-desktop-target canvas'
            );
            const context = canvas?.getContext('2d');
            if (!canvas || !context || !canvas.width || !canvas.height) return false;
            const [r, g, b] = context.getImageData(
              Math.floor(canvas.width / 2),
              Math.floor(canvas.height / 2),
              1,
              1
            ).data;
            return r > 150 && g < 100 && b < 100;
          },
          { timeout: 10_000 }
        );
      }
      if (process.env.MAR_TEST_PAGE_QUALITY === '1') {
        const quality = page.getByTestId('desktop-quality');
        const initial = await quality.innerText();
        await quality.click();
        await page.getByRole('option').first().click();
        assert.notEqual(await quality.innerText(), initial);
        await quality.click();
        await page.getByRole('option').nth(2).click();
        assert.notEqual(await quality.innerText(), initial);
        await quality.click();
        await page.getByRole('option').nth(1).click();
        assert.equal(await quality.innerText(), initial);
        assert.equal(await page.locator('.remote-desktop-target canvas').count(), 1);
      }
      if (process.env.MAR_TEST_MULTIDISPLAY === '1') {
        const secondary = displays.find((display) => !display.primary);
        assert(secondary);
        await page.getByTestId('desktop-screen').click();
        await page.getByRole('option', { name: secondary.name, exact: true }).click();
        await page.waitForFunction((name) => {
          const select = document.querySelector('[data-testid="desktop-screen"]');
          return (
            select?.textContent?.includes(name) || select?.querySelector('input')?.value === name
          );
        }, secondary.name);
        assert(await page.locator('.remote-desktop-target canvas').count());
        console.log('PRODUCT_DESKTOP_TWO_DISPLAYS_READY');
      }
      await page.getByTestId('desktop-control').click();
      await page.waitForFunction(
        () => {
          const keyboard = document.querySelector<HTMLButtonElement>(
            '[data-testid="desktop-keyboard"]'
          );
          return (
            !!document.querySelector('.remote-desktop-target canvas') &&
            !!keyboard &&
            !keyboard.disabled
          );
        },
        { timeout: 30_000 }
      );
      await page.locator('.remote-desktop-target canvas').click();
      await page.keyboard.down('a');
      await waitForKey(true);
    } catch (error) {
      const frame = await page
        .locator('.remote-desktop-target canvas')
        .evaluate((canvas: HTMLCanvasElement) => {
          const context = canvas.getContext('2d');
          return {
            width: canvas.width,
            height: canvas.height,
            samples: [0.25, 0.5, 0.75].map((ratio) =>
              context && canvas.width && canvas.height
                ? Array.from(
                    context.getImageData(
                      Math.floor(canvas.width * ratio),
                      Math.floor(canvas.height * ratio),
                      1,
                      1
                    ).data
                  )
                : []
            )
          };
        })
        .catch(() => undefined);
      console.error(
        'PRODUCT_DESKTOP_FRAME_DIAGNOSTIC',
        JSON.stringify({ description: discovery.json().description, frame })
      );
      throw new Error(
        `Browser desktop did not become ready: ${await page.locator('body').innerText()}`,
        { cause: error }
      );
    }
    await context.close();
    try {
      await waitForKey(false);
    } catch (error) {
      if (!process.env.MAR_TEST_KEY_UP_RECEIPT && !process.env.MAR_DESKTOP_KEY_UP_RECEIPT)
        throw error;
      console.warn('PRODUCT_DESKTOP_KEY_RELEASE_UNOBSERVED');
    }
    const relay = controlFrames.some((frame) => frame.includes('desktop.relay.prepare'));
    const direct = controlFrames.some((frame) => frame.includes('desktop.direct.prepare'));
    assert(relay || direct, 'No desktop prepare observed on the product control connection.');
    if (process.env.MAR_TEST_TRANSPORT === 'RELAY') assert(relay, 'Relay was not used.');
    console.log(`PRODUCT_DESKTOP_TRANSPORT_${relay ? 'RELAY' : 'DIRECT'}`);
    console.log('PRODUCT_DESKTOP_BROWSER_READY');
  }
  console.log('PRODUCT_DESKTOP_DISCOVERY_READY');
} finally {
  trace('closing browser and services');
  await browser?.close();
  trace('browser closed');
  await connector?.stop();
  trace('connector stopped');
  await app.shutdown();
  trace('server stopped');
  if (process.env.MAR_TEST_TRACE === '1') {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const handles = (process as any)._getActiveHandles() as any[];
    trace(
      `remaining handles: ${handles
        .map((handle) =>
          JSON.stringify({
            type: handle.constructor.name,
            listening: handle.listening,
            destroyed: handle.destroyed,
            fd: handle.fd,
            isStdio: handle._isStdio,
            readable: handle.readable,
            writable: handle.writable,
            localPort: handle.localPort,
            remotePort: handle.remotePort,
            referenced: handle.hasRef?.() ?? handle._handle?.hasRef?.()
          })
        )
        .join(', ')}`
    );
    trace(`active resources: ${process.getActiveResourcesInfo().join(', ')}`);
  }
}
