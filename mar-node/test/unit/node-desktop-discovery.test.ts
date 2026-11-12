import { createEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { RemoteDesktopError } from '../../src/remote-desktop/desktop-error.js';
import {
  MacosRemoteDesktopRuntime,
  macosCombinedDesktopLayout
} from '../../src/remote-desktop/macos-remote-desktop-runtime.js';

describe('Node desktop discovery', () => {
  it('refreshes the macOS topology before describing it', async () => {
    const database = new NodeDatabase(':memory:', 'desktop-refresh');
    const connector = new NodeConnector({
      database,
      config: { serverUrl: 'http://127.0.0.1', nodeId: 'node-a', allowedRoots: [] }
    });
    const owners = connector as unknown as {
      desktopRuntime?: MacosRemoteDesktopRuntime;
      operationRouter: { execute(operation: string, data: unknown): Promise<unknown> };
      nodeRequests: { handle(envelope: ReturnType<typeof createEnvelope>): Promise<void> };
      controlChannel: { send(type: string, payload: unknown, replyTo?: string): void };
    };
    const runtime = Object.create(MacosRemoteDesktopRuntime.prototype) as MacosRemoteDesktopRuntime;
    const layout = macosCombinedDesktopLayout(
      [
        {
          id: 1,
          primary: true,
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          pixelWidth: 800,
          pixelHeight: 600
        }
      ],
      'desktop-12345678',
      1
    );
    const refresh = vi.spyOn(runtime, 'refresh').mockResolvedValue();
    vi.spyOn(runtime, 'describe').mockReturnValue(layout);
    vi.spyOn(runtime, 'dispose').mockResolvedValue();
    owners.desktopRuntime = runtime;
    try {
      expect(await owners.operationRouter.execute('desktop.describe', {})).toEqual(layout);
      expect(refresh).toHaveBeenCalledOnce();
      expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(runtime.describe).mock.invocationCallOrder[0]!
      );
      const send = vi.spyOn(owners.controlChannel, 'send');
      const request = createEnvelope('node.request', {});
      const now = Date.now();
      const authorization = {
        userId: 1,
        sessionHash: 'a'.repeat(43),
        nodeId: 'node-a',
        operation: 'desktop.describe',
        requestId: request.id,
        issuedAt: now,
        expiresAt: now + 10_000
      };
      for (const selection of [
        {},
        { displayId: 'display_1' },
        { desktopGeneration: layout.desktopGeneration }
      ]) {
        request.payload = {
          operation: 'desktop.describe',
          data: selection,
          userAuthorization: authorization
        };
        await owners.nodeRequests.handle(request);
        expect(send).toHaveBeenLastCalledWith('node.response', { result: layout }, request.id);
        expect(runtime.describe).toHaveBeenLastCalledWith(selection);
      }
      for (const selection of [
        [],
        null,
        'display_1',
        { displayId: 'display_1', desktopGeneration: layout.desktopGeneration },
        { displayId: '' },
        { unexpected: true }
      ]) {
        request.payload = {
          operation: 'desktop.describe',
          data: selection,
          userAuthorization: authorization
        };
        await owners.nodeRequests.handle(request);
        expect(send).toHaveBeenLastCalledWith(
          'node.response',
          expect.objectContaining({ error: 'DESKTOP_TOPOLOGY_UNAVAILABLE' }),
          request.id
        );
      }
      expect(refresh).toHaveBeenCalledTimes(4);
      const projection = connector as unknown as {
        directTransferService: unknown;
        projectRemoteDesktopCapability(input: object): {
          remoteDesktop: { supportsMultiDisplay: boolean };
        };
      };
      const previous = projection.directTransferService;
      try {
        projection.directTransferService = {};
        expect(
          projection.projectRemoteDesktopCapability({}).remoteDesktop.supportsMultiDisplay
        ).toBe(false);
      } finally {
        projection.directTransferService = previous;
      }
    } finally {
      await connector.stop();
      vi.restoreAllMocks();
    }
  });
  it('requires the request authorization and reports only the current safe native layout', async () => {
    const database = new NodeDatabase(':memory:', 'desktop-discovery');
    const connector = new NodeConnector({
      database,
      config: { serverUrl: 'http://127.0.0.1', nodeId: 'node-a', allowedRoots: [] }
    });
    const owners = connector as unknown as {
      desktopRuntime?: { describe(): unknown; dispose(): Promise<void> };
      nodeRequests: { handle(envelope: ReturnType<typeof createEnvelope>): Promise<void> };
      controlChannel: { send(type: string, payload: unknown, replyTo?: string): void };
    };
    const send = vi.spyOn(owners.controlChannel, 'send');
    const now = Date.now();
    const request = createEnvelope('node.request', {});
    request.payload = {
      operation: 'desktop.describe',
      data: {},
      userAuthorization: {
        userId: 1,
        sessionHash: 'a'.repeat(43),
        nodeId: 'node-a',
        operation: 'desktop.describe',
        requestId: request.id,
        issuedAt: now,
        expiresAt: now + 10_000
      }
    };
    try {
      await owners.nodeRequests.handle(request);
      expect(send).toHaveBeenLastCalledWith(
        'node.response',
        expect.objectContaining({ error: 'DESKTOP_UNAVAILABLE' }),
        request.id
      );
      const layout = {
        desktopGeneration: 'desktop-12345678',
        topologyRevision: 1,
        framebuffer: { width: 800, height: 600 },
        displays: [
          {
            displayId: 'display-12345678',
            name: 'Primary',
            primary: true,
            nativeBounds: { x: 0, y: 0, width: 800, height: 600 },
            framebufferBounds: { x: 0, y: 0, width: 800, height: 600 },
            nativeToFramebuffer: [1, 0, 0, 1, 0, 0]
          }
        ]
      };
      const describe = vi.fn(() => layout);
      owners.desktopRuntime = { describe, dispose: async () => {} };
      await owners.nodeRequests.handle(request);
      expect(send).toHaveBeenLastCalledWith('node.response', { result: layout }, request.id);
      const denied = createEnvelope('node.request', { operation: 'desktop.describe', data: {} });
      await owners.nodeRequests.handle(denied);
      expect(send).toHaveBeenLastCalledWith(
        'node.response',
        expect.objectContaining({ error: 'USER_AUTHORIZATION_REQUIRED' }),
        denied.id
      );
      expect(describe).toHaveBeenCalledOnce();
      describe.mockReturnValue({ ...layout, displays: [] });
      await owners.nodeRequests.handle(request);
      expect(send).toHaveBeenLastCalledWith(
        'node.response',
        expect.objectContaining({ error: 'DESKTOP_TOPOLOGY_UNAVAILABLE' }),
        request.id
      );
      describe.mockImplementation(() => {
        throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      });
      await owners.nodeRequests.handle(request);
      expect(send).toHaveBeenLastCalledWith(
        'node.response',
        expect.objectContaining({ error: 'DESKTOP_TOPOLOGY_UNAVAILABLE' }),
        request.id
      );
    } finally {
      await connector.stop();
    }
  });
});
