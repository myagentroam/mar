import { describe, expect, it } from 'vitest';
import { createWorkspaceViewCacheService } from '../../src/service/WorkspaceViewCacheService.js';

describe('Web Workspace View Cache', () => {
  it('Keeps distinct Turns of a continuous Run and updates older cached units in place', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    const cache = state.get('node-1', 'workspace-1');
    const turns = ['old', 'new'].map((id) => ({
      id,
      sessionId: 'session-1',
      runId: 'run-1',
      status: 'RUNNING',
      items: []
    }));
    state.saveDetail(
      cache,
      {
        sessionId: 'session-1',
        runs: [],
        turns,
        nextCursor: null,
        contextUsage: null,
        lastAccessedAt: 1
      },
      2,
      'session-1'
    );
    state.cacheTurn('node-1', 'workspace-1', { ...turns[0]!, status: 'SUCCEEDED' });
    const cached = cache.sessionDetails.get('session-1')!.turns;
    expect(cached.map((turn) => turn.id)).toEqual(['old', 'new']);
    expect(cached.map((turn) => turn.status)).toEqual(['SUCCEEDED', 'RUNNING']);
  });

  it('Creates stable caches per Workspace and precisely clears Node-associated state', () => {
    const cache = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    const first = cache.get('node-1', 'workspace-1');
    first.selectedSessionId = 'session-1';
    expect(cache.get('node-1', 'workspace-1')).toBe(first);

    cache.get('node-2', 'workspace-1');
    cache.removeNode('node-1');
    expect(cache.caches.has('node-1:workspace-1')).toBe(false);
    expect(cache.caches.has('node-2:workspace-1')).toBe(true);
  });

  it('Caches keep independent Node/Workspace identities and switch active context separately', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    const first = state.activate('node-1', 'workspace-1');
    const second = state.activate('node-2', 'workspace-2');

    expect(first).toMatchObject({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    expect(second).toMatchObject({ nodeId: 'node-2', workspaceId: 'workspace-2' });
    expect(state.active.value).toBe(second);
    expect(state.caches.get('node-1:workspace-1')).toBe(first);

    state.deactivate();
    expect(state.active.value).toBeUndefined();
    expect(state.caches.get('node-1:workspace-1')).toBe(first);
  });

  it('Evicts session details by LRU while retaining the current session and refreshing its access time', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    const cache = state.get('node-1', 'workspace-1');
    for (const [sessionId, lastAccessedAt] of [
      ['current', 1],
      ['old', 2],
      ['new', 3]
    ] as const)
      state.saveDetail(
        cache,
        {
          sessionId,
          runs: [],
          turns: [],
          nextCursor: null,
          contextUsage: null,
          lastAccessedAt
        },
        2,
        'current'
      );

    expect([...cache.sessionDetails.keys()]).toEqual(['current', 'new']);
    expect(state.touchDetail('node-1', 'workspace-1', 'current', 10)?.lastAccessedAt).toBe(10);
  });

  it('Retains only the newest 15 Segments and clears an old cursor that can no longer be used', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    const cache = state.get('node-1', 'workspace-1');
    state.saveDetail(
      cache,
      {
        sessionId: 'session-1',
        runs: [],
        turns: Array.from({ length: 40 }, (_, index) => ({
          id: `turn-${index + 1}`,
          sessionId: 'session-1',
          runId: null,
          status: 'SUCCEEDED',
          items: []
        })),
        nextCursor: 'before-turn-1',
        contextUsage: null,
        lastAccessedAt: 1
      },
      2,
      'session-1'
    );

    const detail = cache.sessionDetails.get('session-1');
    expect(detail?.turns).toHaveLength(15);
    expect(detail?.turns[0]?.id).toBe('turn-26');
    expect(detail?.nextCursor).toBeNull();

    state.cacheTurn('node-1', 'workspace-1', {
      id: 'turn-41',
      sessionId: 'session-1',
      runId: 'run-41',
      status: 'RUNNING',
      startedAt: 1,
      items: []
    });
    expect(detail?.turns).toHaveLength(15);
    expect(detail?.turns[0]?.id).toBe('turn-27');
    expect(detail?.turns.at(-1)?.id).toBe('turn-41');

    state.replaceTurns(
      'node-1',
      'workspace-1',
      'session-1',
      [
        {
          id: 'authoritative-1',
          sessionId: 'session-1',
          runId: null,
          status: 'SUCCEEDED',
          items: []
        },
        {
          id: 'authoritative-2',
          sessionId: 'session-1',
          runId: null,
          status: 'SUCCEEDED',
          items: []
        }
      ],
      'before-authoritative-1'
    );
    expect(detail?.turns.map((turn) => turn.id)).toEqual(['authoritative-1', 'authoritative-2']);
    expect(detail?.nextCursor).toBe('before-authoritative-1');
  });

  it('Atomically migrates details, queue, and Workspace selection after Session identity is confirmed', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    const cache = state.get('node-1', 'workspace-1');
    cache.sessions = [
      {
        id: 'draft-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        activity: 'IDLE'
      }
    ];
    cache.sessionDetails.set('draft-1', {
      sessionId: 'draft-1',
      runs: [],
      turns: [
        {
          id: 'turn-1',
          sessionId: 'draft-1',
          runId: null,
          status: 'PREPARING',
          items: []
        }
      ],
      nextCursor: null,
      contextUsage: undefined,
      lastAccessedAt: 1
    });
    cache.queues.set('draft-1', { version: 1, paused: false, items: [] });
    cache.queues.set('session-1', { version: 2, paused: true, items: [] });
    cache.selectedSessionId = 'draft-1';

    state.migrateSession('node-1', 'workspace-1', 'draft-1', 'session-1', {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-session-1',
      activity: 'MANAGED_ACTIVE'
    });

    expect(cache.sessions).toEqual([
      expect.objectContaining({ id: 'session-1', activity: 'MANAGED_ACTIVE' })
    ]);
    expect(cache.sessionDetails.has('draft-1')).toBe(false);
    expect(cache.sessionDetails.get('session-1')).toMatchObject({
      sessionId: 'session-1',
      turns: [{ sessionId: 'session-1' }]
    });
    expect(cache.queues.has('draft-1')).toBe(false);
    expect(cache.queues.get('session-1')).toEqual({ version: 2, paused: true, items: [] });
    expect(cache.selectedSessionId).toBe('session-1');
  });

  it('Caches only sessions with native identities and clears their details and selection when leaving a temporary session', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    const cache = state.get('node-1', 'workspace-1');
    const runners = ['codex', 'claude-code', 'opencode', 'mar-agent'] as const;
    const bootstrap = runners.map((runner) => ({
      id: `bootstrap-${runner}`,
      workspaceId: 'workspace-1',
      runner,
      externalSessionId: null
    }));
    const native = runners.map((runner) => ({
      id: `native-${runner}`,
      workspaceId: 'workspace-1',
      runner,
      externalSessionId: `native-${runner}`
    }));

    state.capture(
      cache,
      {
        sessions: [...bootstrap, ...native],
        selectedSessionId: bootstrap[0]!.id,
        queue: { version: 1, paused: false, items: [] },
        detail: {
          sessionId: bootstrap[0]!.id,
          runs: [],
          turns: [],
          nextCursor: null,
          contextUsage: null,
          lastAccessedAt: 1
        }
      },
      2
    );

    expect(cache.sessions).toEqual(native);
    expect(cache.selectedSessionId).toBeUndefined();
    expect(cache.queues.has(bootstrap[0]!.id)).toBe(false);
    expect(cache.sessionDetails.has(bootstrap[0]!.id)).toBe(false);
  });

  it('Does not create or migrate Workspace cache before bootstrap identity is promoted', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );

    state.migrateSession('node-1', 'workspace-1', 'draft:session-1', 'bootstrap-1', {
      id: 'bootstrap-1',
      workspaceId: 'workspace-1',
      runner: 'opencode',
      externalSessionId: null
    });

    expect(state.caches.has('node-1:workspace-1')).toBe(false);
  });
});
