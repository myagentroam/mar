import { createServer } from 'node:net';
import { MacosRemoteDesktopRuntime } from '../../src/remote-desktop/macos-remote-desktop-runtime.js';
const [binaryPath, topologyBinary, port] = process.argv.slice(2);
if (!binaryPath || !topologyBinary || !port) throw new Error('Missing test arguments');
const runtime = await MacosRemoteDesktopRuntime.start(
  { binaryPath, topologyBinary, maxPixels: 67108864, fence: (code) => console.log('fence', code) },
  AbortSignal.timeout(20000)
);
const desktop = runtime.describe();
console.log('TOPOLOGY', JSON.stringify(desktop));
const server = createServer((socket) => {
  const attachment = runtime.createAttachment(
    {
      attachmentId: 'probe-attachment',
      mode: 'CONTROL',
      desktopGeneration: desktop.desktopGeneration,
      topologyRevision: desktop.topologyRevision
    },
    socket,
    { attached: () => console.log('ATTACHED'), failed: (code) => console.error('FAILED', code) }
  );
  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    try {
      await attachment.close(AbortSignal.timeout(10000));
      await runtime.dispose();
      server.close();
      console.log('CLOSED');
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
      server.close();
    }
  };
  socket.once('close', () => void finish());
  void attachment.open(AbortSignal.timeout(20000)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
    void finish();
  });
});
server.listen(Number(port), '127.0.0.1', () => console.log('READY'));
