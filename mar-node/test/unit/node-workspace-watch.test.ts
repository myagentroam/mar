import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';
import { WorkspaceChangeService } from '../../src/workspace/workspace-change-service.js';
import {
  WorkspaceSessionService,
  type WorkspaceSessionServiceOptions
} from '../../src/workspace/workspace-session-service.js';
import { WorkspaceWatchService } from '../../src/workspace/workspace-watch-service.js';
import { WorkspaceWatchSnapshotService } from '../../src/workspace/workspace-watch-snapshot-service.js';

function sessionState(service: WorkspaceSessionService) {
  return service as unknown as {
    sessionWatchSignatures: Map<string, string>;
    sessionCache: Map<string, { sessions: readonly NodeAgentSession[]; expiresAt: number }>;
    sessionCacheReads: Map<string, Promise<readonly NodeAgentSession[]>>;
  };
}

describe('Node Workspace watch', () => {
  it('publishes thirty sessions in the initial snapshot with a cursor for remaining sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-session-page-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-session-page');
    const connector = new NodeConnector({ reconnect: false, database });
    try {
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const sessions = Array.from({ length: 32 }, (_, index) => ({
        ...session(`session-${index}`, 'codex'),
        workspaceId: workspace.id,
        cwd: root,
        lastActivityAt: 100 - index
      }));
      const internals = connector as unknown as {
        discoverWorkspaceSessions: WorkspaceSessionServiceOptions['discover'];
        send(type: string, payload: unknown): void;
      };
      vi.spyOn(internals, 'discoverWorkspaceSessions').mockResolvedValue(sessions);
      const send = vi.spyOn(internals, 'send');
      await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'session-page-watch',
        mode: 'initial',
        topics: { sessions: true }
      });
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            topic: 'sessions',
            payload: expect.objectContaining({
              sessions: sessions
                .slice(0, 30)
                .map((entry) => expect.objectContaining({ id: entry.id })),
              nextCursor: expect.any(String)
            })
          })
        )
      );
    } finally {
      connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps MAIN and CHILD initial snapshots isolated within the same Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-session-groups-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-session-groups');
    const connector = new NodeConnector({ reconnect: false, database });
    try {
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const main = {
        ...session('main-session', 'codex'),
        workspaceId: workspace.id,
        cwd: root,
        parentSessionId: null
      };
      const child = {
        ...session('child-session', 'codex'),
        workspaceId: workspace.id,
        cwd: root,
        parentSessionId: 'missing-parent'
      };
      const internals = connector as unknown as {
        discoverWorkspaceSessions: WorkspaceSessionServiceOptions['discover'];
        send(type: string, payload: unknown): void;
      };
      vi.spyOn(internals, 'discoverWorkspaceSessions').mockResolvedValue([main, child]);
      const send = vi.spyOn(internals, 'send');

      await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'main-session-watch',
        mode: 'initial',
        topics: { sessions: true, sessionGroup: 'MAIN' }
      });
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            topic: 'sessions',
            payload: expect.objectContaining({
              sessions: [expect.objectContaining({ id: 'main-session' })],
              nextCursor: null
            })
          })
        )
      );

      await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'child-session-watch',
        mode: 'initial',
        topics: { sessions: true, sessionGroup: 'CHILD' }
      });
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            topic: 'sessions',
            payload: expect.objectContaining({
              sessions: [expect.objectContaining({ id: 'child-session' })],
              nextCursor: null
            })
          })
        )
      );
    } finally {
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('makes a removed lease inactive before cancelling its queued preparation', () => {
    const observed: boolean[] = [];
    const service = new WorkspaceWatchService(vi.fn(), vi.fn(), vi.fn(), (watch) => {
      observed.push(
        service.matches(
          watch.workspaceId,
          `${watch.sessionHash}:${watch.workbenchConnectionId}`,
          watch.watchId
        )
      );
    });
    const watch = service.create(
      'workspace-1',
      'watch-12345678',
      'session-hash',
      'connection-1',
      'generation-1',
      {
        sessions: false,
        changes: true,
        files: undefined
      },
      true
    );
    expect(service.observes('workspace-1', 'session-hash', 'connection-1')).toBe(true);
    expect(service.observes('workspace-1', 'other-owner', 'connection-1')).toBe(false);
    expect(service.observes('workspace-2', 'session-hash', 'connection-1')).toBe(false);
    service.remove(watch.workspaceId, `${watch.sessionHash}:${watch.workbenchConnectionId}`);
    expect(service.observes('workspace-1', 'session-hash', 'connection-1')).toBe(false);
    service.create(
      'workspace-1',
      'watch-12345679',
      'session-hash',
      'connection-1',
      'generation-1',
      {
        sessions: false,
        changes: true,
        files: undefined
      },
      true
    );
    service.clear('workspace-1');
    service.create(
      'workspace-1',
      'watch-12345670',
      'session-hash',
      'connection-1',
      'generation-1',
      {
        sessions: false,
        changes: true,
        files: undefined
      },
      true
    );
    service.clearAll();
    expect(observed).toEqual([false, false, false]);
  });

  it('cleans up Workspace Watch resources from the unified release path when the last lease expires', async () => {
    vi.useFakeTimers();
    const stopSessions = vi.fn();
    const releaseWorkspace = vi.fn();
    const service = new WorkspaceWatchService(vi.fn(), stopSessions, releaseWorkspace);
    service.create(
      'workspace-1',
      'watch-12345678',
      'session-hash',
      'connection-1',
      'generation-1',
      { sessions: true, changes: false, files: undefined }
    );
    service.nextRevision('workspace-1:sessions');

    await vi.advanceTimersByTimeAsync(45_000);

    expect(service.activeWatches('workspace-1')).toEqual([]);
    expect(
      (service as unknown as { watchRevisions: Map<string, number> }).watchRevisions.size
    ).toBe(0);
    expect(stopSessions).toHaveBeenCalledWith('workspace-1');
    expect(releaseWorkspace).toHaveBeenCalledWith('workspace-1');
    vi.useRealTimers();
  });

  it('the Files initial snapshot skips quick-open indexing and starts low-frequency refresh', async () => {
    vi.useFakeTimers();
    let finishList!: () => void;
    const index = vi.fn();
    const list = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (finishList = () => resolve([]))))
      .mockResolvedValue([]);
    const watch = {
      workspaceId: 'workspace-1',
      watchId: 'watch-1',
      sessionHash: 'session-hash',
      workbenchConnectionId: 'connection-1',
      nodeGeneration: 'generation-1',
      expiresAt: Date.now() + 45_000,
      topics: { sessions: false, changes: false, files: { path: '.' } },
      timer: undefined
    };
    const service = new WorkspaceWatchSnapshotService({
      requireWorkspace: () => ({ id: 'workspace-1', kind: 'DIRECTORY' }) as never,
      watch: {
        activeWatches: () => [watch],
        activeWorkspaceIds: () => ['workspace-1'],
        matches: () => true,
        nextRevision: vi.fn().mockReturnValue(1),
        nextSnapshotSequence: vi.fn().mockReturnValue(1)
      } as never,
      files: {
        index,
        list
      } as never,
      changes: {} as never,
      listSessions: vi.fn(),
      nodeId: () => 'node-1',
      emitWatchEvent: vi.fn(),
      filesRefreshIntervalMs: 30_000
    });

    const initial = service.initial(
      { id: 'workspace-1', kind: 'DIRECTORY' } as never,
      watch as never
    );
    expect(index).not.toHaveBeenCalled();
    finishList();
    await initial;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledTimes(2);
    service.clearAll();
    vi.useRealTimers();
  });

  it('prewarms only a lease that explicitly requested it, and cancels before it starts', async () => {
    vi.useFakeTimers();
    try {
      const prepare = vi.fn(async (_workspace: unknown, needed: () => boolean) => {
        expect(needed()).toBe(true);
      });
      let active = true;
      const workspace = { id: 'workspace-1', kind: 'DIRECTORY' } as never;
      const watch = {
        workspaceId: 'workspace-1',
        watchId: 'watch-12345678',
        sessionHash: 'session-hash',
        workbenchConnectionId: 'connection-1',
        nodeGeneration: 'generation-1',
        expiresAt: Date.now() + 45_000,
        prepareFiles: true,
        topics: { sessions: true, changes: false },
        timer: undefined
      };
      const service = new WorkspaceWatchSnapshotService({
        requireWorkspace: () => workspace,
        watch: { matches: () => active, activeWatches: () => (active ? [watch] : []) } as never,
        files: { prepare } as never,
        changes: {} as never,
        listSessions: async () => ({ sessions: [] }),
        nodeId: () => 'node-1',
        emitWatchEvent: vi.fn()
      });
      service.prewarmFiles(workspace, watch as never);
      active = false;
      service.cancelFilePrewarm(watch as never);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(prepare).not.toHaveBeenCalled();
      active = true;
      service.prewarmFiles(workspace, watch as never);
      await vi.advanceTimersByTimeAsync(749);
      expect(prepare).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(prepare).toHaveBeenCalledTimes(1);
      active = false;
      service.clearAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['session', 'connection'] as const)(
    'isolates preparation timers for reused watch IDs across %s boundaries',
    async (boundary) => {
      vi.useFakeTimers();
      const workspace = { id: 'workspace-1', kind: 'DIRECTORY' } as never;
      const first = {
        workspaceId: 'workspace-1',
        watchId: 'watch-12345678',
        sessionHash: 'session-1',
        workbenchConnectionId: 'connection-1',
        prepareFiles: true
      };
      const second = {
        ...first,
        ...(boundary === 'session'
          ? { sessionHash: 'session-2' }
          : { workbenchConnectionId: 'connection-2' })
      };
      const prepare = vi.fn(async () => undefined);
      const service = new WorkspaceWatchSnapshotService({
        requireWorkspace: () => workspace,
        watch: { matches: () => true } as never,
        files: { prepare } as never,
        changes: {} as never,
        listSessions: async () => ({ sessions: [] }),
        nodeId: () => 'node-1',
        emitWatchEvent: vi.fn()
      });
      try {
        service.prewarmFiles(workspace, first as never);
        service.prewarmFiles(workspace, second as never);
        service.cancelFilePrewarm(first as never);
        await vi.advanceTimersByTimeAsync(750);
        expect(prepare).toHaveBeenCalledTimes(1);
        service.prewarmFiles(workspace, first as never);
        service.prewarmFiles(workspace, second as never);
        service.clear('workspace-1');
        await vi.advanceTimersByTimeAsync(750);
        expect(prepare).toHaveBeenCalledTimes(1);
      } finally {
        service.clearAll();
        vi.useRealTimers();
      }
    }
  );

  it('late initial reads after lease release do not restore the signature or send a snapshot', async () => {
    let finish!: (value: unknown) => void;
    let active = true;
    const emitted = vi.fn();
    const listSessions = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue({ sessions: [] });
    const watch = {
      workspaceId: 'workspace-1',
      watchId: 'watch-1',
      sessionHash: 'session-hash',
      workbenchConnectionId: 'connection-1',
      nodeGeneration: 'generation-1',
      expiresAt: Date.now() + 45_000,
      topics: { sessions: true, changes: false },
      timer: undefined
    };
    const service = new WorkspaceWatchSnapshotService({
      requireWorkspace: () => ({ id: 'workspace-1', kind: 'DIRECTORY' }) as never,
      watch: {
        activeWatches: () => (active ? [watch] : []),
        matches: () => active,
        nextRevision: vi.fn().mockReturnValue(1),
        nextSnapshotSequence: vi.fn().mockReturnValue(1)
      } as never,
      files: {} as never,
      changes: {} as never,
      listSessions,
      nodeId: () => 'node-1',
      emitWatchEvent: emitted
    });

    const initial = service.initial(
      { id: 'workspace-1', kind: 'DIRECTORY' } as never,
      watch as never
    );
    active = false;
    service.clear('workspace-1');
    finish({ sessions: [] });
    await initial;

    expect(emitted).not.toHaveBeenCalled();
    active = true;
    await service.invalidate('workspace-1', 'sessions');
    expect(emitted).toHaveBeenCalledOnce();
  });

  it.each(['success', 'failure'] as const)(
    'does not reuse or publish a late Changes %s read after parent Git is disabled and re-enabled',
    async (staleOutcome) => {
      const database = new NodeDatabase(':memory:', `node-watch-policy-race-${staleOutcome}`);
      const workspace = database.saveWorkspace({
        path: '/workspace',
        kind: 'GIT_WORKSPACE',
        gitSummary: { repositoryRoot: '/repository' },
        includeParentRepository: true
      });
      const changes = new WorkspaceChangeService();
      const oldRead = deferred<unknown>();
      const currentRead = deferred<unknown>();
      const oldReadStarted = deferred<void>();
      const currentReadStarted = deferred<void>();
      const emitted: unknown[] = [];
      const current = vi.spyOn(changes, 'current').mockImplementation(() => {
        if (current.mock.calls.length === 1) {
          oldReadStarted.resolve(undefined);
          return oldRead.promise;
        }
        if (current.mock.calls.length >= 2) {
          currentReadStarted.resolve(undefined);
          return currentRead.promise;
        }
        throw new Error('UNEXPECTED_CHANGES_READ');
      });
      const watches = new WorkspaceWatchService(vi.fn(), vi.fn(), vi.fn());
      const watch = watches.create(
        workspace.id,
        'watch-parent-git',
        'session-hash',
        'connection-1',
        'generation-1',
        { sessions: false, changes: true, files: undefined }
      );
      const snapshots = new WorkspaceWatchSnapshotService({
        requireWorkspace: (workspaceId) => database.getWorkspace(String(workspaceId))!,
        watch: watches,
        files: {} as never,
        changes,
        listSessions: vi.fn(),
        nodeId: () => 'node-1',
        emitWatchEvent: (event) => emitted.push(event)
      });
      let oldInitial: Promise<void> | undefined;
      let currentInitial: Promise<void> | undefined;

      try {
        oldInitial = snapshots.initial(workspace, watch);
        await oldReadStarted.promise;

        database.setWorkspaceGitPolicy(workspace.id, true, false);
        changes.invalidate(workspace.id);
        database.setWorkspaceGitPolicy(workspace.id, true, true);
        changes.invalidate(workspace.id);

        currentInitial = snapshots.initial(database.getWorkspace(workspace.id)!, watch);
        expect(current).toHaveBeenCalledTimes(2);
        await currentReadStarted.promise;

        if (staleOutcome === 'success') oldRead.resolve({ marker: 'stale-parent-read' });
        else oldRead.reject(new Error('STALE_CHANGES_READ_FAILED'));
        await oldInitial;

        const refresh = snapshots.ensureSnapshot(workspace.id, 'changes');
        currentRead.resolve({ marker: 'current-parent-read' });
        await Promise.all([currentInitial, refresh]);

        expect(emitted).toEqual([
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            watchId: watch.watchId,
            topic: 'changes',
            payload: { marker: 'current-parent-read' }
          })
        ]);
      } finally {
        watches.clearAll();
        snapshots.clearAll();
        oldRead.resolve({ marker: 'cleanup' });
        currentRead.resolve({ marker: 'cleanup' });
        await Promise.allSettled([oldInitial, currentInitial]);
        await snapshots.ensureSnapshot(workspace.id, 'changes');
        database.close();
      }
    }
  );

  it('coalesces in-flight reads for one topic and merges repeated invalidations into one trailing refresh', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    const completions: Array<() => void> = [];
    const listSessions = vi.fn(async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise<void>((resolve) => completions.push(resolve));
      activeReads -= 1;
      return { sessions: [] };
    });
    const watch = {
      workspaceId: 'workspace-1',
      watchId: 'watch-1',
      sessionHash: 'session-hash',
      workbenchConnectionId: 'connection-1',
      nodeGeneration: 'generation-1',
      expiresAt: Date.now() + 45_000,
      topics: { sessions: true, changes: false },
      timer: undefined
    };
    const service = new WorkspaceWatchSnapshotService({
      requireWorkspace: () => ({ id: 'workspace-1', kind: 'DIRECTORY' }) as never,
      watch: {
        activeWatches: () => [watch],
        matches: () => true,
        nextRevision: vi.fn().mockReturnValue(1),
        nextSnapshotSequence: vi.fn().mockReturnValue(1)
      } as never,
      files: {} as never,
      changes: {} as never,
      listSessions,
      nodeId: () => 'node-1',
      emitWatchEvent: vi.fn()
    });

    const first = service.invalidate('workspace-1', 'sessions');
    const second = service.invalidate('workspace-1', 'sessions');
    const third = service.invalidate('workspace-1', 'sessions');
    expect(listSessions).toHaveBeenCalledOnce();
    completions.shift()?.();
    await Promise.all([first, second, third]);
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    completions.shift()?.();
    await vi.waitFor(() => expect(activeReads).toBe(0));

    expect(maxActiveReads).toBe(1);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('does not rebroadcast a change snapshot when topic content is unchanged', async () => {
    const emitted: unknown[] = [];
    const watch = {
      workspaceId: 'workspace-1',
      watchId: 'watch-1',
      sessionHash: 'session-hash',
      workbenchConnectionId: 'connection-1',
      nodeGeneration: 'generation-1',
      expiresAt: Date.now() + 45_000,
      topics: { sessions: true, changes: false },
      timer: undefined
    };
    const service = new WorkspaceWatchSnapshotService({
      requireWorkspace: () => ({ id: 'workspace-1', kind: 'DIRECTORY' }) as never,
      watch: {
        activeWatches: () => [watch],
        matches: () => true,
        nextRevision: vi.fn().mockReturnValue(1),
        nextSnapshotSequence: vi.fn().mockReturnValue(1)
      } as never,
      files: {} as never,
      changes: {} as never,
      listSessions: vi.fn().mockResolvedValue({ sessions: [{ id: 'session-1' }] }),
      nodeId: () => 'node-1',
      emitWatchEvent: (event) => emitted.push(event)
    });

    await service.initial({ id: 'workspace-1', kind: 'DIRECTORY' } as never, watch as never);
    await service.invalidate('workspace-1', 'sessions');

    expect(emitted).toHaveLength(1);
  });

  it('reuses the in-flight read to confirm the current topic snapshot without marking it dirty again', async () => {
    let finish!: () => void;
    const listSessions = vi.fn(
      () => new Promise<unknown>((resolve) => (finish = () => resolve({ sessions: [] })))
    );
    const watch = {
      workspaceId: 'workspace-1',
      watchId: 'watch-1',
      sessionHash: 'session-hash',
      workbenchConnectionId: 'connection-1',
      nodeGeneration: 'generation-1',
      expiresAt: Date.now() + 45_000,
      topics: { sessions: true, changes: false },
      timer: undefined
    };
    const service = new WorkspaceWatchSnapshotService({
      requireWorkspace: () => ({ id: 'workspace-1', kind: 'DIRECTORY' }) as never,
      watch: {
        activeWatches: () => [watch],
        matches: () => true,
        nextRevision: vi.fn().mockReturnValue(1),
        nextSnapshotSequence: vi.fn().mockReturnValue(1)
      } as never,
      files: {} as never,
      changes: {} as never,
      listSessions,
      nodeId: () => 'node-1',
      emitWatchEvent: vi.fn()
    });

    const refresh = service.invalidate('workspace-1', 'sessions');
    const settled = service.ensureSnapshot('workspace-1', 'sessions');
    finish();
    await Promise.all([refresh, settled]);
    await Promise.resolve();

    expect(listSessions).toHaveBeenCalledOnce();
  });

  it('Files projects failures independently for different views without contaminating successful views', async () => {
    const watches = [
      {
        workspaceId: 'workspace-1',
        watchId: 'watch-ok',
        sessionHash: 'session-ok',
        workbenchConnectionId: 'connection-ok',
        nodeGeneration: 'generation-1',
        expiresAt: Date.now() + 45_000,
        topics: { sessions: false, changes: false, files: { path: 'ok' } },
        timer: undefined
      },
      {
        workspaceId: 'workspace-1',
        watchId: 'watch-failed',
        sessionHash: 'session-failed',
        workbenchConnectionId: 'connection-failed',
        nodeGeneration: 'generation-1',
        expiresAt: Date.now() + 45_000,
        topics: { sessions: false, changes: false, files: { path: 'failed' } },
        timer: undefined
      }
    ];
    const emitted: Array<Record<string, unknown>> = [];
    const service = new WorkspaceWatchSnapshotService({
      requireWorkspace: () => ({ id: 'workspace-1', kind: 'DIRECTORY' }) as never,
      watch: {
        activeWatches: () => watches,
        matches: () => true,
        nextRevision: vi.fn().mockReturnValue(1),
        nextSnapshotSequence: vi.fn().mockReturnValue(1)
      } as never,
      files: {
        list: vi.fn(async (_workspace, view: { path: string }) => {
          if (view.path === 'failed') throw new Error('read failed');
          return [{ path: 'ok/file.txt' }];
        })
      } as never,
      changes: {} as never,
      listSessions: vi.fn(),
      nodeId: () => 'node-1',
      emitWatchEvent: (event) => emitted.push(event as Record<string, unknown>)
    });

    await service.invalidate('workspace-1', 'files');

    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'watch.workspace.snapshot',
          watchId: 'watch-ok',
          topic: 'files'
        }),
        expect.objectContaining({
          type: 'watch.failed',
          watchId: 'watch-failed',
          topic: 'files'
        })
      ])
    );
    expect(emitted).not.toContainEqual(
      expect.objectContaining({ type: 'watch.failed', watchId: 'watch-ok' })
    );
  });

  it('Workspace session observation schedules the next cycle after the previous read completes without overlapping reads', async () => {
    vi.useFakeTimers();
    const watch = new WorkspaceWatchService(vi.fn(), vi.fn(), vi.fn());
    let finish!: () => void;
    const listPage = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<unknown>((resolve) => (finish = () => resolve({ sessions: [{ id: 'old' }] })))
      )
      .mockResolvedValue({ sessions: [] });
    const invalidate = vi.fn();
    const service = new WorkspaceSessionService({
      discover: vi.fn().mockResolvedValue([]),
      listPage,
      active: () => true,
      invalidate
    });

    service.ensureWatch('workspace-1');
    expect(listPage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listPage).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(listPage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(listPage).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
    expect(
      (watch as unknown as { watchRevisions: Map<string, number> }).watchRevisions.has(
        'workspace-1'
      )
    ).toBe(false);

    service.clear();
    vi.useRealTimers();
  });

  it('immediate resubscription after cancellation reuses an unfinished session-observation read', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const listPage = vi
      .fn()
      .mockReturnValue(
        new Promise<unknown>((resolve) => (finish = () => resolve({ sessions: [] })))
      );
    const service = new WorkspaceSessionService({
      discover: vi.fn().mockResolvedValue([]),
      listPage,
      active: () => true,
      invalidate: vi.fn()
    });

    service.ensureWatch('workspace-1');
    service.stopWatch('workspace-1');
    service.ensureWatch('workspace-1');

    expect(listPage).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    service.clear();
    vi.useRealTimers();
  });

  it('late session-observation reads after the last subscription release do not restore the signature', async () => {
    let active = true;
    let finish!: () => void;
    const service = new WorkspaceSessionService({
      discover: vi.fn().mockResolvedValue([]),
      listPage: vi
        .fn()
        .mockReturnValue(
          new Promise<unknown>((resolve) => (finish = () => resolve({ sessions: [] })))
        ),
      active: () => active,
      invalidate: vi.fn()
    });

    service.ensureWatch('workspace-1');
    active = false;
    service.stopWatch('workspace-1');
    finish();
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionState(service).sessionWatchSignatures.has('workspace-1')).toBe(false);
    service.clear();
  });

  it('refreshes completed Runners independently while preserving pending Runner cache entries', async () => {
    const older = [session('old-mar', 'mar-agent'), session('old-codex', 'codex')];
    let batch!: Parameters<WorkspaceSessionServiceOptions['discover']>[1];
    let finish!: (sessions: readonly NodeAgentSession[]) => void;
    const invalidate = vi.fn();
    const service = new WorkspaceSessionService({
      discover: (_workspaceId, onRunnerDiscovered) => {
        batch = onRunnerDiscovered;
        return new Promise((resolve) => (finish = resolve));
      },
      listPage: vi.fn(),
      active: () => true,
      invalidate
    });
    sessionState(service).sessionCache.set('workspace-1', { sessions: older, expiresAt: 0 });
    try {
      await expect(service.cached('workspace-1')).resolves.toEqual(older);
      expect(service.discoveryPending('workspace-1')).toBe(false);
      const updated = session('new-mar', 'mar-agent');
      batch('mar-agent', [updated]);
      await expect(service.cached('workspace-1')).resolves.toEqual([older[1], updated]);
      expect(invalidate).toHaveBeenCalledOnce();
      service.invalidateCache('workspace-1');
      batch('codex', [session('late-codex', 'codex')]);
      finish([updated]);
      await Promise.resolve();
      await Promise.resolve();
      expect(sessionState(service).sessionCache.has('workspace-1')).toBe(false);
      expect(invalidate).toHaveBeenCalledOnce();
    } finally {
      finish([]);
      service.clear();
    }
  });

  it.each(['warm', 'cold'] as const)(
    'coalesces events during a %s discovery and keeps its result stale for a follow-up refresh',
    async (mode) => {
      const known = [session('known-mar', 'mar-agent')];
      let batch!: Parameters<WorkspaceSessionServiceOptions['discover']>[1];
      let finish!: (sessions: readonly NodeAgentSession[]) => void;
      const discover = vi
        .fn<WorkspaceSessionServiceOptions['discover']>()
        .mockImplementationOnce((_workspaceId, onRunnerDiscovered) => {
          batch = onRunnerDiscovered;
          return new Promise((resolve) => (finish = resolve));
        })
        .mockResolvedValue(known);
      const invalidate = vi.fn();
      const service = new WorkspaceSessionService({
        discover,
        listPage: vi.fn(),
        active: () => true,
        invalidate
      });
      if (mode === 'warm')
        sessionState(service).sessionCache.set('workspace-1', { sessions: known, expiresAt: 0 });
      try {
        const initial = service.cached('workspace-1');
        const read = sessionState(service).sessionCacheReads.get('workspace-1');
        service.markCacheStale('workspace-1');
        service.markCacheStale('workspace-1');
        batch('mar-agent', known);
        await expect(initial).resolves.toEqual(known);
        await expect(service.cached('workspace-1')).resolves.toEqual(known);
        expect(sessionState(service).sessionCacheReads.get('workspace-1')).toBe(read);
        expect(discover).toHaveBeenCalledOnce();
        expect(sessionState(service).sessionCache.get('workspace-1')?.expiresAt).toBe(0);
        finish(known);
        await read;
        expect(sessionState(service).sessionCache.get('workspace-1')?.expiresAt).toBe(0);
        expect(invalidate).toHaveBeenCalledOnce();

        await expect(service.cached('workspace-1')).resolves.toEqual(known);
        await sessionState(service).sessionCacheReads.get('workspace-1');
        expect(discover).toHaveBeenCalledTimes(2);
        expect(sessionState(service).sessionCache.get('workspace-1')?.expiresAt).toBeGreaterThan(
          Date.now()
        );
        await service.cached('workspace-1');
        expect(discover).toHaveBeenCalledTimes(2);
      } finally {
        finish?.([]);
        service.clear();
      }
    }
  );

  it('an in-flight display event refreshes again even when discovery publishes no batches or changes', async () => {
    const known = [session('known-codex', 'codex')];
    let finish!: (sessions: readonly NodeAgentSession[]) => void;
    const invalidate = vi.fn();
    const service = new WorkspaceSessionService({
      discover: () => new Promise((resolve) => (finish = resolve)),
      listPage: vi.fn(),
      active: () => true,
      invalidate
    });
    sessionState(service).sessionCache.set('workspace-1', { sessions: known, expiresAt: 0 });
    try {
      await service.cached('workspace-1');
      service.markCacheStale('workspace-1');
      finish(known);
      await sessionState(service).sessionCacheReads.get('workspace-1');
      expect(sessionState(service).sessionCache.get('workspace-1')).toEqual({
        sessions: known,
        expiresAt: 0
      });
      expect(invalidate).toHaveBeenCalledOnce();
    } finally {
      finish?.([]);
      service.clear();
    }
  });

  it.each(['invalidateCache', 'clear'] as const)(
    '%s rejects stale discovery writes without consuming a replacement refresh request',
    async (action) => {
      const known = [session('known-codex', 'codex')];
      const batches: Parameters<WorkspaceSessionServiceOptions['discover']>[1][] = [];
      const finishes: ((sessions: readonly NodeAgentSession[]) => void)[] = [];
      const pending: WorkspaceSessionServiceOptions['discover'] = (_workspaceId, batch) => {
        batches.push(batch);
        return new Promise((resolve) => finishes.push(resolve));
      };
      const discover = vi
        .fn<WorkspaceSessionServiceOptions['discover']>()
        .mockImplementationOnce(pending)
        .mockImplementationOnce(pending)
        .mockResolvedValue(known);
      const invalidate = vi.fn();
      const service = new WorkspaceSessionService({
        discover,
        listPage: vi.fn(),
        active: () => true,
        invalidate
      });
      sessionState(service).sessionCache.set('workspace-1', { sessions: known, expiresAt: 0 });
      try {
        await service.cached('workspace-1');
        const previous = sessionState(service).sessionCacheReads.get('workspace-1');
        service.markCacheStale('workspace-1');
        if (action === 'clear') service.clear();
        else service.invalidateCache('workspace-1');
        const replacement = service.cached('workspace-1');
        const current = sessionState(service).sessionCacheReads.get('workspace-1');
        service.markCacheStale('workspace-1');
        batches[0]!('codex', [session('late-codex', 'codex')]);
        finishes[0]!(known);
        await previous;
        expect(sessionState(service).sessionCache.has('workspace-1')).toBe(false);
        expect(sessionState(service).sessionCacheReads.get('workspace-1')).toBe(current);
        expect(invalidate).not.toHaveBeenCalled();

        batches[1]!('codex', known);
        await expect(replacement).resolves.toEqual(known);
        finishes[1]!(known);
        await current;
        expect(sessionState(service).sessionCache.get('workspace-1')?.expiresAt).toBe(0);
        expect(invalidate).toHaveBeenCalledOnce();
        await service.cached('workspace-1');
        await sessionState(service).sessionCacheReads.get('workspace-1');
        expect(discover).toHaveBeenCalledTimes(3);
        expect(sessionState(service).sessionCache.get('workspace-1')?.expiresAt).toBeGreaterThan(
          Date.now()
        );
      } finally {
        for (const finish of finishes) finish([]);
        service.clear();
      }
    }
  );

  it('rejects an initial discovery failure and retries; a later failure preserves the confirmed batch and rejects late writes', async () => {
    let batch!: Parameters<WorkspaceSessionServiceOptions['discover']>[1];
    let fail!: (error: Error) => void;
    const confirmed = session('confirmed-mar', 'mar-agent');
    const discover = vi
      .fn<WorkspaceSessionServiceOptions['discover']>()
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockImplementationOnce((_workspaceId, onRunnerDiscovered) => {
        batch = onRunnerDiscovered;
        return new Promise((_resolve, reject) => (fail = reject));
      })
      .mockResolvedValue([confirmed]);
    const service = new WorkspaceSessionService({
      discover,
      listPage: vi.fn(),
      active: () => true,
      invalidate: vi.fn()
    });
    try {
      await expect(service.cached('workspace-1')).rejects.toThrow('initial failure');
      const firstBatch = service.cached('workspace-1');
      batch('mar-agent', [confirmed]);
      await expect(firstBatch).resolves.toEqual([confirmed]);
      service.markCacheStale('workspace-1');
      fail(new Error('later Runner failure'));
      await sessionState(service)
        .sessionCacheReads.get('workspace-1')
        ?.catch(() => undefined);
      expect(service.discoveryPending('workspace-1')).toBe(true);
      batch('codex', [session('late-codex', 'codex')]);
      expect(sessionState(service).sessionCache.get('workspace-1')).toMatchObject({
        sessions: [confirmed],
        expiresAt: 0
      });
      await expect(service.cached('workspace-1')).resolves.toEqual([confirmed]);
      await sessionState(service).sessionCacheReads.get('workspace-1');
      expect(service.discoveryPending('workspace-1')).toBe(false);
      expect(discover).toHaveBeenCalledTimes(3);
    } finally {
      service.clear();
    }
  });

  it('session discovery does not broadcast to pages without a Workspace watch', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-session-pending-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-session-pending');
    const connector = new NodeConnector({ reconnect: false, database });
    try {
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const internals = connector as unknown as {
        discoverWorkspaceSessions(workspaceId: string): Promise<readonly unknown[]>;
        emitWorkbenchEvent(category: string, payload: unknown): void;
      };
      let finishDiscovery!: (sessions: readonly unknown[]) => void;
      vi.spyOn(internals, 'discoverWorkspaceSessions').mockReturnValue(
        new Promise((resolve) => (finishDiscovery = resolve))
      );
      const emitted = vi.spyOn(internals, 'emitWorkbenchEvent');

      const result = operation(connector, 'session.list', { workspaceId: workspace.id, limit: 20 });
      const resolved = vi.fn();
      void result.then(resolved);
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).not.toHaveBeenCalled();
      finishDiscovery([]);
      await expect(result).resolves.toMatchObject({ sessions: [], nextCursor: null });
      await vi.runAllTicks();
      await Promise.resolve();
      expect(emitted).not.toHaveBeenCalled();
    } finally {
      connector.stop();
      await rm(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('reuses the session-discovery cache briefly for the same workspace while preserving the runtime merge path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-session-cache-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-session-cache');
    const connector = new NodeConnector({ reconnect: false, database });
    try {
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const internals = connector as unknown as {
        discoverWorkspaceSessions(workspaceId: string): Promise<readonly unknown[]>;
        emitWorkbenchEvent(category: string, payload: unknown): void;
      };
      const discover = vi.spyOn(internals, 'discoverWorkspaceSessions').mockResolvedValue([]);
      const emitted = vi.spyOn(internals, 'emitWorkbenchEvent');

      await operation(connector, 'session.list', { workspaceId: workspace.id, limit: 10 });
      await operation(connector, 'session.list', { workspaceId: workspace.id, limit: 10 });

      expect(discover).toHaveBeenCalledTimes(1);
      expect(emitted).not.toHaveBeenCalledWith(
        'workspace',
        expect.objectContaining({ workspaceId: workspace.id, topic: 'sessions' })
      );
    } finally {
      connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('late session discovery after invalidation does not write back to the cache or emit a revision', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-session-invalidated-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-session-invalidated');
    const connector = new NodeConnector({ reconnect: false, database });
    try {
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const internals = connector as unknown as {
        discoverWorkspaceSessions(workspaceId: string): Promise<readonly unknown[]>;
        emitWorkbenchEvent(category: string, payload: unknown): void;
        workspaceSessionService: { invalidate(workspaceId: string): void };
      };
      let finishDiscovery!: (sessions: readonly unknown[]) => void;
      let finishReplacement!: (sessions: readonly unknown[]) => void;
      const discover = vi
        .spyOn(internals, 'discoverWorkspaceSessions')
        .mockReturnValueOnce(new Promise((resolve) => (finishDiscovery = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (finishReplacement = resolve)));
      const emitted = vi.spyOn(internals, 'emitWorkbenchEvent');

      const first = operation(connector, 'session.list', { workspaceId: workspace.id, limit: 20 });
      await vi.advanceTimersByTimeAsync(500);
      internals.workspaceSessionService.invalidate(workspace.id);
      const replacement = operation(connector, 'session.list', {
        workspaceId: workspace.id,
        limit: 20
      });
      finishDiscovery([]);
      await expect(first).resolves.toMatchObject({ sessions: [] });
      await vi.runAllTicks();
      await Promise.resolve();

      expect(emitted).not.toHaveBeenCalledWith(
        'workspace',
        expect.objectContaining({ workspaceId: workspace.id, topic: 'sessions' })
      );
      const sharedReplacement = operation(connector, 'session.list', {
        workspaceId: workspace.id,
        limit: 20
      });
      expect(discover).toHaveBeenCalledTimes(2);
      finishReplacement([]);
      await expect(Promise.all([replacement, sharedReplacement])).resolves.toHaveLength(2);
    } finally {
      connector.stop();
      await rm(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('two invalidations keep reverse-completing discoveries from aliasing a new single-flight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-session-aba-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-session-aba');
    const connector = new NodeConnector({ reconnect: false, database });
    let finishOlder!: (sessions: readonly unknown[]) => void;
    let finishNewer!: (sessions: readonly unknown[]) => void;
    let finishCurrent!: (sessions: readonly unknown[]) => void;
    try {
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const internals = connector as unknown as {
        discoverWorkspaceSessions(workspaceId: string): Promise<readonly unknown[]>;
        workspaceSessionService: { invalidateCache(workspaceId: string): void };
      };
      const discover = vi
        .spyOn(internals, 'discoverWorkspaceSessions')
        .mockReturnValueOnce(new Promise((resolve) => (finishOlder = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (finishNewer = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (finishCurrent = resolve)));
      const older = { ...session('stale-older', 'codex'), workspaceId: workspace.id, cwd: root };
      const newer = { ...session('stale-newer', 'codex'), workspaceId: workspace.id, cwd: root };
      const current = { ...session('current', 'codex'), workspaceId: workspace.id, cwd: root };
      const first = operation(connector, 'session.list', { workspaceId: workspace.id, limit: 20 });
      await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
      internals.workspaceSessionService.invalidateCache(workspace.id);
      const second = operation(connector, 'session.list', { workspaceId: workspace.id, limit: 20 });
      await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
      internals.workspaceSessionService.invalidateCache(workspace.id);

      finishNewer([newer]);
      await expect(second).resolves.toMatchObject({
        sessions: [expect.objectContaining({ id: newer.id })]
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const replacement = operation(connector, 'session.list', {
        workspaceId: workspace.id,
        limit: 20
      });
      await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(3));
      finishOlder([older]);
      await first;

      let replacementSettled = false;
      const sharedReplacement = operation(connector, 'session.list', {
        workspaceId: workspace.id,
        limit: 20
      });
      void sharedReplacement.then(
        () => (replacementSettled = true),
        () => (replacementSettled = true)
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(replacementSettled).toBe(false);
      expect(discover).toHaveBeenCalledTimes(3);

      finishCurrent([current]);
      const results = (await Promise.all([replacement, sharedReplacement])) as {
        readonly sessions: readonly NodeAgentSession[];
      }[];
      for (const result of results)
        expect(result.sessions.map((entry) => entry.id)).toEqual([current.id]);
    } finally {
      finishOlder?.([]);
      finishNewer?.([]);
      finishCurrent?.([]);
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('initial confirms quickly and returns the snapshot asynchronously; renew only extends the lease and owners remain isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-watch-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-watch');
    const connector = new NodeConnector({ reconnect: false, database });
    try {
      const internals = connector as unknown as {
        discoverWorkspaceSessions(workspaceId: string): Promise<readonly unknown[]>;
        send(type: string, payload: unknown): void;
        workspaceSessionService: { invalidate(workspaceId: string): void };
        workspaceWorkbenchService: {
          invalidateTopic(workspaceId: string, topic: 'files' | 'sessions'): Promise<void>;
        };
      };
      const discover = vi.spyOn(internals, 'discoverWorkspaceSessions').mockResolvedValue([]);
      const send = vi.spyOn(internals, 'send');
      await writeFile(join(root, 'visible.txt'), 'visible');
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const first = (await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'tab-watch-one',
        mode: 'initial',
        topics: { files: { path: '.', limit: 20 }, sessions: true }
      })) as { accepted: boolean; expiresAt: number; watchId: string };
      expect(first).toMatchObject({
        accepted: true,
        watchId: 'tab-watch-one',
        expiresAt: expect.any(Number)
      });
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({ type: 'watch.workspace.snapshot', topic: 'files' })
        )
      );

      send.mockClear();
      internals.workspaceSessionService.invalidate(workspace.id);
      discover.mockRejectedValueOnce(new Error('discovery unavailable'));
      await expect(
        internals.workspaceWorkbenchService.invalidateTopic(workspace.id, 'sessions')
      ).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({
          type: 'watch.failed',
          topic: 'sessions',
          code: 'WORKSPACE_WATCH_SNAPSHOT_FAILED'
        })
      );

      const renewed = (await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'tab-watch-one',
        mode: 'renew'
      })) as { accepted: boolean };
      expect(renewed).toMatchObject({ accepted: true, watchId: 'tab-watch-one' });

      await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'shared-watch',
        mode: 'initial',
        topics: { sessions: true },
        __workspaceWatchSessionHash: 'admin-a'
      });
      await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'shared-watch',
        mode: 'initial',
        topics: { sessions: true },
        __workspaceWatchSessionHash: 'admin-b'
      });
      await operation(connector, 'workspace.unwatch', {
        workspaceId: workspace.id,
        watchId: 'shared-watch',
        __workspaceWatchSessionHash: 'admin-a'
      });
      await expect(
        operation(connector, 'workspace.watch', {
          workspaceId: workspace.id,
          watchId: 'shared-watch',
          mode: 'renew',
          __workspaceWatchSessionHash: 'admin-a'
        })
      ).rejects.toThrow('WORKSPACE_WATCH_NOT_FOUND');
      await expect(
        operation(connector, 'workspace.watch', {
          workspaceId: workspace.id,
          watchId: 'shared-watch',
          mode: 'renew',
          __workspaceWatchSessionHash: 'admin-b'
        })
      ).resolves.toMatchObject({ accepted: true, watchId: 'shared-watch' });

      await expect(
        operation(connector, 'workspace.watch', {
          workspaceId: workspace.id,
          watchId: 'tab-watch-two',
          mode: 'renew'
        })
      ).rejects.toThrow('WORKSPACE_WATCH_NOT_FOUND');

      send.mockClear();
      await writeFile(join(root, 'added.txt'), 'added');
      await internals.workspaceWorkbenchService.invalidateTopic(workspace.id, 'files');
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({ type: 'watch.workspace.snapshot', topic: 'files' })
        )
      );
    } finally {
      connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Session display events preserve pinned sessions while refreshing slow Runners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-session-order-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-session-order');
    const connector = new NodeConnector({ reconnect: false, database });
    let finish!: (sessions: readonly NodeAgentSession[]) => void;
    try {
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const pinned = {
        ...session('pinned-codex', 'codex'),
        workspaceId: workspace.id,
        cwd: root,
        pinOrder: 0,
        pinnedAt: 1
      };
      const sending = {
        ...session('sending-mar', 'mar-agent'),
        workspaceId: workspace.id,
        cwd: root,
        lastActivityAt: 900
      };
      const internals = connector as unknown as {
        workspaceSessionService: WorkspaceSessionService;
        discoverWorkspaceSessions: WorkspaceSessionServiceOptions['discover'];
        emitSessionWorkbenchEvent(payload: unknown): void;
        send(type: string, payload: unknown): void;
        workspaceWorkbenchService: {
          invalidateTopic(workspaceId: string, topic: 'sessions'): Promise<void>;
        };
      };
      sessionState(internals.workspaceSessionService).sessionCache.set(workspace.id, {
        sessions: [pinned, sending],
        expiresAt: Date.now() + 60_000
      });
      const send = vi.spyOn(internals, 'send');
      const discover = vi
        .spyOn(internals, 'discoverWorkspaceSessions')
        .mockImplementationOnce((_workspaceId, batch) => {
          batch('mar-agent', [sending]);
          return new Promise((resolve) => (finish = resolve));
        })
        .mockResolvedValue([pinned, sending]);
      const list = async (): Promise<string[]> => {
        const page = (await operation(connector, 'session.list', {
          workspaceId: workspace.id,
          limit: 20
        })) as { sessions: NodeAgentSession[] };
        return page.sessions.map((entry) => entry.id);
      };

      expect(await list()).toEqual([pinned.id, sending.id]);
      await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'session-order-watch',
        mode: 'initial',
        topics: { sessions: true }
      });
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            topic: 'sessions',
            payload: expect.objectContaining({
              sessions: [
                expect.objectContaining({ id: pinned.id }),
                expect.objectContaining({ id: sending.id })
              ]
            })
          })
        )
      );
      send.mockClear();
      internals.emitSessionWorkbenchEvent({ session: sending });
      internals.emitSessionWorkbenchEvent({ session: sending });
      expect(await list()).toEqual([pinned.id, sending.id]);
      expect(await list()).toEqual([pinned.id, sending.id]);
      expect(discover).toHaveBeenCalledOnce();
      finish([pinned, sending]);
      await sessionState(internals.workspaceSessionService).sessionCacheReads.get(workspace.id);
      await internals.workspaceWorkbenchService.invalidateTopic(workspace.id, 'sessions');
      expect(await list()).toEqual([pinned.id, sending.id]);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(send).not.toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({ type: 'watch.workspace.snapshot', topic: 'sessions' })
      );
    } finally {
      finish?.([]);
      connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a Session display event expires the discovery cache without discarding it and refreshes the topic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-session-event-'));
    const database = new NodeDatabase(':memory:', 'node-workspace-session-event');
    const connector = new NodeConnector({ reconnect: false, database });
    try {
      const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
      const internals = connector as unknown as {
        emitSessionWorkbenchEvent(payload: unknown): void;
        workspaceSessionService: WorkspaceSessionService;
        workspaceWorkbenchService: {
          invalidateTopic(workspaceId: string, topic: 'sessions'): Promise<void>;
        };
      };
      const refresh = vi
        .spyOn(internals.workspaceWorkbenchService, 'invalidateTopic')
        .mockResolvedValue(undefined);
      const known = [session('known-codex', 'codex')];
      sessionState(internals.workspaceSessionService).sessionCache.set(workspace.id, {
        sessions: known,
        expiresAt: Date.now() + 60_000
      });

      internals.emitSessionWorkbenchEvent({
        session: { id: 'session-1', workspaceId: workspace.id }
      });

      expect(refresh).toHaveBeenCalledWith(workspace.id, 'sessions');
      expect(
        sessionState(internals.workspaceSessionService).sessionCache.get(workspace.id)
      ).toEqual({
        sessions: known,
        expiresAt: 0
      });
    } finally {
      connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function session(id: string, runner: NodeAgentSession['runner']): NodeAgentSession {
  return {
    id,
    runner,
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    externalSessionId: id,
    nativeControl: 'EXTERNAL',
    channelToken: null,
    cwd: '/workspace',
    model: null,
    effort: null,
    access: null,
    customTitle: null,
    runnerTitle: id,
    pinnedAt: null,
    pinOrder: null,
    titleSource: 'RUNNER',
    externalDiscovered: true,
    lastActivityAt: 100,
    createdAt: 100
  };
}

function operation(connector: NodeConnector, operation: string, data: unknown): Promise<unknown> {
  const input = data as Record<string, unknown>;
  const requestData =
    operation.startsWith('workspace.') && operation.includes('watch')
      ? { workbenchConnectionId: 'test-workbench-connection', ...input }
      : data;
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operation, requestData);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
