import { ref } from 'vue';
import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONVERSATION_ITEM_TEXT_CHARACTERS,
  MAX_CONVERSATION_SEGMENT_ITEMS,
  reconcileOptimisticConversationTurns,
  limitConversationHistory
} from '../../src/util/conversation-history.js';
import { createWorkbenchConversationPagingService } from '../../src/service/WorkbenchConversationPagingService.js';
import { ApiError } from '../../src/util/api-error.js';
import type { ConversationTurn, ConversationTurnPage } from '../../src/model/workbench.js';

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

describe('Conversation History Pagination', () => {
  it('does not merge a first-generation A page after A to B to A', async () => {
    const workspaceTarget = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const turns = ref([turn('current')]);
    const nextCursor = ref<string | null>('cursor');
    const loadingOlder = ref(false);
    let finish!: (page: unknown) => void;
    const service = createWorkbenchConversationPagingService({
      workspaceTarget,
      selectedSessionId: ref('session-1'),
      turns: turns as never,
      nextCursor,
      loadingOlder,
      scrollElement: ref(),
      pageSize: 10,
      recentSegmentWindowSize: 30,
      replaceRecent: vi.fn(),
      request: () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as never,
      sessionPathId: (value) => value,
      notice: ref(''),
      errorMessage: String
    });
    const pending = service.loadOlderConversationTurns();
    workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-2' };
    workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-1' };
    finish({ turns: [turn('stale')], nextCursor: null });
    await pending;
    expect(turns.value.map((value) => value.id)).toEqual(['current']);
    expect(nextCursor.value).toBe('cursor');
    expect(loadingOlder.value).toBe(false);
  });

  it('Discards success or failure from an in-flight page request when the authoritative window has replaced its cursor', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const turns = { value: [turn('current')] };
      const nextCursor = { value: 'runtime-cursor' as string | null };
      const notice = { value: '' };
      let resolveRequest!: (value: unknown) => void;
      let rejectRequest!: (error: Error) => void;
      const service = createWorkbenchConversationPagingService({
        workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
        selectedSessionId: { value: 'session-1' } as never,
        nextCursor: nextCursor as never,
        loadingOlder: { value: false } as never,
        turns: turns as never,
        scrollElement: { value: undefined } as never,
        pageSize: 10,
        recentSegmentWindowSize: 30,
        replaceRecent: vi.fn(),
        request: () =>
          new Promise((resolve, reject) => {
            resolveRequest = resolve;
            rejectRequest = reject;
          }) as never,
        sessionPathId: (value) => value,
        notice: notice as never,
        errorMessage: String
      });

      const pending = service.loadOlderConversationTurns();
      await Promise.resolve();
      nextCursor.value = 'official-cursor';
      if (outcome === 'resolve')
        resolveRequest({
          unit: 'SEGMENT',
          segments: [turn('stale')],
          nextCursor: null
        });
      else rejectRequest(new Error('EVENT_CURSOR_INVALID'));
      await pending;

      expect(turns.value.map((candidate) => candidate.id)).toEqual(['current']);
      expect(nextCursor.value).toBe('official-cursor');
      expect(notice.value).toBe('');
    }
  });

  it('Keeps displayed history when the page cursor expires and retries once with the latest cursor', async () => {
    const turns = { value: [turn('already-loaded'), turn('current')] };
    const nextCursor = { value: 'expired-cursor' as string | null };
    const notice = { value: '' };
    const requests: string[] = [];
    const scrollElement = {
      scrollTop: 50,
      get scrollHeight() {
        return turns.value.length * 100;
      }
    };
    const service = createWorkbenchConversationPagingService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: 'session-1' } as never,
      nextCursor: nextCursor as never,
      loadingOlder: { value: false } as never,
      turns: turns as never,
      scrollElement: { value: scrollElement } as never,
      pageSize: 10,
      recentSegmentWindowSize: 15,
      replaceRecent: vi.fn(),
      request: async (path) => {
        requests.push(path);
        if (path.includes('cursor=expired-cursor'))
          throw new ApiError('EVENT_CURSOR_INVALID', 'The request failed (EVENT_CURSOR_INVALID).');
        if (!path.includes('cursor='))
          return segmentPage([turn('current'), turn('latest')], 'recovered-cursor') as never;
        return segmentPage([turn('older')], null) as never;
      },
      sessionPathId: (value) => value,
      notice: notice as never,
      errorMessage: String
    });

    await service.loadOlderConversationTurns();

    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain('limit=15&unit=SEGMENT');
    expect(requests[1]).not.toContain('cursor=');
    expect(requests[2]).toContain('limit=10&cursor=recovered-cursor');
    expect(turns.value.map((candidate) => candidate.id)).toEqual([
      'older',
      'already-loaded',
      'current',
      'latest'
    ]);
    expect(nextCursor.value).toBeNull();
    expect(notice.value).toBe('');
    expect(scrollElement.scrollTop).toBe(150);
  });

  it('Reports cursor-repair failure until a later explicit load retries successfully', async () => {
    const turns = { value: [turn('current')] };
    const nextCursor = { value: 'expired-cursor' as string | null };
    const notice = { value: '' };
    const requests: string[] = [];
    const service = createWorkbenchConversationPagingService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: 'session-1' } as never,
      nextCursor: nextCursor as never,
      loadingOlder: { value: false } as never,
      turns: turns as never,
      scrollElement: { value: undefined } as never,
      pageSize: 10,
      recentSegmentWindowSize: 15,
      replaceRecent: vi.fn(),
      request: async (path) => {
        requests.push(path);
        if (requests.length <= 3) throw new Error('EVENT_CURSOR_INVALID');
        if (requests.length === 4)
          return segmentPage([turn('current'), turn('latest')], 'manual-recovered-cursor') as never;
        return segmentPage([turn('older')], null) as never;
      },
      sessionPathId: (value) => value,
      notice: notice as never,
      errorMessage: String
    });

    await service.loadOlderConversationTurns();

    expect(requests).toHaveLength(2);
    expect(turns.value.map((candidate) => candidate.id)).toEqual(['current']);
    expect(nextCursor.value).toBe('expired-cursor');
    expect(service.olderHistoryError.value).toContain('EVENT_CURSOR_INVALID');
    expect(notice.value).toBe('');

    await service.loadOlderConversationTurns();

    expect(requests).toHaveLength(5);
    expect(turns.value.map((candidate) => candidate.id)).toEqual(['older', 'current', 'latest']);
    expect(nextCursor.value).toBeNull();
    expect(service.olderHistoryError.value).toBe('');
  });

  it('Clears older loading when a recent refresh invalidates its in-flight page', async () => {
    const workspaceTarget = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const turns = ref<ConversationTurn[]>([turn('current')]);
    const nextCursor = ref<string | null>('older-cursor');
    const loadingOlder = ref(false);
    let resolveOlder!: (value: unknown) => void;
    let resolveRecent!: (value: unknown) => void;
    const olderPage = new Promise<unknown>((resolve) => {
      resolveOlder = resolve;
    });
    const recentPage = new Promise<unknown>((resolve) => {
      resolveRecent = resolve;
    });
    const service = createWorkbenchConversationPagingService({
      workspaceTarget,
      selectedSessionId: ref('session-1'),
      turns: turns as never,
      nextCursor,
      loadingOlder,
      scrollElement: ref(),
      pageSize: 10,
      recentSegmentWindowSize: 30,
      replaceRecent: (page) => {
        turns.value = page.turns;
        nextCursor.value = page.nextCursor;
      },
      request: (path) => (path.includes('cursor=older-cursor') ? olderPage : recentPage) as never,
      sessionPathId: (value) => value,
      notice: ref(''),
      errorMessage: String
    });

    const loading = service.loadOlderConversationTurns();
    expect(loadingOlder.value).toBe(true);
    const refreshing = service.refreshRecentConversationTurns();
    resolveRecent(segmentPage([turn('latest')], 'fresh-cursor'));
    await refreshing;
    resolveOlder(segmentPage([turn('stale-older')], null));
    await loading;

    expect(turns.value.map((value) => value.id)).toEqual(['latest']);
    expect(nextCursor.value).toBe('fresh-cursor');
    expect(loadingOlder.value).toBe(false);
  });

  it('Discards a late recent refresh after the selected target changes A to B to A', async () => {
    const workspaceTarget = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const turns = ref<ConversationTurn[]>([turn('current')]);
    const nextCursor = ref<string | null>('current-cursor');
    let resolveRecent!: (value: unknown) => void;
    const recentPage = new Promise<unknown>((resolve) => {
      resolveRecent = resolve;
    });
    const replaceRecent = vi.fn((page: ConversationTurnPage) => {
      turns.value = page.turns;
      nextCursor.value = page.nextCursor;
    });
    const service = createWorkbenchConversationPagingService({
      workspaceTarget,
      selectedSessionId: ref('session-1'),
      turns: turns as never,
      nextCursor,
      loadingOlder: ref(false),
      scrollElement: ref(),
      pageSize: 10,
      recentSegmentWindowSize: 30,
      replaceRecent,
      request: () => recentPage as never,
      sessionPathId: (value) => value,
      notice: ref(''),
      errorMessage: String
    });

    const refreshing = service.refreshRecentConversationTurns();
    workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-2' };
    workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-1' };
    resolveRecent(segmentPage([turn('stale-refresh')], 'stale-cursor'));
    await refreshing;

    expect(replaceRecent).not.toHaveBeenCalled();
    expect(turns.value.map((value) => value.id)).toEqual(['current']);
    expect(nextCursor.value).toBe('current-cursor');
  });

  it('Invalidates old recovery when the authoritative window changes during cursor repair', async () => {
    const turns = { value: [turn('current')] };
    const nextCursor = { value: 'expired-cursor' as string | null };
    const notice = { value: '' };
    const requests: string[] = [];
    let resolveRecovery!: (value: unknown) => void;
    const service = createWorkbenchConversationPagingService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: 'session-1' } as never,
      nextCursor: nextCursor as never,
      loadingOlder: { value: false } as never,
      turns: turns as never,
      scrollElement: { value: undefined } as never,
      pageSize: 10,
      recentSegmentWindowSize: 15,
      replaceRecent: vi.fn(),
      request: (path) => {
        requests.push(path);
        if (path.includes('cursor=')) return Promise.reject(new Error('EVENT_CURSOR_INVALID'));
        return new Promise((resolve) => {
          resolveRecovery = resolve;
        }) as never;
      },
      sessionPathId: (value) => value,
      notice: notice as never,
      errorMessage: String
    });

    const pending = service.loadOlderConversationTurns();
    await Promise.resolve();
    await Promise.resolve();
    nextCursor.value = 'authoritative-cursor';
    resolveRecovery(segmentPage([turn('current')], 'stale-recovered-cursor'));
    await pending;

    expect(requests).toHaveLength(2);
    expect(nextCursor.value).toBe('authoritative-cursor');
    expect(turns.value.map((candidate) => candidate.id)).toEqual(['current']);
    expect(notice.value).toBe('');
  });

  it('Do not fold missing runId historical Segment errors into the same Turn', () => {
    const turns = reconcileOptimisticConversationTurns([
      turn('turn-1', {
        items: [
          { id: 'item-1', kind: 'assistant_message', status: 'COMPLETED', payload: { text: 'one' } }
        ]
      }),
      turn('turn-2', {
        items: [
          { id: 'item-2', kind: 'assistant_message', status: 'COMPLETED', payload: { text: 'two' } }
        ]
      })
    ]);

    expect(turns.map((item) => item.id)).toEqual(['turn-1', 'turn-2']);
  });

  it('Preserves distinct Node-owned Turns even when clientMessageId matches', () => {
    const turns = reconcileOptimisticConversationTurns([
      turn('official', {
        items: [
          {
            id: 'user',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: { clientMessageId: 'message-1' }
          }
        ]
      }),
      turn('runtime', {
        runId: 'run-1',
        items: [
          {
            id: 'user',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: { clientMessageId: 'message-1' }
          },
          {
            id: 'assistant',
            kind: 'assistant_message',
            status: 'IN_PROGRESS',
            payload: { text: 'Processing...' }
          }
        ]
      })
    ]);

    expect(turns.map((entry) => entry.id)).toEqual(['official', 'runtime']);
  });

  it('Keeps multiple Segments from the same Turn separate instead of collapsing them by shared runId', () => {
    const segments = reconcileOptimisticConversationTurns([
      turn('turn-1:segment:0', {
        turnId: 'turn-1',
        segmentIndex: 0,
        runId: 'run-1',
        items: [
          {
            id: 'user-1',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: { clientMessageId: 'client-1', text: 'Start' }
          }
        ]
      }),
      turn('turn-1:segment:1', {
        turnId: 'turn-1',
        segmentIndex: 1,
        runId: 'run-1',
        items: []
      }),
      turn('turn-1:segment:2', {
        turnId: 'turn-1',
        segmentIndex: 2,
        runId: 'run-1',
        items: []
      })
    ]);

    expect(segments.map((segment) => segment.id)).toEqual([
      'turn-1:segment:0',
      'turn-1:segment:1',
      'turn-1:segment:2'
    ]);
  });

  it('Preserves Node-owned question identities without merging their request payloads', () => {
    const input = ['old', 'new'].map((id) =>
      turn(id, {
        items: [
          {
            id: `${id}-question`,
            kind: 'user_input_request',
            status: 'PENDING',
            payload: { requestId: 'shared-request' }
          }
        ]
      })
    );
    const retained = limitConversationHistory(input);
    expect(retained.map((entry) => entry.id)).toEqual(['old', 'new']);
    expect(retained.map((entry) => entry.items[0]?.id)).toEqual(['old-question', 'new-question']);
  });

  it('Evicts from the oldest Turn when the memory window is exceeded while retaining contiguous newer records', () => {
    const newest = turn('newest', {
      items: [
        {
          id: 'newest-message',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'New'.repeat(100) }
        }
      ]
    });
    const middle = turn('middle', {
      items: [
        {
          id: 'middle-message',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Medium'.repeat(100) }
        }
      ]
    });
    const oldest = turn('oldest', {
      items: [
        {
          id: 'oldest-message',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Old'.repeat(100) }
        }
      ]
    });
    const twoTurnBytes =
      new TextEncoder().encode(JSON.stringify(newest)).byteLength +
      new TextEncoder().encode(JSON.stringify(middle)).byteLength +
      3;

    expect(
      limitConversationHistory([oldest, middle, newest], twoTurnBytes).map((item) => item.id)
    ).toEqual(['middle', 'newest']);
  });

  it('When a single newest Turn exceeds the limit, removes large payloads while preserving the local truncation notice', () => {
    const oversized = turn('newest', {
      items: [
        {
          id: 'assistant',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Content'.repeat(10_000), metadata: 'additional data '.repeat(10_000) }
        }
      ]
    });

    const limited = limitConversationHistory([oversized], 2_048);
    const bytes = new TextEncoder().encode(JSON.stringify(limited)).byteLength;
    const payloads = limited[0]?.items.map((item) => item.payload) ?? [];

    expect(bytes).toBeLessThanOrEqual(2_048);
    expect(payloads).toEqual(
      expect.arrayContaining([expect.objectContaining({ truncated: true })])
    );
    expect(JSON.stringify(payloads)).not.toContain('additional data');
  });

  it('Even within the total window limit, bounds a single message body to prevent terminal history from expanding the page again', () => {
    const limited = limitConversationHistory([
      turn('long-message', {
        items: [
          {
            id: 'assistant',
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: `${'older '.repeat(80_000)}latest content` }
          }
        ]
      })
    ]);
    const payload = limited[0]?.items[0]?.payload as {
      text?: string;
      truncated?: boolean;
    };

    expect(payload.truncated).toBe(true);
    expect(payload.text?.length).toBeLessThanOrEqual(MAX_CONVERSATION_ITEM_TEXT_CHARACTERS);
    expect(payload.text).toMatch(/latest content$/u);
  });

  it('Bounds output fields appended by tools so a long Run cannot grow one tool item without limit', () => {
    const limited = limitConversationHistory([
      turn('long-tool-output', {
        items: [
          {
            id: 'tool',
            kind: 'tool_call',
            status: 'IN_PROGRESS',
            payload: {
              outputPreview: `${'older '.repeat(80_000)}latest preview`,
              outputSummary: `${'older '.repeat(80_000)}latest summary`
            }
          }
        ]
      })
    ]);
    const payload = limited[0]?.items[0]?.payload as {
      outputPreview?: string;
      outputSummary?: string;
      truncated?: boolean;
    };

    expect(payload.truncated).toBe(true);
    expect(payload.outputPreview?.length).toBeLessThanOrEqual(
      MAX_CONVERSATION_ITEM_TEXT_CHARACTERS
    );
    expect(payload.outputSummary?.length).toBeLessThanOrEqual(
      MAX_CONVERSATION_ITEM_TEXT_CHARACTERS
    );
    expect(payload.outputPreview).toMatch(/latest preview$/u);
    expect(payload.outputSummary).toMatch(/latest summary$/u);
  });

  it('limits the Item count of each Turn in a long Run while retaining the user input and newest result', () => {
    const limited = limitConversationHistory([
      turn('long-run', {
        items: [
          { id: 'user', kind: 'user_message', status: 'COMPLETED', payload: { text: 'Task' } },
          ...Array.from({ length: 250 }, (_, index) => ({
            id: `tool-${index}`,
            kind: 'tool_call',
            status: 'COMPLETED',
            payload: { text: `Tool call ${index}` }
          }))
        ]
      })
    ]);
    const items = limited[0]?.items ?? [];

    expect(items).toHaveLength(MAX_CONVERSATION_SEGMENT_ITEMS);
    expect(items[0]?.id).toBe('user');
    expect(items.some((item) => item.kind === 'warning')).toBe(true);
    expect(items.at(-1)?.id).toBe('tool-249');
  });

  it('Reuses Turn-body normalization and byte estimation when limiting an unchanged long Run', () => {
    let serializations = 0;
    const payload = {
      outputSummary: 'result '.repeat(10_000),
      toJSON() {
        serializations += 1;
        return { outputSummary: this.outputSummary };
      }
    };
    const item = {
      id: 'tool',
      kind: 'tool_call',
      status: 'IN_PROGRESS',
      payload
    };
    const source = turn('active-run', { items: [item] });

    const first = limitConversationHistory([source]);
    const serializationsAfterFirstLimit = serializations;
    const second = limitConversationHistory(first);

    expect(second[0]).toBe(first[0]);
    expect(serializationsAfterFirstLimit).toBeGreaterThan(0);
    expect(serializations).toBe(serializationsAfterFirstLimit);
  });
});
