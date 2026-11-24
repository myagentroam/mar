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
    expect(stream.acknowledge(2)).toBeUndefined();
    expect(stream.acknowledge(1)).toBe(1);
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
    expect(stream.acknowledge(1)).toBe(1);
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
    expect(stream.acknowledge(1)).toBeUndefined();
    stream.setView(2);
    stream.offer(capture(2, 2));
    old.resolve({ data: Buffer.from([1]), key: true });
    await vi.waitFor(() => expect(received).toEqual([2]));
    expect(encode).toHaveBeenLastCalledWith(
      Buffer.from([2]),
      true,
      { viewVersion: 2, width: 800, height: 600 },
      { fps: 24, bitrate: 1_500_000, hd: false }
    );
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
    expect(stream.acknowledge(1)).toBeUndefined();
    first.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(stream.acknowledge(1)).toBe(1);
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
    expect(stream.acknowledge(1)).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls).toEqual([['BROWSER_FRAME_TIMEOUT']]);
  });

  it.each([
    ['encode', 'BROWSER_FRAME_ENCODE_FAILED'],
    ['send', 'BROWSER_FRAME_TRANSPORT_FAILED']
  ] as const)(
    'reports a failed %s immediately and discards pending work',
    async (stage, reason) => {
      vi.useFakeTimers();
      const error = new Error('test failure');
      const encodeFrame = vi.fn(encode);
      const send = vi.fn(async () => {});
      if (stage === 'encode') encodeFrame.mockRejectedValueOnce(error);
      else send.mockRejectedValueOnce(error);
      const failed = vi.fn();
      const stream = new BrowserFrameStream({
        encode: encodeFrame,
        send,
        failed,
        deadlineMs: 1000
      });
      stream.setView(1);
      stream.offer(capture(1));
      stream.offer(capture(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(failed).toHaveBeenCalledExactlyOnceWith(reason);
      stream.offer(capture(3));
      expect(stream.acknowledge(1)).toBeUndefined();
      expect(encodeFrame).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(stage === 'send' ? 1 : 0);
    }
  );

  it('paces before encoding, sends the final pending capture, and gives a new view immediate credit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const receiver = new BrowserFrameReceiver();
    const frames: number[] = [];
    const stream = new BrowserFrameStream({
      encode,
      send: async (chunk) => {
        const frame = receiver.push(chunk)!;
        frames.push(frame.data[0]!);
        stream.acknowledge(frame.sequence);
      },
      failed: vi.fn(),
      deadlineMs: 1000
    });
    stream.setView(1);
    stream.offer(capture(1));
    await vi.advanceTimersByTimeAsync(0);
    stream.offer(capture(2));
    stream.offer(capture(3));
    await vi.advanceTimersByTimeAsync(5);
    expect(frames).toEqual([1]);
    await vi.advanceTimersByTimeAsync(40);
    expect(frames).toEqual([1, 3]);
    stream.offer(capture(4));
    stream.setView(2);
    stream.offer(capture(5, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([1, 3, 5]);
    stream.offer(capture(6, 2));
    stream.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toEqual([1, 3, 5]);
  });

  it('starts each changed quality profile with a key frame without changing the view', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const receiver = new BrowserFrameReceiver();
    const encode = vi.fn<ConstructorParameters<typeof BrowserFrameStream>[0]['encode']>(
      async (jpeg, key) => ({
        data: Buffer.alloc(10 * 1024, jpeg[0]),
        key
      })
    );
    const stream = new BrowserFrameStream({
      encode,
      send: async (chunk) => {
        const frame = receiver.push(chunk)!;
        await new Promise((resolve) => setTimeout(resolve, 120));
        stream.acknowledge(frame.sequence);
      },
      failed: vi.fn(),
      deadlineMs: 1000
    });
    stream.setView(1);
    for (let value = 1; value <= 8; value++) {
      stream.offer(capture(value));
      await vi.advanceTimersByTimeAsync(150);
    }
    const calls = encode.mock.calls;
    expect(calls.slice(0, 6).map((call) => call[1])).toEqual([
      true,
      false,
      false,
      true,
      false,
      false
    ]);
    expect(calls[3]?.[3]).toEqual({ ...calls[0]![3], fps: 10 });
    expect(calls[6]?.[1]).toBe(true);
    expect(calls[6]?.[2]).toEqual({ viewVersion: 1, width: 800, height: 600 });
    expect(calls[6]?.[3]).toEqual({ fps: 10, bitrate: 768_000, hd: false });
    stream.close();
  });
});
