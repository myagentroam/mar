import { describe, expect, it } from 'vitest';
import {
  decodeByteFrame,
  decodeTerminalMux,
  encodeByteFrame,
  encodeTerminalMux,
  TERMINAL_MUX
} from '../../src/byte-frame.js';

describe('binary data frames', () => {
  it('preserves UTF-8 metadata and opaque payloads in a single message', () => {
    const metadata = { type: 'output', terminalId: '终端', sequence: 7 };
    const payload = Uint8Array.of(0, 0x89, 0xff, 0x0d, 0x0a);
    const encoded = encodeByteFrame(metadata, payload);
    expect(decodeByteFrame(encoded)).toEqual({ metadata, payload });
    expect(decodeByteFrame(encoded.buffer)).toEqual({ metadata, payload });
  });

  it('rejects text, unknown versions, malformed UTF-8 and excessive payloads', () => {
    expect(() => decodeByteFrame('{"type":"exit"}')).toThrow();
    expect(() => decodeByteFrame(Uint8Array.of(2, 0, 2, 123, 125))).toThrow();
    expect(() => decodeByteFrame(Uint8Array.of(1, 0, 2, 0xff, 0xff))).toThrow();
    expect(() => decodeByteFrame(Uint8Array.of(1, 0, 3, 123, 125))).toThrow();
    expect(() => encodeByteFrame({}, new Uint8Array(65_537))).toThrow();
  });

  it('wraps unmodified binary terminal frames with a stream ID and rejects invalid mux headers', () => {
    const payload = encodeByteFrame({ type: 'output' }, Uint8Array.of(0, 0xff));
    const encoded = encodeTerminalMux(TERMINAL_MUX.data, 0xffffffff, payload);
    expect(decodeTerminalMux(encoded)).toEqual({
      type: TERMINAL_MUX.data,
      stream: 0xffffffff,
      payload
    });
    expect(() => encodeTerminalMux(257, 1, payload)).toThrow('TERMINAL_MUX_INVALID');
    expect(() => encodeTerminalMux(TERMINAL_MUX.close, 0x100000001)).toThrow(
      'TERMINAL_MUX_INVALID'
    );
    expect(() => decodeTerminalMux(Uint8Array.of(3, 0, 0, 0, 1, 1))).toThrow(
      'TERMINAL_MUX_INVALID'
    );
    expect(decodeTerminalMux(encodeTerminalMux(TERMINAL_MUX.ready, 0))).toMatchObject({
      type: TERMINAL_MUX.ready,
      stream: 0
    });
    expect(() => encodeTerminalMux(TERMINAL_MUX.ready, 1)).toThrow('TERMINAL_MUX_INVALID');
  });
});
