import { workspaceTargetRef } from './support/workspace-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceWatchService } from '../../src/service/workspace-watch-service.js';

describe('Shared Workspace Watch', () => {
  it('adds feature-gated prewarm to initial only and not to renew', async () => {
    vi.useFakeTimers();
    const initialBodies: Array<Record<string, unknown>> = [];
    const service = createWorkspaceWatchService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      workspaces: { value: [{ id: 'workspace-1', kind: 'DIRECTORY' }] } as never,
      heartbeatMs: 1_000,
      prepareFiles: () => true,
      request: async (_path, init) => {
        if (init?.method === 'POST') initialBodies.push(JSON.parse(String(init.body)));
        return { accepted: true } as never;
      },
      onSnapshot: vi.fn()
    });
    try {
      await service.start('workspace-1');
      expect(initialBodies[0]?.prepareFiles).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(initialBodies[1]?.mode).toBe('renew');
      expect(initialBodies[1]).not.toHaveProperty('prepareFiles');
    } finally {
      service.stop();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  afterEach(() => vi.useRealTimers());
  it('Workspace Watch renews its lease inside the service and releases the current watch on stop', async () => {
    vi.useFakeTimers();
    const requests: { path: string; init?: RequestInit }[] = [];
    const snapshots: unknown[] = [];
    const service = createWorkspaceWatchService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      workspaces: {
        value: [{ id: 'workspace-1', path: '/project', kind: 'GIT_WORKSPACE' }]
      } as never,
      heartbeatMs: 100,
      request: (path, init) => {
        requests.push(init === undefined ? { path } : { path, init });
        return Promise.resolve({ accepted: true }) as never;
      },
      onSnapshot: (_nodeId, _workspaceId, snapshot) => snapshots.push(snapshot)
    });

    await service.start('workspace-1');
    expect(service.topicStatus).toMatchObject({
      sessions: 'loading',
      files: 'loading',
      changes: 'loading'
    });
    const initial = JSON.parse(String(requests[0]?.init?.body)) as { watchId: string };
    service.handleEvent({
      type: 'watch.workspace.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      watchId: initial.watchId,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      topic: 'sessions',
      revision: 1,
      payload: { sessions: [] }
    });
    expect(snapshots).toEqual([{ sessions: { sessions: [] } }]);
    expect(service.topicStatus).toMatchObject({
      sessions: 'ready',
      files: 'loading',
      changes: 'loading'
    });
    await vi.advanceTimersByTimeAsync(100);
    service.stop();
    expect(requests.map((entry) => entry.init?.method)).toEqual(['POST', 'POST', 'DELETE']);
    vi.useRealTimers();
  });

  it('Workspace Watch drops late revisions per topic without affecting readiness of other topics', async () => {
    const snapshots: unknown[] = [];
    const requests: RequestInit[] = [];
    const service = createWorkspaceWatchService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      workspaces: {
        value: [{ id: 'workspace-1', path: '/project', kind: 'GIT_WORKSPACE' }]
      } as never,
      heartbeatMs: 15_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { accepted: true } as never;
      },
      onSnapshot: (_nodeId, _workspaceId, snapshot) => snapshots.push(snapshot)
    });
    await service.start('workspace-1');
    const initial = JSON.parse(String(requests[0]?.body)) as { watchId: string };
    const identity = {
      type: 'watch.workspace.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'test-generation',
      watchId: initial.watchId,
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    };

    service.handleEvent({ ...identity, topic: 'files', revision: 3, payload: { files: ['new'] } });
    service.handleEvent({
      ...identity,
      topic: 'files',
      revision: 2,
      payload: { files: ['stale'] }
    });
    service.handleEvent({
      ...identity,
      topic: 'changes',
      revision: 1,
      payload: { branch: 'main' }
    });

    expect(snapshots).toEqual([{ files: { files: ['new'] } }, { changes: { branch: 'main' } }]);
    expect(service.topicStatus).toMatchObject({
      sessions: 'loading',
      files: 'ready',
      changes: 'ready'
    });
    service.stop();
  });

  it('keeps grouped sessions on the shared Workspace Watch and rejects a late previous-group snapshot', async () => {
    let sessionGroup: 'MAIN' | 'CHILD' = 'MAIN';
    const requests: { path: string; init?: RequestInit }[] = [];
    const snapshots: unknown[] = [];
    const service = createWorkspaceWatchService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      workspaces: {
        value: [{ id: 'workspace-1', path: '/project', kind: 'GIT_WORKSPACE' }]
      } as never,
      heartbeatMs: 15_000,
      sessionGroup: () => sessionGroup,
      request: (path, init) => {
        requests.push(init === undefined ? { path } : { path, init });
        return Promise.resolve({ accepted: true }) as never;
      },
      onSnapshot: (_nodeId, _workspaceId, snapshot) => snapshots.push(snapshot)
    });

    await service.start('workspace-1', 'src');
    const mainWatch = JSON.parse(String(requests[0]?.init?.body)) as {
      watchId: string;
      workbenchConnectionId: string;
      topics: Record<string, unknown>;
    };
    expect(requests.filter(({ init }) => init?.method === 'POST')).toHaveLength(1);
    expect(mainWatch.topics).toEqual({
      sessions: true,
      sessionGroup: 'MAIN',
      files: { path: 'src', limit: 200 },
      changes: true
    });

    for (const topic of ['files', 'changes'] as const)
      service.handleEvent({
        type: 'watch.workspace.snapshot',
        workbenchConnectionId: mainWatch.workbenchConnectionId,
        nodeGeneration: 'test-generation',
        watchId: mainWatch.watchId,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        topic,
        revision: 1,
        payload: {}
      });
    snapshots.length = 0;
    sessionGroup = 'CHILD';
    expect(
      service.handleEvent({
        type: 'watch.workspace.snapshot',
        workbenchConnectionId: mainWatch.workbenchConnectionId,
        nodeGeneration: 'test-generation',
        watchId: mainWatch.watchId,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        topic: 'sessions',
        revision: 1,
        payload: { sessions: [{ id: 'stale-main-session' }] }
      })
    ).toBe(false);
    expect(snapshots).toEqual([]);

    await service.start('workspace-1');
    expect(service.topicStatus).toEqual({ sessions: 'loading', files: 'ready', changes: 'ready' });
    const posts = requests.filter(({ init }) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    const childWatch = JSON.parse(String(posts[1]?.init?.body)) as {
      watchId: string;
      workbenchConnectionId: string;
      mode: string;
      topics: Record<string, unknown>;
    };
    expect(childWatch).toMatchObject({
      workbenchConnectionId: mainWatch.workbenchConnectionId,
      mode: 'initial',
      topics: { sessions: true, sessionGroup: 'CHILD' }
    });
    expect(childWatch.topics).toEqual({
      sessions: true,
      sessionGroup: 'CHILD',
      files: { path: 'src', limit: 200 },
      changes: true
    });
    expect(
      service.handleEvent({
        type: 'watch.workspace.snapshot',
        workbenchConnectionId: childWatch.workbenchConnectionId,
        nodeGeneration: 'test-generation',
        watchId: childWatch.watchId,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        topic: 'sessions',
        revision: 1,
        payload: { sessions: [{ id: 'child-session' }] }
      })
    ).toBe(true);
    expect(snapshots).toEqual([{ sessions: { sessions: [{ id: 'child-session' }] } }]);
    service.stop();
  });

  it('Preserves a ready topic when the initial Workspace snapshot arrives before a failed ACK', async () => {
    vi.useFakeTimers();
    let rejectRequest!: (error: Error) => void;
    const requests: RequestInit[] = [];
    const service = createWorkspaceWatchService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      workspaces: { value: [{ id: 'workspace-1', path: '/project', kind: 'DIRECTORY' }] } as never,
      heartbeatMs: 15_000,
      request: (_path, init) => {
        requests.push(init ?? {});
        return new Promise((_resolve, reject) => (rejectRequest = reject)) as never;
      },
      onSnapshot: vi.fn()
    });
    const starting = service.start('workspace-1');
    const initial = JSON.parse(String(requests[0]?.body)) as { watchId: string };
    service.handleEvent({
      type: 'watch.workspace.snapshot',
      workbenchConnectionId: 'local-test-connection',
      watchId: initial.watchId,
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      topic: 'sessions',
      revision: 1,
      payload: { sessions: [] }
    });
    rejectRequest(new Error('response lost'));
    await starting;

    expect(service.topicStatus.sessions).toBe('ready');
    expect(service.topicStatus.files).toBe('failed');
    service.stop();
    vi.useRealTimers();
  });

  it('Uses bounded backoff and rebuilds the lease with a new generation when an async Workspace snapshot fails', async () => {
    vi.useFakeTimers();
    const requests: RequestInit[] = [];
    const service = createWorkspaceWatchService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      workspaces: { value: [{ id: 'workspace-1', path: '/project', kind: 'DIRECTORY' }] } as never,
      heartbeatMs: 15_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { accepted: true } as never;
      },
      onSnapshot: vi.fn()
    });
    await service.start('workspace-1');
    const first = JSON.parse(String(requests[0]?.body)) as { watchId: string };
    service.handleEvent({
      type: 'watch.workspace.snapshot',
      workbenchConnectionId: 'local-test-connection',
      watchId: first.watchId,
      nodeGeneration: 'test-generation',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      topic: 'sessions',
      revision: 1,
      payload: { sessions: [] }
    });
    expect(service.topicStatus.sessions).toBe('ready');
    expect(
      service.handleEvent({
        type: 'watch.failed',
        watchType: 'workspace',
        workbenchConnectionId: 'local-test-connection',
        watchId: first.watchId,
        nodeGeneration: 'test-generation',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        topic: 'files',
        code: 'WORKSPACE_WATCH_SNAPSHOT_FAILED',
        message: 'Workspace watch snapshot failed.'
      })
    ).toBe(true);
    expect(service.topicStatus.files).toBe('failed');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const replacement = JSON.parse(String(requests[1]?.body)) as {
      watchId: string;
      mode: string;
    };
    expect(replacement).toMatchObject({ mode: 'initial' });
    expect(replacement.watchId).not.toBe(first.watchId);
    expect(service.topicStatus.files).toBe('loading');
    expect(service.topicStatus.sessions).toBe('ready');
    service.stop();
    vi.useRealTimers();
  });

  it('Does not send Workspace Watch until Workbench connection identity is ready', async () => {
    const connection = { id: undefined as string | undefined };
    const request = vi.fn();
    const service = createWorkspaceWatchService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      workspaces: { value: [{ id: 'workspace-1', path: '/project', kind: 'DIRECTORY' }] } as never,
      heartbeatMs: 15_000,
      workbenchConnectionId: () => connection.id,
      request,
      onSnapshot: vi.fn()
    });
    await service.start('workspace-1');
    expect(request).not.toHaveBeenCalled();
    connection.id = 'connection-ready';
    request.mockResolvedValue({ accepted: true });
    await service.start('workspace-1');
    expect(request).toHaveBeenCalledOnce();
    service.stop();
  });

  it('Recreates the same target with a new generation after Workspace Watch is paused', async () => {
    const requests: RequestInit[] = [];
    const service = createWorkspaceWatchService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      workspaces: { value: [{ id: 'workspace-1', path: '/project', kind: 'DIRECTORY' }] } as never,
      heartbeatMs: 15_000,
      request: async (_path, init) => {
        requests.push(init ?? {});
        return { accepted: true } as never;
      },
      onSnapshot: vi.fn()
    });

    await service.start('workspace-1');
    const first = JSON.parse(String(requests[0]?.body)) as { watchId: string };
    service.pause();
    await service.start('workspace-1');
    const resumed = JSON.parse(String(requests[1]?.body)) as { watchId: string };

    expect(resumed.watchId).not.toBe(first.watchId);
    expect(requests).toHaveLength(2);
    service.stop();
  });
});
