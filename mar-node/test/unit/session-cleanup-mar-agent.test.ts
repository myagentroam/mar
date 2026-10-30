import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NodeCapabilities } from '@myagentroam/protocol';
import { JsonlSessionStore } from '../../../mar-agent/src/session/store/index.js';
import { openAgentSessionCatalog } from '../../../mar-agent/src/index.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { CommandStateStore } from '../../src/runner-command-engine.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import { SessionCatalogService } from '../../src/session/session-catalog-service.js';

const DAY = 24 * 60 * 60 * 1000;

async function fixture(recentParent = false, childSource: 'user' | 'subagent' = 'user') {
  const home = await mkdtemp(join(tmpdir(), 'mar-cleanup-tree-'));
  const database = new NodeDatabase(':memory:', 'mar-cleanup-tree');
  const workspace = database.saveWorkspace({ path: home, kind: 'DIRECTORY', gitSummary: null });
  const now = Date.now();
  const store = await JsonlSessionStore.open(home);
  vi.useFakeTimers({ toFake: ['Date'] });
  let root, child, grandchild;
  try {
    vi.setSystemTime(recentParent ? now : now - 60 * DAY);
    root = await store.createSession({ workspace: home });
    vi.setSystemTime(recentParent ? now - 40 * DAY : now);
    child = await store.createSession({
      workspace: home,
      source:
        childSource === 'user'
          ? { type: 'user', parentSessionId: root.id }
          : {
              type: 'subagent',
              parentSessionId: root.id,
              rootSessionId: root.id,
              parentExecutionId: 'fixture-execution',
              role: 'general-purpose',
              description: 'Legacy SDK child'
            }
    });
    vi.setSystemTime(now);
    grandchild = await store.createSession({
      workspace: home,
      source: { type: 'user', parentSessionId: child.id }
    });
  } finally {
    vi.useRealTimers();
    await store.close();
  }
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => database.getWorkspace(id)
  );
  const runner = new MarAgentRunner(home);
  const runners = new RunnerRegistry([runner]);
  const projection = new NativeSessionProjectionService({
    database: () => database,
    nodeId: () => 'node',
    runtime,
    runners,
    capabilities: () => ({ marAgent: { available: true } }) as NodeCapabilities,
    commands: new CommandStateStore(),
    releaseResumeState: () => {},
    present: () => {
      throw new Error('UNEXPECTED_PRESENT');
    }
  });
  const batch = vi.spyOn(runner, 'removeNativeMembers');
  const watched = new Set<string>();
  const refresh = vi.fn(async () => {});
  const service = new SessionCatalogService({
    database: () => database,
    nodeId: () => 'node',
    runtime,
    runners,
    projection,
    runnerAvailable: () => true,
    cachedNative: () => projection.cachedNative(),
    cachedWorkspace: async () => [],
    discoveryPending: () => false,
    discoverWorkspace: (id) => projection.discoverWorkspace(id, undefined, true),
    present: (session) => session,
    nativeIds: (session) => projection.nativeIds(session),
    forget: (session, nativeIds) => projection.forget(session, nativeIds),
    refreshActivity: refresh,
    externalActivity: () => undefined,
    isWatching: (id) => watched.has(id),
    history: async () => ({ turns: [], nextCursor: null }),
    invalidateHistory: () => {},
    invalidateWorkspaceSessions: () => {},
    emitSession: () => {}
  });
  return {
    root,
    child,
    grandchild,
    database,
    workspace,
    runtime,
    runner,
    projection,
    batch,
    watched,
    refresh,
    cleanup: async () =>
      service.operations()['workspace.sessions.cleanup']!({
        workspaceId: workspace.id,
        inactiveDays: 30
      }),
    remaining: async () => {
      const catalog = await openAgentSessionCatalog({ homeDirectory: home });
      try {
        return (await catalog.list({ limit: 200 })).sessions.map(({ id }) => id);
      } finally {
        await catalog.close();
      }
    },
    close: async () => {
      database.close();
      await rm(home, { recursive: true, force: true });
    }
  };
}

describe('MAR Agent workspace cleanup', () => {
  it.each(['user', 'subagent'] as const)(
    'cleans an expired %s child and its recent descendant while a long-lived parent remains',
    async (source) => {
      const f = await fixture(true, source);
      try {
        expect(f.database.listSessionRecords(f.workspace.id)).toEqual([]);
        expect(
          (await f.projection.discover('mar-agent', f.workspace.id, true)).find(
            (s) => s.id === f.child.id
          )?.lastActivityAt
        ).toBeLessThan(Date.now() - 30 * DAY);
        await expect(f.cleanup()).resolves.toEqual({
          deleted: 2,
          skipped: 1,
          failed: 0,
          deletedByRunner: { 'mar-agent': 2 }
        });
        expect(await f.remaining()).toEqual([f.root.id]);
        expect(f.batch).toHaveBeenCalledOnce();
        expect(f.batch.mock.calls[0]![0].map(({ id }) => id)).toEqual([
          f.grandchild.id,
          f.child.id
        ]);
        expect(f.database.listSessionRecords(f.workspace.id)).toEqual([]);
      } finally {
        await f.close();
      }
    }
  );

  it('cascades an expired parent through recent, pinned, watched and paused queued descendants', async () => {
    const f = await fixture();
    try {
      f.database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: f.root.id,
        workspaceId: f.workspace.id
      });
      f.database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: f.child.id,
        workspaceId: f.workspace.id,
        parentSessionId: f.root.id,
        pinned: true
      });
      f.runtime.createAgentSession({
        workspaceId: f.workspace.id,
        runner: 'mar-agent',
        cwd: f.workspace.path,
        externalSessionId: f.child.id,
        parentSessionId: f.root.id
      });
      const queued = f.runtime.createQueueItem({
        sessionId: f.child.id,
        clientMessageId: 'queued',
        content: 'discard with expired parent'
      }).item;
      f.runtime.pauseSessionQueue(f.child.id);
      f.watched.add(f.grandchild.id);
      expect(
        (await f.projection.discover('mar-agent', f.workspace.id, true)).find(
          (s) => s.id === f.root.id
        )?.lastActivityAt
      ).toBeLessThan(Date.now() - 30 * DAY);
      await expect(f.cleanup()).resolves.toEqual({
        deleted: 3,
        skipped: 0,
        failed: 0,
        deletedByRunner: { 'mar-agent': 3 }
      });
      expect(await f.remaining()).toEqual([]);
      expect(f.database.listSessionRecords(f.workspace.id)).toEqual([]);
      expect(f.runtime.getQueueItem(queued.id)).toBeUndefined();
      expect(f.batch).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it('keeps a parent used after discovery even when its new run has already finished', async () => {
    const f = await fixture();
    try {
      const store = await JsonlSessionStore.open(f.workspace.path);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() - 40 * DAY);
        await store.createSession({ workspace: f.workspace.path });
      } finally {
        vi.useRealTimers();
        await store.close();
      }
      f.refresh.mockImplementationOnce(async () => {
        f.runtime.createAgentSession({
          workspaceId: f.workspace.id,
          runner: 'mar-agent',
          cwd: f.workspace.path,
          externalSessionId: f.root.id
        });
        const { run } = f.runtime.createMessageRun({
          sessionId: f.root.id,
          clientMessageId: 'new-parent-message',
          content: 'recent activity after the cleanup snapshot'
        });
        f.runtime.finishRun(run.id, 'SUCCEEDED');
      });
      await expect(f.cleanup()).resolves.toEqual({
        deleted: 1,
        skipped: 3,
        failed: 0,
        deletedByRunner: { 'mar-agent': 1 }
      });
      expect((await f.remaining()).sort()).toEqual([f.root.id, f.child.id, f.grandchild.id].sort());
      expect(f.runtime.getAgentSession(f.root.id)).toBeDefined();
      expect(f.batch).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it('protects an expired ancestor when a grandchild is running', async () => {
    const f = await fixture();
    try {
      f.runtime.createAgentSession({
        workspaceId: f.workspace.id,
        runner: 'mar-agent',
        cwd: f.workspace.path,
        externalSessionId: f.grandchild.id,
        parentSessionId: f.child.id
      });
      f.runtime.createMessageRun({
        sessionId: f.grandchild.id,
        clientMessageId: 'running',
        content: 'still working'
      });
      await expect(f.cleanup()).resolves.toEqual({
        deleted: 0,
        skipped: 3,
        failed: 0,
        deletedByRunner: {}
      });
      expect((await f.remaining()).sort()).toEqual([f.root.id, f.child.id, f.grandchild.id].sort());
      expect(f.batch).not.toHaveBeenCalled();
      f.runtime.beginSessionHistoryMutation(f.root.id)();
      f.runtime.beginSessionHistoryMutation(f.child.id)();
    } finally {
      await f.close();
    }
  });

  it('settles every member of an admitted native batch before returning an expired budget', async () => {
    const f = await fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const remove = MarAgentRunner.prototype.removeNativeMembers.bind(f.runner);
    f.batch.mockImplementation(async (members) => {
      entered.resolve();
      await ready.promise;
      await remove(members);
    });
    let settled = false;
    const work = f.cleanup().finally(() => {
      settled = true;
    });
    try {
      await entered.promise;
      clock.mockReturnValue(25_000);
      expect(settled).toBe(false);
      ready.resolve();
      await expect(work).resolves.toEqual({
        deleted: 3,
        skipped: 0,
        failed: 0,
        deletedByRunner: { 'mar-agent': 3 },
        timedOut: true,
        remaining: 0
      });
      expect(await f.remaining()).toEqual([]);
      expect(f.batch).toHaveBeenCalledOnce();
    } finally {
      ready.resolve();
      await work;
      clock.mockRestore();
      await f.close();
    }
  });

  it('settles a missing child before a native parent whose admitted batch exhausts the budget', async () => {
    const f = await fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const native = await f.projection.discover('mar-agent', f.workspace.id, true);
      await f.runner.removeNativeMembers(native.filter(({ id }) => id !== f.root.id));
      f.batch.mockClear();
      f.database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: f.root.id,
        workspaceId: f.workspace.id
      });
      f.database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: f.child.id,
        workspaceId: f.workspace.id,
        parentSessionId: f.root.id
      });
      const remove = MarAgentRunner.prototype.removeNativeMembers.bind(f.runner);
      f.batch.mockImplementation(async (members) => {
        await remove(members);
        clock.mockReturnValue(25_000);
      });

      await expect(f.cleanup()).resolves.toEqual({
        deleted: 2,
        skipped: 0,
        failed: 0,
        deletedByRunner: { 'mar-agent': 2 },
        timedOut: true,
        remaining: 0
      });
      expect(f.database.listSessionRecords(f.workspace.id)).toEqual([]);
      expect(await f.remaining()).toEqual([]);
      expect(f.batch).toHaveBeenCalledOnce();
      expect(f.batch.mock.calls[0]![0].map(({ id }) => id)).toEqual([f.root.id]);
    } finally {
      clock.mockRestore();
      await f.close();
    }
  });

  it('keeps a missing intermediate record when its descendant batch exhausts the budget and retries later', async () => {
    const f = await fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const native = await f.projection.discover('mar-agent', f.workspace.id, true);
      await f.runner.removeNativeMembers(native.filter(({ id }) => id === f.child.id));
      f.batch.mockClear();
      f.database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: f.root.id,
        workspaceId: f.workspace.id
      });
      f.database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: f.child.id,
        workspaceId: f.workspace.id,
        parentSessionId: f.root.id
      });
      const remove = MarAgentRunner.prototype.removeNativeMembers.bind(f.runner);
      f.batch.mockImplementation(async (members) => {
        await remove(members);
        clock.mockReturnValue(25_000);
      });

      await expect(f.cleanup()).resolves.toEqual({
        deleted: 1,
        skipped: 0,
        failed: 0,
        deletedByRunner: { 'mar-agent': 1 },
        timedOut: true,
        remaining: 2
      });
      expect(await f.remaining()).toEqual([f.root.id]);
      expect(f.database.getSessionRecord(f.root.id)).toBeDefined();
      expect(f.database.getSessionRecord(f.child.id)?.metadata.parentSessionId).toBe(f.root.id);
      expect(f.batch).toHaveBeenCalledOnce();
      expect(f.batch.mock.calls[0]![0].map(({ id }) => id)).toEqual([f.grandchild.id]);

      clock.mockReturnValue(0);
      f.batch.mockImplementation(remove);
      await expect(f.cleanup()).resolves.toEqual({
        deleted: 2,
        skipped: 0,
        failed: 0,
        deletedByRunner: { 'mar-agent': 2 }
      });
      expect(await f.remaining()).toEqual([]);
      expect(f.database.listSessionRecords(f.workspace.id)).toEqual([]);
    } finally {
      clock.mockRestore();
      await f.close();
    }
  });

  it('locks every member before activity reads and releases locks after a native batch failure', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    f.refresh.mockImplementationOnce(async () => {
      entered.resolve();
      await ready.promise;
    });
    f.batch.mockRejectedValue(new Error('CONTROLLED_BATCH_FAILURE'));
    const work = f.cleanup();
    try {
      await entered.promise;
      for (const member of [f.root, f.child, f.grandchild]) {
        expect(() =>
          f.runtime.adoptRun({
            runId: `late-${member.id}`,
            sessionId: member.id,
            workspaceId: f.workspace.id,
            runner: 'mar-agent',
            cwd: f.workspace.path
          })
        ).toThrow('SESSION_ACTIVE');
      }
      ready.resolve();
      await expect(work).resolves.toMatchObject({ deleted: 0, failed: 1 });
      expect((await f.remaining()).sort()).toEqual([f.root.id, f.child.id, f.grandchild.id].sort());
      for (const member of [f.root, f.child, f.grandchild])
        f.runtime.beginSessionHistoryMutation(member.id)();
    } finally {
      ready.resolve();
      await work;
      await f.close();
    }
  });
});
