import { describe, expect, it, vi } from 'vitest';
import type { RTCPeerConnection } from 'node-datachannel/polyfill';
import { RemoteDesktopAdmission } from '../../../packages/server-core/src/remote-desktop-admission.js';
import { RemoteDesktopDirectCoordinator } from '../../../packages/server-core/src/remote-desktop-direct-coordinator.js';
import { DirectDesktopService } from '../../src/remote-desktop/direct-desktop-service.js';
import type { RemoteDesktopAttachment } from '../../src/remote-desktop/remote-desktop-attachment.js';

describe('desktop close delivery across Node and Server owners', () => {
  it('retries a lost close report only after native cleanup and rejects a new generation', async () => {
    const admission = new RemoteDesktopAdmission();
    let dropped = 0;
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const channel = {
      readyState: 'connecting',
      bufferedAmount: 0,
      onmessage: null as ((event: { data: string }) => void) | null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn()
    };
    const peer = { createDataChannel: () => channel, sctp: { maxMessageSize: 65_536 } };
    let server!: RemoteDesktopDirectCoordinator;
    const node = new DirectDesktopService({
      nodeGeneration: () => 'generation-a',
      peer: () => peer as unknown as RTCPeerConnection,
      isCurrent: () => true,
      createAttachment: (_command, stream, callbacks) => {
        stream.on('error', () => {});
        return {
          open: async () => callbacks.attached(),
          close: () => cleanup
        } as unknown as RemoteDesktopAttachment;
      },
      emit: (event) => {
        if (event.type === 'desktop.direct.closed' && dropped++ === 0) return true;
        void server.onNodeEvent('node-a', 'generation-a', event);
        return true;
      }
    });
    server = new RemoteDesktopDirectCoordinator({
      admission,
      authorize: () => true,
      preflight: async () => 4,
      transport: {
        authorizedTransport: () => ({
          browserFingerprint: `sha-256 ${'AA:'.repeat(31)}AA`,
          nodeFingerprint: `sha-256 ${'BB:'.repeat(31)}BB`
        })
      },
      sendNode: (_node, command) => node.handle(command),
      sendBrowser: async () => 'delivered'
    });
    const identity = {
      userId: 1,
      sessionHash: 'session-a',
      workbenchConnectionId: 'page-12345678'
    };
    let attachmentId = '';
    try {
      // Capture the issued grant from the Node-bound prepare command.
      const handle = node.handle.bind(node);
      const spy = vi.spyOn(node, 'handle').mockImplementation((raw) => {
        const command = raw as { type: string; attachmentId: string; grant?: string };
        if (command.type === 'desktop.direct.prepare') {
          attachmentId = command.attachmentId;
          queueMicrotask(() => {
            channel.readyState = 'open';
            channel.onmessage?.({
              data: JSON.stringify({ type: 'OPEN', attachmentId, grant: command.grant })
            });
          });
        }
        return handle(raw);
      });
      await server.handleBrowser(identity, {
        type: 'desktop.direct.prepare',
        requestId: 'request-123',
        nodeId: 'node-a',
        nodeGeneration: 'generation-a',
        transportSessionId: 'transport-a',
        desktopGeneration: 'desktop-a',
        topologyRevision: 1,
        mode: 'CONTROL'
      });
      await vi.waitFor(() => expect(channel.send).toHaveBeenCalled());
      await server.handleBrowser(identity, { type: 'desktop.direct.cancel', attachmentId });
      expect(admission.get(attachmentId)?.phase).toBe('CLOSING');
      expect(dropped).toBe(0);
      resolveCleanup();
      await vi.waitFor(() => expect(dropped).toBe(1));
      expect(admission.countNode('node-a')).toBe(1);
      await server.onNodeEvent('node-a', 'generation-new', {
        type: 'desktop.direct.closed',
        nodeGeneration: 'generation-new',
        attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
      expect(admission.countNode('node-a')).toBe(1);
      await vi.waitFor(() => expect(admission.countNode('node-a')).toBe(0), { timeout: 4_000 });
      expect(dropped).toBeGreaterThanOrEqual(2);
      spy.mockRestore();
    } finally {
      resolveCleanup();
      server.close();
      node.dispose();
    }
  });
});
