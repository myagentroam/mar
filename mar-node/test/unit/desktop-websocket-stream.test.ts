import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { DesktopByteStream } from '../../src/remote-desktop/desktop-byte-stream.js';

describe('desktop relay byte stream', () => {
  it('exchanges ordered binary bytes on a real WebSocket and owns its close', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    const accepted = once(server, 'connection');
    const browser = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(browser, 'open');
    const [socket] = (await accepted) as [WebSocket];
    const stream = new DesktopByteStream(socket, 16);
    stream.on('error', () => {});
    try {
      const incoming = once(stream, 'data');
      browser.send(Buffer.from([1, 2, 3]));
      expect((await incoming)[0]).toEqual(Buffer.from([1, 2, 3]));
      const outgoing = once(browser, 'message');
      const input = Buffer.from([4, 5, 6]);
      await new Promise<void>((resolve, reject) =>
        stream.write(input, (error) => (error ? reject(error) : resolve()))
      );
      input.fill(0);
      const [message, binary] = await outgoing;
      expect(message).toEqual(Buffer.from([4, 5, 6]));
      expect(binary).toBe(true);
    } finally {
      const closed = once(browser, 'close');
      stream.destroy();
      await closed;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
