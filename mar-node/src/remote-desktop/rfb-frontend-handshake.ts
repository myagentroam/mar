import type { Duplex } from 'node:stream';
import { RemoteDesktopError } from './desktop-error.js';
import { RfbHandshakeIo } from './rfb-handshake-io.js';

/**
 * Negotiates RFB 3.8 on an already authorized attachment. None is only the
 * inner RFB security type: this function must never admit an unauthenticated
 * transport. On success the caller regains the paused stream, including any
 * buffered client messages, and must pass them through the input gate.
 */
export async function handshakeRfbFrontend(
  stream: Duplex,
  serverInit: Buffer,
  signal: AbortSignal
): Promise<void> {
  const io = new RfbHandshakeIo(stream, signal);
  try {
    if (
      serverInit.length < 24 ||
      serverInit.length > 24 + 4096 ||
      serverInit.readUInt32BE(20) !== serverInit.length - 24
    )
      throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    const banner = Buffer.from('RFB 003.008\n');
    await io.write(banner);
    if (!(await io.read(12)).equals(banner)) throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    await io.write(Buffer.from([1, 1]));
    if ((await io.read(1))[0] !== 1) throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    await io.write(Buffer.alloc(4));
    // Never let an exclusive browser connection disconnect other observers.
    if ((await io.read(1))[0] !== 1) throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    await io.write(serverInit);
  } catch (error) {
    stream.destroy();
    if (error instanceof RemoteDesktopError) throw error;
    throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
  } finally {
    io.dispose();
  }
}
