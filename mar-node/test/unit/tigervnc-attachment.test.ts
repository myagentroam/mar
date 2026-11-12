import { Duplex, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RfbClientGate } from '../../src/remote-desktop/rfb-client-gate.js';
import { TigerVncAttachment } from '../../src/remote-desktop/tigervnc-attachment.js';
import { TigerVncCleanupChannel } from '../../src/remote-desktop/tigervnc-cleanup-channel.js';

function setup() {
  let finishWrite!: (error?: Error | null) => void;
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      finishWrite = done;
    }
  });
  const gate = new RfbClientGate(socket, 'CONTROL', () => true, vi.fn());
  const receipts = new PassThrough();
  const channel = new TigerVncCleanupChannel(receipts);
  const ticket = channel.issue();
  const attachment = new TigerVncAttachment(socket, gate, ticket);
  const receipt = (status = 'OK') =>
    receipts.write(`MAR1 ${ticket.registration.subarray(8).toString('hex')} ${status}\n`);
  const input = () => gate.receive(Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]));
  return { attachment, socket, channel, receipt, input, finishWrite: () => finishWrite() };
}

describe('TigerVNC attachment cleanup', () => {
  it('fences in-flight input before closing and waits for the matching native receipt', async () => {
    const ctx = setup();
    ctx.input();
    let closed = false;
    const closing = ctx.attachment.close(new AbortController().signal).then(() => (closed = true));
    expect(ctx.socket.destroyed).toBe(false);
    ctx.finishWrite();
    await vi.waitFor(() => expect(ctx.socket.destroyed).toBe(true));
    expect(closed).toBe(false);
    ctx.receipt();
    await closing;
    expect(closed).toBe(true);
    await ctx.attachment.close(new AbortController().signal);
    ctx.channel.dispose();
  });

  it('destroys the stream on timeout but does not treat it as a cleanup receipt', async () => {
    const ctx = setup();
    ctx.input();
    const abort = new AbortController();
    const closing = ctx.attachment.close(abort.signal);
    abort.abort();
    await expect(closing).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT',
      message: expect.any(String)
    });
    expect(ctx.socket.destroyed).toBe(true);
    ctx.receipt();
    await ctx.attachment.close(new AbortController().signal);
    ctx.channel.dispose();
  });

  it('does not report release when native cleanup fails', async () => {
    const ctx = setup();
    const closing = ctx.attachment.close(new AbortController().signal);
    await vi.waitFor(() => expect(ctx.socket.destroyed).toBe(true));
    ctx.receipt('FAILED');
    await expect(closing).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_FAILED',
      message: expect.any(String)
    });
    await expect(ctx.attachment.close(new AbortController().signal)).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_FAILED',
      message: expect.any(String)
    });
    ctx.channel.dispose();
  });
});
