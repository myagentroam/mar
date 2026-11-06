import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSessionService } from '../../src/workspace/workspace-session-service.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { unavailableCapabilities } from '../../src/capabilities.js';
import type { SessionCatalogService } from '../../src/session/session-catalog-service.js';

describe('Workspace Session query lifecycle', () => {
  it.each([false, true])(
    'keeps the Node database open until an internal page read settles (failed recovery: %s)',
    async (failedRecovery) => {
      const database = new NodeDatabase(':memory:', 'query-lifecycle');
      const connector = new NodeConnector({ database, capabilities: unavailableCapabilities() });
      const owners = connector as unknown as {
        workspaceSessionService: WorkspaceSessionService;
        sessionCatalogService: SessionCatalogService;
        restartHandoff: { wait(): Promise<void> };
      };
      const failure = new Error('RECOVERY_FAILED');
      if (failedRecovery) vi.spyOn(owners.restartHandoff, 'wait').mockRejectedValue(failure);
      const pending = Promise.withResolvers<unknown>();
      vi.spyOn(owners.sessionCatalogService, 'listWorkspacePage').mockReturnValue(pending.promise);
      const page = owners.workspaceSessionService.listPage('workspace');
      const stopping = connector.stop().catch((error: unknown) => error);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(() => database.listWorkspaces()).not.toThrow();
        pending.resolve({ sessions: [] });
        await expect(page).resolves.toEqual({ sessions: [] });
        expect(await stopping).toBe(failedRecovery ? failure : undefined);
        expect(() => database.listWorkspaces()).toThrow();
      } finally {
        pending.resolve({ sessions: [] });
        await stopping;
      }
    }
  );

  it('joins remaining discovery after a partial first page, even if its cache is retired', async () => {
    const runtime = new NodeRuntimeState(
      () => 'node',
      (id) => ({ id, path: '/workspace', kind: 'DIRECTORY', gitSummary: null })
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace',
      cwd: '/workspace',
      runner: 'codex'
    });
    const pending = Promise.withResolvers<readonly NodeAgentSession[]>();
    const invalidate = vi.fn();
    const service: WorkspaceSessionService = new WorkspaceSessionService({
      discover: async (_id, batch) => {
        batch('codex', [session]);
        return pending.promise;
      },
      listPage: async (id) => ({ sessions: await service.cached(id) }),
      active: () => false,
      invalidate
    });
    await expect(service.listPage('workspace')).resolves.toEqual({ sessions: [session] });
    service.invalidateCache('workspace');
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    pending.resolve([session]);
    await stopping;
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'stops admitting reads and joins an in-flight page that will %s',
    async (outcome) => {
      const pending = Promise.withResolvers<unknown>();
      const listPage = vi.fn(() => pending.promise);
      const service = new WorkspaceSessionService({
        discover: async () => [],
        listPage,
        active: () => false,
        invalidate: vi.fn()
      });
      const page = service.listPage('workspace', 'CHILD');
      const result = page.catch((error: unknown) => error);
      let stopped = false;
      const stopping = service.stop().then(() => {
        stopped = true;
      });
      await expect(service.listPage('workspace')).rejects.toThrow('NODE_STOPPED');
      expect(listPage).toHaveBeenCalledExactlyOnceWith('workspace', 'CHILD');
      await Promise.resolve();
      expect(stopped).toBe(false);
      const value = outcome === 'resolve' ? { sessions: [] } : new Error('READ_FAILED');
      if (outcome === 'resolve') pending.resolve(value);
      else pending.reject(value);
      expect(await result).toBe(value);
      await stopping;
      service.resume();
      listPage.mockResolvedValue({ sessions: [] });
      await expect(service.listPage('workspace')).resolves.toEqual({ sessions: [] });
      await service.stop();
    }
  );

  it('joins a periodic refresh without invalidating or scheduling again after stop', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<unknown>();
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [] })
      .mockReturnValue(pending.promise);
    const invalidate = vi.fn();
    const service = new WorkspaceSessionService({
      discover: async () => [],
      listPage,
      active: () => true,
      invalidate
    });
    try {
      service.ensureWatch('workspace');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(listPage).toHaveBeenCalledTimes(2);
      const stopping = service.stop();
      pending.resolve({ sessions: ['changed'] });
      await stopping;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listPage).toHaveBeenCalledTimes(2);
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      pending.resolve({ sessions: [] });
      await service.stop();
      vi.useRealTimers();
    }
  });
});
