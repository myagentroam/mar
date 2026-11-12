import { describe, expect, it, vi } from 'vitest';
import { unavailableCapabilities } from '../../src/capabilities.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';

describe('Node desktop shutdown', () => {
  it.each([false, true])(
    'joins Remote cleanup before closing the control channel (cleanup failure: %s)',
    async (failed) => {
      const database = new NodeDatabase(':memory:', 'desktop-shutdown');
      const connector = new NodeConnector({ database, capabilities: unavailableCapabilities() });
      const owners = connector as unknown as {
        directTransferService: { shutdown(signal: AbortSignal): Promise<void> };
        controlChannel: { stop(): void };
      };
      const cleanup = Promise.withResolvers<void>();
      const shutdown = vi.fn((_signal: AbortSignal) => cleanup.promise);
      owners.directTransferService = { shutdown };
      const stopControl = vi.spyOn(owners.controlChannel, 'stop');
      const stopping = connector.stop().catch((error: unknown) => error);
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
      expect(shutdown.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
      expect(stopControl).not.toHaveBeenCalled();
      const error = new Error('NATIVE_CLEANUP_FAILED');
      if (failed) cleanup.reject(error);
      else cleanup.resolve();
      expect(await stopping).toBe(failed ? error : undefined);
      expect(stopControl).toHaveBeenCalledOnce();
      expect(() => database.listWorkspaces()).toThrow();
    }
  );

  it('joins both path owners even if one cleanup fails before the other finishes', async () => {
    const database = new NodeDatabase(':memory:', 'desktop-shutdown-both');
    const connector = new NodeConnector({ database, capabilities: unavailableCapabilities() });
    const owners = connector as unknown as {
      directTransferService: { shutdown(signal: AbortSignal): Promise<void> };
      relayDesktopService: { shutdown(signal: AbortSignal): Promise<void> };
      desktopRuntime: { dispose(): Promise<void> };
      controlChannel: { stop(): void };
    };
    const direct = Promise.withResolvers<void>();
    const relay = Promise.withResolvers<void>();
    const directShutdown = vi.fn(() => direct.promise);
    owners.directTransferService = { shutdown: directShutdown };
    owners.relayDesktopService = { shutdown: () => relay.promise };
    const disposeRuntime = vi.fn(async () => {});
    owners.desktopRuntime = { dispose: disposeRuntime };
    const stopControl = vi.spyOn(owners.controlChannel, 'stop');
    const failure = new Error('DIRECT_CLEANUP_FAILED');
    const stopping = connector.stop().catch((error: unknown) => error);
    await vi.waitFor(() => expect(directShutdown).toHaveBeenCalledOnce());
    direct.reject(failure);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopControl).not.toHaveBeenCalled();
    expect(disposeRuntime).not.toHaveBeenCalled();
    relay.resolve();
    expect(await stopping).toBe(failure);
    expect(disposeRuntime).toHaveBeenCalledOnce();
    expect(stopControl).toHaveBeenCalledOnce();
  });
});
