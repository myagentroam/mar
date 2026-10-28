import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@myagentroam/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';

describe('Node request authorization', () => {
  it('Node rejects requests without Admin authorization and operations outside the fixed allowlist', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('ADDRESS_INVALID');
    const database = new NodeDatabase(':memory:', 'node-a');
    const connector = new NodeConnector({
      database,
      reconnect: false,
      config: {
        serverUrl: `http://127.0.0.1:${address.port}`,
        allowedRoots: [],
        nodeId: 'node-a',
        credential: 'test'
      }
    });
    const sent: { type: string; payload: unknown; replyTo?: string }[] = [];
    const connection = once(server, 'connection') as Promise<[WebSocket]>;
    (connector as unknown as { controlChannel: { connect(): void } }).controlChannel.connect();
    const [socket] = await connection;
    socket.on('message', (raw) => {
      sent.push(JSON.parse(raw.toString()) as { type: string; payload: unknown; replyTo?: string });
    });
    try {
      const unauthorized = createEnvelope('node.request', {
        operation: 'workspace.list',
        data: {}
      });
      socket.send(JSON.stringify(unauthorized));
      await vi.waitFor(() =>
        expect(sent).toContainEqual(
          expect.objectContaining({
            type: 'node.response',
            replyTo: unauthorized.id,
            payload: {
              error: 'USER_AUTHORIZATION_REQUIRED',
              message: 'User authorization is required.'
            }
          })
        )
      );
      sent.length = 0;
      const legacyRequestId = 'legacy-authorized-request';
      const now = Date.now();
      socket.send(
        JSON.stringify(
          createEnvelope(
            'node.request',
            {
              operation: 'workspace.list',
              data: {},
              ownerAuthorization: {
                userId: 1,
                sessionHash: 'a'.repeat(43),
                nodeId: 'node-a',
                operation: 'workspace.list',
                requestId: legacyRequestId,
                issuedAt: now,
                expiresAt: now + 15_000
              }
            },
            { id: legacyRequestId }
          )
        )
      );
      await vi.waitFor(() =>
        expect(sent).toContainEqual(
          expect.objectContaining({
            type: 'node.response',
            replyTo: legacyRequestId,
            payload: {
              error: 'USER_AUTHORIZATION_REQUIRED',
              message: 'User authorization is required.'
            }
          })
        )
      );
      sent.length = 0;
      const requestId = 'authorized-request';
      socket.send(
        JSON.stringify(
          createEnvelope(
            'node.request',
            {
              operation: 'shell.exec',
              data: {},
              userAuthorization: {
                userId: 1,
                sessionHash: 'a'.repeat(43),
                nodeId: 'node-a',
                operation: 'shell.exec',
                requestId,
                issuedAt: now + 1_000,
                expiresAt: now + 16_000
              }
            },
            { id: requestId }
          )
        )
      );
      await vi.waitFor(() =>
        expect(sent).toContainEqual(
          expect.objectContaining({
            type: 'node.response',
            replyTo: requestId,
            payload: {
              error: 'OPERATION_UNSUPPORTED',
              message: 'Operation is unsupported.'
            }
          })
        )
      );
    } finally {
      await connector.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
