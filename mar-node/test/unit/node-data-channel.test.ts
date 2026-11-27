import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { NodeStreamMux } from '@myagentroam/protocol/node-stream-mux';
import {
  decodeNodeRelayHandshake,
  encodeNodeRelayHandshake
} from '@myagentroam/protocol/node-stream-wire';
import type { NodeConfig } from '../../src/config.js';
import { NodeDataChannel } from '../../src/service/node-data-channel.js';

describe('Node data channel', () => {
  it('admits streams after the relay handshake, then reconnects under the new control binding', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const config = {
      serverUrl: `http://127.0.0.1:${address.port}`,
      nodeId: 'test-node',
      credential: 'test-credential'
    } as NodeConfig;
    const channels: { binding: string; socket: WebSocket; mux: NodeStreamMux }[] = [];
    const urls: (string | undefined)[] = [];
    const credentials: string[] = [];
    server.on('connection', (socket, request) => {
      urls.push(request.url);
      const mux = new NodeStreamMux({
        maxStreams: 4,
        send: (bytes) =>
          new Promise((resolve, reject) => {
            socket.send(bytes, (error) => (error ? reject(error) : resolve()));
          })
      });
      socket.once('message', (raw) => {
        const auth = decodeNodeRelayHandshake(raw);
        if (auth.type !== 'RELAY_AUTH') return socket.close();
        credentials.push(`${auth.nodeId}:${auth.credential}`);
        channels.push({ binding: auth.controlBinding, socket, mux });
        socket.on('message', (message) => mux.receive(message));
        socket.send(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
      });
      socket.once('close', () => mux.disconnect());
    });
    const relay = new NodeDataChannel({
      config: () => config,
      controlConnected: () => true,
      reconnect: true,
      reconnectDelay: () => 5,
      accept: async ({ grant }) =>
        grant === 'permitted'
          ? async (stream) => {
              for await (const bytes of stream) await stream.write(bytes);
              await stream.endWrite();
            }
          : undefined
    });

    try {
      relay.connect('old-binding');
      await vi.waitFor(() => expect(channels).toHaveLength(1));
      const first = channels[0]!;
      await expect(first.mux.openStream({ kind: 'file', grant: 'not-permitted' })).rejects.toThrow(
        'RESOURCE_DENIED'
      );
      const stream = await first.mux.openStream({ kind: 'file', grant: 'permitted' });
      expect(stream).toBeDefined();
      await stream!.write(Uint8Array.of(0, 255, 16));
      await stream!.endWrite();
      const output: Uint8Array[] = [];
      for await (const bytes of stream!) output.push(bytes);
      expect(Buffer.concat(output)).toEqual(Buffer.from([0, 255, 16]));

      const oldClosed = once(first.socket, 'close');
      relay.connect('new-binding');
      await oldClosed;
      await vi.waitFor(() => expect(channels).toHaveLength(2));
      channels[1]!.socket.terminate();
      await vi.waitFor(() => expect(channels).toHaveLength(3));
      expect(channels.map(({ binding }) => binding)).toEqual([
        'old-binding',
        'new-binding',
        'new-binding'
      ]);
      expect(urls).toEqual(Array(3).fill('/api/node/relay'));
      expect(credentials).toEqual(Array(3).fill('test-node:test-credential'));
    } finally {
      relay.disconnect();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
