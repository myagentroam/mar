import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RfbClientGate } from '../../src/remote-desktop/rfb-client-gate.js';

class Backend extends EventEmitter {
  readonly writes: Buffer[] = [];
  blocked = false;
  holdCallbacks = false;
  readonly callbacks: ((error?: Error | null) => void)[] = [];
  write(data: Buffer, callback: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(data));
    if (this.holdCallbacks) this.callbacks.push(callback);
    else queueMicrotask(callback);
    return !this.blocked;
  }
}

const key = (down: boolean, symbol = 0x61) => {
  const message = Buffer.alloc(8);
  message[0] = 4;
  message[1] = Number(down);
  message.writeUInt32BE(symbol, 4);
  return message;
};
const pointer = (buttons: number) => Buffer.from([5, buttons, 0, 2, 0, 3]);
const update = () => Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 0, 2]);
function encodings(values: readonly number[]): Buffer {
  const frame = Buffer.alloc(4 + values.length * 4);
  frame[0] = 2;
  frame.writeUInt16BE(values.length, 2);
  values.forEach((value, index) => frame.writeInt32BE(value, 4 + 4 * index));
  return frame;
}
function extendedClipboard(flags: number, body = Buffer.alloc(0)): Buffer {
  const frame = Buffer.alloc(12 + body.length);
  frame[0] = 6;
  frame.writeInt32BE(-(4 + body.length), 4);
  frame.writeUInt32BE(flags, 8);
  body.copy(frame, 12);
  return frame;
}
function setup(mode: 'VIEW' | 'CONTROL' = 'CONTROL') {
  const backend = new Backend();
  const failure = vi.fn();
  const isOwner = vi.fn(() => true);
  const gate = new RfbClientGate(backend as unknown as Writable, mode, isOwner, failure);
  return { gate, backend, failure, isOwner };
}

describe('Remote Desktop RFB client gate', () => {
  it('forwards the standard Tight and quality settings for both modes', () => {
    for (const mode of ['VIEW', 'CONTROL'] as const) {
      const { gate, backend } = setup(mode);
      for (const quality of [-29, -26, -23]) {
        const frame = encodings([7, 21, 0, quality, -254]);
        gate.receive(frame);
        expect(backend.writes.at(-1)).toEqual(frame);
      }
      gate.dispose();
    }
  });
  it('frames fragmented and concatenated standard messages without losing bytes', async () => {
    const { gate, backend, failure } = setup();
    const expected = [update(), key(true), pointer(1), key(false)];
    const payload = Buffer.concat(expected);
    for (const byte of payload) gate.receive(Uint8Array.of(byte));
    expect(backend.writes).toEqual(expected);
    expect(failure).not.toHaveBeenCalled();
    expect(await gate.fence()).toEqual({ keys: [], buttons: 1, x: 2, y: 3 });
    gate.dispose();
  });

  it('never forwards VIEW keyboard, pointer, or clipboard input', () => {
    for (const input of [key(true), pointer(1), Buffer.alloc(8, 0).fill(6, 0, 1)]) {
      const { gate, backend, failure } = setup('VIEW');
      gate.receive(Buffer.concat([update(), input]));
      expect(backend.writes).toEqual([update()]);
      expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_INPUT_DENIED');
      gate.receive(update());
      expect(backend.writes).toHaveLength(1);
      gate.dispose();
    }
  });

  it('filters unsupported extensions and only offers clipboard to CONTROL', () => {
    const requested = [0, -258, -309, -312, -313, -308, -1063131698, -23, 7];
    for (const mode of ['VIEW', 'CONTROL'] as const) {
      const { gate, backend } = setup(mode);
      gate.receive(encodings(requested));
      const expected = mode === 'VIEW' ? [0, -308, -23, 7] : [0, -308, -1063131698, -23, 7];
      expect(backend.writes).toEqual([encodings(expected)]);
      gate.dispose();
    }
  });

  it('rechecks the lease at actual backend write after backpressure', () => {
    const { gate, backend, isOwner, failure } = setup();
    backend.blocked = true;
    gate.receive(Buffer.concat([update(), key(true)]));
    expect(backend.writes).toEqual([update()]);
    isOwner.mockReturnValue(false);
    backend.blocked = false;
    backend.emit('drain');
    expect(backend.writes).toEqual([update()]);
    expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_CONTROL_LOST');
    gate.dispose();
  });

  it('fails closed if the control authority cannot answer', () => {
    const { gate, backend, isOwner, failure } = setup();
    isOwner.mockImplementation(() => {
      throw new Error('authority unavailable');
    });
    gate.receive(key(true));
    expect(backend.writes).toEqual([]);
    expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_CONTROL_LOST');
    gate.dispose();
  });

  it('permits only negotiated text clipboard actions and resets negotiation', () => {
    const { gate, backend, failure } = setup();
    const caps = extendedClipboard(0x1b000001, Buffer.alloc(4));
    const notify = extendedClipboard(0x08000001);
    const provide = extendedClipboard(0x10000001, Buffer.from([1]));
    const offer = encodings([-1063131698]);
    gate.receive(Buffer.concat([offer, caps, notify, provide]));
    expect(backend.writes).toEqual([offer, caps, notify, provide]);
    gate.receive(encodings([0]));
    gate.receive(notify);
    expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_RFB_INVALID');
    gate.dispose();
  });

  it('rejects unsolicited or unsafe extended clipboard actions and malformed capabilities', () => {
    const rejected = [
      extendedClipboard(0x02000001), // request
      extendedClipboard(0x04000001), // peek
      extendedClipboard(0x08000002), // non-text format
      extendedClipboard(0x08010001), // reserved flag
      extendedClipboard(0x19000001), // missing capability size
      extendedClipboard(0x10000001) // missing compressed payload
    ];
    for (const frame of rejected) {
      const { gate, backend, failure } = setup();
      gate.receive(encodings([-1063131698]));
      gate.receive(frame);
      expect(backend.writes).toHaveLength(1);
      expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_RFB_INVALID');
      gate.dispose();
    }
    const { gate, backend, failure } = setup();
    gate.receive(extendedClipboard(0x08000001));
    expect(backend.writes).toEqual([]);
    expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_RFB_INVALID');
    gate.dispose();
  });

  it('bounds both queued frames and distinct pressed keys before backend write', () => {
    const blocked = setup();
    blocked.backend.blocked = true;
    blocked.gate.receive(update());
    blocked.gate.receive(Buffer.concat(Array.from({ length: 1025 }, update)));
    expect(blocked.failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_BACKPRESSURE');
    expect(blocked.backend.writes).toHaveLength(1);
    blocked.gate.dispose();

    const pressed = setup();
    for (let symbol = 0; symbol < 256; symbol++) pressed.gate.receive(key(true, symbol));
    pressed.gate.receive(key(true, 256));
    expect(pressed.backend.writes).toHaveLength(256);
    expect(pressed.failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_RFB_INVALID');
    pressed.gate.dispose();
  });

  it('fences queued input and waits for written bytes to drain before returning the snapshot', async () => {
    const { gate, backend } = setup();
    backend.blocked = true;
    gate.receive(Buffer.concat([key(true), pointer(1)]));
    const fencing = gate.fence();
    expect(gate.fence()).toBe(fencing);
    let settled = false;
    void fencing.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.receive(key(false));
    backend.emit('drain');
    expect(await fencing).toEqual({ keys: [0x61], buttons: 0, x: 0, y: 0 });
    expect(backend.writes).toEqual([key(true)]);
    gate.dispose();
  });

  it('retains the last submitted pointer position, not a queued position discarded by fencing', async () => {
    const { gate, backend } = setup();
    backend.blocked = true;
    gate.receive(Buffer.concat([pointer(1), Buffer.from([5, 1, 0, 9, 0, 10])]));
    const fencing = gate.fence();
    backend.emit('drain');
    expect(await fencing).toEqual({ keys: [], buttons: 1, x: 2, y: 3 });
    expect(backend.writes).toEqual([pointer(1)]);
    gate.dispose();
  });

  it('rejects a failed drain rather than claiming cleanup', async () => {
    const { gate, backend, failure } = setup();
    backend.blocked = true;
    gate.receive(key(true));
    const fenced = gate.fence();
    backend.emit('error', new Error('broken pipe'));
    await expect(fenced).rejects.toMatchObject({
      code: 'DESKTOP_TRANSPORT_ERROR',
      message: expect.any(String)
    });
    expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_TRANSPORT_ERROR');
    gate.dispose();
  });

  it('waits for successful write callbacks even when write returned true', async () => {
    const { gate, backend } = setup();
    backend.holdCallbacks = true;
    gate.receive(key(true));
    const fenced = gate.fence();
    let settled = false;
    void fenced.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    backend.callbacks[0]!();
    expect(await fenced).toEqual({ keys: [0x61], buttons: 0, x: 0, y: 0 });
    gate.dispose();
  });

  it('bounds in-flight frames even when the writable keeps accepting data', () => {
    const { gate, backend } = setup();
    backend.holdCallbacks = true;
    gate.receive(Buffer.concat(Array.from({ length: 1025 }, update)));
    expect(backend.writes).toHaveLength(1024);
    backend.callbacks[0]!();
    expect(backend.writes).toHaveLength(1025);
    gate.dispose();
  });

  it('rejects fencing when an in-flight write callback reports failure', async () => {
    const { gate, backend, failure } = setup();
    backend.holdCallbacks = true;
    gate.receive(key(true));
    const fenced = gate.fence();
    backend.callbacks[0]!(new Error('write failed'));
    await expect(fenced).rejects.toMatchObject({
      code: 'DESKTOP_TRANSPORT_ERROR',
      message: expect.any(String)
    });
    expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_TRANSPORT_ERROR');
    gate.dispose();
  });

  it('rejects unsupported message types and bounded variable-length frames', () => {
    const tooManyEncodings = Buffer.from([2, 0, 1, 1]);
    const oversizedClipboard = Buffer.from([6, 0, 0, 0, 0, 0x10, 0, 1]);
    const oversizedExtendedClipboard = Buffer.from([6, 0, 0, 0, 0xff, 0xef, 0xff, 0xff]);
    for (const frame of [
      Buffer.from([255]),
      tooManyEncodings,
      oversizedClipboard,
      oversizedExtendedClipboard
    ]) {
      const { gate, backend, failure } = setup();
      gate.receive(frame);
      expect(failure).toHaveBeenCalledExactlyOnceWith('DESKTOP_RFB_INVALID');
      expect(backend.writes).toEqual([]);
      gate.dispose();
    }
  });
});
