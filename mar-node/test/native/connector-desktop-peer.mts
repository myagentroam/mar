import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { NodeConnector } from '../../src/connector.js';
import { unavailableCapabilities } from '../../src/capabilities.js';
import type { X11RemoteDesktopRuntime } from '../../src/remote-desktop/x11-remote-desktop-runtime.js';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('Missing private data directory.');
const connector = new NodeConnector({
  reconnect: false,
  capabilities: unavailableCapabilities(),
  config: {
    serverUrl: 'http://127.0.0.1:1',
    allowedRoots: [],
    dataDirectory: directory,
    nodeId: 'node-native-probe',
    credential: 'native-probe-credential',
    computerUse: { enabled: false }
  }
});
try {
  await connector.start();
  const internal = connector as unknown as {
    capabilities: ReturnType<typeof unavailableCapabilities>;
    desktopRuntime?: X11RemoteDesktopRuntime;
  };
  assert.equal(internal.capabilities.remoteDesktop?.available, true);
  const runtime = internal.desktopRuntime!;
  const layout = runtime.describe();
  assert.deepEqual(layout.framebuffer, { width: 800, height: 600 });
  const frontend = new Duplex({ read() {}, write(_data, _encoding, callback) { callback(); } });
  const attachment = runtime.createAttachment(
    { attachmentId: 'native-auto-attachment', desktopGeneration: layout.desktopGeneration,
      topologyRevision: layout.topologyRevision, mode: 'CONTROL' },
    frontend,
    { attached: () => frontend.push(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])])),
      failed: (code) => { throw new Error(code); } }
  );
  await attachment.open(AbortSignal.timeout(8_000));
  frontend.push(Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]));
  await attachment.close(AbortSignal.timeout(8_000));
  console.log('NATIVE_CONNECTOR_DESKTOP_READY');
} finally {
  await connector.stop();
}
