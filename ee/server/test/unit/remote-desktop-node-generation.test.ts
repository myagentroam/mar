import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { createEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  NodeControl,
  type NodeControlComponents,
  type NodeControlConsumers,
  type NodeControlStore,
  type NodeControlTransport
} from '../../src/node-control.js';

class Socket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
  terminate = vi.fn(() => this.close());
  receive(type: string, payload: unknown) {
    this.emit('message', JSON.stringify(createEnvelope(type, payload)));
  }
}

describe('Remote Desktop Node event generation', () => {
  it('uses the authenticated current connection capability and rejects stale generations', async () => {
    const event = vi.fn(async () => {});
    const noop = vi.fn();
    const retireDirect = vi.fn();
    const retireRelay = vi.fn();
    const request = vi.fn(async () => ({}));
    const store = {
      authenticateNode: vi.fn(async () => ({
        id: 'node-1',
        ownerUserId: 1,
        displayName: null,
        registeredAddress: 'unknown',
        metadata: '{}',
        disabled: false,
        lastHeartbeatAt: null
      })),
      updateNodeHeartbeat: vi.fn(async () => {})
    } as unknown as NodeControlStore;
    const components = {
      requestBroker: { request, rejectNode: noop, close: noop },
      workbenchRelay: { broadcast: noop, close: noop },
      directTransfers: { revokeNode: noop, close: noop },
      terminalDirect: { revokeNode: noop, close: noop },
      desktopDirect: {
        onNodeEvent: event,
        revokeNode: noop,
        retireOtherGenerations: retireDirect,
        close: noop
      },
      desktopRelay: {
        onNodeEvent: event,
        revokeNode: noop,
        retireOtherGenerations: retireRelay,
        close: noop
      },
      desktopPairing: { close: noop },
      desktopRelaySockets: { close: noop },
      terminalRelay: { disconnectNode: noop, close: noop },
      messageProjector: {
        enqueueSessionProjection: vi.fn(async () => {}),
        drain: vi.fn(async () => {})
      }
    } as unknown as NodeControlComponents;
    const consumers = {
      runtimeCredentials: { activateNodeConnection: noop, deactivateNodeConnection: noop },
      recentRunDisconnected: vi.fn(async () => {})
    } as unknown as NodeControlConsumers;
    let transport!: NodeControlTransport;
    const control = new NodeControl(
      store,
      (value) => {
        transport = value;
        return components;
      },
      consumers
    );
    const socket = new Socket();
    try {
      const signal = new AbortController().signal;
      const user = { userId: 1, sessionHash: 'session-hash' };
      await transport.request('node-1', 'desktop.describe', {}, user, 1234, signal);
      expect(request).toHaveBeenCalledWith('node-1', 'desktop.describe', {}, user, 1234, signal);
      control.attach(socket as unknown as WebSocket);
      socket.receive('authenticate', { nodeId: 'node-1', credential: 'test' });
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      socket.receive('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24',
        nodeAppVersion: '0.11.40',
        codex: { available: false },
        claudeCode: { available: false },
        remoteDesktop: {
          apiVersion: 1,
          available: false,
          nodeGeneration: 'generation-new',
          reasonCode: 'DESKTOP_UNAVAILABLE'
        }
      });
      await vi.waitFor(() =>
        expect(control.nodeCapabilities('node-1')?.remoteDesktop?.nodeGeneration).toBe(
          'generation-new'
        )
      );
      await vi.waitFor(() => expect(retireDirect).toHaveBeenCalledWith('node-1', 'generation-new'));
      expect(retireRelay).toHaveBeenCalledWith('node-1', 'generation-new');
      const closed = {
        attachmentId: 'attachment-1',
        nodeGeneration: 'generation-old',
        code: 'DESKTOP_CLOSED'
      };
      socket.receive('desktop.direct.closed', closed);
      await control.drainProjections();
      expect(event).not.toHaveBeenCalled();
      socket.receive('desktop.direct.closed', { ...closed, nodeGeneration: 'generation-new' });
      await vi.waitFor(() =>
        expect(event).toHaveBeenCalledWith(
          'node-1',
          'generation-new',
          expect.objectContaining({ type: 'desktop.direct.closed' })
        )
      );
      event.mockClear();
      const replacement = new Socket();
      control.attach(replacement as unknown as WebSocket);
      replacement.receive('authenticate', { nodeId: 'node-1', credential: 'test' });
      await vi.waitFor(() => expect(socket.readyState).toBe(3));
      replacement.receive('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24',
        nodeAppVersion: '0.11.40',
        codex: { available: false },
        claudeCode: { available: false },
        remoteDesktop: {
          apiVersion: 1,
          available: false,
          nodeGeneration: 'generation-next',
          reasonCode: 'DESKTOP_UNAVAILABLE'
        }
      });
      await vi.waitFor(() =>
        expect(control.nodeCapabilities('node-1')?.remoteDesktop?.nodeGeneration).toBe(
          'generation-next'
        )
      );
      await vi.waitFor(() =>
        expect(retireDirect).toHaveBeenCalledWith('node-1', 'generation-next')
      );
      expect(retireRelay).toHaveBeenCalledWith('node-1', 'generation-next');
      replacement.receive('desktop.direct.closed', { ...closed, nodeGeneration: 'generation-new' });
      await control.drainProjections();
      expect(event).not.toHaveBeenCalled();
      replacement.receive('desktop.direct.closed', {
        ...closed,
        nodeGeneration: 'generation-next'
      });
      await vi.waitFor(() =>
        expect(event).toHaveBeenCalledWith(
          'node-1',
          'generation-next',
          expect.objectContaining({ type: 'desktop.direct.closed' })
        )
      );
      event.mockClear();
      replacement.receive('desktop.relay.closed', { ...closed, nodeGeneration: 'generation-new' });
      await control.drainProjections();
      expect(event).not.toHaveBeenCalled();
      replacement.receive('desktop.relay.closed', { ...closed, nodeGeneration: 'generation-next' });
      await vi.waitFor(() =>
        expect(event).toHaveBeenCalledWith(
          'node-1',
          'generation-next',
          expect.objectContaining({ type: 'desktop.relay.closed' })
        )
      );
    } finally {
      control.close();
    }
  });
});
