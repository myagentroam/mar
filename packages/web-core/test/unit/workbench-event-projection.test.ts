import {
  conversationProjectionFixture,
  pagingAnchor
} from './support/conversation-paging-fixture.js';
import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_RECENT_SEGMENT_LIMIT,
  CONVERSATION_SEGMENT_PAGE_SIZE
} from '../../src/util/conversation-history';
import { createWorkbenchConversationPagingService } from '../../src/service/workbench-conversation-paging-service';
import { createWorkbenchEventProjectionService } from '../../src/service/workbench-event-projection-service';
import type { AgentRun, Session } from '../../src/model/workbench';
import { createWorkspaceViewCacheService } from '../../src/service/workspace-view-cache-service.js';
import { createRunService } from '../../src/service/run-service.js';
import { ref } from 'vue';

function turn(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: 'session-1',
    runId: null,
    status: 'RUNNING',
    items: [],
    ...overrides
  };
}

function segmentPage(turns: ReturnType<typeof turn>[], nextCursor: string | null) {
  return {
    unit: 'SEGMENT' as const,
    segments: turns.map((entry, index) => ({
      ...entry,
      turnId: entry.id,
      index,
      status: entry.status
    })),
    nextCursor
  };
}

describe('Workbench Event Projection', () => {
  it('caches a selected native child queue without requiring that child in the Workspace list', () => {
    const cacheQueue = vi.fn();
    const mergeQueue = vi.fn();
    const service = createWorkbenchEventProjectionService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: ref('child'),
      selectedSession: ref({
        id: 'child',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'native-child'
      }),
      sessions: ref([]),
      cacheQueue,
      mergeQueue
    } as never);
    const queue = { version: 1, paused: false, items: [] };
    service.apply(
      { nodeId: 'node-1', sequence: 1, category: 'queue', payload: { sessionId: 'child', queue } },
      'initial'
    );
    expect(cacheQueue).toHaveBeenCalledWith('node-1', 'workspace-1', 'child', queue, 'initial');
    expect(mergeQueue).toHaveBeenCalledWith(queue, 'initial');
  });

  it('accepts only the selected Node Run through its owner and does not reopen a stale active update', () => {
    const selectedSessionId = ref<string | undefined>('session-1');
    const owner = createRunService(selectedSessionId);
    owner.acceptRun({
      id: 'run-1',
      sessionId: 'session-1',
      status: 'SUCCEEDED',
      version: 3
    } as AgentRun);
    const openRun = vi.fn();
    const cacheRun = vi.fn();
    const service = createWorkbenchEventProjectionService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId,
      syncTurnStatus: vi.fn(),
      cacheRun,
      acceptRun: owner.acceptRun,
      openRun
    } as never);

    service.apply({
      nodeId: 'node-1',
      sequence: 1,
      category: 'run',
      payload: { run: { id: 'run-1', sessionId: 'session-1', status: 'RUNNING', version: 2 } }
    });
    service.apply({
      nodeId: 'node-2',
      sequence: 2,
      category: 'run',
      payload: { run: { id: 'other', sessionId: 'session-1', status: 'RUNNING' } }
    });
    expect(owner.runs.value).toMatchObject([{ id: 'run-1', status: 'SUCCEEDED', version: 3 }]);
    expect(cacheRun).toHaveBeenCalledTimes(1);
    expect(openRun).not.toHaveBeenCalled();
  });

  it('Refreshes complete metadata when a Node reconnects so version-gated capabilities are updated', () => {
    const nodes = {
      value: [{ id: 'node-1', connected: false, nodeAppVersion: '0.9.11' }]
    };
    const onNodeConnected = vi.fn();
    const service = createWorkbenchEventProjectionService({
      nodes,
      setNodeConnection: (nodeId: string, connected: boolean) => {
        const node = nodes.value.find((item) => item.id === nodeId);
        if (node === undefined) return undefined;
        const previous = node.connected;
        node.connected = connected;
        return previous;
      },
      sessions: { value: [] },
      runs: { value: [] },
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: undefined },
      conversationNextCursor: { value: null },
      cacheQueue: vi.fn(),
      mergeQueue: vi.fn(),
      mergeSessions: vi.fn(),
      settleSessionRuns: () => false,
      observeManagedSessionActive: vi.fn(),
      updateContext: vi.fn(),
      syncTurnStatus: vi.fn(),
      cacheRun: vi.fn(),
      acceptRun: (next: AgentRun) => next,
      openRun: vi.fn(),
      markLiveTurn: vi.fn(),
      cacheTurn: vi.fn(),
      mergeTurns: () => false,
      applyConversationSnapshot: () => false,
      mergeTextDelta: vi.fn(),
      invalidateWorkspace: vi.fn(),
      onNodeConnected
    } as never);

    service.updateNodeConnection('node-1', true);

    expect(nodes.value[0]).toMatchObject({ connected: true, nodeAppVersion: '0.9.11' });
    expect(onNodeConnected).toHaveBeenCalledOnce();
    expect(onNodeConnected).toHaveBeenCalledWith('node-1');

    service.updateNodeConnection('node-1', true);
    expect(onNodeConnected).toHaveBeenCalledOnce();

    service.updateNodeConnection('node-1', false);
    expect(onNodeConnected).toHaveBeenCalledOnce();
  });

  it('projects MAR Agent Session events only through the Watch projection entry, not ordinary broadcasts', () => {
    const mergeSessions = vi.fn();
    const service = createWorkbenchEventProjectionService({
      nodes: { value: [] },
      sessions: { value: [] },
      runs: { value: [] },
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: undefined },
      conversationNextCursor: { value: null },
      cacheQueue: vi.fn(),
      mergeQueue: vi.fn(),
      mergeSessions,
      settleSessionRuns: () => false,
      observeManagedSessionActive: vi.fn(),
      updateContext: vi.fn(),
      syncTurnStatus: vi.fn(),
      cacheRun: vi.fn(),
      acceptRun: (next: AgentRun) => next,
      openRun: vi.fn(),
      markLiveTurn: vi.fn(),
      cacheTurn: vi.fn(),
      mergeTurns: () => false,
      applyConversationSnapshot: () => false,
      mergeTextDelta: vi.fn(),
      invalidateWorkspace: vi.fn(),
      onNodeConnected: vi.fn()
    } as never);

    const event = {
      nodeId: 'node-1',
      sequence: 1,
      category: 'session' as const,
      payload: {
        session: {
          id: 'native-mar-agent-1',
          workspaceId: 'workspace-1',
          runner: 'mar-agent',
          externalSessionId: 'native-mar-agent-1'
        }
      }
    };

    service.applyBroadcast(event);
    expect(mergeSessions).not.toHaveBeenCalled();
    service.apply(event);

    expect(mergeSessions).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'native-mar-agent-1', runner: 'mar-agent' })
    ]);
  });

  it('Real-time queue events do not populate the cache for a temporary Session without native identity', () => {
    const sessions: { value: Session[] } = {
      value: [
        {
          id: 'bootstrap-1',
          workspaceId: 'workspace-1',
          runner: 'mar-agent',
          externalSessionId: null
        }
      ]
    };
    const cacheQueue = vi.fn();
    const service = createWorkbenchEventProjectionService({
      nodes: { value: [] },
      sessions,
      runs: { value: [] },
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: 'bootstrap-1' },
      conversationNextCursor: { value: null },
      cacheQueue,
      mergeQueue: vi.fn(),
      mergeSessions: vi.fn(),
      settleSessionRuns: () => false,
      observeManagedSessionActive: vi.fn(),
      updateContext: vi.fn(),
      syncTurnStatus: vi.fn(),
      cacheRun: vi.fn(),
      acceptRun: (next: AgentRun) => next,
      openRun: vi.fn(),
      markLiveTurn: vi.fn(),
      cacheTurn: vi.fn(),
      mergeTurns: () => false,
      applyConversationSnapshot: () => false,
      mergeTextDelta: vi.fn(),
      invalidateWorkspace: vi.fn(),
      onNodeConnected: vi.fn()
    } as never);

    service.apply({
      nodeId: 'node-1',
      sequence: 1,
      category: 'queue',
      payload: {
        sessionId: 'bootstrap-1',
        queue: { version: 1, paused: false, items: [] }
      }
    });

    expect(cacheQueue).not.toHaveBeenCalled();
  });

  it('A Session Watch initial queue snapshot replaces an expired cache for the same Session', () => {
    const stale = { version: 8, paused: true, items: [{ queueItemId: 'stale-item' }] };
    const authoritative = { version: 0, paused: false, items: [] };
    const sessions: { value: Session[] } = {
      value: [
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          externalSessionId: 'native-session-1'
        }
      ]
    };
    const cacheService = createWorkspaceViewCacheService(
      (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
    );
    cacheService.activate('node-1', 'workspace-1');
    cacheService.cacheQueue('node-1', 'workspace-1', 'session-1', stale as never, 'initial');
    const mergeQueue = vi.fn();
    const service = createWorkbenchEventProjectionService({
      nodes: { value: [] },
      sessions,
      runs: { value: [] },
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: 'session-1' },
      conversationNextCursor: { value: null },
      cacheQueue: cacheService.cacheQueue,
      mergeQueue,
      mergeSessions: vi.fn(),
      settleSessionRuns: () => false,
      observeManagedSessionActive: vi.fn(),
      updateContext: vi.fn(),
      syncTurnStatus: vi.fn(),
      cacheRun: vi.fn(),
      acceptRun: (next: AgentRun) => next,
      openRun: vi.fn(),
      markLiveTurn: vi.fn(),
      cacheTurn: vi.fn(),
      mergeTurns: () => false,
      applyConversationSnapshot: () => false,
      mergeTextDelta: vi.fn(),
      invalidateWorkspace: vi.fn(),
      onNodeConnected: vi.fn()
    } as never);

    service.apply(
      {
        nodeId: 'node-1',
        sequence: 2,
        category: 'queue',
        payload: { sessionId: 'session-1', queue: authoritative }
      },
      'initial'
    );

    expect(cacheService.queueFor('node-1', 'workspace-1', 'session-1')).toBe(authoritative);
    expect(mergeQueue).toHaveBeenCalledWith(authoritative, 'initial');
  });

  it('allows manual upward paging to exceed 15 Turns temporarily and uses the cursor returned by Node on recent-window refresh', async () => {
    const turns = {
      value: Array.from({ length: 30 }, (_, index) => turn(`turn-${index + 11}`))
    };
    const nextCursor = { value: 'before-11' as string | null };
    const requests: string[] = [];
    const replaceRecent = vi.fn();
    const service = createWorkbenchConversationPagingService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: ref('session-1'),
      nextCursor: nextCursor as never,
      loadingOlder: { value: false } as never,
      ...conversationProjectionFixture(turns, nextCursor),
      capturePrependAnchor: pagingAnchor(),
      pageSize: CONVERSATION_SEGMENT_PAGE_SIZE,
      recentSegmentWindowSize: CONVERSATION_RECENT_SEGMENT_LIMIT,
      replaceRecent,
      request: async (path) => {
        requests.push(path);
        return (
          path.includes('cursor=')
            ? segmentPage(
                Array.from({ length: 3 }, (_, index) => turn(`turn-${index + 8}`)),
                'before-8'
              )
            : segmentPage(
                Array.from({ length: 15 }, (_, index) => turn(`turn-${index + 27}`)),
                'before-27'
              )
        ) as never;
      },
      sessionPathId: (value) => value,
      notice: vi.fn(),
      errorMessage: String
    });

    await service.loadOlderConversationTurns();
    expect(turns.value).toHaveLength(33);
    expect(nextCursor.value).toBe('before-8');
    await service.refreshRecentConversationTurns();
    expect(requests[0]).toContain('limit=3&cursor=before-11');
    expect(requests[1]).toContain('limit=15');
    expect(requests[1]).not.toContain('cursor=');
    expect(replaceRecent).toHaveBeenCalledWith(
      expect.objectContaining({ nextCursor: 'before-27' })
    );
  });

  it('Always requests Segment pages through the same turns endpoint', async () => {
    const requests: string[] = [];
    const turns = { value: [turn('turn-1:segment:1', { turnId: 'turn-1', segmentIndex: 1 })] };
    const nextCursor = { value: 'segment-cursor' as string | null };
    const service = createWorkbenchConversationPagingService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: ref('session-1'),
      nextCursor: nextCursor as never,
      loadingOlder: { value: false } as never,
      ...conversationProjectionFixture(turns, nextCursor),
      capturePrependAnchor: pagingAnchor(),
      pageSize: 10,
      recentSegmentWindowSize: 30,
      replaceRecent: vi.fn(),
      request: async (path) => {
        requests.push(path);
        return {
          unit: 'SEGMENT',
          segments: [],
          nextCursor: null,
          snapshotSequence: 1,
          source: 'runtime',
          readAt: 1,
          latestVisibleAt: 1
        } as never;
      },
      sessionPathId: (value) => value,
      notice: vi.fn(),
      errorMessage: String
    });

    await service.loadOlderConversationTurns();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/turns?');
    expect(requests[0]).toContain('cursor=segment-cursor');
    expect(requests[0]).toContain('unit=SEGMENT');
  });

  it('Rebuilding the recent window invalidates in-flight old paging and applies only the final response as new Turns arrive', async () => {
    const turns = { value: [turn('turn-31')] };
    const nextCursor = { value: 'older' as string | null };
    const pending: ((page: never) => void)[] = [];
    const replaceRecent = vi.fn();
    const service = createWorkbenchConversationPagingService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: ref('session-1'),
      nextCursor: nextCursor as never,
      loadingOlder: { value: false } as never,
      ...conversationProjectionFixture(turns, nextCursor),
      capturePrependAnchor: pagingAnchor(),
      pageSize: 10,
      recentSegmentWindowSize: 30,
      replaceRecent,
      request: () => new Promise((resolve) => pending.push(resolve as (page: never) => void)),
      sessionPathId: (value) => value,
      notice: vi.fn(),
      errorMessage: String
    });

    const older = service.loadOlderConversationTurns();
    await Promise.resolve();
    const recent = service.refreshRecentConversationTurns();
    await Promise.resolve();
    await service.refreshRecentConversationTurns();
    pending[1]?.(segmentPage([turn('stale-recent')], 'stale-cursor') as never);
    await Promise.resolve();
    pending[2]?.(segmentPage([turn('latest-recent')], 'latest-cursor') as never);
    await recent;
    pending[0]?.(segmentPage([turn('stale-older')], 'older-cursor') as never);
    await older;

    expect(replaceRecent).toHaveBeenCalledOnce();
    expect(replaceRecent).toHaveBeenCalledWith(
      expect.objectContaining({ nextCursor: 'latest-cursor' })
    );
    expect(turns.value.map((item) => item.id)).toEqual(['turn-31']);
    expect(nextCursor.value).toBe('older');
  });

  it('Watch initial convergence establishes idle state, while real-time deltas project only the current ready Run', () => {
    const sessions: { value: Session[] } = {
      value: [
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          activity: 'MANAGED_ACTIVE'
        }
      ]
    };
    const runs: { value: AgentRun[] } = {
      value: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          status: 'RUNNING'
        } as AgentRun
      ]
    };
    const nextCursor = { value: 'runtime-cursor' as string | null };
    const mergeItem = vi.fn();
    const mergeTextDelta = vi.fn();
    const service = createWorkbenchEventProjectionService({
      nodes: { value: [] },
      sessions,
      runs,
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: 'session-1' },
      conversationNextCursor: nextCursor,
      cacheQueue: vi.fn(),
      mergeQueue: vi.fn(),
      mergeSessions: (incoming: readonly Session[]) => {
        sessions.value = [...incoming];
      },
      settleSessionRuns: () => false,
      observeManagedSessionActive: vi.fn(),
      updateContext: vi.fn(),
      syncTurnStatus: vi.fn(),
      cacheRun: vi.fn(),
      acceptRun: (next: AgentRun) => next,
      openRun: vi.fn(),
      markLiveTurn: vi.fn(),
      cacheTurn: vi.fn(),
      mergeTurns: () => false,
      applyConversationSnapshot: () => false,
      mergeItem,
      mergeTextDelta,
      invalidateWorkspace: vi.fn()
    } as never);

    service.apply({
      nodeId: 'node-1',
      sequence: 1,
      category: 'session',
      payload: {
        session: {
          id: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          activity: 'IDLE'
        }
      }
    });

    // SDK Runtime remains authoritative after completion; its pagination cursor stays valid.
    expect(nextCursor.value).toBe('runtime-cursor');

    service.apply({
      nodeId: 'node-1',
      sequence: 2,
      category: 'conversation',
      payload: {
        event: {
          runId: 'unknown-run',
          sequence: 2,
          eventType: 'text.delta',
          payload: { text: 'ignored' }
        }
      }
    });

    service.apply({
      nodeId: 'node-1',
      sequence: 3,
      category: 'conversation',
      payload: {
        event: {
          runId: 'run-1',
          sequence: 3,
          eventType: 'text.delta',
          payload: { text: 'applied' }
        }
      }
    });

    expect(mergeTextDelta).not.toHaveBeenCalled();

    service.apply({
      nodeId: 'node-1',
      sequence: 4,
      category: 'conversation',
      payload: {
        sessionId: 'session-1',
        delta: {
          runId: 'run-1',
          itemId: 'run-1:codex:item-1',
          text: 'normalized',
          createdAt: 4
        }
      }
    });

    expect(mergeTextDelta).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ itemId: 'run-1:codex:item-1', text: 'normalized' }),
      4,
      4
    );

    service.apply({
      nodeId: 'node-1',
      sequence: 5,
      category: 'conversation',
      payload: {
        sessionId: 'session-1',
        runId: 'run-1',
        item: {
          itemId: 'run-1:tool-1',
          kind: 'tool_call',
          status: 'COMPLETED',
          segmentId: 'turn-1:segment:1',
          segmentIndex: 1,
          startedAt: 3,
          completedAt: 5,
          payload: { outputSummary: 'Complete' }
        }
      }
    });

    expect(mergeItem).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        itemId: 'run-1:tool-1',
        segmentId: 'turn-1:segment:1',
        payload: { outputSummary: 'Complete' }
      }),
      5,
      3
    );
  });

  it.each(['session-1', 'session-2', undefined])(
    'settles only the selected Run before merging idle status with selection %s',
    (selectedSessionId) => {
      const sessions: { value: Session[] } = {
        value: [
          {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'mar-agent',
            activity: 'MANAGED_ACTIVE'
          }
        ]
      };
      const runs: { value: AgentRun[] } = {
        value: [{ id: 'run-1', sessionId: 'session-1', status: 'RUNNING' } as AgentRun]
      };
      const order: string[] = [];
      const service = createWorkbenchEventProjectionService({
        nodes: { value: [] },
        sessions,
        runs,
        workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
        selectedSessionId: { value: selectedSessionId },
        conversationNextCursor: { value: 'runtime-cursor' },
        cacheQueue: vi.fn(),
        mergeQueue: vi.fn(),
        mergeSessions: (incoming: readonly Session[]) => {
          order.push('merge');
          const next = incoming[0]!;
          const hasActiveRun = runs.value.some(
            (run) =>
              run.sessionId === next.id &&
              ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
          );
          sessions.value = [
            selectedSessionId === next.id &&
            hasActiveRun &&
            sessions.value[0]?.activity === 'MANAGED_ACTIVE'
              ? { ...next, activity: 'MANAGED_ACTIVE' }
              : next
          ];
        },
        settleSessionRuns: () => {
          order.push('settle');
          const settled = runs.value.length > 0;
          runs.value = [];
          return settled;
        },
        observeManagedSessionActive: vi.fn(),
        updateContext: vi.fn(),
        syncTurnStatus: vi.fn(),
        cacheRun: vi.fn(),
        acceptRun: (next: AgentRun) => next,
        openRun: vi.fn(),
        markLiveTurn: vi.fn(),
        cacheTurn: vi.fn(),
        mergeTurns: () => false,
        applyConversationSnapshot: () => false,
        mergeItem: vi.fn(),
        mergeTextDelta: vi.fn(),
        invalidateWorkspace: vi.fn()
      } as never);

      service.apply({
        nodeId: 'node-1',
        sequence: 1,
        category: 'session',
        payload: {
          session: {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'mar-agent',
            activity: 'IDLE'
          }
        }
      });

      expect(order).toEqual(selectedSessionId === 'session-1' ? ['settle', 'merge'] : ['merge']);
      expect(sessions.value[0]?.activity).toBe('IDLE');
      expect(runs.value).toHaveLength(selectedSessionId === 'session-1' ? 0 : 1);
      service.apply({
        nodeId: 'node-1',
        sequence: 2,
        category: 'session',
        payload: {
          session: {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'mar-agent',
            activity: 'IDLE'
          }
        }
      });
      expect(sessions.value[0]?.activity).toBe('IDLE');
      expect(runs.value).toHaveLength(selectedSessionId === 'session-1' ? 0 : 1);
    }
  );
});

describe('Segment-only conversation ingress', () => {
  it.each([undefined, [{ id: 'malformed', items: [] }]])(
    'rejects raw Turn fallback when Segments are %j',
    (segments) => {
      const mergeTurns = vi.fn();
      const cacheTurn = vi.fn();
      const markLiveTurn = vi.fn();
      const service = createWorkbenchEventProjectionService({
        workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
        selectedSessionId: { value: 'session-1' },
        conversationNextCursor: { value: null },
        mergeTurns,
        cacheTurn,
        markLiveTurn
      } as never);
      service.apply({
        nodeId: 'node-1',
        sequence: 10,
        category: 'conversation',
        payload: {
          turn: turn('runtime-turn'),
          ...(segments === undefined ? {} : { segments })
        }
      });
      expect(mergeTurns).not.toHaveBeenCalled();
      expect(cacheTurn).not.toHaveBeenCalled();
      expect(markLiveTurn).not.toHaveBeenCalled();
    }
  );
});
