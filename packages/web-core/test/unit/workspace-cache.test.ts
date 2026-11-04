import { describe, expect, it } from 'vitest';
import { createWorkspaceViewCacheService } from '../../src/service/workspace-view-cache-service.js';

describe('Web Workspace View Cache', () => {
  it('captures an Aside detail without changing Main selection or evicting either visible session', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    const main = {
      id: 'main',
      workspaceId: 'w',
      runner: 'codex' as const,
      externalSessionId: 'native-main'
    };
    const child = {
      id: 'child',
      workspaceId: 'w',
      runner: 'codex' as const,
      externalSessionId: 'native-child'
    };
    const queue = { version: 1, paused: false, items: [] };
    const detail = (sessionId: string) => ({
      sessionId,
      runs: [],
      turns: [],
      nextCursor: null,
      contextUsage: null,
      lastAccessedAt: 1
    });
    state.activate('n', 'w');
    state.captureActive(
      { sessions: [main], selectedSessionId: 'main', queue, detail: detail('main') },
      1
    );
    state.captureSession('n', 'w', child, queue, detail('child'), 1);
    expect(state.view('n', 'w').selectedSessionId).toBe('main');
    expect(state.view('n', 'w').sessions).toEqual([main]);
    expect(state.detail('n', 'w', 'main')).toBeDefined();
    expect(state.detail('n', 'w', 'child')).toBeDefined();
    expect(state.queueFor('n', 'w', 'child')).toEqual(queue);
    state.captureActive(
      { sessions: [main], selectedSessionId: 'main', queue, detail: detail('main') },
      1,
      'child'
    );
    expect(state.detail('n', 'w', 'main')).toBeDefined();
    expect(state.detail('n', 'w', 'child')).toBeDefined();

    state.captureSession('other-node', 'w', child, queue, detail('child'), 1);
    state.captureSession('n', 'w', { ...child, workspaceId: 'other' }, queue, detail('child'), 1);
    state.captureSession('n', 'w', child, queue, detail('other-session'), 1);
    expect(state.has('other-node', 'w')).toBe(false);
    expect(state.detail('n', 'w', 'other-session')).toBeUndefined();
    state.remove('n', 'w');
    state.captureSession('n', 'w', child, queue, detail('child'), 1);
    expect(state.has('n', 'w')).toBe(false);
  });

  it('removes all cached state for a deleted session without creating an absent cache', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    state.activate('node-1', 'workspace-1');
    state.captureActive(
      {
        sessions: [
          {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            externalSessionId: 'native'
          }
        ],
        selectedSessionId: 'session-1',
        queue: { version: 1, paused: false, items: [] },
        detail: {
          sessionId: 'session-1',
          runs: [],
          turns: [],
          nextCursor: null,
          contextUsage: null,
          lastAccessedAt: 1
        }
      },
      2
    );
    state.removeSession('node-1', 'workspace-1', 'session-1');
    expect(state.view('node-1', 'workspace-1').sessions).toEqual([]);
    expect(state.view('node-1', 'workspace-1').selectedSessionId).toBeUndefined();
    expect(state.queueFor('node-1', 'workspace-1', 'session-1')).toBeUndefined();
    expect(state.detail('node-1', 'workspace-1', 'session-1')).toBeUndefined();
    state.removeSession('node-2', 'workspace-2', 'session-1');
    expect(state.queueFor('node-2', 'workspace-2', 'session-1')).toBeUndefined();
    state.invalidateDetail('node-2', 'workspace-2', 'session-1');
    state.updateContext('node-2', 'workspace-2', 'session-1', null);
    state.syncRunStatus('node-2', 'workspace-2', 'session-1', 'run-1', 'SUCCEEDED');
    expect(state.has('node-2', 'workspace-2')).toBe(false);
  });

  it('reconciles queue snapshots without reviving a removed workspace cache', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    state.activate('node-1', 'workspace-1');
    const initial = { version: 0, paused: false, items: [] };
    const newer = { version: 2, paused: true, items: [] };
    state.cacheQueue('node-1', 'workspace-1', 'session-1', newer, 'event');
    state.cacheQueue('node-1', 'workspace-1', 'session-1', initial, 'event');
    expect(state.queueFor('node-1', 'workspace-1', 'session-1')).toEqual(newer);
    state.cacheQueue('node-1', 'workspace-1', 'session-1', initial, 'initial');
    expect(state.queueFor('node-1', 'workspace-1', 'session-1')).toEqual(initial);
    state.remove('node-1', 'workspace-1');
    state.cacheQueue('node-1', 'workspace-1', 'session-1', newer, 'event');
    expect(state.touchDetail('node-1', 'workspace-1', 'session-1')).toBeUndefined();
    expect(state.has('node-1', 'workspace-1')).toBe(false);
  });

  it('Keeps distinct Turns of a continuous Run and updates older cached units in place', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    state.activate('node-1', 'workspace-1');
    const turns = ['old', 'new'].map((id) => ({
      id,
      sessionId: 'session-1',
      runId: 'run-1',
      status: 'RUNNING',
      items: []
    }));
    state.captureActive(
      {
        sessions: [
          {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            externalSessionId: 'native'
          }
        ],
        selectedSessionId: 'session-1',
        detail: {
          sessionId: 'session-1',
          runs: [],
          turns,
          nextCursor: null,
          contextUsage: null,
          lastAccessedAt: 1
        }
      },
      2
    );
    state.cacheTurn('node-1', 'workspace-1', { ...turns[0]!, status: 'SUCCEEDED' });
    const cached = state.detail('node-1', 'workspace-1', 'session-1')!.turns;
    expect(cached.map((turn) => turn.id)).toEqual(['old', 'new']);
    expect(cached.map((turn) => turn.status)).toEqual(['SUCCEEDED', 'RUNNING']);
  });

  it('Creates stable caches per Workspace and precisely clears Node-associated state', () => {
    const cache = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    cache.activate('node-1', 'workspace-1');
    cache.captureActive(
      {
        sessions: [
          {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            externalSessionId: 'native'
          }
        ],
        selectedSessionId: 'session-1'
      },
      2
    );
    expect(cache.view('node-1', 'workspace-1').selectedSessionId).toBe('session-1');

    cache.activate('node-2', 'workspace-1');
    cache.removeNode('node-1');
    expect(cache.has('node-1', 'workspace-1')).toBe(false);
    expect(cache.has('node-2', 'workspace-1')).toBe(true);
  });

  it('Caches keep independent Node/Workspace identities and switch active context separately', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    state.activate('node-1', 'workspace-1');
    const first = state.view('node-1', 'workspace-1');
    state.activate('node-2', 'workspace-2');
    const second = state.view('node-2', 'workspace-2');

    expect(first).toMatchObject({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    expect(second).toMatchObject({ nodeId: 'node-2', workspaceId: 'workspace-2' });
    expect(state.isActive('node-2', 'workspace-2')).toBe(true);
    expect(state.view('node-1', 'workspace-1')).toEqual(first);

    state.deactivate();
    expect(state.hasActive()).toBe(false);
    expect(state.view('node-1', 'workspace-1')).toEqual(first);
  });

  it('Evicts session details by LRU while retaining the current session and refreshing its access time', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    state.activate('node-1', 'workspace-1');
    for (const [sessionId, lastAccessedAt] of [
      ['current', 1],
      ['old', 2],
      ['new', 3]
    ] as const)
      state.captureActive(
        {
          sessions: [
            {
              id: 'current',
              workspaceId: 'workspace-1',
              runner: 'codex',
              externalSessionId: 'native'
            }
          ],
          selectedSessionId: 'current',
          detail: {
            sessionId,
            runs: [],
            turns: [],
            nextCursor: null,
            contextUsage: null,
            lastAccessedAt
          }
        },
        2
      );

    expect(state.detail('node-1', 'workspace-1', 'old')).toBeUndefined();
    expect(state.detail('node-1', 'workspace-1', 'current')).toBeDefined();
    expect(state.detail('node-1', 'workspace-1', 'new')).toBeDefined();
    expect(state.touchDetail('node-1', 'workspace-1', 'current', 10)?.lastAccessedAt).toBe(10);
  });

  it('Retains only the newest 15 Segments and clears an old cursor that can no longer be used', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    state.activate('node-1', 'workspace-1');
    state.captureActive(
      {
        sessions: [
          {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            externalSessionId: 'native'
          }
        ],
        selectedSessionId: 'session-1',
        detail: {
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
        }
      },
      2
    );

    const detail = state.detail('node-1', 'workspace-1', 'session-1');
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
    state.activate('node-1', 'workspace-1');
    state.captureActive(
      {
        sessions: [
          {
            id: 'draft-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            externalSessionId: 'old-native',
            activity: 'IDLE'
          }
        ],
        selectedSessionId: 'draft-1',
        detail: {
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
        },
        queue: { version: 1, paused: false, items: [] }
      },
      2
    );
    state.cacheQueue(
      'node-1',
      'workspace-1',
      'session-1',
      { version: 2, paused: true, items: [] },
      'initial'
    );

    state.migrateSession('node-1', 'workspace-1', 'draft-1', 'session-1', {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-session-1',
      activity: 'MANAGED_ACTIVE'
    });

    expect(state.view('node-1', 'workspace-1').sessions).toEqual([
      expect.objectContaining({ id: 'session-1', activity: 'MANAGED_ACTIVE' })
    ]);
    expect(state.detail('node-1', 'workspace-1', 'draft-1')).toBeUndefined();
    expect(state.detail('node-1', 'workspace-1', 'session-1')).toMatchObject({
      sessionId: 'session-1',
      turns: [{ sessionId: 'session-1' }]
    });
    expect(state.queueFor('node-1', 'workspace-1', 'draft-1')).toBeUndefined();
    expect(state.queueFor('node-1', 'workspace-1', 'session-1')).toEqual({
      version: 2,
      paused: true,
      items: []
    });
    expect(state.view('node-1', 'workspace-1').selectedSessionId).toBe('session-1');
  });

  it('Caches only sessions with native identities and clears their details and selection when leaving a temporary session', () => {
    const state = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    state.activate('node-1', 'workspace-1');
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

    state.captureActive(
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

    expect(state.view('node-1', 'workspace-1').sessions).toEqual(native);
    expect(state.view('node-1', 'workspace-1').selectedSessionId).toBeUndefined();
    expect(state.queueFor('node-1', 'workspace-1', bootstrap[0]!.id)).toBeUndefined();
    expect(state.detail('node-1', 'workspace-1', bootstrap[0]!.id)).toBeUndefined();
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

    expect(state.has('node-1', 'workspace-1')).toBe(false);
  });
});
