import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { unavailableCapabilities } from '../../src/capabilities.js';
import { NodeConnector } from '../../src/connector.js';
import { DirectTransferService } from '../../src/connection/direct-transfer-service.js';

// Generation ownership must not discover or start the host's actual GUI helpers.
vi.mock('../../src/remote-desktop/linux-managed-binaries.js', () => ({
  linuxManagedDesktopBinaries: async () => undefined
}));
vi.mock('../../src/remote-desktop/windows-managed-binaries.js', () => ({
  windowsManagedDesktopBinaries: async () => undefined
}));
vi.mock('../../src/remote-desktop/macos-managed-binaries.js', () => ({
  macosManagedDesktopBinaries: async () => undefined
}));

describe('Node desktop generation ownership', () => {
  it('retires the generation on resource restart and pins the old Direct owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-generation-'));
    const owners: Array<() => string> = [];
    const create = vi.spyOn(DirectTransferService, 'create').mockImplementation(async (options) => {
      owners.push(options.nodeGeneration);
      return { async shutdown() {}, close() {} } as unknown as DirectTransferService;
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: unavailableCapabilities(),
      config: {
        serverUrl: 'http://127.0.0.1:1',
        allowedRoots: [],
        dataDirectory: directory,
        nodeId: 'node-generation-test',
        credential: 'test'
      }
    });
    const internal = connector as unknown as {
      nodeGeneration: string;
      capabilities: ReturnType<typeof unavailableCapabilities>;
      controlChannel: { connect(): void; stop(): void };
      connectionLifecycle: { start(): void };
      terminalManager: { warmup(): Promise<void> };
    };
    vi.spyOn(internal.controlChannel, 'connect').mockImplementation(() => {});
    vi.spyOn(internal.connectionLifecycle, 'start').mockImplementation(() => {});
    vi.spyOn(internal.terminalManager, 'warmup').mockResolvedValue(undefined);
    try {
      await connector.start();
      const first = internal.nodeGeneration;
      expect(internal.capabilities.remoteDesktop).toEqual({
        apiVersion: 1,
        available: false,
        nodeGeneration: first,
        reasonCode: 'DESKTOP_UNAVAILABLE'
      });
      expect(owners[0]?.()).toBe(first);
      internal.controlChannel.stop();
      internal.controlChannel.connect();
      expect(internal.nodeGeneration).toBe(first);
      await connector.stop();
      await connector.start();
      const second = internal.nodeGeneration;
      expect(second).not.toBe(first);
      expect(internal.capabilities.remoteDesktop).toEqual({
        apiVersion: 1,
        available: false,
        nodeGeneration: second,
        reasonCode: 'DESKTOP_UNAVAILABLE'
      });
      expect(owners[0]?.()).toBe(first);
      expect(owners[1]?.()).toBe(second);
    } finally {
      await connector.stop();
      create.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
