import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { NodeControlMessageService } from '../../src/service/node-control-message-service.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';

describe('Node desktop control routing', () => {
  it('routes relay commands and delivers ready to only the matching attachment owner', () => {
    const direct = vi.fn((message: NodeEnvelope) => message.payload === 'direct');
    const relay = vi.fn(() => true);
    const send = vi.fn();
    const options = {
      handleDesktopDirect: direct,
      handleDesktopRelay: relay,
      handleRuntimeCredentialResponse: () => false,
      send
    } as unknown as ConstructorParameters<typeof NodeControlMessageService>[0];
    const service = new NodeControlMessageService(options);
    const handle = (type: string, payload: unknown) =>
      service.handle(JSON.stringify(createEnvelope(type, payload)));

    handle('desktop.relay.prepare', {});
    expect(direct).not.toHaveBeenCalled();
    expect(relay).toHaveBeenCalledTimes(1);
    relay.mockClear();
    handle('desktop.direct.prepare', 'direct');
    expect(direct).toHaveBeenCalledTimes(1);
    expect(relay).not.toHaveBeenCalled();
    direct.mockClear();
    handle('desktop.ready', 'direct');
    expect(direct).toHaveBeenCalledTimes(1);
    expect(relay).not.toHaveBeenCalled();
    handle('desktop.ready', 'relay');
    expect(direct).toHaveBeenCalledTimes(2);
    expect(relay).toHaveBeenCalledTimes(1);
    direct.mockReturnValue(false);
    relay.mockReturnValue(false);
    handle('desktop.ready', 'expired');
    expect(relay).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('routes through the connector to Relay when Direct does not own ready', async () => {
    const database = new NodeDatabase(':memory:', 'desktop-routing');
    const connector = new NodeConnector({ database });
    const owners = connector as unknown as {
      directTransferService: {
        handleDesktop(command: unknown): boolean;
        shutdown(signal: AbortSignal): Promise<void>;
      };
      relayDesktopService: {
        handle(command: unknown): boolean;
        shutdown(signal: AbortSignal): Promise<void>;
      };
      handleMessage(raw: string): void;
    };
    const direct = vi.fn(() => false);
    const relay = vi.fn(() => true);
    owners.directTransferService = { handleDesktop: direct, shutdown: async () => {} };
    owners.relayDesktopService = { handle: relay, shutdown: async () => {} };
    const ready = { attachmentId: 'relay-attachment' };
    owners.handleMessage(JSON.stringify(createEnvelope('desktop.ready', ready)));
    expect(direct).toHaveBeenCalledWith({ type: 'desktop.ready', ...ready });
    expect(relay).toHaveBeenCalledWith({ type: 'desktop.ready', ...ready });
    relay.mockClear();
    owners.handleMessage(JSON.stringify(createEnvelope('desktop.relay.cancel', ready)));
    expect(relay).toHaveBeenCalledWith({ type: 'desktop.relay.cancel', ...ready });
    await connector.stop();
  });

  it('fences Relay on control disconnect without treating it as cleanup confirmation', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const database = new NodeDatabase(':memory:', 'desktop-disconnect');
    const connector = new NodeConnector({
      database,
      config: {
        serverUrl: `http://127.0.0.1:${address.port}`,
        allowedRoots: [],
        nodeId: 'node-test',
        credential: 'test-credential'
      }
    });
    const owners = connector as unknown as {
      controlChannel: { connect(): void };
      relayDesktopService: {
        invalidate(code: string): void;
        shutdown(signal: AbortSignal): Promise<void>;
      };
    };
    const invalidate = vi.fn();
    const shutdown = vi.fn(async () => {});
    owners.relayDesktopService = { invalidate, shutdown };
    const connecting = once(server, 'connection');
    try {
      owners.controlChannel.connect();
      const [socket] = await connecting;
      socket.close();
      await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith('DESKTOP_TRANSPORT_ERROR'));
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      await connector.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
