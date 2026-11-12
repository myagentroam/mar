import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RfbClientGate } from '../../src/remote-desktop/rfb-client-gate.js';
import { submitRfbInputRelease } from '../../src/remote-desktop/rfb-input-release.js';

function key(down: boolean, symbol: number): Buffer {
  const frame = Buffer.alloc(8);
  frame[0] = 4;
  frame[1] = Number(down);
  frame.writeUInt32BE(symbol, 4);
  return frame;
}

describe('RFB input release submission', () => {
  it('fences input and submits ordinary key-ups before modifiers and pointer-up at the last submitted position', async () => {
    const writes: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writes.push(Buffer.from(chunk));
        callback();
      }
    });
    const gate = new RfbClientGate(
      stream,
      'CONTROL',
      () => true,
      () => {}
    );
    gate.receive(
      Buffer.concat([key(true, 0xffe1), key(true, 0x61), Buffer.from([5, 1, 0, 9, 0, 12])])
    );
    await submitRfbInputRelease(gate, stream, new AbortController().signal);
    expect(writes.at(-1)).toEqual(
      Buffer.concat([key(false, 0x61), key(false, 0xffe1), Buffer.from([5, 0, 0, 9, 0, 12])])
    );
    gate.receive(key(true, 0x62));
    expect(writes).toHaveLength(4);
    gate.dispose();
    stream.destroy();
  });

  it('does not submit release while an in-flight input is still pending after cancellation', async () => {
    const writes: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, _callback) {
        writes.push(Buffer.from(chunk));
      }
    });
    const gate = new RfbClientGate(
      stream,
      'CONTROL',
      () => true,
      () => {}
    );
    gate.receive(key(true, 0x61));
    const controller = new AbortController();
    const result = submitRfbInputRelease(gate, stream, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT' });
    expect(writes).toEqual([key(true, 0x61)]);
    gate.dispose();
    stream.destroy();
  });

  it('reports a failed release write instead of treating it as cleanup', async () => {
    let writes = 0;
    const stream = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        writes++;
        callback(writes === 1 ? undefined : new Error('backend closed'));
      }
    });
    const gate = new RfbClientGate(
      stream,
      'CONTROL',
      () => true,
      () => {}
    );
    gate.receive(key(true, 0x61));
    await expect(
      submitRfbInputRelease(gate, stream, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'DESKTOP_NATIVE_CLEANUP_FAILED' });
    expect(writes).toBe(2);
    gate.dispose();
    stream.on('error', () => {});
    stream.destroy();
  });

  it('reports an uncertain release on cancellation without retaining release listeners', async () => {
    let writes = 0;
    const stream = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        writes++;
        if (writes === 1) callback();
      }
    });
    const gate = new RfbClientGate(
      stream,
      'CONTROL',
      () => true,
      () => {}
    );
    gate.receive(key(true, 0x61));
    const controller = new AbortController();
    const release = submitRfbInputRelease(gate, stream, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toBe(2);
    controller.abort();
    await expect(release).rejects.toMatchObject({ code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT' });
    expect(stream.listenerCount('close')).toBe(1); // The gate still owns its listener.
    expect(stream.listenerCount('error')).toBe(1);
    gate.dispose();
    stream.destroy();
  });
});
