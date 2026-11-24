import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  BROWSER_FRAME_MAX_BYTES,
  BrowserFrameReceiver,
  type BrowserFrame
} from '@myagentroam/protocol';
import * as vnc from '@myagentroam/browser-vnc';
import { BrowserVncStream } from '../../src/browser/browser-vnc-stream.js';

const request = Buffer.of(3, 1, 0, 0, 0, 0, 0, 64, 0, 80);
const streams: BrowserVncStream[] = [];
const capture = async (value: number, viewVersion = 1, width = 64) => ({
  viewVersion,
  width,
  height: 80,
  png: await sharp({
    create: { width, height: 80, channels: 3, background: { r: value, g: 0, b: 0 } }
  })
    .png()
    .toBuffer()
});

function fixture(send?: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>, tight = true) {
  const receiver = new BrowserFrameReceiver();
  const frames: BrowserFrame[] = [];
  const failed = vi.fn();
  const stream = new BrowserVncStream({
    deadlineMs: 350,
    relay: false,
    failed,
    changed: vi.fn(),
    handshake: vi.fn(),
    send: async (chunk, signal) => {
      const frame = receiver.push(chunk);
      if (frame) frames.push(frame);
      await send?.(chunk, signal);
    }
  });
  streams.push(stream);
  stream.start();
  stream.receive(Buffer.from('RFB 003.008\n'));
  stream.receive(Buffer.of(1, 1));
  const encodings = Buffer.from([2, 0, 0, tight ? 2 : 1, 255, 255, 255, 33, 0, 0, 0, 7]);
  stream.receive(tight ? encodings : encodings.subarray(0, 8));
  const next = () => stream.receive(request);
  stream.setView(1);
  next();
  return { stream, frames, failed, next };
}

afterEach(() => {
  for (const stream of streams.splice(0)) stream.close();
  vi.restoreAllMocks();
});

it('admits one update until drawn and keeps only the final capture of a burst', async () => {
  const [first, middle, last] = await Promise.all([capture(1), capture(2), capture(3)]);
  const { stream, frames, next } = fixture();
  stream.offer(first);
  stream.offer(middle);
  stream.offer(last);
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  next();
  expect(stream.acknowledge(2)).toBeUndefined();
  expect(stream.acknowledge(1)).toBe(1);
  expect(stream.acknowledge(1)).toBeUndefined();
  await vi.waitFor(() => expect(frames).toHaveLength(2));
  expect(frames[1]!.data[17]).toBe(3); // Tight Fill red channel.
});

it('drops stale encodes and pending views, but finishes consuming a committed older view', async () => {
  const [a, b, c, d] = await Promise.all([
    capture(1),
    capture(2, 2),
    capture(3, 2),
    capture(4, 3, 80)
  ]);
  const { stream, frames, next } = fixture();
  stream.offer(a);
  stream.setView(2);
  stream.offer(b);
  await vi.waitFor(() => expect(frames.map(({ viewVersion }) => viewVersion)).toEqual([2]));
  stream.offer(c);
  stream.setView(3);
  stream.offer(c);
  stream.offer(d);
  expect(stream.acknowledge(1)).toBe(2);
  next();
  await vi.waitFor(() => expect(frames.map(({ viewVersion }) => viewVersion)).toEqual([2, 3]));
  expect(frames[1]!.key).toBe(true);
});

it('rejects credit before the last chunk starts and waits for its write even after credit', async () => {
  const [a, b] = await Promise.all([capture(1), capture(2)]);
  const first = Promise.withResolvers<void>();
  const last = Promise.withResolvers<void>();
  const send = vi
    .fn(async (_chunk: Uint8Array, _signal: AbortSignal) => {})
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(last.promise);
  const { stream, frames, next } = fixture(send, false);
  stream.offer(a);
  stream.offer(b);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(stream.acknowledge(1)).toBeUndefined();
  first.resolve();
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  next();
  expect(stream.acknowledge(1)).toBe(1);
  expect(send).toHaveBeenCalledTimes(2);
  last.resolve();
  await vi.waitFor(() => expect(frames).toHaveLength(2));
});

it('times out once, aborting a blocked send and discarding pending work', async () => {
  const a = await capture(1);
  const send = vi.fn(
    (_chunk: Uint8Array, signal: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );
  const { stream, next, failed } = fixture(send);
  stream.offer(a);
  stream.offer(a);
  await vi.waitFor(() => expect(failed).toHaveBeenCalledExactlyOnceWith('BROWSER_FRAME_TIMEOUT'));
  next();
  stream.offer(a);
  expect(stream.acknowledge(1)).toBeUndefined();
  expect(send).toHaveBeenCalledOnce();
});

it('times out a stalled encode on an established view and never sends its late result', async () => {
  const [first, second] = await Promise.all([capture(1), capture(2)]);
  const encode = vi.spyOn(vnc, 'encodeBrowserVncUpdate');
  const { stream, next, frames, failed } = fixture();
  stream.offer(first);
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  expect(stream.acknowledge(1)).toBe(1);
  const late = Promise.withResolvers<vnc.BrowserVncUpdate | undefined>();
  const encoded = await encode.mock.results[0]!.value;
  encode.mockReturnValueOnce(late.promise);
  next();
  stream.offer(second);
  await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(2));
  try {
    await vi.waitFor(() => expect(failed).toHaveBeenCalledExactlyOnceWith('BROWSER_FRAME_TIMEOUT'));
  } finally {
    late.resolve(encoded);
  }
  await Promise.resolve();
  expect(frames).toHaveLength(1);
});

it.each([
  { label: 'expensive continuous motion', encodeMs: 250, ackMs: 20, pause: 0, expectedFps: 12 },
  { label: 'expensive isolated stills', encodeMs: 250, ackMs: 20, pause: 600, expectedFps: 24 },
  { label: 'continuous motion with steady RTT', encodeMs: 5, ackMs: 140, pause: 0, expectedFps: 24 }
] as const)('selects cadence for $label', async ({ encodeMs, ackMs, pause, expectedFps }) => {
  const pictures = await Promise.all([capture(1), capture(2), capture(3), capture(4)]);
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const encode = vnc.encodeBrowserVncUpdate;
  vi.spyOn(vnc, 'encodeBrowserVncUpdate').mockImplementation(async (...args) => {
    const update = await encode(...args);
    clock += encodeMs;
    return update;
  });

  const { stream, frames, next } = fixture();
  for (const [index, picture] of pictures.entries()) {
    stream.offer(picture);
    await vi.waitFor(() => expect(frames).toHaveLength(index + 1));
    clock += ackMs;
    expect(stream.acknowledge(index + 1)).toBe(1);
    await Promise.resolve();
    clock += pause;
    next();
  }
  expect(stream.fps).toBe(expectedFps);
  expect(stream.scale).toBe(2);
});

it('closes on malformed capture or failed writes rather than draining queued updates', async () => {
  const a = await capture(1);
  const send = vi.fn(async () => {
    throw new Error('fixture transport failure');
  });
  const write = fixture(send);
  write.stream.offer(a);
  write.stream.offer(a);
  await vi.waitFor(() =>
    expect(write.failed).toHaveBeenCalledExactlyOnceWith('BROWSER_FRAME_TRANSPORT_FAILED')
  );
  expect(send).toHaveBeenCalledOnce();
  const bad = fixture(send);
  bad.stream.offer({ ...a, png: Buffer.of(1) });
  await vi.waitFor(() =>
    expect(bad.failed).toHaveBeenCalledExactlyOnceWith('BROWSER_FRAME_ENCODE_FAILED')
  );
  expect(send).toHaveBeenCalledOnce();
});

it('reports an oversized encoded update as an encode failure before sending any chunks', async () => {
  const picture = await capture(1);
  const real = vnc.encodeBrowserVncUpdate;
  const encode = vi.spyOn(vnc, 'encodeBrowserVncUpdate');
  const { stream, frames, failed } = fixture();
  // Leave the encoder's geometry unchanged while substituting an invalid payload size.
  encode.mockImplementationOnce(async (...args) => {
    const update = await real(...args);
    return update && { ...update, data: Buffer.alloc(BROWSER_FRAME_MAX_BYTES + 1) };
  });
  stream.offer(picture);
  await vi.waitFor(() =>
    expect(failed).toHaveBeenCalledExactlyOnceWith('BROWSER_FRAME_ENCODE_FAILED')
  );
  expect(frames).toHaveLength(0);
});
