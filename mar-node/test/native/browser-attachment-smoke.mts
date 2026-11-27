import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import type { BrowserAttachmentOpen } from '@myagentroam/protocol';
import {
  BrowserAttachmentCoordinator,
  BrowserScopeRevoked
} from '../../../packages/server-core/src/browser-attachment-coordinator.js';
import { NodeStreamRelay } from '../../../packages/server-core/src/node-stream-relay.js';
import {
  bindNodeStreamPath,
  bindNodeDirectPath,
  rtcNodeStreamCarrier
} from '@myagentroam/protocol/node-stream-path';
import {
  encodeNodeStreamFrame,
  MAX_NODE_STREAM_FRAME_BYTES
} from '@myagentroam/protocol/node-stream-wire';
import { parseBrowserStreamGrant } from '@myagentroam/protocol/browser-stream';
import { serveBrowserStream } from '../../src/browser/browser-stream-channel.js';
import {
  BROWSER_DEVICE_SCALE_FACTOR,
  browserStreamSize
} from '../../src/browser/browser-capture-config.js';
import { BrowserRuntime } from '../../src/browser/browser-runtime.js';
import { createBrowserResourceOperation } from '../../src/browser/browser-resource-operations.js';
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
      key(key: string, edge: 'down' | 'up'): boolean;
      context(): boolean;
      resize(width: number, height: number): boolean;
      resizeAndNavigate(address: string): boolean;
      wheel(y: number): boolean;
      quality?: 'low' | 'medium' | 'high';
      selectQuality(mode: 'low' | 'medium' | 'high' | 'auto'): boolean;
      samples: { bitsPerSecond: number; framesPerSecond: number }[];
    };
  }
}

// Uses the actual attachment owners and data adapters. The isolated fixture
// supplies verified identities and connects the data peers, not product routes.
// --measure optionally adds per-phase counters; --limit-kbps=N caps frame writes
// during scrolling and animation, but does not emulate WAN RTT or packet loss.
const mode = process.argv[2] ?? 'relay';
assert(mode === 'relay' || mode === 'ice' || mode === 'ice-hd');
const flags = process.argv.slice(3);
const limit = flags.find((arg) => arg.startsWith('--limit-kbps='));
const limitKbps = limit === undefined ? 0 : Number(limit.slice('--limit-kbps='.length));
assert(limit === undefined || (Number.isFinite(limitKbps) && limitKbps > 0));
assert(flags.every((arg) => arg === '--measure' || arg === limit));
const measure = flags.includes('--measure') || !!limit;
const hd = mode === 'ice-hd';
const fixtureViewport = hd ? { width: 1920, height: 1080 } : { width: 960, height: 600 };
const transportId = 'fixture-transport';
const fingerprint = 'fixture-fingerprint';
const launchArgs = [`--force-device-scale-factor=${BROWSER_DEVICE_SCALE_FACTOR}`];
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
const wss = new WebSocketServer({ server, maxPayload: MAX_NODE_STREAM_FRAME_BYTES });
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
let nativePeer: RTCPeerConnection | undefined;
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
        args: launchArgs,
        deviceScaleFactor: BROWSER_DEVICE_SCALE_FACTOR,
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
      chromiumSandbox: true,
      args: launchArgs
    });
    try {
      const context = await process.newContext({
        deviceScaleFactor: BROWSER_DEVICE_SCALE_FACTOR,
        viewport: fixtureViewport
      });
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
  failed
});
const service = runtime.attachments;
let motionPhase = false;
let frameBytes = 0;
if (measure) {
  const open = service.open.bind(service);
  service.open = (grant, route, channel) => {
    const send = channel.sendFrame.bind(channel);
    channel.sendFrame = async (chunk, signal) => {
      if (motionPhase && limitKbps)
        await delay(Math.ceil((chunk.byteLength * 8) / limitKbps), undefined, { signal });
      await send(chunk, signal);
      frameBytes += chunk.byteLength;
    };
    return open(grant, route, channel);
  };
}
const revoked: string[] = [];
const revoke = service.revoke.bind(service);
service.revoke = (id, code) => {
  revoked.push(code);
  return revoke(id, code);
};
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
  resource: (_node, nodeGeneration, data) => {
    assert.equal(nodeGeneration, generation);
    return resource(data);
  },
  failed
});
const relayNode = bindNodeStreamPath({
  carrier: {
    send: async (bytes) => relay.receiveNode(bytes),
    close: () => relay.close()
  },
  maxStreams: 32,
  accept: async ({ kind, grant }) => {
    const open = kind === 'browser-rfb' && parseBrowserStreamGrant(grant);
    return open
      ? (stream) => serveBrowserStream(service, open, { type: 'relay' }, stream)
      : undefined;
  }
});
const relay = new NodeStreamRelay((frame) => relayNode.receive(encodeNodeStreamFrame(frame)), {
  perClient: 4,
  perNode: 32
});
wss.on('connection', (socket) => {
  const client = relay.attachClient(
    (frame) => socket.send(encodeNodeStreamFrame(frame)),
    async ({ kind, grant }, signal) => {
      const open = kind === 'browser-rfb' && parseBrowserStreamGrant(grant);
      if (!open) return undefined;
      const admission = await coordinator.authorizeRelayStream(identity, 'node', open, signal);
      if (admission) return { grant, ...admission };
    }
  );
  socket.on('message', (bytes, binary) => (binary ? client.receive(bytes) : socket.terminate()));
  socket.once('close', client.close);
});
let primaryRenewal: ReturnType<typeof setInterval> | undefined;

try {
  await listening;
  const address = server.address();
  assert(address && typeof address !== 'string');
  const http = `http://127.0.0.1:${address.port}`;
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
    await coordinator.authorizeRelayStream(
      identity,
      'wrong-node',
      open,
      new AbortController().signal
    ),
    undefined
  );
  assert.equal(
    await coordinator.authorizeRelayStream(
      { ...identity, sessionFingerprint: 'wrong-session' },
      'node',
      open,
      new AbortController().signal
    ),
    undefined
  );
  assert.equal(
    await coordinator.authorizeRelayStream(
      identity,
      'node',
      { ...open, ticket: 'x'.repeat(32) },
      new AbortController().signal
    ),
    undefined
  );
  const web = await chrome.newPage();
  const webProfile = measure ? await web.context().newCDPSession(web) : undefined;
  await webProfile?.send('Performance.enable', { timeDomain: 'threadTicks' });
  const taskMs = async () => {
    const profile = await webProfile?.send('Performance.getMetrics');
    const task = profile?.metrics.find(({ name }) => name === 'TaskDuration');
    assert(task, 'Chromium did not report renderer task time');
    return task.value * 1_000;
  };
  const startMeasurement = async () => {
    if (!measure) return;
    const tasks = await taskMs();
    return { tasks, bytes: frameBytes, at: performance.now(), cpu: process.cpuUsage() };
  };
  const finishMeasurement = async (
    phase: string,
    start: Awaited<ReturnType<typeof startMeasurement>>,
    frames: number
  ) => {
    if (!start) return;
    const durationMs = performance.now() - start.at;
    const cpu = process.cpuUsage(start.cpu);
    const bytes = frameBytes - start.bytes;
    console.log(
      JSON.stringify({
        phase,
        mode,
        limitKbps,
        durationMs,
        frames,
        bytes,
        fps: (frames * 1_000) / durationMs,
        mbps: (bytes * 8) / durationMs / 1_000,
        nodeCpuMs: (cpu.user + cpu.system) / 1_000,
        webTaskMs: (await taskMs()) - start.tasks
      })
    );
  };
  web.on('pageerror', (error) => errors.push(error));
  web.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await web.goto(http);
  const bundle = await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `import { BrowserAttachmentClient } from '../../../packages/web-core/src/service/browser-attachment-client.ts';
        import { BrowserRecordLink } from '../../../packages/web-core/src/service/browser-record-link.ts';
        import { bindNodeDirectPath, rtcNodeStreamCarrier } from '@myagentroam/protocol/node-stream-path';
        import { browserStreamGrant } from '@myagentroam/protocol/browser-stream';
        async function start(path, grant) {
          const stream = await path.openStream({ kind: 'browser-rfb', grant: browserStreamGrant(grant) });
          const link = new BrowserRecordLink(stream);
          let version;
          const button = (edge) => client.send({ type: 'input', action: {
            type: 'button', button: 'left', x: 20, y: 16, viewVersion: version, edge
          } });
          window.probe = { frame: 0, contextReceived: false, button, samples: [],
            click: () => button('down') && button('up'),
            key: (key, edge) => client.send({ type: 'input', action: { type: 'key', key, edge, viewVersion: version } }),
            wheel: (y) => client.send({ type: 'input', action: {
              type: 'wheel', x: 0, y, viewVersion: version
            } }),
            selectQuality: (mode) => client.send({ type: 'quality', mode }),
            context: () => client.send({ type: 'context.open', id: crypto.randomUUID(), viewVersion: version, point: { x: 20, y: 16 } }),
            resize: (width, height) => client.send({ type: 'viewport.resize', width, height }),
          resizeAndNavigate: (address) =>
            client.send({ type: 'viewport.resize', width: 391, height: 701 }) &&
            client.send({ type: 'navigate', address, viewVersion: version })
          };
          const client = new BrowserAttachmentClient(link, document.querySelector('canvas'), {
            attached: () => {
              if (${hd}) client.send({ type: 'viewport.resize', width: 1920, height: 1080 });
            },
            snapshot: (state) => { window.probe.active = state.activeId; },
            contextMenu: () => { window.probe.contextReceived = true; },
            frame: (drawn) => { version = drawn.viewVersion; window.probe.frame++; window.probe.viewport = drawn; },
            sample: (sample) => { window.probe.samples.push(sample); },
            quality: (quality) => { window.probe.quality = quality; },
            failed: (code) => { console.error("remote failure", code); throw new Error(code); },
            ended: (code) => { window.probe.ended = code; }
          });
        }
        window.startProbe = async (url, grant) => {
          const ws = new WebSocket(url);
          ws.binaryType = 'arraybuffer';
          const path = bindNodeDirectPath({ maxStreams: 4, carrier: {
            send: async (bytes) => ws.send(bytes), close: () => ws.close(),
            onMessage: (receive) => ws.addEventListener('message', ({ data }) => receive(data)),
            onClose: (close) => ws.addEventListener('close', close)
          }});
          await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
          await start(path, grant);
        };
        window.startIce = async (grant) => {
          const pc = new RTCPeerConnection({ iceServers: [] });
          window.receiveAnswer = (answer) => pc.setRemoteDescription(answer);
          const channel = pc.createDataChannel('mar-node-stream');
          const path = bindNodeDirectPath({ maxStreams: 4, carrier: rtcNodeStreamCarrier(channel) });
          channel.addEventListener('open', () => void start(path, grant), { once: true });
          await pc.setLocalDescription(await pc.createOffer());
          if (pc.iceGatheringState !== 'complete') await new Promise(resolve => pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); }));
          return pc.localDescription.toJSON();
        };`
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm'
  });
  await web.addScriptTag({ type: 'module', content: bundle.outputFiles[0]!.text });
  await web.waitForFunction(() => !!window.startIce);
  if (mode === 'relay') {
    await web.evaluate(({ ws, open }) => window.startProbe(ws, open), { ws, open });
  } else {
    const peer = (nativePeer = new RTCPeerConnection({
      iceServers: [],
      maxMessageSize: 64 * 1024
    }));
    peer.addEventListener('datachannel', ({ channel }) => {
      bindNodeDirectPath({
        carrier: rtcNodeStreamCarrier(channel),
        maxStreams: 4,
        accept: async ({ kind, grant }) => {
          const open = kind === 'browser-rfb' && parseBrowserStreamGrant(grant);
          return open
            ? (stream) =>
                serveBrowserStream(service, open, { type: 'ice', transportId, fingerprint }, stream)
            : undefined;
        }
      });
    });
    await peer.setRemoteDescription(await web.evaluate((open) => window.startIce(open), open));
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
    () => (window.probe?.frame > 0 && !!window.probe.active) || !!window.probe?.ended,
    undefined,
    { timeout: 8_000 }
  );
  const ended = await web.evaluate(() => window.probe.ended);
  assert.equal(ended, undefined, JSON.stringify({ ended, errors: errors.map(String) }));
  primaryRenewal = setInterval(() => {
    void coordinator.renew(identity, open.attachmentId).catch(failed);
  }, 5_000).unref();
  await web.waitForFunction(
    ({ width, height }) =>
      window.probe.viewport?.width === width && window.probe.viewport.height === height,
    fixtureViewport,
    { timeout: 5_000 }
  );
  assert.deepEqual(
    await web
      .locator('canvas')
      .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]),
    [fixtureViewport.width, fixtureViewport.height],
    'The first idle page must draw at 1× even with Chromium rendering at 2×'
  );
  assert.equal(await web.evaluate(() => window.probe.click()), true);
  await target.waitForFunction(() => window.browserClicked, undefined, { timeout: 5_000 });
  const readKeys = await target.evaluateHandle(() => {
    const keys: unknown[] = [];
    for (const type of ['keydown', 'keyup'] as const) {
      document.addEventListener(type, ({ code, key, ctrlKey, shiftKey }) => {
        if (code === 'KeyY') keys.push({ type, key, ctrlKey, shiftKey });
      });
    }
    return { keys };
  });
  assert.equal(
    await web.evaluate(() => {
      const { key } = window.probe;
      return (
        key('Control', 'down') &&
        key('Shift', 'down') &&
        key('Y', 'down') &&
        key('Shift', 'up') &&
        key('Control', 'up') &&
        key('Y', 'up')
      );
    }),
    true
  );
  await target.waitForFunction((value) => value.keys.length === 2, readKeys, { timeout: 5_000 });
  assert.deepEqual(await readKeys.evaluate((value) => value.keys), [
    { type: 'keydown', key: 'Y', ctrlKey: true, shiftKey: true },
    { type: 'keyup', key: 'Y', ctrlKey: false, shiftKey: false }
  ]);
  await readKeys.dispose();
  const scrollFixture = `<!doctype html><style>
    body{margin:0;background:#141f59;color:white} header{position:fixed;inset:0 0 auto;height:48px;background:#9a2855}
    section{box-sizing:border-box;height:160px;padding:62px 16px;font:22px monospace}
    </style><header></header>${Array.from(
      { length: 30 },
      (_, index) =>
        `<section style="background:rgb(${20 + index * 6},${40 + index * 3},89)">Section ${index}</section>`
    ).join('')}`;
  await target.setContent(scrollFixture);
  const scrollPixel = (red: number) =>
    web.waitForFunction(
      (expected) => {
        const screen = document.querySelector('canvas')!;
        if (!screen.width || !screen.height) return false;
        const context = screen.getContext('2d')!;
        const [r, g, b] = context.getImageData(
          4,
          Math.floor((screen.height * 100) / window.probe.viewport!.height),
          1,
          1
        ).data;
        return r === expected && g === 40 + (expected - 20) / 2 && b === 89;
      },
      red,
      { timeout: 5_000 }
    );
  await scrollPixel(20);
  const scrollStart = performance.now();
  assert(await web.evaluate(() => window.probe.wheel(170)));
  await target.waitForFunction(() => scrollY === 170, undefined, { timeout: 5_000 });
  await scrollPixel(26);
  const scrollDownMs = performance.now() - scrollStart;
  const scrollBack = performance.now();
  assert(await web.evaluate(() => window.probe.wheel(-170)));
  await target.waitForFunction(() => scrollY === 0, undefined, { timeout: 5_000 });
  await scrollPixel(20);
  const scrollUpMs = performance.now() - scrollBack;

  const continuous = async (delta: number, expectedY: number, expectedRed: number) => {
    const start = await web.evaluate(() => ({
      frame: window.probe.frame,
      samples: window.probe.samples.length
    }));
    const measurement = await startMeasurement();
    const started = performance.now();
    assert(
      await web.evaluate(async (dy) => {
        for (let i = 0; i < 90; i++) {
          if (!window.probe.wheel(dy)) return false;
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        return true;
      }, delta)
    );
    const sent = performance.now();
    await target.waitForFunction((y) => scrollY === y, expectedY, { timeout: 5_000 });
    await scrollPixel(expectedRed);
    const elapsed = performance.now() - started;
    const result = await web.evaluate(({ frame, samples }) => {
      const canvas = document.querySelector('canvas')!;
      const fixed = canvas.getContext('2d')!.getImageData(4, 4, 1, 1).data;
      return {
        frames: window.probe.frame - frame,
        fixed: Array.from(fixed),
        quality: window.probe.quality,
        samples: window.probe.samples.slice(samples)
      };
    }, start);
    assert(result.frames > 2, 'Continuous scrolling must draw intermediate frames');
    assert.deepEqual(result.fixed, [154, 40, 85, 255]);
    const finalAfterInputMs = performance.now() - sent;
    await finishMeasurement(delta > 0 ? 'scroll-down' : 'scroll-up', measurement, result.frames);
    return {
      ...result,
      fps: (result.frames * 1_000) / elapsed,
      finalAfterInputMs
    };
  };
  motionPhase = true;
  const continuousScroll = [await continuous(16, 1440, 74), await continuous(-16, 0, 20)];
  motionPhase = false;
  // The text fixture must stop drawing and consuming bytes after the final paint.
  // Wait for two full sampling windows so the final legitimate frame isn't counted.
  const waitForScrollSilence = async () => {
    const scrollSamples = await web.evaluate(() => window.probe.samples.length);
    await web.waitForFunction(
      (sampleCount) => {
        const samples = window.probe.samples;
        return (
          samples.length >= sampleCount + 3 &&
          samples
            .slice(-2)
            .every((sample) => sample.framesPerSecond === 0 && sample.bitsPerSecond === 0)
        );
      },
      scrollSamples,
      { timeout: 5_000 }
    );
  };
  await waitForScrollSilence();

  assert(await web.evaluate(() => window.probe.selectQuality('high')));
  const highRaster = browserStreamSize(fixtureViewport, BROWSER_DEVICE_SCALE_FACTOR);

  // Stable textured canvas, full-surface animation, then an exact repeat of the
  // initial state. Sample full rows, not just a solid patch that JPEG preserves.
  // Use integral scaling for the texture at both fixture sizes.
  const textureHeight = fixtureViewport.height / (hd ? 2 : 1);
  await target.setContent(`<!doctype html><style>body{margin:0}canvas{width:100vw;height:100vh;display:block;image-rendering:pixelated}</style>
    <canvas width="960" height="${textureHeight}"></canvas><script>
    const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
    const ref = document.createElement('canvas'); ref.width = canvas.width; ref.height = canvas.height;
    const refCtx = ref.getContext('2d'); const image = refCtx.createImageData(ref.width,ref.height);
    for (let y=0;y<ref.height;y++) for(let x=0;x<ref.width;x++) {
      const i=(y*ref.width+x)*4; let v=((x*113+y*271) ^ (x*y*31)) & 255;
      image.data.set([v,(v+y)&255,(v+x)&255,255],i);
    }
    refCtx.putImageData(image,0,0);
    let running = false;
    function draw(shift) {
      ctx.drawImage(ref,-shift,0); if (shift) ctx.drawImage(ref,ref.width-shift,0);
      ctx.fillStyle=shift?'#40da24':'#f01969';ctx.fillRect(0,0,48,48);
    }
    draw(0);
    window.animateFixture = enable => { running=enable; if (!running) draw(0);
      else requestAnimationFrame(function tick(t) { if (running) { draw(1+(Math.floor(t/8)%500)); requestAnimationFrame(tick); } }); };
    let markerTimer;
    window.animateMarker = enable => {
      clearInterval(markerTimer); if (!enable) { draw(0); return; }
      let tick=0; markerTimer = setInterval(() => {
        ctx.fillStyle = 'rgb(' + (tick++ % 256) + ',48,225)'; ctx.fillRect(800,32,24,24);
      },80);
    };
    </script>`);
  await web.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas')!;
      if (!canvas.width || !canvas.height) return false;
      return canvas.getContext('2d')!.getImageData(8, 8, 1, 1).data[0] === 240;
    },
    undefined,
    { timeout: 5_000 }
  );
  // Keep both reference and recovery samples on the live screencast path.
  const mark = (enabled: boolean) =>
    target.evaluate(
      (value) =>
        (window as unknown as { animateMarker: (active: boolean) => void }).animateMarker(value),
      enabled
    );
  const baselineStart = await web.evaluate(() => window.probe.frame);
  await mark(true);
  // Selecting high does not undo a congestion downgrade until we draw more frames.
  await web.waitForFunction(
    ({ count, size }) => {
      const canvas = document.querySelector('canvas')!;
      return (
        window.probe.frame >= count + 3 &&
        window.probe.quality === 'high' &&
        canvas.width === size.width &&
        canvas.height === size.height
      );
    },
    { count: baselineStart, size: highRaster },
    { timeout: 12_000 }
  );
  const stillPixels = await web.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    return Array.from(canvas.getContext('2d')!.getImageData(100, 100, 160, 1).data);
  });
  await mark(false);
  const beforeMotion = await web.evaluate(() => {
    window.probe.samples.length = 0;
    return window.probe.frame;
  });
  assert(await web.evaluate(() => window.probe.selectQuality('auto')));
  const animate = (enabled: boolean) =>
    target.evaluate(
      (value) =>
        (window as unknown as { animateFixture: (active: boolean) => void }).animateFixture(value),
      enabled
    );
  motionPhase = true;
  await animate(true);
  try {
    await web.waitForFunction(
      (count) =>
        window.probe.frame >= count + 5 &&
        window.probe.samples.length >= 3 &&
        window.probe.quality !== 'high',
      beforeMotion,
      // A capped link must finish the first lossless update before it can
      // observe congestion; require the same number of real drawn updates.
      { timeout: limitKbps ? 30_000 : 12_000 }
    );
  } catch (cause) {
    const observed = await web.evaluate(() => ({ ...window.probe }));
    throw new Error(
      `Motion did not adapt: ${JSON.stringify({ observed, revoked, errors: errors.map(String) })}`,
      { cause }
    );
  }
  const animation = await web.evaluate(() => window.probe.samples.slice(1));
  const stableStart = await web.evaluate(() => ({
    samples: window.probe.samples.length,
    frame: window.probe.frame
  }));
  const motionMeasurement = await startMeasurement();
  await web.waitForFunction(
    (count) => window.probe.samples.length >= count + 3,
    stableStart.samples,
    {
      timeout: 10_000
    }
  );
  const steady = await web.evaluate(
    ({ samples, frame }) => ({
      samples: window.probe.samples.slice(samples + 1),
      frames: window.probe.frame - frame
    }),
    stableStart
  );
  await finishMeasurement('steady-animation', motionMeasurement, steady.frames);
  const steadyAnimation = steady.samples;
  motionPhase = false;
  const settleStarted = performance.now();
  await animate(false);
  try {
    await web.waitForFunction(
      () => {
        const canvas = document.querySelector('canvas')!;
        const data = canvas.getContext('2d')!.getImageData(8, 8, 1, 1).data;
        return data[0] === 240 && data[1] === 25 && data[2] === 105;
      },
      undefined,
      { timeout: 8_000 }
    );
  } catch (cause) {
    const state = await web.evaluate(() => ({
      ...window.probe,
      pixel: Array.from(
        document.querySelector('canvas')!.getContext('2d')!.getImageData(8, 8, 1, 1).data
      )
    }));
    throw new Error(
      `Motion did not settle: ${JSON.stringify({ state, revoked, errors: errors.map(String) })}`,
      { cause }
    );
  }
  const adaptiveQuality = await web.evaluate(() => window.probe.quality);
  assert.notEqual(adaptiveQuality, 'high', 'Sustained textured motion must reduce the quality');
  const quietMs = performance.now() - settleStarted;
  // Compare pixels at the original raster; changing the raster changes the
  // compositor's sampling even for an otherwise identical page. A small
  // ticker supplies fresh draw samples so auto can ramp back up without help.
  await mark(true);
  try {
    await web.waitForFunction(
      ({ pixels, size }) => {
        const canvas = document.querySelector('canvas')!;
        const context = canvas.getContext('2d')!;
        return (
          window.probe.quality === 'high' &&
          canvas.width === size.width &&
          canvas.height === size.height &&
          context.getImageData(8, 8, 1, 1).data[0] === 240 &&
          context.getImageData(100, 100, 160, 1).data.every((value, i) => value === pixels[i])
        );
      },
      { pixels: stillPixels, size: highRaster },
      { timeout: 16_000 }
    );
  } catch (cause) {
    const detail = await web.evaluate((pixels) => {
      const canvas = document.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      const actual = Array.from(ctx.getImageData(100, 100, 160, 1).data);
      return {
        quality: window.probe.quality,
        width: canvas.width,
        height: canvas.height,
        frame: window.probe.frame,
        count: actual.filter((value, i) => value !== pixels[i]).length,
        actual: actual.slice(0, 16),
        expected: pixels.slice(0, 16),
        ended: window.probe.ended,
        samples: window.probe.samples.slice(-3)
      };
    }, stillPixels);
    throw new Error(
      `Quality did not recover: ${JSON.stringify({ detail, revoked, errors: errors.map(String) })}`,
      { cause }
    );
  }
  await mark(false);
  console.log(
    JSON.stringify({
      mode,
      scrollDownMs: Math.round(scrollDownMs),
      scrollUpMs: Math.round(scrollUpMs),
      continuousScroll,
      animation,
      steadyAnimation,
      adaptiveQuality,
      settledMs: Math.round(quietMs),
      restoredHighMs: Math.round(performance.now() - settleStarted)
    })
  );
  if (mode === 'ice') {
    // The original feedback loop occurred with paced capture and an odd-sized viewport.
    assert(
      await web.evaluate(() => window.probe.resize(660, 839) && window.probe.selectQuality('low'))
    );
    await web.waitForFunction(
      () =>
        window.probe.quality === 'low' &&
        window.probe.viewport?.width === 660 &&
        window.probe.viewport.height === 839,
      undefined,
      { timeout: 5_000 }
    );
    await target.setContent(scrollFixture);
    await scrollPixel(20);
    assert(
      await web.evaluate(async () => {
        for (let i = 0; i < 24; i++) {
          if (!window.probe.wheel(39)) return false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return true;
      })
    );
    await target.waitForFunction(() => scrollY === 936, undefined, { timeout: 5_000 });
    await scrollPixel(56);
    await waitForScrollSilence();
  }
  const resized = `${http}/after-resize`;
  assert.equal(await web.evaluate((url) => window.probe.resizeAndNavigate(url), resized), true);
  await target.waitForURL(resized, { timeout: 5_000 });
  try {
    await web.waitForFunction(
      () => window.probe.viewport?.width === 391 && window.probe.viewport.height === 701,
      undefined,
      { timeout: 5_000 }
    );
  } catch (cause) {
    const observed = await web.evaluate(() => ({ ...window.probe, samples: [] }));
    const size = target.viewportSize();
    throw new Error(
      `Resize was not drawn: ${JSON.stringify({ observed, size, revoked, errors: errors.map(String) })}`,
      { cause }
    );
  }
  assert.deepEqual(await target.evaluate(() => [innerWidth, innerHeight]), [391, 701]);
  const other = { ...identity, connectionId: 'other-workbench' };
  const otherGrant = await coordinator.prepare(other, { ...targetScope, browserId });
  const otherWeb = await chrome.newPage();
  otherWeb.on('pageerror', failed);
  await otherWeb.goto(http);
  await otherWeb.addScriptTag({ type: 'module', content: bundle.outputFiles[0]!.text });
  await otherWeb.waitForFunction(() => !!window.startProbe);
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
  // The second viewer can right-click during the first viewer's gesture, but
  // its unmatched left-button release must not end that gesture.
  assert.equal(
    await otherWeb.evaluate(() => window.probe.button('up') && window.probe.context()),
    true
  );
  await otherWeb.waitForFunction(() => window.probe.contextReceived, undefined, { timeout: 5_000 });
  const concurrentInput = 'mousedown:0;mousedown:2;mouseup:2;';
  assert.equal(await target.evaluate(() => document.body.dataset.input), concurrentInput);
  clearInterval(primaryRenewal);
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
  assert.equal(
    await target.evaluate(() => document.body.dataset.input),
    `${concurrentInput}mouseup:0;`
  );
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
    `Browser ${mode} attachment: RFB drawing, concurrent relay viewer, viewport handoff, click and lease revocation passed.`
  );
} finally {
  clearInterval(primaryRenewal);
  await coordinator.shutdown();
  await runtime.shutdown();
  relayNode.path.close();
  nativePeer?.close();
  for (const socket of wss.clients) socket.terminate();
  await chrome?.close();
  await rm(profileRoot, { recursive: true, force: true });
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  server.close();
  if (nativePeer) cleanup();
}
