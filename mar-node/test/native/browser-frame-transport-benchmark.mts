import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';
import WebSocket, { WebSocketServer } from 'ws';
import { BrowserAttachment } from '../../src/browser/browser-attachment.js';
import { createBrowserLauncher } from '../../src/browser/browser-launcher.js';
import { BrowserTabs } from '../../src/browser/browser-tabs.js';
import { BROWSER_FRAME_MESSAGE_BYTES, browserAttachmentMessageSchema } from '@myagentroam/protocol';
import { createBrowserVideoEncoder } from '../../src/browser/browser-video-encoder.js';
import { BrowserSessionService } from '../../src/browser/browser-session-service.js';
import {
  BROWSER_CAPTURE_QUALITY,
  BROWSER_VIDEO_BITRATE,
  BROWSER_VIDEO_FRAMERATE,
  BROWSER_VIDEO_HD_BITRATE,
  BROWSER_VIDEO_HD_LIMIT,
  BROWSER_VIEWPORT
} from '../../src/browser/browser-video-config.js';

declare global {
  interface Window {
    animate(): void;
    freeze(): void;
    probe: {
      startAt: number;
      stats: {
        first: number;
        frames: number;
        bytes: number;
        clicks: number[];
        sibling: number[];
        size: [number, number];
        viewport?: { width: number; height: number; viewVersion: number };
        raster?: { width: number; height: number };
        fineDetail: number;
        wheelMessages: number;
        wheelToDrawMs: number;
      };
      ice(): Promise<RTCSessionDescriptionInit>;
      answer(answer: RTCSessionDescriptionInit): Promise<void>;
      relay(url: string): void;
      ready(): Promise<void>;
      click(): Promise<void>;
      keyboard(): void;
      wheelBurst(): number;
      slow(milliseconds: number): void;
      select(tabId: string): void;
    };
    probeWheeledAt?: number;
  }
}

// Inspect the JPEG before encoding: a small decoded frame does not prove that
// the compositor actually reduced its capture raster.
function captureRaster(jpeg: Buffer): [number, number] {
  assert.equal(jpeg.readUInt16BE(0), 0xffd8);
  for (let offset = 2; offset + 4 <= jpeg.length;) {
    const marker = jpeg.readUInt16BE(offset);
    const segmentLength = jpeg.readUInt16BE(offset + 2);
    if (marker === 0xffc0 || marker === 0xffc2) {
      return [jpeg.readUInt16BE(offset + 7), jpeg.readUInt16BE(offset + 5)];
    }
    assert((marker & 0xff00) === 0xff00 && marker !== 0xffda && segmentLength >= 2);
    offset += segmentLength + 2;
  }
  throw new Error('JPEG capture is missing its frame dimensions.');
}

// Runs real Chrome / native ICE or a two-hop loopback WS relay. It measures
// input and frames without starting MAR routing, authentication or a PTY.
const mode = process.argv[2];
assert(
  mode === 'ice' || mode === 'ice-hd' || mode === 'ice-hd-small' || mode === 'relay',
  'Specify ice, ice-hd, ice-hd-small or relay.'
);
const small = mode === 'ice-hd-small';
const hd = mode === 'ice-hd' || small;
const bitrate = hd ? BROWSER_VIDEO_HD_BITRATE : BROWSER_VIDEO_BITRATE;
const targetSize = small
  ? { width: 800, height: 450 }
  : hd
    ? BROWSER_VIDEO_HD_LIMIT
    : { width: 1600, height: 900 };
const fullRaster = small ? [1600, 900] : hd ? [1920, 1080] : [1280, 720];
const standardRaster = small ? [800, 450] : [1280, 720];
const quality = Number(process.argv[3] ?? BROWSER_CAPTURE_QUALITY);
assert(Number.isInteger(quality) && quality >= 1 && quality <= 100, 'JPEG quality must be 1–100.');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  chromiumSandbox: true,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
});
const scope = { workspaceId: 'benchmark-workspace', userId: 1 };
const root = await mkdtemp(join(tmpdir(), 'mar-browser-frame-benchmark-'));
const launcher = createBrowserLauncher(join(root, 'runs'), join(root, 'profiles'), console.error);
const sessions = new BrowserSessionService({
  limit: 1,
  onCloseFailed: () => {
    throw new Error('Benchmark session did not close.');
  },
  launch: async () => {
    const target = await launcher.launch();
    try {
      const { context } = target;
      const resource = {
        page: context.pages()[0] ?? (await context.newPage()),
        tabs: new BrowserTabs(context, { limit: 6, failed: console.error })
      };
      return { resource, close: target.close };
    } catch (error) {
      await target.close();
      throw error;
    }
  }
});
let relay: WebSocketServer | undefined;
let fixtureServer: Server | undefined;
let peer: RTCPeerConnection | undefined;
try {
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<canvas width="960" height="600"></canvas>');
  }).listen(0, '127.0.0.1');
  await once(fixtureServer, 'listening');
  const address = fixtureServer.address();
  assert(address && typeof address !== 'string');
  const site = `http://127.0.0.1:${address.port}`;
  if (mode === 'relay') {
    relay = new WebSocketServer({ server: fixtureServer, maxPayload: BROWSER_FRAME_MESSAGE_BYTES });
  }
  const workbench = await browser.newPage();
  workbench.on('pageerror', (error) => console.error('Workbench:', error.message));
  await workbench.goto(`${site}/workbench`);
  const encoderPage = await browser.newPage();
  await encoderPage.goto(`${site}/encode`);
  const encoder = await createBrowserVideoEncoder(encoderPage, {
    ...(hd ? BROWSER_VIDEO_HD_LIMIT : BROWSER_VIEWPORT),
    bitrate,
    framerate: BROWSER_VIDEO_FRAMERATE,
    hd
  });
  const browserId = await sessions.open(scope);
  const borrow = sessions.pin(scope, browserId);
  const target = borrow.resource.page;
  const originalTab = borrow.resource.tabs.snapshot().activeId!;
  borrow.resource.tabs.resize(targetSize);
  await target.setContent(`
    <style>body{margin:0}canvas{display:block}aside{position:absolute;top:60px;right:40px;width:460px;
      height:${small ? '75vh' : '750px'};overflow:auto;background:#fafafa;color:#242936;padding-inline:12px;font:12px/21px monospace}
      .detail{position:absolute;left:32px;top:35px;width:160px;height:16px;pointer-events:none;
        background:repeating-linear-gradient(90deg,#000 0 .5px,#fff .5px 1px)}</style>
    <canvas width="1600" height="900"></canvas>
    ${small ? '<div class="detail"></div>' : ''}
    <aside>${Array.from({ length: 150 }, (_, i) => `<div>${i + 1}: Render the latest frame at the current viewport.</div>`).join('')}</aside>
    <script>
      const ctx = document.querySelector('canvas').getContext('2d');
      const text = document.querySelector('aside');
      let count = 0;
      const texture = ctx.createImageData(480, 96);
      let seed = 17;
      for (let i = 0; i < texture.data.length; i += 4) {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        texture.data[i] = texture.data[i + 1] = texture.data[i + 2] = seed >>> 24;
        texture.data[i + 3] = 255;
      }
      function paint() {
        const g = ctx.createLinearGradient(count % 700, 0, 1600, 900);
        g.addColorStop(0, '#314b88'); g.addColorStop(1, '#eea742');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 1600, 900);
        for(let i = 0; i < 40; i++) {
          ctx.fillStyle = i % 2 ? '#cde0ae' : '#832d38';
          ctx.fillRect((i * 143 + count * 31) % 870, (i * 69) % 560, 55, 30);
        }
        ctx.putImageData(texture, 480, 504);
        ctx.fillStyle = count % 2 ? '#fff' : '#000'; ctx.fillRect(0, 0, 32, 32);
      }
      onclick = () => { count++; paint(); };
      let timer;
      window.animate = () => {
        timer = setInterval(() => {
          text.scrollTop = count * 6 % (text.scrollHeight - text.clientHeight);
          onclick();
        }, 16);
      };
      window.freeze = () => clearInterval(timer);
      paint();
    </script>
  `);
  const artifact = await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `
      import { BrowserViewport } from '../../../packages/web-core/src/service/browser-viewport.ts';
      import { BrowserInputScheduler } from '../../../packages/web-core/src/service/browser-input-scheduler.ts';
      const stats = { first: 0, frames: 0, bytes: 0, clicks: [], sibling: [], size: [], fineDetail: 0, wheelMessages: 0, wheelToDrawMs: 0 };
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const viewport = new BrowserViewport(canvas);
      viewport.setHd(${hd});
      let currentView;
      const pc = new RTCPeerConnection({ iceServers: [] });
      const opened = {};
      let browserChannel, terminal, sentAt = 0, sampleAt = 0, ackDelay = 0, clickDone, white, clickTarget;
      let wheelAt;
      const input = new BrowserInputScheduler((action) => {
        browserChannel.send(JSON.stringify({ type: 'input', action }));
        if (action.type === 'wheel') stats.wheelMessages++;
        return true;
      });
      function attach(label, channel) {
        channel.binaryType = 'arraybuffer';
        opened[label] = new Promise((resolve, reject) => {
          channel.addEventListener('open', resolve, {once:true});
          channel.addEventListener('error', () => reject(new Error(label + ' probe connection failed')), {once:true});
        });
        if (label === 'terminal-echo') {
          terminal = channel;
          terminal.onmessage = () => stats.sibling.push(performance.now() - sampleAt);
          return;
        }
        browserChannel = channel;
        channel.onmessage = async ({ data }) => {
          if (typeof data === 'string') {
            const event = JSON.parse(data);
            if (event.type === 'snapshot' && currentView !== event.snapshot.viewVersion) {
              currentView = event.snapshot.viewVersion; viewport.setView(currentView);
            }
            return;
          }
          stats.bytes += data.byteLength;
          const frame = await viewport.receive(new Uint8Array(data));
          if (!frame) return;
          if (!frame.viewport) { browserChannel.send(JSON.stringify({ type: 'ack', sequence: frame.sequence })); return; }
          white = ctx.getImageData(4, 4, 1, 1).data[0] > 128;
          if (wheelAt && !stats.wheelToDrawMs) {
            const [r, g, b] = ctx.getImageData(44, 8, 1, 1).data;
            if (g > 180 && r < 65 && b < 65) stats.wheelToDrawMs = performance.now() - wheelAt;
          }
          stats.size = [canvas.width, canvas.height];
          const { raster, ...cssViewport } = frame.viewport;
          stats.viewport = cssViewport;
          stats.raster = raster;
          if (${small} && raster.width === 1600) {
            const pixels = ctx.getImageData(80, 80, 128, 1).data;
            let contrast = 0;
            for (let i = 0; i < pixels.length; i += 8) contrast += pixels[i + 4] - pixels[i];
            stats.fineDetail = Math.round(contrast / 64);
          }
          stats.frames++;
          if (!stats.first) stats.first = performance.now() - globalThis.probe.startAt;
          if (clickDone && white === clickTarget) {
            stats.clicks.push(performance.now() - sentAt); clickDone(); clickDone = undefined;
          }
          if (ackDelay) await new Promise(resolve => setTimeout(resolve, ackDelay));
          browserChannel.send(JSON.stringify({ type: 'ack', sequence: frame.sequence }));
        };
      }
      globalThis.probe = { stats, startAt: 0,
        async ice() {
          attach('browser', pc.createDataChannel('browser'));
          attach('terminal-echo', pc.createDataChannel('terminal-echo'));
          await pc.setLocalDescription(await pc.createOffer());
          if(pc.iceGatheringState !== 'complete') await new Promise(resolve =>
            pc.addEventListener('icegatheringstatechange', () => {if(pc.iceGatheringState === 'complete') resolve();}));
          return pc.localDescription.toJSON();
        }, async answer(answer) { await pc.setRemoteDescription(answer); },
        relay(url) { attach('browser', new WebSocket(url + '/web')); attach('terminal-echo', new WebSocket(url + '/echo')); },
        ready() { return Promise.all(Object.values(opened)); },
        click() { clickTarget = !white; sentAt = performance.now();
          const position = { type: 'button', button: 'left', x: 10, y: 10, viewVersion: currentView };
          browserChannel.send(JSON.stringify({ type: 'input', action: { ...position, edge: 'down' } }));
          browserChannel.send(JSON.stringify({ type: 'input', action: { ...position, edge: 'up' } }));
          return new Promise(resolve => {clickDone = resolve;}); },
        keyboard() { sampleAt = performance.now(); terminal.send('key'); },
        wheelBurst() {
          wheelAt = performance.now();
          for (let i = 0; i < 100; i++) input.wheel({viewVersion: currentView, x: ${targetSize.width - 300}, y: 120}, 0, 4);
          return performance.timeOrigin + wheelAt;
        },
        slow(value) { ackDelay = value; },
        select(tabId) { browserChannel.send(JSON.stringify({ type: 'tab.select', tabId })); }
      };
    `
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife'
  });
  await workbench.addScriptTag({ content: artifact.outputFiles[0]!.text });
  let send: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;
  let accept: (receive: (message: string) => void) => void;
  let sendText: (text: string) => void;
  let buffered = () => 0;
  if (mode !== 'relay') {
    peer = new RTCPeerConnection({ iceServers: [], maxMessageSize: 64 * 1024 });
    const remote = peer;
    const channelPromise = new Promise<RTCDataChannel>((resolve) => {
      remote.addEventListener('datachannel', ({ channel }) => {
        if (channel.label === 'browser') resolve(channel);
        else channel.addEventListener('message', ({ data }) => channel.send(data));
      });
    });
    const offer = await workbench.evaluate(() => window.probe.ice());
    await remote.setRemoteDescription(offer);
    if (remote.iceGatheringState !== 'complete')
      await new Promise<void>((resolve) => {
        remote.addEventListener('icegatheringstatechange', () => {
          if (remote.iceGatheringState === 'complete') resolve();
        });
      });
    await workbench.evaluate((answer) => window.probe.answer(answer), {
      type: remote.localDescription!.type,
      sdp: remote.localDescription!.sdp
    });
    const channel = await channelPromise;
    accept = (receive) => channel.addEventListener('message', ({ data }) => receive(String(data)));
    sendText = (text) => channel.send(text);
    buffered = () => channel.bufferedAmount;
    send = async (chunk, signal) => {
      while (channel.bufferedAmount >= 2 * BROWSER_FRAME_MESSAGE_BYTES)
        await delay(2, undefined, { signal });
      assert(channel.readyState === 'open');
      channel.send(chunk as Uint8Array<ArrayBuffer>);
    };
  } else {
    assert(relay);
    const url = site.replace(/^http:/, 'ws:');
    const sides = new Map<string, WebSocket>();
    relay.on('connection', (socket, request) => {
      const side = request.url ?? '';
      sides.set(side, socket);
      socket.on('message', (message, binary) => {
        const other = side === '/echo' ? socket : sides.get(side === '/web' ? '/node' : '/web');
        assert(other?.readyState === WebSocket.OPEN);
        other.send(message, { binary });
      });
    });
    const socket = new WebSocket(`${url}/node`);
    await once(socket, 'open');
    await workbench.evaluate((value) => window.probe.relay(value), url);
    accept = (receive) => socket.on('message', (data) => receive(String(data)));
    sendText = (text) => socket.send(text);
    buffered = () => socket.bufferedAmount;
    send = (chunk, signal) =>
      new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        socket.send(chunk, { binary: true }, (error) => (error ? reject(error) : resolve()));
      });
  }
  await workbench.evaluate(() => window.probe.ready());
  let captures = 0;
  let largestJpegBytes = 0;
  let largestKeyBytes = 0;
  let largestDeltaBytes = 0;
  let keysSent = 0;
  let capturedBytes = 0;
  const encodeTimes: number[] = [];
  const bitrateChanges: number[] = [];
  const fpsChanges: number[] = [];
  let peakBuffered = 0;
  let streamError: Error | undefined;
  let rejectClick: ((error: Error) => void) | undefined;
  async function measureClick(): Promise<void> {
    if (streamError) throw streamError;
    const { promise, reject } = Promise.withResolvers<never>();
    rejectClick = reject;
    // A click can produce no new frame even when the frame stream is healthy.
    const timeout = setTimeout(
      reject,
      8_000,
      new Error('Timed out waiting for the click to draw.')
    );
    try {
      await Promise.race([promise, workbench.evaluate(() => window.probe.click())]);
    } finally {
      clearTimeout(timeout);
      rejectClick = undefined;
    }
  }
  // An application-level bottleneck makes sender backpressure reproducible
  // without modifying the host network. It doesn't model packet loss or TCP.
  const sampleKibPerSecond = 125;
  let throttle = false;
  let firstCaptureRaster: [number, number] | undefined;
  let latestCaptureRaster: [number, number] | undefined;
  await workbench.evaluate(() => {
    window.probe.startAt = performance.now();
  });
  const attachment = new BrowserAttachment(
    { resource: borrow.resource.tabs, release: borrow.release },
    {
      encoder: {
        ...(hd && { hd: true }),
        close: encoder.close,
        encode: async (jpeg, key, raster, profile) => {
          latestCaptureRaster = captureRaster(jpeg);
          firstCaptureRaster ??= latestCaptureRaster;
          const started = performance.now();
          const unit = await encoder.encode(jpeg, key, raster, profile).catch((error: unknown) => {
            console.error('Encoder:', error);
            throw error;
          });
          if (bitrateChanges.at(-1) !== profile.bitrate) {
            assert(unit.key, 'Bitrate must change on a key frame.');
            bitrateChanges.push(profile.bitrate);
          }
          if (fpsChanges.at(-1) !== profile.fps) {
            assert(unit.key, 'Encoder cadence must change on a key frame.');
            fpsChanges.push(profile.fps);
          }
          encodeTimes.push(performance.now() - started);
          if (unit.key) {
            keysSent++;
            largestKeyBytes = Math.max(largestKeyBytes, unit.data.byteLength);
          } else largestDeltaBytes = Math.max(largestDeltaBytes, unit.data.byteLength);
          return unit;
        }
      },
      quality,
      captured: (size) => {
        captures++;
        capturedBytes += size;
        largestJpegBytes = Math.max(largestJpegBytes, size);
      },
      sendControl: (event) => sendText(JSON.stringify(event)),
      deadlineMs: 5_000,
      failed: (code) => {
        streamError = new Error(code);
        rejectClick?.(streamError);
      },
      sendFrame: async (chunk, signal) => {
        if (throttle)
          await delay(chunk.byteLength / ((sampleKibPerSecond * 1024) / 1000), undefined, {
            signal
          });
        await send(chunk, signal).catch((error: unknown) => {
          console.error('Transport:', error);
          throw error;
        });
        peakBuffered = Math.max(peakBuffered, buffered());
      }
    }
  );
  accept((value) => attachment.receive(browserAttachmentMessageSchema.parse(JSON.parse(value))));
  try {
    await workbench.waitForFunction(() => window.probe.stats.frames > 0, undefined, {
      timeout: 8_000
    });
    const first = await workbench.evaluate(() => window.probe.stats);
    assert.deepEqual(first.size, fullRaster);
    assert.deepEqual(first.raster, { width: fullRaster[0], height: fullRaster[1] });
    assert.equal(bitrateChanges[0], bitrate);
    for (let i = 0; i < 12; i++) {
      const count = await workbench.evaluate(() => window.probe.stats.sibling.length);
      await workbench.evaluate(() => window.probe.keyboard());
      await workbench.waitForFunction((n) => window.probe.stats.sibling.length > n, count);
    }
    for (let i = 0; i < 12; i++) await measureClick();
    const before = await workbench.evaluate(() => window.probe.stats);
    const capturedBefore = captures;
    const capturedBytesBefore = capturedBytes;
    throttle = true;
    const ackDelayMs = 120;
    await workbench.evaluate((ms) => window.probe.slow(ms), ackDelayMs);
    await target.evaluate(() => {
      window.animate();
    });
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    let samples = 0;
    // The one-frame credit and paced writes put a lower bound on how quickly
    // a large key frame can finish; give all HD backoff steps time to settle.
    while (samples < 20 || (hd && performance.now() - started < 12_000)) {
      await workbench.evaluate(() => window.probe.keyboard());
      await delay(110);
      samples++;
    }
    const seconds = (performance.now() - started) / 1000;
    const cpu = process.cpuUsage(cpuBefore);
    const after = await workbench.evaluate(() => window.probe.stats);
    const captured = captures - capturedBefore;
    const delivered = after.frames - before.frames;
    const sampleJpegSize = capturedBytes - capturedBytesBefore;
    if (streamError) throw streamError;
    assert.deepEqual(
      after.size,
      standardRaster,
      'Sustained pressure must use the standard raster.'
    );
    assert.deepEqual(after.raster, { width: standardRaster[0], height: standardRaster[1] });
    const pressuredCapture = latestCaptureRaster;
    assert.deepEqual(pressuredCapture, standardRaster, 'The capture itself must also downshift.');
    assert.deepEqual(
      after.viewport,
      first.viewport,
      'Raster changes must not change the CSS view.'
    );
    assert(
      bitrateChanges.at(-1)! < BROWSER_VIDEO_BITRATE,
      `Expected sustained backoff; bitrate history: ${bitrateChanges.join(', ')}.`
    );
    assert(fpsChanges.at(-1)! < BROWSER_VIDEO_FRAMERATE, 'Expected encoder cadence reduction.');
    assert(
      delivered > 2 && captured > delivered + 2,
      `Expected draws and dropped captures in the slow sample (captured ${captured}, drew ${delivered}).`
    );
    await target.evaluate(() => window.freeze());
    await delay(1_000);
    await target.evaluate(async () => {
      const pane = document.querySelector('aside')!;
      pane.scrollTop = 0;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      pane.addEventListener('scroll', () => {
        if (pane.scrollTop !== 400 || window.probeWheeledAt !== undefined) return;
        window.probeWheeledAt = performance.timeOrigin + performance.now();
        const ctx = document.querySelector('canvas')!.getContext('2d')!;
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(40, 0, 32, 32);
      });
    });
    const wheelAt = await workbench.evaluate(() => window.probe.wheelBurst());
    await workbench.waitForFunction(() => window.probe.stats.wheelToDrawMs > 0, undefined, {
      timeout: 5_000
    });
    const { wheelMessages, wheelToDrawMs } = await workbench.evaluate(() => window.probe.stats);
    const wheeledAt = await target.evaluate(() => window.probeWheeledAt);
    assert.equal(wheelMessages, 2, 'Expected two transmitted wheel commands for one burst.');
    assert(wheeledAt !== undefined, 'Expected exact scroll distance in the targeted pane.');
    for (let i = 0; i < 6; i++) await measureClick();
    const slowClicks = await workbench.evaluate(() => window.probe.stats.clicks.slice(12));
    await workbench.evaluate(() => window.probe.slow(0));
    throttle = false;
    const recoveredAt = performance.now();
    await target.evaluate(() => window.animate());
    while (
      (bitrateChanges.at(-1) !== bitrate || fpsChanges.at(-1) !== BROWSER_VIDEO_FRAMERATE) &&
      !streamError
    ) {
      assert(performance.now() - recoveredAt < (hd ? 14_000 : 8_000), 'Expected bitrate recovery.');
      await delay(100);
    }
    if (streamError) throw streamError;
    const recoveryMs = Math.round(performance.now() - recoveredAt);
    // Wait until the receiver draws additional frames after the bitrate change,
    // not just until the encoder is configured.
    const drawnAtRecovery = await workbench.evaluate(() => window.probe.stats.frames);
    await workbench.waitForFunction(
      (count) => window.probe.stats.frames >= count + 2,
      drawnAtRecovery,
      { timeout: 5_000 }
    );
    await target.evaluate(() => window.freeze());
    const recovered = await workbench.evaluate(() => window.probe.stats);
    assert.deepEqual(recovered.size, fullRaster);
    assert.deepEqual(recovered.raster, first.raster);
    assert.deepEqual(latestCaptureRaster, fullRaster, 'The capture itself must also recover.');
    assert.deepEqual(recovered.viewport, first.viewport);
    assert.equal(fpsChanges.at(-1), BROWSER_VIDEO_FRAMERATE);
    if (small) {
      assert.equal(first.viewport?.width, 800);
      assert.equal(first.viewport?.height, 450);
      assert.deepEqual(firstCaptureRaster, fullRaster, 'The original JPEG must contain HD pixels.');
      assert(
        first.fineDetail >= 100 && recovered.fineDetail >= 100,
        'Expected real sub-CSS-pixel detail, not an upscaled JPEG.'
      );
    }
    await borrow.resource.tabs.open();
    const previousKeys = keysSent;
    const drawnBeforeSwitch = await workbench.evaluate(() => window.probe.stats.frames);
    const switchedAt = performance.now();
    await workbench.evaluate((tabId) => window.probe.select(tabId), originalTab);
    await workbench.waitForFunction(
      (count) => window.probe.stats.frames > count,
      drawnBeforeSwitch,
      { timeout: 5_000 }
    );
    const switchToDrawMs = Math.round(performance.now() - switchedAt);
    assert(keysSent > previousKeys, 'The new view did not start with a key frame.');
    const p95 = (values: number[]) =>
      Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]! * 10) / 10;
    if (streamError) throw streamError;
    assert.equal(after.clicks.length, 12);
    assert.equal(slowClicks.length, 6);
    assert.equal(after.sibling.length, 12 + samples);
    assert(
      largestKeyBytes > 0 && largestDeltaBytes > 0,
      'Benchmark did not encode key and delta frames.'
    );
    console.log(
      JSON.stringify({
        mode,
        quality,
        cssViewport: first.viewport,
        firstCaptureRaster,
        ...(small && { fineDetail: first.fineDetail, recoveredFineDetail: recovered.fineDetail }),
        firstRaster: first.size,
        encodedSize: after.size,
        pressuredCapture,
        recoveredRaster: recovered.size,
        bitrateChanges,
        fpsChanges,
        recoveryMs,
        firstFrameMs: Math.round(after.first),
        switchToDrawMs,
        inputToDrawP95Ms: p95(after.clicks),
        shapedInputToDrawP95Ms: p95(slowClicks),
        shapedWheel: {
          inputEvents: 100,
          wheelMessages,
          inputToPageMs: Math.round(wheeledAt - wheelAt),
          inputToDrawMs: Math.round(wheelToDrawMs)
        },
        siblingIdleP95Ms: p95(before.sibling),
        siblingBusyP95Ms: p95(after.sibling.slice(12)),
        ackDelayMs,
        sampleKibPerSecond,
        slowSampleSeconds: Math.round(seconds * 100) / 100,
        captured,
        delivered,
        slowWireKiBPerSecond: Math.round((after.bytes - before.bytes) / seconds / 1024),
        largestJpegBytes,
        largestKeyBytes,
        largestDeltaBytes,
        rawCaptureKiBPerSecond: Math.round(sampleJpegSize / seconds / 1024),
        encodeP95Ms: p95(encodeTimes),
        nodeCpuMsPerSecond: Math.round((cpu.user + cpu.system) / seconds / 1000),
        peakNodeBufferedBytes: peakBuffered
      })
    );
  } finally {
    await attachment.close();
  }
} finally {
  for (const socket of relay?.clients ?? []) socket.terminate();
  if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
  peer?.close();
  await sessions.shutdown();
  await rm(root, { recursive: true, force: true });
  await browser.close();
  fixtureServer?.close();
  cleanup();
}
