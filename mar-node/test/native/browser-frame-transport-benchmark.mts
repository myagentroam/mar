import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';
import WebSocket, { WebSocketServer } from 'ws';
import { BrowserAttachment } from '../../src/browser/browser-attachment.js';
import { BrowserTabs } from '../../src/browser/browser-tabs.js';
import { BROWSER_FRAME_MESSAGE_BYTES, browserAttachmentMessageSchema } from '@myagentroam/protocol';
import { createBrowserVideoEncoder } from '../../src/browser/browser-video-encoder.js';
import { BrowserSessionService } from '../../src/browser/browser-session-service.js';
import {
  BROWSER_CAPTURE_QUALITY,
  BROWSER_VIDEO_BITRATE,
  BROWSER_VIDEO_FRAMERATE,
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
      };
      ice(): Promise<RTCSessionDescriptionInit>;
      answer(answer: RTCSessionDescriptionInit): Promise<void>;
      relay(url: string): void;
      ready(): Promise<void>;
      click(): Promise<void>;
      keyboard(): void;
      slow(milliseconds: number): void;
      select(tabId: string): void;
    };
  }
}

// Runs real Chrome / native ICE or a two-hop loopback WS relay. It measures the
// frame layer only; it does not start MAR routing, authentication or a PTY.
const mode = process.argv[2];
assert(mode === 'ice' || mode === 'relay', 'Specify ice or relay.');
const quality = Number(process.argv[3] ?? BROWSER_CAPTURE_QUALITY);
assert(Number.isInteger(quality) && quality >= 1 && quality <= 100, 'JPEG quality must be 1–100.');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  chromiumSandbox: true,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
});
const scope = { workspaceId: 'benchmark-workspace', userId: 1 };
const sessions = new BrowserSessionService({
  limit: 1,
  onCloseFailed: () => {
    throw new Error('Benchmark session did not close.');
  },
  launch: async () => {
    const target = await chromium.launch({
      channel: 'chrome',
      headless: true,
      chromiumSandbox: true
    });
    try {
      const context = await target.newContext({ viewport: BROWSER_VIEWPORT });
      const resource = {
        page: await context.newPage(),
        tabs: new BrowserTabs(context, { limit: 6, failed: console.error })
      };
      return {
        resource,
        close: async () => {
          try {
            await context.close();
          } finally {
            await target.close();
          }
        }
      };
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
    ...BROWSER_VIEWPORT,
    bitrate: BROWSER_VIDEO_BITRATE,
    framerate: BROWSER_VIDEO_FRAMERATE
  });
  const browserId = await sessions.open(scope);
  const borrow = sessions.pin(scope, browserId);
  const target = borrow.resource.page;
  const originalTab = borrow.resource.tabs.snapshot().activeId!;
  borrow.resource.tabs.resize({ width: 1600, height: 900 });
  await target.setContent(`
    <style>body{margin:0}canvas{display:block}aside{position:absolute;top:60px;right:40px;width:460px;
      height:750px;overflow:auto;background:#fafafa;color:#242936;padding-inline:12px;font:12px/21px monospace}</style>
    <canvas width="1600" height="900"></canvas>
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
      const stats = { first: 0, frames: 0, bytes: 0, clicks: [], sibling: [], size: [] };
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const viewport = new BrowserViewport(canvas);
      let currentView;
      const pc = new RTCPeerConnection({ iceServers: [] });
      const opened = {};
      let browserChannel, terminal, sentAt = 0, sampleAt = 0, ackDelay = 0, clickDone, white, clickTarget;
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
          stats.size = [canvas.width, canvas.height];
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
  if (mode === 'ice') {
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
  await workbench.evaluate(() => {
    window.probe.startAt = performance.now();
  });
  const attachment = new BrowserAttachment(
    { resource: borrow.resource.tabs, release: borrow.release },
    {
      encoder: {
        close: encoder.close,
        encode: async (jpeg, key, viewport, bitrate) => {
          const started = performance.now();
          const unit = await encoder
            .encode(jpeg, key, viewport, bitrate)
            .catch((error: unknown) => {
              console.error('Encoder:', error);
              throw error;
            });
          if (bitrateChanges.at(-1) !== bitrate) {
            assert(unit.key, 'Bitrate must change on a key frame.');
            bitrateChanges.push(bitrate);
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
    assert.deepEqual(await workbench.evaluate(() => window.probe.stats.size), [1280, 720]);
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
    for (let i = 0; i < 20; i++) {
      await workbench.evaluate(() => window.probe.keyboard());
      await delay(110);
    }
    const seconds = (performance.now() - started) / 1000;
    const cpu = process.cpuUsage(cpuBefore);
    const after = await workbench.evaluate(() => window.probe.stats);
    const captured = captures - capturedBefore;
    const delivered = after.frames - before.frames;
    const sampleJpegSize = capturedBytes - capturedBytesBefore;
    if (streamError) throw streamError;
    assert.deepEqual(after.size, [1280, 720], 'Network shaping must not resize the stream.');
    assert(bitrateChanges.at(-1)! < BROWSER_VIDEO_BITRATE, 'Expected sustained backoff.');
    assert(
      delivered > 2 && captured > delivered + 2,
      `Expected draws and dropped captures in the slow sample (captured ${captured}, drew ${delivered}).`
    );
    await target.evaluate(() => window.freeze());
    await delay(1_000);
    for (let i = 0; i < 6; i++) await measureClick();
    const slowClicks = await workbench.evaluate(() => window.probe.stats.clicks.slice(12));
    await workbench.evaluate(() => window.probe.slow(0));
    throttle = false;
    const recoveredAt = performance.now();
    await target.evaluate(() => window.animate());
    while (bitrateChanges.at(-1) !== BROWSER_VIDEO_BITRATE && !streamError) {
      assert(performance.now() - recoveredAt < 8_000, 'Expected bitrate recovery.');
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
    assert.deepEqual(await workbench.evaluate(() => window.probe.stats.size), [1280, 720]);
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
    assert.equal(after.sibling.length, 32);
    assert(
      largestKeyBytes > 0 && largestDeltaBytes > 0,
      'Benchmark did not encode key and delta frames.'
    );
    console.log(
      JSON.stringify({
        mode,
        quality,
        encodedSize: after.size,
        bitrateChanges,
        recoveryMs,
        firstFrameMs: Math.round(after.first),
        switchToDrawMs,
        inputToDrawP95Ms: p95(after.clicks),
        shapedInputToDrawP95Ms: p95(slowClicks),
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
  await browser.close();
  fixtureServer?.close();
  cleanup();
}
