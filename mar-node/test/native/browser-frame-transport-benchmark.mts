import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';
import WebSocket, { WebSocketServer } from 'ws';
import { BrowserPageView } from '../../src/browser/browser-page-view.js';
import { BROWSER_FRAME_MESSAGE_BYTES, browserPageInputSchema } from '@myagentroam/protocol';
import { createBrowserVideoEncoder } from '../../src/browser/browser-video-encoder.js';
import { BrowserFrameStream } from '../../src/browser/browser-frame-stream.js';
import { BrowserSessionService } from '../../src/browser/browser-session-service.js';

declare global {
  interface Window {
    animate(): void;
    freeze(): void;
    probe: {
      startAt: number;
      stats: { first: number; frames: number; bytes: number; clicks: number[]; sibling: number[] };
      ice(): Promise<RTCSessionDescriptionInit>;
      answer(answer: RTCSessionDescriptionInit): Promise<void>;
      relay(url: string): void;
      ready(): Promise<void>;
      click(): Promise<void>;
      keyboard(): void;
      slow(milliseconds: number): void;
      view(version: number): void;
    };
  }
}

// Runs real Chrome / native ICE or a two-hop loopback WS relay. It measures the
// frame layer only; it does not start MAR routing, authentication or a PTY.
const mode = process.argv[2];
assert(mode === 'ice' || mode === 'relay', 'Specify ice or relay.');
const quality = Number(process.argv[3] ?? 70);
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
      const resource = await target.newPage({ viewport: { width: 960, height: 600 } });
      return { resource, close: () => target.close() };
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
    width: 960,
    height: 600,
    bitrate: 384_000,
    framerate: 24
  });
  const browserId = await sessions.open(scope);
  const { resource: target, release } = sessions.pin(scope, browserId);
  const pageView = new BrowserPageView(target);
  await target.setContent(`
    <style>body{margin:0}canvas{display:block}</style><canvas width="960" height="600"></canvas>
    <script>
      const ctx = document.querySelector('canvas').getContext('2d');
      let count = 0;
      const texture = ctx.createImageData(480, 96);
      let seed = 17;
      for (let i = 0; i < texture.data.length; i += 4) {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        texture.data[i] = texture.data[i + 1] = texture.data[i + 2] = seed >>> 24;
        texture.data[i + 3] = 255;
      }
      function paint() {
        const g = ctx.createLinearGradient(count % 700, 0, 960, 600);
        g.addColorStop(0, '#314b88'); g.addColorStop(1, '#eea742');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 960, 600);
        for(let i = 0; i < 40; i++) {
          ctx.fillStyle = i % 2 ? '#cde0ae' : '#832d38';
          ctx.fillRect((i * 143 + count * 31) % 870, (i * 69) % 560, 55, 30);
        }
        ctx.putImageData(texture, 480, 504);
        ctx.fillStyle = count % 2 ? '#fff' : '#000'; ctx.fillRect(0, 0, 32, 32);
      }
      onclick = () => { count++; paint(); };
      let timer;
      window.animate = () => { timer = setInterval(onclick, 16); };
      window.freeze = () => clearInterval(timer);
      paint();
    </script>
  `);
  const artifact = await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `
      import { BrowserViewport } from '../../../packages/web-core/src/service/browser-viewport.ts';
      const stats = { first: 0, frames: 0, bytes: 0, clicks: [], sibling: [] };
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const viewport = new BrowserViewport(canvas);
      let currentView = 1;
      viewport.setView(currentView);
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
          stats.bytes += data.byteLength;
          const frame = await viewport.receive(new Uint8Array(data));
          if (!frame) return;
          if (!frame.viewport) { browserChannel.send(String(frame.sequence)); return; }
          white = ctx.getImageData(4, 4, 1, 1).data[0] > 128;
          stats.frames++;
          if (!stats.first) stats.first = performance.now() - globalThis.probe.startAt;
          if (clickDone && white === clickTarget) {
            stats.clicks.push(performance.now() - sentAt); clickDone(); clickDone = undefined;
          }
          if (ackDelay) await new Promise(resolve => setTimeout(resolve, ackDelay));
          browserChannel.send(String(frame.sequence));
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
          browserChannel.send(JSON.stringify({ ...position, edge: 'down' }));
          browserChannel.send(JSON.stringify({ ...position, edge: 'up' }));
          return new Promise(resolve => {clickDone = resolve;}); },
        keyboard() { sampleAt = performance.now(); terminal.send('key'); },
        slow(value) { ackDelay = value; },
        view(version) { currentView = version; viewport.setView(version); }
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
    buffered = () => socket.bufferedAmount;
    send = (chunk, signal) =>
      new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        socket.send(chunk, { binary: true }, (error) => (error ? reject(error) : resolve()));
      });
  }
  await workbench.evaluate(() => window.probe.ready());
  const errors: string[] = [];
  let captures = 0;
  let largestJpegBytes = 0;
  let largestKeyBytes = 0;
  let largestDeltaBytes = 0;
  let keysSent = 0;
  let capturedBytes = 0;
  const encodeTimes: number[] = [];
  let peakBuffered = 0;
  // An application-level bottleneck makes sender backpressure reproducible
  // without modifying the host network. It doesn't model packet loss or TCP.
  const sampleKibPerSecond = 125;
  let throttle = false;
  const stream = new BrowserFrameStream({
    encode: async (jpeg, key) => {
      const started = performance.now();
      const unit = await encoder.encode(jpeg, key).catch((error: unknown) => {
        console.error('Encoder:', error);
        throw error;
      });
      encodeTimes.push(performance.now() - started);
      if (unit.key) {
        keysSent++;
        largestKeyBytes = Math.max(largestKeyBytes, unit.data.byteLength);
      } else largestDeltaBytes = Math.max(largestDeltaBytes, unit.data.byteLength);
      return unit;
    },
    deadlineMs: 5_000,
    failed: (code) => {
      errors.push(code);
      console.error(code);
    },
    send: async (chunk, signal) => {
      if (throttle)
        await delay(chunk.byteLength / ((sampleKibPerSecond * 1024) / 1000), undefined, { signal });
      await send(chunk, signal).catch((error: unknown) => {
        console.error('Transport:', error);
        throw error;
      });
      peakBuffered = Math.max(peakBuffered, buffered());
    }
  });
  let capture: Awaited<ReturnType<BrowserPageView['startCapture']>> | undefined;
  const beginCapture = (viewVersion: number) =>
    pageView.startCapture({ width: 960, height: 600, quality }, (frame) => {
      captures++;
      capturedBytes += frame.jpeg.byteLength;
      largestJpegBytes = Math.max(largestJpegBytes, frame.jpeg.byteLength);
      stream.offer({ ...frame, viewVersion });
    });
  try {
    let viewVersion = 1;
    stream.setView(viewVersion);
    let input = Promise.resolve();
    accept((value) => {
      if (value.startsWith('{')) {
        const action = browserPageInputSchema.parse(JSON.parse(value));
        input = input
          .then(async () => {
            if (action.viewVersion === viewVersion) await pageView.input(action);
          })
          .catch(() => {
            errors.push('CLICK_FAILED');
          });
      } else if (!stream.acknowledge(Number(value))) errors.push('BAD_ACK');
    });
    await workbench.evaluate(() => {
      window.probe.startAt = performance.now();
    });
    capture = await beginCapture(1);
    await workbench.waitForFunction(() => window.probe.stats.frames > 0, undefined, {
      timeout: 8_000
    });
    for (let i = 0; i < 12; i++) {
      const count = await workbench.evaluate(() => window.probe.stats.sibling.length);
      await workbench.evaluate(() => window.probe.keyboard());
      await workbench.waitForFunction((n) => window.probe.stats.sibling.length > n, count);
    }
    for (let i = 0; i < 12; i++) await workbench.evaluate(() => window.probe.click());
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
    const sampleJpegSize = capturedBytes - capturedBytesBefore;
    await target.evaluate(() => {
      window.freeze();
    });
    await delay(1_000);
    for (let i = 0; i < 6; i++) await workbench.evaluate(() => window.probe.click());
    const slowClicks = await workbench.evaluate(() => window.probe.stats.clicks.slice(12));
    await capture.stop();
    stream.setView(++viewVersion);
    await workbench.evaluate(() => {
      window.probe.view(2);
      window.probe.slow(0);
    });
    throttle = false;
    const previousKeys = keysSent;
    const drawnBeforeSwitch = await workbench.evaluate(() => window.probe.stats.frames);
    const switchedAt = performance.now();
    capture = await beginCapture(2);
    await workbench.waitForFunction(
      (count) => window.probe.stats.frames > count,
      drawnBeforeSwitch,
      { timeout: 5_000 }
    );
    const switchToDrawMs = Math.round(performance.now() - switchedAt);
    assert(keysSent > previousKeys, 'The new view did not start with a key frame.');
    const p95 = (values: number[]) =>
      Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]! * 10) / 10;
    assert.deepEqual(errors, []);
    assert.equal(after.clicks.length, 12);
    assert.equal(slowClicks.length, 6);
    assert.equal(after.sibling.length, 32);
    const delivered = after.frames - before.frames;
    assert(delivered > 2 && captures - capturedBefore > delivered + 2);
    assert(
      largestKeyBytes > 0 && largestDeltaBytes > 0,
      'Benchmark did not encode key and delta frames.'
    );
    console.log(
      JSON.stringify({
        mode,
        quality,
        firstFrameMs: Math.round(after.first),
        switchToDrawMs,
        inputToDrawP95Ms: p95(after.clicks),
        shapedInputToDrawP95Ms: p95(slowClicks),
        siblingIdleP95Ms: p95(before.sibling),
        siblingBusyP95Ms: p95(after.sibling.slice(12)),
        ackDelayMs,
        sampleKibPerSecond,
        slowSampleSeconds: Math.round(seconds * 100) / 100,
        captured: captures - capturedBefore,
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
    stream.close();
    await capture?.stop();
    await encoder.close();
    release();
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
