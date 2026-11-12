import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TigerVncCleanupChannel } from '../../src/remote-desktop/tigervnc-cleanup-channel.js';

const live = () => new AbortController().signal;
const token = (registration: Buffer) => registration.subarray(8).toString('hex');
const receipt = (registration: Buffer, status = 'OK') => `MAR1 ${token(registration)} ${status}\n`;

describe('TigerVNC private cleanup channel', () => {
  it('correlates fragmented and out-of-order native receipts without releasing another ticket', async () => {
    const stream = new PassThrough();
    const channel = new TigerVncCleanupChannel(stream);
    const first = channel.issue();
    const second = channel.issue();
    expect(first.registration.subarray(0, 8)).toEqual(Buffer.from('020000054d415231', 'hex'));
    expect(token(first.registration)).not.toBe(token(second.registration));
    let firstDone = false;
    const firstWait = first.wait(live()).then(() => (firstDone = true));
    const secondWait = second.wait(live());
    const line = receipt(second.registration);
    stream.write(line.slice(0, 9));
    stream.write(line.slice(9));
    await secondWait;
    expect(firstDone).toBe(false);
    stream.write(receipt(first.registration));
    await firstWait;
    expect(firstDone).toBe(true);
    channel.dispose();
  });

  it('keeps a timed-out ticket correlated so a late receipt cannot activate a replacement', async () => {
    const stream = new PassThrough();
    const channel = new TigerVncCleanupChannel(stream);
    const old = channel.issue();
    const abort = new AbortController();
    const oldWait = old.wait(abort.signal);
    abort.abort();
    await expect(oldWait).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT',
      message: expect.any(String)
    });
    const replacement = channel.issue();
    let replacementDone = false;
    const replacementWait = replacement.wait(live()).then(() => (replacementDone = true));
    stream.write(receipt(old.registration));
    await old.wait(live());
    expect(replacementDone).toBe(false);
    stream.write(receipt(replacement.registration));
    await replacementWait;
    channel.dispose();
  });

  it('reports native rejection and stream loss without treating either as cleanup', async () => {
    const stream = new PassThrough();
    const channel = new TigerVncCleanupChannel(stream);
    const failed = channel.issue();
    const lost = channel.issue();
    const failedWait = expect(failed.wait(live())).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_FAILED',
      message: expect.any(String)
    });
    const lostWait = expect(lost.wait(live())).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CHANNEL_CLOSED',
      message: expect.any(String)
    });
    stream.write(receipt(failed.registration, 'FAILED'));
    stream.end();
    await Promise.all([failedWait, lostWait]);
    expect(() => channel.issue()).toThrow(
      expect.objectContaining({
        code: 'DESKTOP_NATIVE_CHANNEL_CLOSED',
        message: expect.any(String)
      })
    );
    channel.dispose();
  });

  it.each(['MAR1 bad OK\n', `${'x'.repeat(65)}\n`])(
    'fails all pending attachments on malformed or unbounded input',
    async (message) => {
      const stream = new PassThrough();
      const channel = new TigerVncCleanupChannel(stream);
      const first = channel.issue();
      const second = channel.issue();
      const waits = [first, second].map((ticket) =>
        expect(ticket.wait(live())).rejects.toMatchObject({
          code: 'DESKTOP_NATIVE_CHANNEL_CLOSED',
          message: expect.any(String)
        })
      );
      stream.write(message);
      await Promise.all(waits);
      channel.dispose();
    }
  );

  it('tracks more than sixteen registrations and disallows concurrent waiters', async () => {
    const stream = new PassThrough();
    const channel = new TigerVncCleanupChannel(stream);
    const tickets = Array.from({ length: 20 }, () => channel.issue());
    expect(channel.outstanding).toBe(20);
    const abort = new AbortController();
    const wait = tickets[0]!.wait(abort.signal);
    await expect(tickets[0]!.wait(live())).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_WAIT_IN_PROGRESS',
      message: expect.any(String)
    });
    abort.abort();
    await expect(wait).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT',
      message: expect.any(String)
    });
    channel.dispose();
    expect(channel.outstanding).toBe(0);
    await expect(tickets[0]!.wait(live())).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CHANNEL_CLOSED',
      message: expect.any(String)
    });
  });
});
