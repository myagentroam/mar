import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_FRAME_MAX_BYTES, BrowserFrameReceiver } from '@myagentroam/protocol';
import { BrowserFrameStream } from '../../src/browser/browser-frame-stream.js';

const capture = (value: number, viewVersion = 1) => ({
  viewVersion,
  width: 800,
  height: 600,
  jpeg: Buffer.from([value])
});
const encode = async (jpeg: Buffer, key: boolean) => ({ data: jpeg, key });

afterEach(() => vi.useRealTimers());

describe('Browser attachment frame stream', () => {
  it('keeps only the newest capture while waiting for frame credit', async () => {
    const receiver = new BrowserFrameReceiver();
    const images: number[] = [];
    const stream = new BrowserFrameStream({
      encode,
      send: async (chunk) => {
        images.push(receiver.push(chunk)!.data[0]!);
      },
      failed: vi.fn(),
      deadlineMs: 1000
    });
    stream.setView(1);
    stream.offer(capture(1));
    stream.offer(capture(2));
    stream.offer(capture(3));
    await vi.waitFor(() => expect(images).toEqual([1]));
    expect(stream.acknowledge(2)).toBe(false);
    expect(stream.acknowledge(1)).toBe(true);
    await vi.waitFor(() => expect(images).toEqual([1, 3]));
    stream.close();
  });

  it('discards pending captures from the previous view but finishes its in-flight frame', async () => {
    const receiver = new BrowserFrameReceiver();
    const images: number[] = [];
    const keys: boolean[] = [];
    const stream = new BrowserFrameStream({
      encode,
      send: async (chunk) => {
        const frame = receiver.push(chunk)!;
        images.push(frame.viewVersion);
        keys.push(frame.key);
      },
      failed: vi.fn(),
      deadlineMs: 1000
    });
    stream.setView(1);
    stream.offer(capture(1));
    stream.offer(capture(2));
    await vi.waitFor(() => expect(images).toEqual([1]));
    stream.setView(2);
    stream.offer(capture(3));
    stream.offer(capture(4, 2));
    expect(stream.acknowledge(1)).toBe(true);
    await vi.waitFor(() => expect(images).toEqual([1, 2]));
    expect(keys).toEqual([true, true]);
    stream.close();
  });

  it('does not send a stale encode and starts the next view with a key', async () => {
    const old = Promise.withResolvers<{ data: Buffer; key: boolean }>();
    const encode = vi
      .fn(async (jpeg: Buffer, key: boolean) => ({ data: jpeg, key }))
      .mockReturnValueOnce(old.promise);
    const receiver = new BrowserFrameReceiver();
    const received: number[] = [];
    const stream = new BrowserFrameStream({
      encode,
      send: async (chunk) => {
        received.push(receiver.push(chunk)!.viewVersion);
      },
      failed: vi.fn(),
      deadlineMs: 1000
    });
    stream.setView(1);
    stream.offer(capture(1));
    expect(stream.acknowledge(1)).toBe(false);
    stream.setView(2);
    stream.offer(capture(2, 2));
    old.resolve({ data: Buffer.from([1]), key: true });
    await vi.waitFor(() => expect(received).toEqual([2]));
    expect(encode).toHaveBeenLastCalledWith(Buffer.from([2]), true);
    stream.close();
  });

  it('does not grant credit before the last fragment starts or until its write finishes', async () => {
    const first = Promise.withResolvers<void>();
    const last = Promise.withResolvers<void>();
    const send = vi
      .fn(async () => {})
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(last.promise);
    const encode = vi.fn(async (_jpeg: Buffer, key: boolean) => ({
      data: Buffer.alloc(17 * 1024),
      key
    }));
    const stream = new BrowserFrameStream({ encode, send, failed: vi.fn(), deadlineMs: 1000 });
    stream.setView(1);
    stream.offer(capture(1));
    stream.offer(capture(2));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(stream.acknowledge(1)).toBe(false);
    first.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(stream.acknowledge(1)).toBe(true);
    expect(encode).toHaveBeenCalledTimes(1);
    last.resolve();
    await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(2));
    stream.close();
  });

  it('reports a wire-size violation as an encode failure, not a path failure', async () => {
    const failed = vi.fn();
    const send = vi.fn(async () => {});
    const encode = vi.fn(async (_jpeg: Buffer, key: boolean) => ({
      data: Buffer.alloc(BROWSER_FRAME_MAX_BYTES + 1),
      key
    }));
    const stream = new BrowserFrameStream({ encode, send, failed, deadlineMs: 1000 });
    stream.setView(1);
    stream.offer({ ...capture(1), jpeg: Buffer.alloc(BROWSER_FRAME_MAX_BYTES + 1) });
    await vi.waitFor(() =>
      expect(failed).toHaveBeenCalledExactlyOnceWith('BROWSER_FRAME_ENCODE_FAILED')
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('aborts a blocked send and reports a single timeout', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const send = vi.fn(
      (_chunk: Uint8Array, signal: AbortSignal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const stream = new BrowserFrameStream({ encode, send, failed, deadlineMs: 100 });
    stream.setView(1);
    stream.offer(capture(1));
    stream.offer(capture(2));
    await vi.advanceTimersByTimeAsync(100);
    stream.offer(capture(3));
    expect(stream.acknowledge(1)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls).toEqual([['BROWSER_FRAME_TIMEOUT']]);
  });
});
