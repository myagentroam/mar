import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { BROWSER_CONTROL_MAX_BYTES, type BrowserAttachmentOpen } from '@myagentroam/protocol';
import {
  BrowserAttachmentCoordinator,
  BrowserScopeRevoked
} from '../../../packages/server-core/src/browser-attachment-coordinator.js';
import { BrowserRelayService } from '../../../packages/server-core/src/browser-relay-service.js';
import {
  openBrowserIceChannel,
  openBrowserRelayChannel
} from '../../src/browser/browser-data-channel.js';
import { BrowserRuntime } from '../../src/browser/browser-runtime.js';
import { createBrowserResourceOperation } from '../../src/browser/browser-resource-operations.js';
import { createBrowserVideoEncoder } from '../../src/browser/browser-video-encoder.js';
import {
  BROWSER_VIDEO_HD_BITRATE,
  BROWSER_VIDEO_HD_LIMIT
} from '../../src/browser/browser-video-config.js';

declare global {
  interface Window {
    startProbe(url: string, grant: BrowserAttachmentOpen): Promise<void>;
    startIce(grant: BrowserAttachmentOpen): Promise<RTCSessionDescriptionInit>;
    receiveAnswer(answer: RTCSessionDescriptionInit): Promise<void>;
    browserClicked: boolean;
    probe: {
      frame: number;
      active?: string;
      ended?: string;
      viewport?: { width: number; height: number };
      contextReceived: boolean;
      click(): boolean;
      button(edge: 'down' | 'up'): boolean;
      context(): boolean;
      resize(width: number, height: number): boolean;
      resizeAndNavigate(address: string): boolean;
    };
  }
}

// Uses the actual attachment owners and data adapters. The isolated fixture
// supplies verified identities and connects the data peers, not product routes.
const mode = process.argv[2] ?? 'relay';
assert(mode === 'relay' || mode === 'ice' || mode === 'ice-hd');
const hd = mode === 'ice-hd';
const fixtureViewport = hd ? BROWSER_VIDEO_HD_LIMIT : { width: 960, height: 600 };
const transportId = 'fixture-transport';
const fingerprint = 'fixture-fingerprint';
const server = createServer((request, response) => {
  if (request.url === '/slow-download') {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="slow.bin"',
      'content-length': 4096
    });
    response.write(Buffer.alloc(1024));
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<canvas></canvas>');
}).listen(0, '127.0.0.1');
const listening = once(server, 'listening');
const wss = new WebSocketServer({ server, maxPayload: BROWSER_CONTROL_MAX_BYTES });
const errors: unknown[] = [];
const failed = (error: unknown) => errors.push(error);
const scope = { workspaceId: 'isolated-test', userId: 1 };
const identity = {
  userId: scope.userId,
  sessionFingerprint: 'test-session',
  connectionId: 'test-workbench'
};
const generation = 'test-generation';
let chrome: Browser | undefined;
let wsNode: WebSocket | undefined;
let wsOther: WebSocket | undefined;
let nativePeer: RTCPeerConnection | undefined;
let fixtureOrigin: string;
let targetPage: Page | undefined;
const profileRoot = await mkdtemp(join(tmpdir(), 'mar-browser-attachment-'));
const runtime = new BrowserRuntime({
  maxBrowsers: 1,
  profileRoot,
  profileUnused: async () => true,
  launch: async (profilePath) => {
    if (profilePath) {
      const context = await chromium.launchPersistentContext(profilePath, {
        channel: 'chrome',
        headless: true,
        chromiumSandbox: true,
        viewport: fixtureViewport
      });
      try {
        targetPage = context.pages()[0] ?? (await context.newPage());
        await targetPage.setContent(
          '<button onclick="window.browserClicked = true">Click me</button>'
        );
        return { context, close: () => context.close() };
      } catch (error) {
        await context.close();
        throw error;
      }
    }
    const process = await chromium.launch({
      channel: 'chrome',
      headless: true,
      chromiumSandbox: true
    });
    try {
      const context = await process.newContext({ viewport: fixtureViewport });
      targetPage = await context.newPage();
      await targetPage.setContent(
        '<button onclick="window.browserClicked = true">Click me</button>'
      );
      return {
        context,
        close: async () => {
          try {
            await context.close();
          } finally {
            await process.close();
          }
        }
      };
    } catch (error) {
      await process.close();
      throw error;
    }
  },
  encoder: async (wantsHd) => {
    if (!chrome) throw new Error('Missing test Chrome');
    const page = await chrome.newPage();
    try {
      await page.goto(fixtureOrigin);
      const codec = await createBrowserVideoEncoder(page, {
        ...(wantsHd ? BROWSER_VIDEO_HD_LIMIT : { width: 960, height: 600 }),
        bitrate: wantsHd ? BROWSER_VIDEO_HD_BITRATE : 384_000,
        framerate: 24,
        hd: wantsHd
      });
      return {
        ...(wantsHd && { hd: true as const }),
        encode: codec.encode,
        close: async () => {
          try {
            await codec.close();
          } finally {
            await page.close();
          }
        }
      };
    } catch (error) {
      await page.close();
      throw error;
    }
  },
  failed
});
const service = runtime.attachments;
const resource = createBrowserResourceOperation(runtime, (id) => {
  if (id !== scope.workspaceId) throw new Error('WORKSPACE_NOT_FOUND');
});
const targetScope = { nodeId: 'node', workspaceId: scope.workspaceId };
let allowed = true;
const coordinator = new BrowserAttachmentCoordinator({
  authorize: async (who, target) => {
    if (
      ![identity.connectionId, 'other-workbench'].includes(who.connectionId) ||
      who.sessionFingerprint !== identity.sessionFingerprint ||
      target.workspaceId !== scope.workspaceId
    )
      return undefined;
    if (!allowed) throw new BrowserScopeRevoked();
    return { generation };
  },
  direct: (_who, _target, _generation, requested) =>
    requested === transportId ? fingerprint : undefined,
  prepare: async (_node, _generation, grant) => service.prepare(grant),
  renew: async (_node, _generation, id, expiresAt) => service.renew(id, expiresAt),
  revoke: async ({ workspaceId, browserId }, _generation, id, code, who) => {
    // Force data-path disposal to win the race against the control RPC.
    if (code === 'BROWSER_NOT_AUTHORIZED') await service.revoke(id, 'BROWSER_DISCONNECTED');
    await runtime.revokeAttachment(who.userId, {
      action: 'revoke',
      attachmentId: id,
      workspaceId,
      browserId,
      code
    });
  },
  closeRelay: (id) => relay.close(id),
  resource: (_node, nodeGeneration, data) => {
    assert.equal(nodeGeneration, generation);
    return resource(data);
  },
  failed
});
const relay = new BrowserRelayService(coordinator, failed);

try {
  await listening;
  const address = server.address();
  assert(address && typeof address !== 'string');
  const http = `http://127.0.0.1:${address.port}`;
  fixtureOrigin = http;
  const ws = `ws://127.0.0.1:${address.port}`;
  chrome = await chromium.launch({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });
  await assert.rejects(
    coordinator.resource({ ...identity, connectionId: 'wrong-page' }, targetScope, {
      action: 'open',
      preserveLogin: true
    }),
    /BROWSER_NOT_AUTHORIZED/
  );
  assert.deepEqual(await coordinator.resource(identity, targetScope, { action: 'lookup' }), {});
  const { browserId } = await coordinator.resource(identity, targetScope, {
    action: 'open',
    preserveLogin: true
  });
  assert(browserId);
  const target = targetPage;
  assert(target);
  await target
    .context()
    .addCookies([
      { name: 'mar-test', value: 'retained', url: http, expires: Date.now() / 1000 + 3600 }
    ]);
  const open = await coordinator.prepare(identity, {
    nodeId: 'node',
    workspaceId: scope.workspaceId,
    browserId,
    ...(mode !== 'relay' ? { transportId } : {})
  });
  assert.equal(
    await coordinator.relayBrowser({ ...identity, connectionId: 'wrong-page' }, open),
    false
  );
  assert.equal(coordinator.relayNode(open.attachmentId, 'node', 'wrong-generation'), false);
  assert.equal(await coordinator.relayBrowser(identity, open), mode === 'relay');
  assert.equal(coordinator.relayNode(open.attachmentId, 'node', generation), mode === 'relay');
  if (mode === 'relay') {
    const peer = once(wss, 'connection');
    wsNode = new WebSocket(ws, { maxPayload: BROWSER_CONTROL_MAX_BYTES });
    await once(wsNode, 'open');
    openBrowserRelayChannel(service, open.attachmentId, wsNode, failed);
    const [nodeSocket] = (await peer) as [WebSocket];
    assert.equal(relay.node(open.attachmentId, 'node', 'wrong-generation', nodeSocket), false);
    assert.equal(relay.node(open.attachmentId, 'node', generation, nodeSocket), true);
    assert.equal(relay.node(open.attachmentId, 'node', generation, nodeSocket), false);
    wss.once('connection', (webSocket) => {
      webSocket.once('message', (data, binary) => {
        if (binary) webSocket.terminate();
        else
          void relay
            .browser(identity, webSocket, data.toString())
            .then((paired) => {
              if (!paired) webSocket.terminate();
            })
            .catch(failed);
      });
    });
  }
  const web = await chrome.newPage();
  web.on('pageerror', (error) => errors.push(error));
  await web.goto(http);
  const bundle = await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `import { BrowserAttachmentClient, supportsBrowserVideo } from '../../../packages/web-core/src/service/browser-attachment-client.ts';
        async function start(link, grant) {
          if (!await supportsBrowserVideo()) throw new Error('No H.264 decoder');
          if (grant.hd && !await supportsBrowserVideo(true)) throw new Error('No HD H.264 decoder');
          let version;
          const button = (edge) => client.send({ type: 'input', action: {
            type: 'button', button: 'left', x: 20, y: 16, viewVersion: version, edge
          } });
          window.probe = { frame: 0, contextReceived: false, button,
            click: () => button('down') && button('up'),
            context: () => client.send({ type: 'context.open', id: crypto.randomUUID(), viewVersion: version, point: { x: 20, y: 16 } }),
            resize: (width, height) => client.send({ type: 'viewport.resize', width, height }),
          resizeAndNavigate: (address) =>
            client.send({ type: 'viewport.resize', width: 391, height: 701 }) &&
            client.send({ type: 'navigate', address, viewVersion: version })
          };
          const client = new BrowserAttachmentClient(link, document.querySelector('canvas'), grant, {
            attached: () => {
              if (grant.hd) client.send({ type: 'viewport.resize', width: 1920, height: 1080 });
            },
            snapshot: (state) => { window.probe.active = state.activeId; },
            contextMenu: () => { window.probe.contextReceived = true; },
            frame: (drawn) => { version = drawn.viewVersion; window.probe.frame++; window.probe.viewport = drawn; },
            sample: () => {},
            failed: (code) => { throw new Error(code); },
            ended: (code) => { window.probe.ended = code; }
          });
        }
        window.startProbe = (url, grant) => start(new WebSocket(url), grant);
        window.startIce = async (grant) => {
          const pc = new RTCPeerConnection({ iceServers: [] });
          window.receiveAnswer = (answer) => pc.setRemoteDescription(answer);
          await start(pc.createDataChannel('mar-browser-fixture'), grant);
          await pc.setLocalDescription(await pc.createOffer());
          if (pc.iceGatheringState !== 'complete') await new Promise(resolve => pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); }));
          return pc.localDescription.toJSON();
        };`
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife'
  });
  await web.addScriptTag({ content: bundle.outputFiles[0]!.text });
  if (mode === 'relay') {
    await web.evaluate(({ ws, open }) => window.startProbe(ws, open), { ws, open });
  } else {
    const peer = (nativePeer = new RTCPeerConnection({
      iceServers: [],
      maxMessageSize: 64 * 1024
    }));
    peer.addEventListener('datachannel', ({ channel }) => {
      channel.addEventListener(
        'message',
        ({ data }) =>
          openBrowserIceChannel(
            service,
            { type: 'ice', transportId, fingerprint },
            channel,
            data,
            failed
          ),
        { once: true }
      );
    });
    await peer.setRemoteDescription(
      await web.evaluate((open) => window.startIce(open), { ...open, ...(hd && { hd: true }) })
    );
    if (peer.iceGatheringState !== 'complete')
      await new Promise<void>((resolve) =>
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') resolve();
        })
      );
    await web.evaluate((answer) => window.receiveAnswer(answer), {
      type: peer.localDescription!.type,
      sdp: peer.localDescription!.sdp
    });
  }
  await web.waitForFunction(
    () => (window.probe.frame > 0 && !!window.probe.active) || !!window.probe.ended,
    undefined,
    { timeout: 8_000 }
  );
  const ended = await web.evaluate(() => window.probe.ended);
  assert.equal(ended, undefined, JSON.stringify({ ended, errors: errors.map(String) }));
  if (hd) {
    await web.waitForFunction(() => window.probe.viewport?.width === 1920, undefined, {
      timeout: 5_000
    });
    assert.deepEqual(
      await web
        .locator('canvas')
        .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]),
      [1920, 1080]
    );
  }
  assert.equal(await web.evaluate(() => window.probe.click()), true);
  await target.waitForFunction(() => window.browserClicked, undefined, { timeout: 5_000 });
  const resized = `${http}/after-resize`;
  assert.equal(await web.evaluate((url) => window.probe.resizeAndNavigate(url), resized), true);
  await target.waitForURL(resized, { timeout: 5_000 });
  await web.waitForFunction(
    () => window.probe.viewport?.width === 391 && window.probe.viewport.height === 701,
    undefined,
    { timeout: 5_000 }
  );
  assert.deepEqual(await target.evaluate(() => [innerWidth, innerHeight]), [391, 701]);
  const other = { ...identity, connectionId: 'other-workbench' };
  const otherGrant = await coordinator.prepare(other, { ...targetScope, browserId });
  const otherNode = once(wss, 'connection');
  wsOther = new WebSocket(ws, { maxPayload: BROWSER_CONTROL_MAX_BYTES });
  await once(wsOther, 'open');
  openBrowserRelayChannel(service, otherGrant.attachmentId, wsOther, failed);
  const [otherSocket] = (await otherNode) as [WebSocket];
  assert.equal(relay.node(otherGrant.attachmentId, 'node', generation, otherSocket), true);
  wss.once('connection', (webSocket) => {
    webSocket.once('message', (data, binary) => {
      if (binary) webSocket.terminate();
      else void relay.browser(other, webSocket, data.toString()).catch(failed);
    });
  });
  const otherWeb = await chrome.newPage();
  otherWeb.on('pageerror', failed);
  await otherWeb.goto(http);
  await otherWeb.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await otherWeb.evaluate(({ ws, grant }) => window.startProbe(ws, grant), {
    ws,
    grant: otherGrant
  });
  try {
    await otherWeb.waitForFunction(
      () => window.probe.frame > 0 || !!window.probe.ended,
      undefined,
      { timeout: 8_000 }
    );
  } catch (cause) {
    throw new Error(`No frame for second viewer: ${errors.map(String).join('; ')}`, { cause });
  }
  assert.equal(
    await otherWeb.evaluate(() => window.probe.ended),
    undefined,
    errors.map(String).join('; ')
  );
  assert.equal(await otherWeb.evaluate(() => window.probe.resize(640, 480)), true);
  assert.equal(await web.evaluate(() => window.probe.ended), undefined);
  const frames = await Promise.all(
    [web, otherWeb].map((view) => view.evaluate(() => window.probe.frame))
  );
  await target.evaluate(() => {
    document.body.style.backgroundColor = 'rgb(123, 45, 67)';
  });
  await Promise.all(
    [web, otherWeb].map((view, index) =>
      view.waitForFunction((frame) => window.probe.frame > frame!, frames[index], {
        timeout: 5_000
      })
    )
  );
  assert.deepEqual(await target.evaluate(() => [innerWidth, innerHeight]), [391, 701]);
  await coordinator.renew(identity, open.attachmentId);
  const downloadEvent = target.waitForEvent('download', { timeout: 5_000 });
  await target.setContent(`<a href="${http}/slow-download">Download</a>`);
  await target.getByRole('link', { name: 'Download' }).click();
  const download = await downloadEvent;
  await target.evaluate(() => {
    document.body.dataset.input = '';
    for (const type of ['mousedown', 'mouseup'] as const) {
      document.addEventListener(type, (event) => {
        document.body.dataset.input += `${event.type}:${event.button};`;
      });
    }
  });
  assert.equal(await web.evaluate(() => window.probe.button('down')), true);
  await target.waitForFunction(() => document.body.dataset.input === 'mousedown:0;');
  assert.equal(
    await otherWeb.evaluate(() => window.probe.button('up') && window.probe.context()),
    true
  );
  await otherWeb.waitForFunction(() => window.probe.contextReceived, undefined, { timeout: 5_000 });
  assert.equal(await target.evaluate(() => document.body.dataset.input), 'mousedown:0;');
  allowed = false;
  await assert.rejects(coordinator.renew(identity, open.attachmentId), /BROWSER_NOT_AUTHORIZED/);
  const failure = await Promise.race([
    download.failure(),
    new Promise((resolve) => setTimeout(resolve, 3000, 'download still running').unref())
  ]);
  assert.equal(failure, 'canceled');
  await web.waitForFunction(() => !!window.probe.ended, undefined, { timeout: 5_000 });
  await otherWeb.waitForFunction(
    () => window.probe.viewport?.width === 640 && window.probe.viewport.height === 480,
    undefined,
    { timeout: 5_000 }
  );
  assert.equal(await otherWeb.evaluate(() => window.probe.ended), undefined);
  assert.deepEqual(await target.evaluate(() => [innerWidth, innerHeight]), [640, 480]);
  assert.equal(await target.evaluate(() => document.body.dataset.input), 'mousedown:0;mouseup:0;');
  await target.setContent('<button onclick="window.browserClicked = true">Click me</button>');
  assert.equal(await otherWeb.evaluate(() => window.probe.click()), true);
  await target.waitForFunction(() => window.browserClicked, undefined, { timeout: 5_000 });
  await coordinator.release(other, otherGrant.attachmentId);
  await otherWeb.close();
  assert.equal(runtime.lookup(scope), browserId);
  await assert.rejects(
    coordinator.resource(identity, targetScope, { action: 'close', browserId }),
    /BROWSER_NOT_AUTHORIZED/
  );
  allowed = true;
  assert.deepEqual(await coordinator.resource(identity, targetScope, { action: 'lookup' }), {
    browserId
  });
  await coordinator.resource(identity, targetScope, { action: 'close', browserId });
  assert.equal(runtime.lookup(scope), undefined);
  assert(target.isClosed());
  const reopened = await runtime.open(scope, true);
  assert.notEqual(reopened, browserId);
  assert.equal(
    (await targetPage?.context().cookies(http))?.find(({ name }) => name === 'mar-test')?.value,
    'retained'
  );
  await runtime.close(scope, reopened);
  assert.deepEqual(errors, []);
  console.log(
    `Browser ${mode} attachment: H.264 decode, concurrent relay viewer, viewport handoff, click and lease revocation passed.`
  );
} finally {
  await coordinator.shutdown();
  await runtime.shutdown();
  wsNode?.terminate();
  wsOther?.terminate();
  nativePeer?.close();
  for (const socket of wss.clients) socket.terminate();
  await chrome?.close();
  await rm(profileRoot, { recursive: true, force: true });
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  server.close();
  if (nativePeer) cleanup();
}
