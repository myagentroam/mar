import { describe, expect, it } from 'vitest';
import { decodeByteFrame, encodeByteFrame } from '../../src/byte-frame.js';

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
});
