import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RfbHandshakeIo } from '../../src/remote-desktop/rfb-handshake-io.js';

// Bound a broken reader's microtask spin so a regression cannot starve the test runner.
class Peer extends Duplex {
  reads = 0;
  override _read(): void {}
  override read(size?: number): Buffer | null {
    if (++this.reads > 100) throw new Error('Reader spun on an incomplete buffered frame.');
    return super.read(size) as Buffer | null;
  }
}

describe('RFB handshake stream reads', () => {
  it.each([12, 24, 65_536])(
    'waits for delayed fragments of a %i-byte frame without spinning',
    async (size) => {
      const stream = new Peer();
      const io = new RfbHandshakeIo(stream, AbortSignal.timeout(1_000));
      stream.push(Buffer.alloc(size / 2, 42));
      const timer = setTimeout(() => {
        stream.push(Buffer.concat([Buffer.alloc(size / 2, 42), Buffer.from([7, 8, 9])]));
      }, 10);
      try {
        await expect(io.read(size)).resolves.toEqual(Buffer.alloc(size, 42));
        expect(stream.read(3)).toEqual(Buffer.from([7, 8, 9]));
      } finally {
        clearTimeout(timer);
        io.dispose();
        stream.destroy();
      }
    }
  );

  it('honors cancellation while only part of a frame is buffered', async () => {
    const stream = new Peer();
    const controller = new AbortController();
    const io = new RfbHandshakeIo(stream, controller.signal);
    stream.push(Buffer.alloc(8));
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(io.read(24)).rejects.toMatchObject({ code: 'DESKTOP_SETUP_CANCELLED' });
    } finally {
      clearTimeout(timer);
      io.dispose();
      stream.destroy();
    }
  });

  it('rejects a closed partial frame instead of returning truncated bytes', async () => {
    const stream = new Peer();
    const io = new RfbHandshakeIo(stream, AbortSignal.timeout(1_000));
    stream.push(Buffer.alloc(8));
    const timer = setTimeout(() => stream.destroy(), 10);
    try {
      await expect(io.read(24)).rejects.toMatchObject({ code: 'DESKTOP_TRANSPORT_ERROR' });
    } finally {
      clearTimeout(timer);
      io.dispose();
      stream.destroy();
    }
  });
});
