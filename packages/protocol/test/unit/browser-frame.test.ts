import { describe, expect, it } from 'vitest';
import {
  BROWSER_FRAME_MAX_BYTES,
  BROWSER_FRAME_MESSAGE_BYTES,
  BrowserFrameReceiver,
  encodeBrowserFrame
} from '../../src/index.js';

const view = { sequence: 1, viewVersion: 7, width: 1280, height: 800, key: true };

describe('Browser frame wire format', () => {
  it('reassembles a maximum-sized frame from bounded binary messages', () => {
    const data = Uint8Array.from({ length: BROWSER_FRAME_MAX_BYTES }, (_, n) => n % 251);
    const receiver = new BrowserFrameReceiver();
    const frame = { ...view, data };
    const chunks = [...encodeBrowserFrame(frame)];
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.byteLength).toBe(BROWSER_FRAME_MESSAGE_BYTES);
      expect(receiver.push(chunk)).toBeUndefined();
    }
    const result = receiver.push(chunks.at(-1)!);
    expect(result).toMatchObject(view);
    expect(Buffer.compare(result!.data, data)).toBe(0);
  });

  it('rejects missing chunks, out-of-budget sizes and interleaved views', () => {
    const data = new Uint8Array(2 * BROWSER_FRAME_MESSAGE_BYTES);
    const [start, next, end] = [...encodeBrowserFrame({ ...view, data })];
    const receiver = new BrowserFrameReceiver();
    expect(() => receiver.push(end!)).toThrow(RangeError);
    const oversized = Uint8Array.from(start!);
    new DataView(oversized.buffer).setUint32(16, BROWSER_FRAME_MAX_BYTES + 1);
    expect(() => receiver.push(oversized)).toThrow(RangeError);
    expect(receiver.push(start!)).toBeUndefined();
    const otherView = Uint8Array.from(next!);
    new DataView(otherView.buffer).setUint32(4, view.viewVersion + 1);
    expect(() => receiver.push(otherView)).toThrow(RangeError);
  });

  it('does not accept a replayed frame after completing it', () => {
    const [chunk] = [...encodeBrowserFrame({ ...view, data: new Uint8Array([42]) })];
    const receiver = new BrowserFrameReceiver();
    expect(receiver.push(chunk!)?.sequence).toBe(1);
    expect(() => receiver.push(chunk!)).toThrow(RangeError);
  });

  it('rejects a key flag change between chunks', () => {
    const [first, last] = [...encodeBrowserFrame({ ...view, data: new Uint8Array(17 * 1024) })];
    const receiver = new BrowserFrameReceiver();
    expect(receiver.push(first!)).toBeUndefined();
    last![20] = 0;
    expect(() => receiver.push(last!)).toThrow(RangeError);
  });
});
