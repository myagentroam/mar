import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';
import { DirectDesktopService } from '../../src/remote-desktop/direct-desktop-service.js';
import { RemoteDesktopAttachment } from '../../src/remote-desktop/remote-desktop-attachment.js';
import { PooledDesktopAttachment } from '../../src/remote-desktop/pooled-desktop-attachment.js';
import { TigerVncBackendPool } from '../../src/remote-desktop/tigervnc-backend-pool.js';
import { TigerVncManagedProcess } from '../../src/remote-desktop/tigervnc-managed-process.js';
import { X11RemoteDesktopRuntime } from '../../src/remote-desktop/x11-remote-desktop-runtime.js';
import { RemoteDesktopAdmission } from '../../../packages/server-core/src/remote-desktop-admission.js';
import { RemoteDesktopDirectCoordinator } from '../../../packages/server-core/src/remote-desktop-direct-coordinator.js';

const [binaryPath, display, xAuthority] = process.argv.slice(2);
if (!binaryPath || !display || !xAuthority) throw new Error('Missing native test arguments.');
const fingerprintA = `sha-256 ${'AA:'.repeat(31)}AA`;
const fingerprintB = `sha-256 ${'BB:'.repeat(31)}BB`;
let attachmentId = 'native-browser-attachment';
const grant = 'g'.repeat(64);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const peer = new RTCPeerConnection({ iceServers: [] });
let backend: TigerVncManagedProcess | undefined;
let service: DirectDesktopService | undefined;
let runtime: X11RemoteDesktopRuntime | undefined;
let server: RemoteDesktopDirectCoordinator | undefined;
let admission: RemoteDesktopAdmission | undefined;
let droppedClosed = false;
const identity = { userId: 1, sessionHash: 'test-session', workbenchConnectionId: 'workbench-1' };
const pool = new TigerVncBackendPool(
  async (signal, onUnexpectedExit) => {
    backend = await TigerVncManagedProcess.start(
      { binaryPath, display, xAuthority, onUnexpectedExit },
      signal
    );
    return backend;
  },
  () => service?.invalidate('DESKTOP_BACKEND_CLOSED')
);
const events: string[] = [];
let closedCode: string | undefined;
function until(target: EventTarget, event: string, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`Timeout: ${event}`));
    }, 8_000);
    const check = () => {
      if (ready()) {
        stop();
        resolve();
      }
    };
    const stop = () => {
      clearTimeout(timer);
      target.removeEventListener(event, check);
    };
    target.addEventListener(event, check);
    check();
  });
}
try {
  const topologyBinary = process.env['MAR_TEST_TOPOLOGY_HELPER'];
  if (topologyBinary) {
    runtime = await X11RemoteDesktopRuntime.start(
      {
        topologyBinary,
        binaryPath,
        display,
        xAuthority,
        maxPixels: 1_000_000,
        fence: (code) => service?.invalidate(code)
      },
      AbortSignal.timeout(8_000)
    );
  }
  await page.setContent('<div id="desktop" style="width:800px;height:600px"></div>');
  const bundle = await build({
    entryPoints: ['packages/web-core/test/e2e/remote-desktop-direct-native-fixture.js'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent'
  });
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0]!.text });
  await page.waitForFunction(() => (globalThis as any).desktopProbe !== undefined);
  const offer = await page.evaluate(() => (globalThis as any).desktopProbe.offer());
  await peer.setRemoteDescription(offer);
  await until(peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete');
  await page.evaluate(async (answer) => (globalThis as any).desktopProbe.answer(answer), {
    type: peer.localDescription!.type,
    sdp: peer.localDescription!.sdp
  });
  await until(peer, 'connectionstatechange', () => peer.connectionState === 'connected');
  service = new DirectDesktopService({
    nodeGeneration: () => 'generation-1',
    peer: () => peer,
    isCurrent:
      runtime?.isCurrent ??
      ((command) =>
        pool.isAvailable() &&
        command.desktopGeneration === 'desktop-1' &&
        command.topologyRevision === 1),
    emit: (event) => {
      events.push(event.type === 'desktop.direct.ready' ? event.phase : event.type);
      if (event.type === 'desktop.direct.closed') closedCode = event.code;
      if (server) {
        if (event.type === 'desktop.direct.closed' && !droppedClosed) droppedClosed = true;
        else void server.onNodeEvent('node-1', 'generation-1', event);
      }
      return true;
    },
    createAttachment:
      runtime?.createAttachment ??
      ((command, frontend, callbacks) =>
        new PooledDesktopAttachment(
          pool,
          frontend,
          (nativeBackend) =>
            new RemoteDesktopAttachment({
              attachmentId: command.attachmentId,
              frontend,
              backend: nativeBackend,
              mode: command.mode,
              maxPixels: 1_000_000,
              isCurrentTopology: (width, height) =>
                pool.isAvailable() && width === 800 && height === 600,
              onAttached: callbacks.attached,
              onFailure: callbacks.failed
            })
        ))
  });
  const description = runtime?.describe() ?? {
    desktopGeneration: 'desktop-1',
    topologyRevision: 1
  };
  await page.evaluate((value) => (globalThis as any).desktopProbe.start(value), description);
  if (process.env['MAR_TEST_SERVER_CLOSE']) {
    admission = new RemoteDesktopAdmission();
    server = new RemoteDesktopDirectCoordinator({
      admission,
      authorize: async () => true,
      preflight: async () => 4,
      transport: {
        authorizedTransport: () => ({
          browserFingerprint: fingerprintA,
          nodeFingerprint: fingerprintB
        })
      },
      sendNode: (_id, message) => {
        if (message.type === 'desktop.direct.prepare') attachmentId = message.attachmentId;
        return service!.handle(message);
      },
      sendBrowser: async (_id, message) => {
        await page.evaluate((value) => (globalThis as any).desktopProbe.prepared(value), message);
        return 'delivered';
      }
    });
    const messages = await page.evaluate(() => (globalThis as any).desktopProbe.messages());
    await server.handleBrowser(
      identity,
      messages.find((message: any) => message.type === 'desktop.direct.prepare')
    );
  } else {
    service.handle({
      type: 'desktop.direct.prepare',
      attachmentId,
      transportSessionId: 'transport-1',
      workbenchConnectionId: 'workbench-1',
      nodeGeneration: 'generation-1',
      desktopGeneration: runtime?.describe().desktopGeneration ?? 'desktop-1',
      topologyRevision: runtime?.describe().topologyRevision ?? 1,
      mode: 'CONTROL',
      grant,
      browserFingerprint: fingerprintA,
      nodeFingerprint: fingerprintB,
      openExpiresAt: Date.now() + 15_000,
      expiresAt: Date.now() + 30_000
    });
    await page.evaluate(
      ({ id, secret }) =>
        (globalThis as any).desktopProbe.prepared({
          type: 'desktop.direct.prepared',
          requestId: 'request-12345678',
          attachmentId: id,
          grant: secret,
          openExpiresAt: Date.now() + 15_000,
          expiresAt: Date.now() + 30_000
        }),
      { id: attachmentId, secret: grant }
    );
  }
  await page.waitForFunction(
    () => (globalThis as any).desktopProbe.state.firstframe === true,
    undefined,
    { timeout: 10_000 }
  );
  assert.equal(await page.evaluate(() => (globalThis as any).desktopProbe.state.ordered), true);
  const browserMessages = await page.evaluate(() => (globalThis as any).desktopProbe.messages());
  assert(
    browserMessages.some(
      (message: any) => message.type === 'desktop.ready' && message.attachmentId === attachmentId
    )
  );
  if (server) await server.handleBrowser(identity, { type: 'desktop.ready', attachmentId });
  else service.handle({ type: 'desktop.ready', attachmentId });
  for (let i = 0; i < 100 && !events.includes('ACTIVE'); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert(events.includes('ACTIVE'));
  console.log('READY');
  for await (const command of createInterface({ input: process.stdin })) {
    if (command === 'key') {
      await page.evaluate(() => (globalThis as any).desktopProbe.key());
      console.log('KEY');
    } else if (command === 'close') {
      if (process.env['MAR_TEST_NODE_SHUTDOWN']) {
        await service.shutdown(AbortSignal.timeout(10_000));
      } else if (server) {
        await server.handleBrowser(identity, { type: 'desktop.direct.cancel', attachmentId });
      } else if (runtime) {
        await promisify(execFile)('xrandr', ['--output', 'screen', '--primary'], {
          env: { ...process.env, DISPLAY: display, XAUTHORITY: xAuthority }
        });
      } else {
        service.handle({ type: 'desktop.direct.cancel', attachmentId, code: 'DESKTOP_CANCELLED' });
      }
      for (let i = 0; i < 500 && !events.includes('desktop.direct.closed'); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(events.includes('desktop.direct.closed'));
      if (process.env['MAR_TEST_NODE_SHUTDOWN'])
        assert.equal(closedCode, 'DESKTOP_SERVER_SHUTDOWN');
      if (admission) {
        assert(droppedClosed);
        assert.equal(admission.get(attachmentId)?.phase, 'CLOSING');
        for (let i = 0; i < 500 && admission.get(attachmentId); i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(admission.get(attachmentId), undefined);
      }
      console.log('CLOSED_WITH_NATIVE_RECEIPT');
      process.stdin.destroy();
      break;
    }
  }
} finally {
  server?.close();
  service?.dispose();
  await runtime?.dispose();
  peer.close();
  await page.close();
  await browser.close();
  await pool.dispose().catch(() => {});
  await backend?.forceStop();
  cleanup();
}
