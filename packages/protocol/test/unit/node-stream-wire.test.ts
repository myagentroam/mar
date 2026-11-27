import { describe, expect, it } from 'vitest';
import { encodeTerminalMessage } from '../../src/byte-frame.js';
import {
  decodeNodeStreamFrame,
  encodeNodeStreamFrame,
  NODE_STREAM_CHUNK_BYTES,
  NODE_STREAM_WINDOW_BYTES,
  type NodeStreamFrame
} from '../../src/node-stream-wire.js';

describe('Node stream wire', () => {
  it('keeps stream metadata separate from binary body', () => {
    const frame = {
      type: 'DATA',
      streamId: 3,
      bytes: Uint8Array.from({ length: NODE_STREAM_CHUNK_BYTES }, (_, index) => index & 0xff)
    } as const;
    expect(decodeNodeStreamFrame(encodeNodeStreamFrame(frame))).toEqual(frame);
  });

  it.each<NodeStreamFrame>([
    { type: 'OPEN', streamId: 1, kind: 'terminal', grant: 'opaque-ticket' },
    { type: 'OPENED', streamId: 2 },
    { type: 'WINDOW', streamId: 3, bytes: NODE_STREAM_WINDOW_BYTES },
    { type: 'FIN', streamId: 4 },
    { type: 'RESET', streamId: 5, code: 'RESOURCE_DENIED' }
  ])('round trips $type', (frame) => {
    expect(decodeNodeStreamFrame(encodeNodeStreamFrame(frame))).toEqual(frame);
  });

  it('rejects old frames and frames outside the stream contract', () => {
    expect(() => decodeNodeStreamFrame(encodeTerminalMessage({ type: 'attach' }))).toThrow();
    expect(() => decodeNodeStreamFrame('{"type":"OPEN"}')).toThrow();
    expect(() => encodeNodeStreamFrame({ type: 'FIN', streamId: 0 })).toThrow();
    expect(() => encodeNodeStreamFrame({ type: 'WINDOW', streamId: 1, bytes: 0 })).toThrow();
    expect(() =>
      encodeNodeStreamFrame({
        type: 'DATA',
        streamId: 1,
        bytes: new Uint8Array(NODE_STREAM_CHUNK_BYTES + 1)
      })
    ).toThrow();
  });
});
