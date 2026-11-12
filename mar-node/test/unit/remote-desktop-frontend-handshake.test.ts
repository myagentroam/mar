import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { handshakeRfbFrontend } from '../../src/remote-desktop/rfb-frontend-handshake.js';

const banner = Buffer.from('RFB 003.008\n');

function peer() {
  const writes: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    }
  });
  return { stream, writes };
}

function serverInit(): Buffer {
  const init = Buffer.alloc(28);
  init.writeUInt16BE(800, 0);
  init.writeUInt16BE(600, 2);
  init.writeUInt32BE(4, 20);
  init.write('test', 24);
  return init;
}

describe('authorized RFB frontend handshake', () => {
  it('negotiates shared RFB 3.8 and preserves client bytes for the gate', async () => {
    const { stream, writes } = peer();
    const init = serverInit();
    const pending = handshakeRfbFrontend(stream, init, AbortSignal.timeout(1_000));
    for (const byte of Buffer.concat([banner, Buffer.from([1, 1, 3, 4, 5])])) {
      stream.push(Buffer.from([byte]));
      await Promise.resolve();
    }
    await pending;
    expect(Buffer.concat(writes)).toEqual(
      Buffer.concat([banner, Buffer.from([1, 1]), Buffer.alloc(4), init])
    );
    expect(stream.read(3)).toEqual(Buffer.from([3, 4, 5]));
    stream.destroy();
  });

  it.each([
    ['unsupported version', Buffer.concat([Buffer.from('RFB 003.003\n'), Buffer.from([1, 1])])],
    ['unsupported security type', Buffer.concat([banner, Buffer.from([2, 1])])],
    ['exclusive client', Buffer.concat([banner, Buffer.from([1, 0])])]
  ])('rejects %s without sending ServerInit', async (_label, input) => {
    const { stream, writes } = peer();
    stream.push(input);
    await expect(
      handshakeRfbFrontend(stream, serverInit(), AbortSignal.timeout(1_000))
    ).rejects.toMatchObject({
      code: 'DESKTOP_RFB_INVALID',
      message: 'The remote desktop protocol message is invalid.'
    });
    expect(stream.destroyed).toBe(true);
    expect(Buffer.concat(writes).includes(serverInit())).toBe(false);
  });

  it('rejects malformed ServerInit before advertising RFB', async () => {
    const { stream, writes } = peer();
    const init = serverInit();
    init.writeUInt32BE(5, 20);
    await expect(
      handshakeRfbFrontend(stream, init, AbortSignal.timeout(1_000))
    ).rejects.toMatchObject({
      code: 'DESKTOP_RFB_INVALID'
    });
    expect(writes).toEqual([]);
  });

  it('cancels a stalled handshake and removes its listeners', async () => {
    const { stream } = peer();
    const controller = new AbortController();
    const pending = handshakeRfbFrontend(stream, serverInit(), controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_SETUP_CANCELLED' });
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount('readable')).toBe(0);
  });
});
