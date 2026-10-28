import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { SessionCatalogService } from '../../src/session/session-catalog-service.js';

function deferred() {
  return Promise.withResolvers<void>();
}

const databases: NodeDatabase[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  vi.useFakeTimers();
  const database = new NodeDatabase(':memory:', 'cleanup-budget');
  databases.push(database);
  const workspace = database.saveWorkspace({
    path: '/workspace',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => database.getWorkspace(id)
  );
  const sessions = ['first', 'second'].map((id) => ({
    ...runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      externalSessionId: id,
      lastActivityAt: 0
    }),
    nativeControl: 'EXTERNAL' as const
  }));
  const removeNative = vi.fn(async () => true);
  const discover = vi.fn(async () => sessions);
  const refresh = vi.fn(async () => {});
  const forget = vi.fn();
  const invalidate = vi.fn();
  const service = new SessionCatalogService({
    database: () => database,
    nodeId: () => 'node',
    runtime,
    runners: { require: () => ({ removeNative }) } as never,
    runnerAvailable: () => true,
    projection: {
      projectionForNative: () => undefined,
      projectionsForNative: () => new Map()
    } as never,
    cachedNative: () => [],
    cachedWorkspace: async () => [],
    discoveryPending: () => false,
    discoverWorkspace: discover,
    present: (session) => session,
    nativeIds: (session) => new Set([session.externalSessionId!]),
    forget,
    refreshActivity: refresh,
    externalActivity: () => undefined,
    isWatching: () => false,
    history: async () => ({ turns: [], nextCursor: null }),
    invalidateHistory: vi.fn(),
    invalidateWorkspaceSessions: invalidate,
    emitSession: vi.fn()
  });
  return {
    service,
    database,
    workspace,
    runtime,
    sessions,
    removeNative,
    discover,
    refresh,
    forget,
    invalidate,
    cleanup: async () =>
      service.operations()['workspace.sessions.cleanup']!({
        workspaceId: workspace.id,
        inactiveDays: 30
      })
  };
}

describe('Workspace session cleanup execution budget', () => {
  it.each(['activity-read', 'earlier-deletion'] as const)(
    'preserves a pin committed after discovery while waiting for %s',
    async (phase) => {
      const f = fixture();
      const ready = deferred();
      if (phase === 'activity-read') f.refresh.mockReturnValueOnce(ready.promise);
      else
        f.removeNative.mockImplementationOnce(async () => {
          await ready.promise;
          return true;
        });
      const result = f.cleanup();
      await vi.advanceTimersByTimeAsync(0);
      const pinned = f.sessions[phase === 'activity-read' ? 0 : 1]!;
      const other = f.sessions[phase === 'activity-read' ? 1 : 0]!;
      f.database.saveNativeSessionMetadata({
        runner: pinned.runner,
        externalSessionId: pinned.externalSessionId!,
        workspaceId: pinned.workspaceId,
        pinned: true
      });
      ready.resolve();
      await expect(result).resolves.toEqual({
        deleted: 1,
        skipped: 1,
        failed: 0,
        deletedByRunner: { 'claude-code': 1 }
      });
      expect(f.removeNative).toHaveBeenCalledTimes(1);
      expect(f.removeNative).toHaveBeenCalledWith(
        expect.objectContaining({ id: other.id }),
        other.externalSessionId
      );
      expect(
        f.database.getNativeSessionMetadata(
          pinned.runner,
          pinned.externalSessionId!,
          pinned.workspaceId
        )
      ).toMatchObject({ pinOrder: 0 });
    }
  );

  it('preserves local records when complete discovery fails rather than clearing from partial results', async () => {
    const f = fixture();
    for (const session of f.sessions)
      f.database.saveNativeSessionMetadata({
        runner: session.runner,
        externalSessionId: session.externalSessionId!,
        workspaceId: f.workspace.id
      });
    const failure = new Error('DISCOVERY_FAILED');
    f.discover.mockRejectedValueOnce(failure);
    await expect(f.cleanup()).rejects.toBe(failure);
    expect(f.database.listSessionRecords(f.workspace.id)).toHaveLength(2);
    expect(f.removeNative).not.toHaveBeenCalled();
    expect(f.forget).not.toHaveBeenCalled();
  });

  it('returns partial zero counts when discovery expires and never deletes late results', async () => {
    const f = fixture();
    const ready = Promise.withResolvers<typeof f.sessions>();
    f.discover.mockReturnValue(ready.promise);
    const result = f.cleanup();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toEqual({
      deleted: 0,
      skipped: 0,
      failed: 0,
      deletedByRunner: {},
      timedOut: true
    });
    ready.resolve(f.sessions);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.removeNative).not.toHaveBeenCalled();
    expect(f.invalidate).toHaveBeenCalledWith(f.workspace.id);
  });

  it('returns settled counts when activity checks expire without counting pending candidates as failures', async () => {
    const f = fixture();
    const ready = deferred();
    f.refresh.mockImplementationOnce(async () => {}).mockImplementationOnce(() => ready.promise);
    const result = f.cleanup();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toEqual({
      deleted: 1,
      skipped: 0,
      failed: 0,
      deletedByRunner: { 'claude-code': 1 },
      timedOut: true,
      remaining: 1
    });
    expect(f.removeNative).toHaveBeenCalledTimes(1);
    f.runtime.beginSessionHistoryMutation(f.sessions[1]!.id)();
    ready.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.removeNative).toHaveBeenCalledTimes(1);
    expect(f.forget).toHaveBeenCalledTimes(1);
  });

  it('settles an admitted native write before returning accurate counts and stops before the next candidate', async () => {
    const f = fixture();
    const ready = deferred();
    f.removeNative.mockImplementationOnce(async () => {
      await ready.promise;
      return true;
    });
    let settled = false;
    const result = f.cleanup().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(false);
    ready.resolve();
    await expect(result).resolves.toEqual({
      deleted: 1,
      skipped: 0,
      failed: 0,
      deletedByRunner: { 'claude-code': 1 },
      timedOut: true,
      remaining: 1
    });
    expect(f.removeNative).toHaveBeenCalledTimes(1);
    expect(f.forget).toHaveBeenCalledTimes(1);
  });

  it('includes mutation queue waiting in the budget and cannot execute an expired queued cleanup later', async () => {
    const f = fixture();
    const ready = deferred();
    f.removeNative.mockImplementationOnce(async () => {
      await ready.promise;
      return true;
    });
    const removal = f.service.operations()['session.remove']!({ sessionId: f.sessions[0]!.id });
    const result = f.cleanup();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toMatchObject({ deleted: 0, timedOut: true });
    expect(f.discover).not.toHaveBeenCalled();
    ready.resolve();
    await removal;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.removeNative).toHaveBeenCalledTimes(1);
  });
});
