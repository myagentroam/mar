import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { RemoteDesktopRelayNodeEvent } from '@myagentroam/protocol';
import { RelayDesktopService } from '../../src/remote-desktop/relay-desktop-service.js';
import { DirectDesktopService } from '../../src/remote-desktop/direct-desktop-service.js';
import { DesktopAttachmentRegistry } from '../../src/remote-desktop/desktop-service-core.js';

const prepare = {
  type: 'desktop.relay.prepare' as const,
  attachmentId: 'attachment-1',
  workbenchConnectionId: 'page-12345678',
  nodeGeneration: 'generation-1',
  desktopGeneration: 'desktop-12345678',
  topologyRevision: 1,
  mode: 'CONTROL' as const,
  grant: 'g'.repeat(32),
  ticket: 't'.repeat(32),
  openExpiresAt: Date.now() + 10000,
  expiresAt: Date.now() + 30000
};

describe('Relay desktop lifecycle', () => {
  it('authenticates before PREPARED, transfers OPEN to the shared writer and waits for native cleanup', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16384 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    const events: RemoteDesktopRelayNodeEvent[] = [];
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => cleanup);
    const slots = new DesktopAttachmentRegistry();
    const direct = new DirectDesktopService({
      registry: slots,
      nodeGeneration: () => 'generation-1',
      peer: () => undefined,
      isCurrent: () => true,
      createAttachment: vi.fn(),
      emit: () => true
    });
    const service = new RelayDesktopService({
      registry: slots,
      nodeId: 'node-a',
      nodeGeneration: () => 'generation-1',
      connect: () => new WebSocket(`ws://127.0.0.1:${address.port}`, { maxPayload: 16384 }),
      credential: () => 'test-credential',
      isCurrent: () => true,
      createAttachment: (_command, _stream, callbacks) => ({
        open: async () => {
          callbacks.attached();
        },
        close
      }),
      emit: (event) => {
        events.push(event);
        return true;
      }
    });
    const connected = once(server, 'connection');
    try {
      expect(service.handle(prepare)).toBe(true);
      expect(events).toEqual([]);
      const [socket] = (await connected) as [WebSocket];
      const [auth, binary] = await once(socket, 'message');
      expect(binary).toBe(false);
      expect(JSON.parse(auth.toString())).toMatchObject({
        type: 'desktop.relay.node',
        nodeId: 'node-a',
        nodeGeneration: 'generation-1',
        attachmentId: prepare.attachmentId,
        ticket: prepare.ticket,
        credential: 'test-credential'
      });
      expect(events).toContainEqual(expect.objectContaining({ phase: 'PREPARED' }));
      const attached = once(socket, 'message');
      socket.send(
        JSON.stringify({ type: 'OPEN', attachmentId: prepare.attachmentId, grant: prepare.grant })
      );
      expect(JSON.parse((await attached)[0].toString())).toEqual({
        type: 'ATTACHED',
        attachmentId: prepare.attachmentId
      });
      const ready = { type: 'desktop.ready', attachmentId: prepare.attachmentId };
      expect(direct.handle(ready)).toBe(false);
      expect(service.handle(ready)).toBe(true);
      await vi.waitFor(() =>
        expect(events).toContainEqual(expect.objectContaining({ phase: 'ACTIVE' }))
      );
      service.handle({
        type: 'desktop.relay.cancel',
        attachmentId: prepare.attachmentId,
        code: 'DESKTOP_CLOSED'
      });
      expect(close).toHaveBeenCalledOnce();
      expect(events.some((event) => event.type === 'desktop.relay.closed')).toBe(false);
      release();
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'desktop.relay.closed',
            attachmentId: prepare.attachmentId,
            code: 'DESKTOP_CLOSED'
          })
        )
      );
      socket.terminate();
    } finally {
      release();
      direct.dispose();
      service.dispose();
      server.clients.forEach((client) => client.terminate());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects stale Node generation before opening a socket', () => {
    const connect = vi.fn();
    const events: RemoteDesktopRelayNodeEvent[] = [];
    const service = new RelayDesktopService({
      nodeId: 'node-a',
      nodeGeneration: () => 'generation-next',
      connect,
      credential: () => 'test-credential',
      isCurrent: () => true,
      createAttachment: vi.fn(),
      emit: (event) => {
        events.push(event);
        return true;
      }
    });
    try {
      service.handle(prepare);
      expect(connect).not.toHaveBeenCalled();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'desktop.relay.closed',
          code: 'DESKTOP_CONTROL_UNAVAILABLE'
        })
      );
    } finally {
      service.dispose();
    }
  });
});
