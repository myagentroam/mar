import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DesktopByteStream } from '../../src/remote-desktop/desktop-byte-stream.js';

function channelFixture() {
  const channel = {
    readyState: 'open',
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    send: vi.fn(),
    close: vi.fn()
  };
  return { channel, stream: new DesktopByteStream(channel as unknown as RTCDataChannel, 3) };
}

describe('desktop RTC byte stream', () => {
  it('preserves message bytes across fragments and uses only the supplied byte range', async () => {
    const { channel, stream } = channelFixture();
    const data = once(stream, 'data');
    const reusable = Uint8Array.from([9, 1, 2, 3, 9]);
    channel.onmessage!({ data: reusable.subarray(1, 4) } as MessageEvent);
    reusable.fill(0);
    expect((await data)[0]).toEqual(Buffer.from([1, 2, 3]));
    await new Promise<void>((resolve, reject) =>
      stream.write(Buffer.from([4, 5, 6, 7]), (error) => (error ? reject(error) : resolve()))
    );
    expect(channel.send.mock.calls.map(([chunk]) => Buffer.from(chunk))).toEqual([
      Buffer.from([4, 5, 6]),
      Buffer.from([7])
    ]);
    stream.destroy();
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it('fails closed rather than dropping RFB bytes on inbound overflow or invalid text', async () => {
    for (const data of [new Uint8Array(1024 * 1024 + 1), 'not-rfb']) {
      const { channel, stream } = channelFixture();
      const failure = once(stream, 'error');
      channel.onmessage!({ data } as MessageEvent);
      const [error] = await failure;
      expect(error.code).toBe(
        typeof data === 'string' ? 'DESKTOP_RFB_INVALID' : 'DESKTOP_BACKPRESSURE'
      );
      expect(channel.close).toHaveBeenCalledOnce();
    }
  });

  it('waits for the existing channel buffer to drain and cancels an outstanding write on close', async () => {
    const { channel, stream } = channelFixture();
    channel.bufferedAmount = 1024 * 1024;
    const write = vi.fn();
    stream.on('error', () => {});
    stream.write(Buffer.from([1]), write);
    expect(channel.send).not.toHaveBeenCalled();
    stream.destroy();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(write.mock.calls[0]![0]?.code).toBe('DESKTOP_RFB_CLOSED');
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it('resumes a paused write without duplication after bufferedAmount falls', async () => {
    const { channel, stream } = channelFixture();
    channel.bufferedAmount = 1024 * 1024;
    const written = new Promise<void>((resolve, reject) =>
      stream.write(Buffer.from([1, 2, 3, 4]), (error) => (error ? reject(error) : resolve()))
    );
    channel.bufferedAmount = 0;
    await written;
    expect(channel.send.mock.calls.map(([chunk]) => Buffer.from(chunk))).toEqual([
      Buffer.from([1, 2, 3]),
      Buffer.from([4])
    ]);
    stream.destroy();
  });

  it('yields between bounded send batches while retaining byte order', async () => {
    const { channel, stream } = channelFixture();
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, index) => index));
    const written = new Promise<void>((resolve, reject) =>
      stream.write(bytes, (error) => (error ? reject(error) : resolve()))
    );
    expect(channel.send).toHaveBeenCalledTimes(4);
    await written;
    expect(Buffer.concat(channel.send.mock.calls.map(([chunk]) => Buffer.from(chunk)))).toEqual(
      bytes
    );
    stream.destroy();
  });

  it('copies outbound bytes before releasing a reusable writer buffer', async () => {
    const { channel, stream } = channelFixture();
    const reusable = Buffer.from([1, 2, 3]);
    await new Promise<void>((resolve, reject) =>
      stream.write(reusable, (error) => (error ? reject(error) : resolve()))
    );
    reusable.fill(0);
    expect(Buffer.from(channel.send.mock.calls[0]![0])).toEqual(Buffer.from([1, 2, 3]));
    stream.destroy();
  });
});
