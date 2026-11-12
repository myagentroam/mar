import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { unavailableCapabilities } from '../../src/capabilities.js';
import { NodeConnector } from '../../src/connector.js';
import { DirectTransferService } from '../../src/connection/direct-transfer-service.js';
import { nodeDesktopRelayEndpoint } from '../../src/connection/endpoints.js';
import { DirectDesktopService } from '../../src/remote-desktop/direct-desktop-service.js';
import * as binaries from '../../src/remote-desktop/linux-managed-binaries.js';
import { X11RemoteDesktopRuntime } from '../../src/remote-desktop/x11-remote-desktop-runtime.js';

describe('Node Remote Desktop composition', () => {
  it('automatically projects an accessible X11 runtime without a Computer Use dependency', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-desktop-auto-'));
    vi.stubEnv('DISPLAY', ':101');
    vi.stubEnv('XAUTHORITY', join(directory, 'Xauthority'));
    vi.spyOn(binaries, 'linuxManagedDesktopBinaries').mockResolvedValue({
      binaryPath: '/fixture/x0vncserver',
      topologyBinary: '/fixture/x11-topology'
    });
    const dispose = vi.fn(async () => {});
    const runtime = {
      describe: () => ({ desktopGeneration: 'desktop-generation', topologyRevision: 1 }),
      dispose
    } as unknown as X11RemoteDesktopRuntime;
    const start = vi.spyOn(X11RemoteDesktopRuntime, 'start').mockResolvedValue(runtime);
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: unavailableCapabilities(),
      config: {
        serverUrl: 'http://127.0.0.1:1',
        allowedRoots: [],
        dataDirectory: directory,
        nodeId: 'node-auto-test',
        credential: 'test-credential',
        computerUse: { enabled: false }
      }
    });
    const internal = connector as unknown as {
      desktopRuntime?: X11RemoteDesktopRuntime;
      directTransferService: object | undefined;
      projectRemoteDesktopCapability(
        value: ReturnType<typeof unavailableCapabilities>
      ): ReturnType<typeof unavailableCapabilities>;
      initializeDesktopRuntime(): Promise<void>;
    };
    try {
      await internal.initializeDesktopRuntime();
      expect(start).toHaveBeenCalledOnce();
      expect(internal.desktopRuntime).toBe(runtime);
      internal.directTransferService = {};
      expect(
        internal.projectRemoteDesktopCapability(unavailableCapabilities()).remoteDesktop
      ).toMatchObject({
        available: true,
        backend: 'TIGERVNC_X0',
        transports: ['DIRECT']
      });
    } finally {
      internal.directTransferService = undefined;
      await connector.stop();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('forms a same-server relay URL without query, fragment or URL credentials', () => {
    expect(nodeDesktopRelayEndpoint('https://example.test/base/?secret=ignored#ignored')).toBe(
      'wss://example.test/base/api/node/desktop-relay'
    );
    expect(nodeDesktopRelayEndpoint('http://example.test')).toBe(
      'ws://example.test/api/node/desktop-relay'
    );
    expect(() => nodeDesktopRelayEndpoint('https://user:password@example.test')).toThrow(
      'SERVER_URL_INVALID'
    );
    expect(() => nodeDesktopRelayEndpoint('file:///tmp/server')).toThrow('SERVER_URL_INVALID');
  });

  it('installs both path owners with shared slots and rejects prepares without a trusted runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-desktop-composition-'));
    vi.stubEnv('DISPLAY', '');
    let options: Parameters<typeof DirectTransferService.create>[0] | undefined;
    const create = vi.spyOn(DirectTransferService, 'create').mockImplementation(async (input) => {
      options = input;
      const desktop = new DirectDesktopService({
        ...input.desktop!,
        nodeGeneration: input.nodeGeneration,
        peer: () => undefined
      });
      return {
        handleDesktop: (command: unknown) => desktop.handle(command),
        close: () => desktop.invalidate('DESKTOP_TRANSPORT_ERROR'),
        shutdown: (signal: AbortSignal) => desktop.shutdown(signal)
      } as unknown as DirectTransferService;
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: unavailableCapabilities(),
      config: {
        serverUrl: 'http://127.0.0.1:1',
        allowedRoots: [],
        dataDirectory: directory,
        nodeId: 'node-composition-test',
        credential: 'test-credential'
      }
    });
    const internal = connector as unknown as {
      nodeGeneration: string;
      capabilities: ReturnType<typeof unavailableCapabilities>;
      controlChannel: {
        connect(): void;
        connected(): boolean;
        send(type: string, payload: unknown): void;
      };
      connectionLifecycle: { start(): void };
      terminalManager: { warmup(): Promise<void> };
      relayDesktopService: unknown;
      handleMessage(raw: string): void;
    };
    vi.spyOn(internal.controlChannel, 'connect').mockImplementation(() => {});
    vi.spyOn(internal.controlChannel, 'connected').mockReturnValue(true);
    const send = vi.spyOn(internal.controlChannel, 'send').mockImplementation(() => {});
    vi.spyOn(internal.connectionLifecycle, 'start').mockImplementation(() => {});
    vi.spyOn(internal.terminalManager, 'warmup').mockResolvedValue(undefined);
    try {
      await connector.start();
      expect(internal.relayDesktopService).toBeDefined();
      expect(internal.capabilities.remoteDesktop).toMatchObject({
        available: false
      });
      const slots = options?.desktop?.registry;
      expect(slots).toBeDefined();
      const attachmentId = 'shared-attachment-test';
      expect(slots!.reserve(attachmentId)).toBe(true);
      internal.handleMessage(
        JSON.stringify(
          createEnvelope('desktop.relay.cancel', { attachmentId, code: 'DESKTOP_UNAVAILABLE' })
        )
      );
      expect(send).not.toHaveBeenCalledWith('desktop.relay.closed', expect.anything());
      slots!.release(attachmentId);
      internal.handleMessage(
        JSON.stringify(
          createEnvelope('desktop.relay.cancel', { attachmentId, code: 'DESKTOP_UNAVAILABLE' })
        )
      );
      expect(send).toHaveBeenCalledWith(
        'desktop.relay.closed',
        expect.objectContaining({ attachmentId, nodeGeneration: internal.nodeGeneration }),
        undefined
      );

      send.mockClear();
      const now = Date.now();
      internal.handleMessage(
        JSON.stringify(
          createEnvelope('desktop.relay.prepare', {
            attachmentId: 'unavailable-attachment',
            workbenchConnectionId: 'page-12345678',
            nodeGeneration: internal.nodeGeneration,
            desktopGeneration: 'desktop-12345678',
            topologyRevision: 1,
            mode: 'VIEW',
            grant: 'g'.repeat(32),
            ticket: 't'.repeat(32),
            openExpiresAt: now + 10000,
            expiresAt: now + 30000
          })
        )
      );
      expect(send).toHaveBeenCalledWith(
        'desktop.relay.closed',
        expect.objectContaining({
          attachmentId: 'unavailable-attachment',
          code: 'DESKTOP_CONTROL_UNAVAILABLE'
        }),
        undefined
      );
      expect(send).not.toHaveBeenCalledWith('desktop.relay.ready', expect.anything());
    } finally {
      await connector.stop();
      create.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
