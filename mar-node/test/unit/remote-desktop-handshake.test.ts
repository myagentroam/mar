import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { handshakeRfbBackend } from '../../src/remote-desktop/rfb-backend-handshake.js';

function peer() {
  const writes: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    }
  });
  const incoming = { write: (value: Buffer) => stream.push(value) };
  const outgoing = { read: () => Buffer.concat(writes) };
  return { incoming, outgoing, stream };
}

function serverInit(width = 800, height = 600): Buffer {
  const result = Buffer.alloc(28);
  result.writeUInt16BE(width, 0);
  result.writeUInt16BE(height, 2);
  result.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
  result.writeUInt32BE(4, 20);
  result.write('test', 24);
  return result;
}

const banner = Buffer.from('RFB 003.008\n');
const challenge = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const credentials = Buffer.from('password');
const signal = () => new AbortController().signal;

function setupBytes(init = serverInit(), result = 0): Buffer {
  const status = Buffer.alloc(4);
  status.writeUInt32BE(result);
  return Buffer.concat([banner, Buffer.from([2, 1, 2]), challenge, status, init]);
}

describe('RFB backend handshake', () => {
  it('authenticates with VNC challenge, forces shared, and preserves subsequent bytes', async () => {
    const { stream, incoming, outgoing } = peer();
    incoming.write(Buffer.concat([setupBytes(), Buffer.from([3, 4, 5])]));
    const result = await handshakeRfbBackend(stream, credentials, 1_000_000, signal());
    expect(result).toEqual({ width: 800, height: 600, serverInit: serverInit() });
    expect(outgoing.read()).toEqual(
      Buffer.concat([
        banner,
        Buffer.from([2]),
        Buffer.from('b866924125c8eebb9debc1db61c538e2', 'hex'),
        Buffer.from([1])
      ])
    );
    expect(stream.read(3)).toEqual(Buffer.from([3, 4, 5]));
    stream.destroy();
  });

  it('accepts nonzero pixel-format boolean flags used by macVNC', async () => {
    const init = serverInit(1024, 768);
    init[6] = 255;
    init[7] = 255;
    const { stream, incoming } = peer();
    incoming.write(setupBytes(init));
    expect((await handshakeRfbBackend(stream, credentials, 1_000_000, signal())).serverInit).toEqual(
      init
    );
    stream.destroy();
  });

  it('refuses a backend offering only unauthenticated access', async () => {
    const { stream, incoming } = peer();
    incoming.write(Buffer.concat([banner, Buffer.from([1, 1])]));
    await expect(
      handshakeRfbBackend(stream, credentials, 1_000_000, signal())
    ).rejects.toMatchObject({
      code: 'DESKTOP_BACKEND_AUTH_UNAVAILABLE',
      message: expect.any(String)
    });
    expect(stream.destroyed).toBe(true);
  });

  it('handles byte-fragmented setup without consuming later server data', async () => {
    const { stream, incoming } = peer();
    const pending = handshakeRfbBackend(stream, credentials, 1_000_000, signal());
    for (const byte of setupBytes()) {
      incoming.write(Buffer.from([byte]));
      await Promise.resolve();
    }
    expect((await pending).serverInit).toEqual(serverInit());
    incoming.write(Buffer.from([42]));
    expect(stream.read(1)).toEqual(Buffer.from([42]));
    stream.destroy();
  });

  it('rejects authentication failure, invalid dimensions, and invalid pixel formats', async () => {
    const invalidFormat = serverInit();
    invalidFormat[7] = 0;
    for (const [bytes, code, message] of [
      [
        setupBytes(serverInit(), 1),
        'DESKTOP_BACKEND_AUTH_FAILED',
        'The desktop backend rejected authentication.'
      ],
      [
        setupBytes(serverInit(0)),
        'DESKTOP_RFB_INVALID',
        'The remote desktop protocol message is invalid.'
      ],
      [
        setupBytes(invalidFormat),
        'DESKTOP_RFB_INVALID',
        'The remote desktop protocol message is invalid.'
      ]
    ]) {
      const { stream, incoming } = peer();
      incoming.write(bytes as Buffer);
      await expect(
        handshakeRfbBackend(stream, credentials, 1_000_000, signal())
      ).rejects.toMatchObject({ code, message });
      expect(stream.destroyed).toBe(true);
    }
  });

  it('rejects oversized names or framebuffers without waiting for their contents', async () => {
    const name = serverInit();
    name.writeUInt32BE(4097, 20);
    for (const init of [name.subarray(0, 24), serverInit(2000, 2000)]) {
      const { stream, incoming } = peer();
      incoming.write(setupBytes(init));
      await expect(
        handshakeRfbBackend(stream, credentials, 1_000_000, signal())
      ).rejects.toMatchObject({ code: 'DESKTOP_RFB_INVALID', message: expect.any(String) });
    }
  });

  it('cancels and closes a stalled setup without keeping stream listeners', async () => {
    const { stream } = peer();
    const controller = new AbortController();
    const pending = handshakeRfbBackend(stream, credentials, 1_000_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'DESKTOP_SETUP_CANCELLED',
      message: expect.any(String)
    });
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount('readable')).toBe(0);
  });

  it('cancels an in-flight write and ignores its late callback', async () => {
    let finish: ((error?: Error | null) => void) | undefined;
    const stream = new Duplex({
      read() {},
      write(_chunk: Buffer, _encoding, callback) {
        finish = callback;
      }
    });
    stream.push(banner);
    const controller = new AbortController();
    const pending = handshakeRfbBackend(stream, credentials, 1_000_000, controller.signal);
    await Promise.resolve();
    expect(finish).toBeDefined();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'DESKTOP_SETUP_CANCELLED',
      message: expect.any(String)
    });
    finish!();
    expect(stream.destroyed).toBe(true);
  });
});
