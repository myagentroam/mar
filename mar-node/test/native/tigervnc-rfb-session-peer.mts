import { Duplex } from 'node:stream';
import { createInterface } from 'node:readline';
import { TigerVncManagedProcess } from '../../src/remote-desktop/tigervnc-managed-process.js';
import { RemoteDesktopAttachment } from '../../src/remote-desktop/remote-desktop-attachment.js';

const [binaryPath, display, xAuthority] = process.argv.slice(2);
if (!binaryPath || !display || !xAuthority) throw new Error('Missing native test arguments.');
class Frontend extends Duplex {
  override _read(): void {}
  override _write(
    _bytes: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    callback();
  }
}
const backend = await TigerVncManagedProcess.start(
  {
    binaryPath,
    display,
    xAuthority,
    onUnexpectedExit: () => console.error('Unexpected backend exit.')
  },
  AbortSignal.timeout(8_000)
);
try {
  const frontend = new Frontend();
  const attachment = new RemoteDesktopAttachment({
    attachmentId: 'native-test-attachment',
    frontend,
    backend,
    mode: 'CONTROL',
    maxPixels: 1_000_000,
    isCurrentTopology: (width, height) => width === 800 && height === 600,
    onAttached: () => {
      frontend.push(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]));
    },
    onFailure: (code) => console.error(code)
  });
  await attachment.open(AbortSignal.timeout(8_000));
  console.log('READY');
  for await (const command of createInterface({ input: process.stdin })) {
    if (command === 'key') {
      frontend.push(Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]));
      console.log('KEY');
    } else if (command === 'close') {
      await attachment.close(AbortSignal.timeout(5_000));
      await backend.stop();
      console.log('CLOSED_WITH_NATIVE_RECEIPT');
      process.stdin.destroy();
      break;
    }
  }
} finally {
  await backend.forceStop();
}
