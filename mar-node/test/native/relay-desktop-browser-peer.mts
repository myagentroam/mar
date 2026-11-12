import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import WebSocket from 'ws';
import { RelayDesktopService } from '../../src/remote-desktop/relay-desktop-service.js';
import { DirectDesktopService } from '../../src/remote-desktop/direct-desktop-service.js';
import { DesktopAttachmentRegistry } from '../../src/remote-desktop/desktop-service-core.js';
import { NodeControlMessageService } from '../../src/service/node-control-message-service.js';
import { X11RemoteDesktopRuntime } from '../../src/remote-desktop/x11-remote-desktop-runtime.js';
import { RemoteDesktopAdmission } from '../../../packages/server-core/src/remote-desktop-admission.js';
import { RemoteDesktopRelayPairing } from '../../../packages/server-core/src/remote-desktop-relay-pairing.js';
import { RemoteDesktopRelayCoordinator } from '../../../packages/server-core/src/remote-desktop-relay-coordinator.js';
import { RemoteDesktopRelaySockets } from '../../../packages/server-core/src/remote-desktop-relay-sockets.js';
import { registerRealtimeRoutes } from '../../../ee/server/src/route/realtime-routes.js';
import { registerRemoteDesktopDiscoveryRoute } from '../../../ee/server/src/route/remote-desktop-discovery-route.js';
import { startCustomThemeFixture } from '../../../test/e2e/support/custom-theme-vite.js';
import { createEnvelope, type RemoteDesktopRelayServerMessage } from '@myagentroam/protocol';

const requireServer = createRequire(new URL('../../../ee/server/package.json', import.meta.url));
const Fastify = requireServer('fastify');

const [binaryPath, display, xAuthority] = process.argv.slice(2);
const topologyBinary = process.env.MAR_TEST_TOPOLOGY_HELPER;
const pageMode = process.env.MAR_TEST_DESKTOP_PAGE === '1';
if (!binaryPath || !display || !xAuthority || !topologyBinary)
  throw new Error('Missing test inputs');
const identity = { userId: 1, sessionHash: 'session-a', workbenchConnectionId: 'page-12345678' };
const admission = new RemoteDesktopAdmission();
let nodeService: RelayDesktopService | undefined;
const runtime = await X11RemoteDesktopRuntime.start(
  {
    binaryPath,
    topologyBinary,
    display,
    xAuthority,
    maxPixels: 1_000_000,
    fence: () => {
      nodeService?.invalidate('DESKTOP_TOPOLOGY_UNAVAILABLE');
    }
  },
  AbortSignal.timeout(8_000)
);
const layout = runtime.describe();
// The browser crop test uses a synthetic split of the real 800x600 Xvfb framebuffer;
// it does not claim that XRandR exposed two physical monitors.
const pageLayout = {
  ...layout,
  displays: [
    {
      displayId: 'fixture-left',
      name: 'Left',
      primary: false,
      nativeBounds: { x: 0, y: 0, width: 400, height: 600 },
      framebufferBounds: { x: 0, y: 0, width: 400, height: 600 },
      nativeToFramebuffer: [1, 0, 0, 1, 0, 0]
    },
    {
      displayId: 'fixture-primary',
      name: 'Primary',
      primary: true,
      nativeBounds: { x: 400, y: 0, width: 400, height: 600 },
      framebufferBounds: { x: 400, y: 0, width: 400, height: 600 },
      nativeToFramebuffer: [1, 0, 0, 1, 0, 0]
    }
  ]
};
let relay: RemoteDesktopRelayCoordinator;
const pairing = new RemoteDesktopRelayPairing({
  admission,
  maxFrameBytes: 16384,
  maxInFlightBytes: 1048576,
  onClosed: (id) => {
    relay.pairingClosed(id);
  }
});
const browserMessages: RemoteDesktopRelayServerMessage[] = [];
const browserControls: { type?: string }[] = [];
let routeNodeControl: ((command: { type: string }) => boolean) | undefined;
let browserPage: Page | undefined;
let workbenchSocket: WebSocket | undefined;
relay = new RemoteDesktopRelayCoordinator({
  admission,
  pairing,
  authorize: () => true,
  preflight: async () => 4,
  sendNode: (_id, command) => {
    if (routeNodeControl) return routeNodeControl(command);
    return nodeService?.handle(command) ?? false;
  },
  sendBrowser: async (_id, message) => {
    browserMessages.push(message);
    if (pageMode) workbenchSocket?.send(JSON.stringify(message));
    else
      await browserPage?.evaluate(
        (frame) => (globalThis as any).desktopRelayProbe.deliver(frame),
        message
      );
    return 'delivered';
  }
});
const relaySockets = new RemoteDesktopRelaySockets({
  pairing,
  ownsPage: (user, id) =>
    user.userId === identity.userId &&
    user.sessionHash === identity.sessionHash &&
    id === identity.workbenchConnectionId,
  authenticateNode: async (id, credential) =>
    id === 'node-a' && credential === 'test-node-credential' ? { id, disabled: false } : undefined,
  currentNodeGeneration: (id) => (id === 'node-a' ? 'generation-1' : undefined)
});
const server = Fastify();
const database = {
  findCurrentUserSession: (sessionId: string) =>
    sessionId === 'test-session'
      ? {
          userId: identity.userId,
          sessionHash: identity.sessionHash,
          username: 'test',
          isAdmin: true,
          mustChangePassword: false,
          csrfTokenHash: 'test'
        }
      : undefined
};
registerRealtimeRoutes({
  app: server,
  publicOrigin: undefined,
  database,
  nodeControl: {
    attachNodeDesktopRelay: (socket: WebSocket) => relaySockets.attachNode(socket),
    attachBrowserDesktopRelay: (socket: WebSocket, user: { userId: number; sessionHash: string }) =>
      relaySockets.attachBrowser(socket, user),
    attachBrowserWorkbench: (socket: WebSocket) => {
      workbenchSocket = socket;
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        browserControls.push(message);
        if (message.type === 'resume')
          socket.send(
            JSON.stringify({
              type: 'workbench.ready',
              workbenchConnectionId: identity.workbenchConnectionId,
              workbenchResumeToken: 'test-resume'
            })
          );
        else if (message.type === 'ping')
          socket.send(JSON.stringify({ type: 'pong', id: message.id }));
        else void relay.handleBrowser(identity, message);
      });
    }
  } as never
});
if (pageMode)
  registerRemoteDesktopDiscoveryRoute({
    app: server,
    database,
    publicOrigin: undefined,
    resources: { canUseNode: async () => true },
    nodeControl: {
      nodeCapabilities: () => ({
        remoteDesktop: {
          apiVersion: 1,
          available: true,
          nodeGeneration: 'generation-1',
          backend: 'TIGERVNC_X0',
          supportsView: true,
          supportsControl: true,
          supportsMultiDisplay: true,
          supportsUnicodePaste: true,
          transports: ['RELAY']
        }
      }),
      requestNode: async () => pageLayout
    } as never
  });
server.get('/', async (_request, reply) =>
  reply.type('text/html').send('<div id="desktop" style="width:800px;height:600px"></div>')
);
const httpUrl = await server.listen({ host: '127.0.0.1', port: 0 });
const url = httpUrl.replace('http:', 'ws:');
const slots = new DesktopAttachmentRegistry();
const directService = new DirectDesktopService({
  registry: slots,
  nodeGeneration: () => 'generation-1',
  peer: () => undefined,
  isCurrent: () => true,
  createAttachment: () => {
    throw new Error('Unexpected Direct attachment');
  },
  emit: () => true
});
nodeService = new RelayDesktopService({
  registry: slots,
  nodeId: 'node-a',
  nodeGeneration: () => 'generation-1',
  connect: () => new WebSocket(`${url}/api/node/desktop-relay`, { maxPayload: 16384 }),
  credential: () => 'test-node-credential',
  isCurrent: (command) => runtime.isCurrent(command),
  createAttachment: (command, stream, callbacks) =>
    runtime.createAttachment(command, stream, callbacks),
  emit: (event) => {
    void relay.onNodeEvent('node-a', 'generation-1', event);
    return true;
  }
});
if (process.env.MAR_TEST_CONTROL_ROUTING === '1') {
  let handled = false;
  const options = {
    handleRuntimeCredentialResponse: () => false,
    handleDesktopDirect: (envelope: { type: string; payload: object }) =>
      (handled = directService.handle({ ...envelope.payload, type: envelope.type })),
    handleDesktopRelay: (envelope: { type: string; payload: object }) =>
      (handled = nodeService!.handle({ ...envelope.payload, type: envelope.type }))
  } as unknown as ConstructorParameters<typeof NodeControlMessageService>[0];
  const control = new NodeControlMessageService(options);
  routeNodeControl = (command) => {
    handled = false;
    const { type, ...payload } = command;
    control.handle(JSON.stringify(createEnvelope(type, payload)));
    return handled;
  };
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for relay state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage(
  process.env.MAR_TEST_PAGE_SOFTKEY === '1'
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : {}
);
async function cycleQuality(): Promise<void> {
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
}
page.setDefaultTimeout(8000);
browserPage = page;
let vite: Awaited<ReturnType<typeof startCustomThemeFixture>> | undefined;
page.on('pageerror', (error) => console.error('Browser probe error:', error.message));
page.on('console', (message) => console.error('Browser console:', message.text()));
try {
  await page
    .context()
    .addCookies([{ name: 'mar_user_session', value: 'test-session', url: httpUrl }]);
  if (pageMode) {
    vite = await startCustomThemeFixture('test/e2e/support/remote-desktop-page.html', {
      protocolSource: true,
      apiProxy: httpUrl
    });
    await page.addInitScript({
      content: `Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { readText: () => new Promise(resolve => { window.finishClipboardRead = resolve; }) }
    });`
    });
    await page.goto(
      `${vite.url}remote-desktop-page.html?remoteDesktop=1&nodeId=node-a${process.env.MAR_TEST_PAGE_LATE_FRAME === '1' ? '&holdFrame=1' : ''}`
    );
    if (process.env.MAR_TEST_PAGE_LATE_FRAME === '1')
      await page.waitForFunction(
        () => typeof (window as any).releaseLateFrame === 'function',
        undefined,
        { timeout: 15_000 }
      );
    else {
      await page.getByTestId('desktop-control').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForFunction(
        () => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-testid="desktop-control"]'
          );
          return button && !button.disabled;
        },
        undefined,
        { timeout: 15_000 }
      );
    }
    const view = browserMessages.find((message) => message.type === 'desktop.relay.prepared');
    assert(view?.type === 'desktop.relay.prepared');
    if (process.env.MAR_TEST_PAGE_LATE_FRAME !== '1')
      await waitFor(() => admission.get(view.attachmentId)?.phase === 'ACTIVE');
    if (process.env.MAR_TEST_PAGE_QUALITY === '1') {
      await cycleQuality();
      assert.equal(admission.get(view.attachmentId)?.phase, 'ACTIVE');
      assert.equal(await page.locator('.remote-desktop-target canvas').count(), 1);
    }
    if (
      process.env.MAR_TEST_PAGE_VIEW_HIDDEN === '1' ||
      process.env.MAR_TEST_PAGE_LATE_FRAME === '1'
    ) {
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => admission.get(view.attachmentId) === undefined);
      if (process.env.MAR_TEST_PAGE_LATE_FRAME === '1') {
        await page.evaluate(() => (window as any).releaseLateFrame());
        assert.equal(
          browserControls.filter((message) => message.type === 'desktop.ready').length,
          0
        );
      }
      assert.equal(await page.locator('.remote-desktop-target canvas').count(), 0);
      const count = browserMessages.filter(
        (message) => message.type === 'desktop.relay.prepared'
      ).length;
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(500);
      assert.equal(
        browserMessages.filter((message) => message.type === 'desktop.relay.prepared').length,
        count
      );
      assert.equal(await page.locator('.remote-desktop-target canvas').count(), 0);
      console.log('HIDDEN_VIEW_CLOSED');
    } else {
      if (process.env.MAR_TEST_PAGE_SCREENSHOT)
        await page.screenshot({ path: process.env.MAR_TEST_PAGE_SCREENSHOT });
      if (process.env.MAR_TEST_PAGE_SOFTKEY === '1') await page.getByTestId('desktop-frame').tap();
      else await page.getByTestId('desktop-frame').click();
      await page.keyboard.down('a');
      console.log('READY');
      for await (const line of createInterface({ input: process.stdin })) {
        if (line === 'key') {
          await page.keyboard.up('a');
          if (process.env.MAR_TEST_PAGE_SOFTKEY === '1')
            await page.getByTestId('desktop-control').tap();
          else await page.getByTestId('desktop-control').click();
          await page.waitForFunction(
            () => {
              return !document.querySelector('.remote-desktop-overlay');
            },
            undefined,
            { timeout: 12_000 }
          );
          const control = browserMessages
            .filter((message) => message.type === 'desktop.relay.prepared')
            .at(-1);
          assert(control?.type === 'desktop.relay.prepared');
          assert.notEqual(control.attachmentId, view.attachmentId);
          await waitFor(() => admission.get(control.attachmentId)?.phase === 'ACTIVE');
          if (process.env.MAR_TEST_PAGE_QUALITY === '1') {
            await cycleQuality();
            assert.equal(admission.get(control.attachmentId)?.phase, 'ACTIVE');
          }
          if (process.env.MAR_TEST_PAGE_SOFTKEY === '1')
            await page.getByTestId('desktop-frame').tap();
          else await page.getByTestId('desktop-frame').click();
          await page.keyboard.down('a');
          if (process.env.MAR_TEST_PAGE_CLIPBOARD === '1')
            await page.evaluate(() => {
              document.querySelector<HTMLButtonElement>('[data-testid="desktop-paste"]')?.click();
              (window as any).finishClipboardRead('真实桌面中文');
            });
          console.log('KEY');
        } else if (line === 'soft') {
          console.error('Soft-keyboard probe: opening');
          await page.getByTestId('desktop-keyboard').tap();
          console.error('Soft-keyboard probe: typing');
          await page
            .getByRole('textbox', { name: 'Text to send to the desktop' })
            .fill(process.env.MAR_TEST_PAGE_STRESS === '1' ? 'b'.repeat(256) : 'bc');
          if (process.env.MAR_TEST_PAGE_SCREENSHOT)
            await page.screenshot({ path: `${process.env.MAR_TEST_PAGE_SCREENSHOT}.keyboard.png` });
          console.error('Soft-keyboard probe: sending');
          await page.getByTestId('desktop-send-text').tap();
          await page.getByTestId('desktop-enter').tap();
          await page.getByTestId('desktop-backspace').tap();
          console.error('Soft-keyboard probe: returning to canvas');
          await page.getByTestId('desktop-frame').tap();
          await page.keyboard.down('a');
          console.log('SOFT_TEXT');
        } else if (line === 'close') {
          await page.evaluate((hidden) => {
            document.querySelector<HTMLButtonElement>('[data-testid="desktop-paste"]')?.click();
            if (typeof (window as any).finishClipboardRead !== 'function')
              throw new Error('Clipboard read did not start');
            if (hidden) {
              Object.defineProperty(document, 'hidden', { configurable: true, value: true });
              document.dispatchEvent(new Event('visibilitychange'));
            } else window.dispatchEvent(new Event('blur'));
            (window as any).finishClipboardRead('must not reach the backend');
          }, process.env.MAR_TEST_PAGE_HIDDEN === '1');
          await waitFor(() =>
            browserMessages
              .filter((message) => message.type === 'desktop.relay.prepared')
              .every(
                (message) =>
                  message.type !== 'desktop.relay.prepared' ||
                  admission.get(message.attachmentId) === undefined
              )
          );
          console.log('CLOSED_WITH_NATIVE_RECEIPT');
          process.stdin.destroy();
          break;
        }
      }
    }
  } else {
    await page.goto(httpUrl);
    await page.exposeFunction('desktopRelayControl', (message) =>
      relay.handleBrowser(identity, message)
    );
    const bundle = await build({
      entryPoints: ['packages/web-core/test/e2e/remote-desktop-relay-native-fixture.js'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false
    });
    await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0]!.text });
    await page.waitForFunction(() => (globalThis as any).desktopRelayProbe !== undefined);
    await page.evaluate((layout) => (globalThis as any).desktopRelayProbe.start(layout), layout);
    const prepared = browserMessages.find((message) => message.type === 'desktop.relay.prepared');
    assert(prepared?.type === 'desktop.relay.prepared');
    const { attachmentId } = prepared;
    await page.waitForFunction(
      () => {
        const state = (globalThis as any).desktopRelayProbe.state;
        return state.firstframe || state.failure;
      },
      undefined,
      { timeout: 7000 }
    );
    assert.equal(
      await page.evaluate(() => (globalThis as any).desktopRelayProbe.state.failure),
      null
    );
    await waitFor(() => admission.get(attachmentId)?.phase === 'ACTIVE');
    console.log('READY');
    for await (const line of createInterface({ input: process.stdin })) {
      if (line === 'key') {
        await page.evaluate(() => (globalThis as any).desktopRelayProbe.key());
        console.log('KEY');
      } else if (line === 'close') {
        if (process.env.MAR_TEST_NODE_SHUTDOWN === '1')
          await nodeService.shutdown(AbortSignal.timeout(8_000));
        else if (process.env.MAR_TEST_NODE_SUSPEND === '1')
          await nodeService.suspend(AbortSignal.timeout(8_000));
        else
          assert.equal(
            await page.evaluate(() => (globalThis as any).desktopRelayProbe.close()),
            true
          );
        await waitFor(() => admission.get(attachmentId) === undefined);
        if (process.env.MAR_TEST_NODE_SUSPEND === '1') {
          assert.equal(nodeService.resume(), true);
        }
        console.log('CLOSED_WITH_NATIVE_RECEIPT');
        process.stdin.destroy();
        break;
      } else if (line === 'switch') {
        await page.evaluate(() => (globalThis as any).desktopRelayProbe.switchToView());
        await waitFor(() => admission.get(attachmentId) === undefined);
        const view = browserMessages
          .filter((message) => message.type === 'desktop.relay.prepared')
          .at(-1);
        assert(view?.type === 'desktop.relay.prepared');
        assert.notEqual(view.attachmentId, attachmentId);
        await page.waitForFunction(
          () => {
            const state = (globalThis as any).desktopRelayProbe.state;
            return state.firstframe || state.failure;
          },
          undefined,
          { timeout: 7000 }
        );
        assert.equal(
          await page.evaluate(() => (globalThis as any).desktopRelayProbe.state.failure),
          null
        );
        await waitFor(() => admission.get(view.attachmentId)?.phase === 'ACTIVE');
        assert.equal(
          await page.evaluate(() => (globalThis as any).desktopRelayProbe.state.failure),
          null
        );
        console.log('SWITCHED_AFTER_NATIVE_RECEIPT');
      }
    }
  }
} finally {
  directService.dispose();
  nodeService.dispose();
  relaySockets.close();
  relay.close();
  pairing.close();
  await runtime.dispose().catch(() => {});
  await page.close();
  await browser.close();
  await vite?.close();
  await server.close();
}
