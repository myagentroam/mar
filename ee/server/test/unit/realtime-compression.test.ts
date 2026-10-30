import { once } from 'node:events';
import type { Socket } from 'node:net';
import Fastify from 'fastify';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { registerRealtimeRoutes } from '../../src/route/realtime-routes.js';

function transport(socket: WebSocket): Socket {
  return (socket as unknown as { _socket: Socket })._socket;
}

describe('realtime transport compression', () => {
  it.each([true, false])(
    'round trips snapshots with client compression offered=%s',
    async (offered) => {
      const app = Fastify();
      let serverSocket: WebSocket | undefined;
      registerRealtimeRoutes({
        app,
        database: {} as never,
        publicOrigin: undefined,
        nodeControl: {
          attach(socket: WebSocket) {
            serverSocket = socket;
            socket.on('message', (message) => socket.send(message.toString()));
          }
        } as never
      });
      let client: WebSocket | undefined;
      try {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        client = new WebSocket(`${origin.replace('http:', 'ws:')}/api/node/connect`, {
          perMessageDeflate: offered
        });
        await once(client, 'open');
        expect(client.extensions).toBe(offered ? 'permessage-deflate' : '');
        expect(serverSocket).toBeDefined();
        const snapshot = JSON.stringify({
          type: 'watch.session.snapshot',
          segments: [
            { items: [{ kind: 'tool_result', output: 'Repeated tool output. '.repeat(12_000) }] }
          ]
        });
        const clientRead = transport(client).bytesRead;
        const serverRead = transport(serverSocket!).bytesRead;
        const received = once(client, 'message');
        client.send(snapshot);
        const [message] = await received;
        expect(message.toString()).toBe(snapshot);
        const download = transport(client).bytesRead - clientRead;
        const upload = transport(serverSocket!).bytesRead - serverRead;
        if (offered) {
          expect(download).toBeLessThan(Buffer.byteLength(snapshot) / 10);
          expect(upload).toBeLessThan(Buffer.byteLength(snapshot) / 10);
        } else {
          expect(download).toBeGreaterThanOrEqual(Buffer.byteLength(snapshot));
          expect(upload).toBeGreaterThanOrEqual(Buffer.byteLength(snapshot));
        }
        const beforeSmall = transport(client).bytesRead;
        const small = once(client, 'message');
        client.send('small');
        expect((await small)[0].toString()).toBe('small');
        expect(transport(client).bytesRead - beforeSmall).toBe(7);
      } finally {
        client?.terminate();
        serverSocket?.terminate();
        await app.close();
      }
    }
  );
});
