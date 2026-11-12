import { RemoteDesktopError } from './desktop-error.js';
import { RfbHandshakeIo } from './rfb-handshake-io.js';
import { createCipheriv } from 'node:crypto';
import type { Duplex } from 'node:stream';

/**
 * Temporarily owns a backend stream during RFB 3.8 setup. The caller supplies
 * the setup deadline and, on success, resumes ownership of the paused stream.
 * It never exposes backend credentials or accepts an unauthenticated backend.
 */
export async function handshakeRfbBackend(
  stream: Duplex,
  password: Uint8Array,
  maxPixels: number,
  signal: AbortSignal
): Promise<{ width: number; height: number; serverInit: Buffer }> {
  const io = new RfbHandshakeIo(stream, signal);
  try {
    if (
      password.length < 1 ||
      password.length > 8 ||
      password.includes(0) ||
      !Number.isSafeInteger(maxPixels) ||
      maxPixels < 1
    )
      throw new RemoteDesktopError('DESKTOP_RFB_INVALID');

    if (!(await io.read(12)).equals(Buffer.from('RFB 003.008\n')))
      throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    await io.write(Buffer.from('RFB 003.008\n'));
    const securityCount = (await io.read(1))[0]!;
    if (securityCount === 0 || !(await io.read(securityCount)).includes(2))
      throw new RemoteDesktopError('DESKTOP_BACKEND_AUTH_UNAVAILABLE');
    await io.write(Buffer.from([2]));
    const challenge = await io.read(16);
    const response = vncResponse(challenge, password);
    try {
      await io.write(response);
    } finally {
      response.fill(0);
      challenge.fill(0);
    }
    if ((await io.read(4)).readUInt32BE() !== 0)
      throw new RemoteDesktopError('DESKTOP_BACKEND_AUTH_FAILED');
    // Every attachment is shared, regardless of any frontend request.
    await io.write(Buffer.from([1]));
    const header = await io.read(24);
    const width = header.readUInt16BE(0);
    const height = header.readUInt16BE(2);
    const nameLength = header.readUInt32BE(20);
    if (
      width === 0 ||
      height === 0 ||
      width * height > maxPixels ||
      nameLength > 4096 ||
      !validPixelFormat(header.subarray(4, 20))
    )
      throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    const name = await io.read(nameLength);
    return { width, height, serverInit: Buffer.concat([header, name]) };
  } catch (error) {
    stream.destroy();
    if (error instanceof RemoteDesktopError) throw error;
    throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
  } finally {
    io.dispose();
  }
}

function vncResponse(challenge: Buffer, password: Uint8Array): Buffer {
  const key = Buffer.alloc(8);
  for (let i = 0; i < password.length; i++) {
    let byte = password[i]!;
    byte = ((byte & 0x55) << 1) | ((byte >>> 1) & 0x55);
    byte = ((byte & 0x33) << 2) | ((byte >>> 2) & 0x33);
    key[i] = ((byte & 0x0f) << 4) | (byte >>> 4);
  }
  // EDE with three identical keys is DES ECB without relying on legacy OpenSSL providers.
  const expanded = Buffer.concat([key, key, key]);
  try {
    const cipher = createCipheriv('des-ede3', expanded, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(challenge), cipher.final()]);
  } finally {
    key.fill(0);
    expanded.fill(0);
  }
}

function validPixelFormat(format: Buffer): boolean {
  const bpp = format[0]!;
  const depth = format[1]!;
  if (![8, 16, 32].includes(bpp) || depth === 0 || depth > bpp || format[3] === 0)
    return false;
  let occupied = 0n;
  for (let i = 0; i < 3; i++) {
    const max = format.readUInt16BE(4 + i * 2);
    const shift = format[10 + i]!;
    if (max === 0 || (max & (max + 1)) !== 0) return false;
    const mask = BigInt(max) << BigInt(shift);
    if (mask >= 1n << BigInt(bpp) || (mask & occupied) !== 0n) return false;
    occupied |= mask;
  }
  return true;
}
