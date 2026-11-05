import { describe, expect, it, vi } from 'vitest';
import { createConversationProjectionService } from '../../src/service/conversation-projection-service.js';
import { createWorkbenchConversationSnapshotService } from '../../src/service/workbench-conversation-snapshot-service.js';
import type { ConversationTurn } from '../../src/model/workbench.js';
import { MAX_CONVERSATION_ITEM_TEXT_CHARACTERS } from '../../src/util/conversation-history.js';
import { conversationDisplayItems } from '../../src/util/conversation-presentation.js';

function turn(status = 'RUNNING'): ConversationTurn {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    runId: 'run-1',
    status,
    items: []
  };
}

function state(initial: ConversationTurn[] = [turn()], onRecentWindowOverflow = vi.fn()) {
  const turns = { value: initial };
  const nextCursor = { value: null as string | null };
  const controller = createConversationProjectionService({
    turns: turns as never,
    nextCursor: nextCursor as never,

    onRecentWindowOverflow,
    limitHistory: (values) => [...values]
  });
  return { turns, nextCursor, controller };
}

describe('Web Conversation Projection State', () => {
  it('Flushes the previous Segment before admitting a new Segment in the same frame', () => {
    const { turns, controller } = state([
      { ...turn(), id: 'turn-1:segment:0', turnId: 'turn-1', segmentIndex: 0 }
    ]);
    controller.mergeTextDelta(
      'run-1',
      {
        turnId: 'turn-1',
        segmentId: 'turn-1:segment:0',
        segmentIndex: 0,
        itemId: 'first',
        text: 'Previous tail'
      },
      1
    );
    controller.mergeTextDelta(
      'run-1',
      {
        turnId: 'turn-1',
        segmentId: 'turn-1:segment:1',
        segmentIndex: 1,
        itemId: 'second',
        text: 'Next reply'
      },
      2
    );
    controller.flushPendingTextDeltas();
    expect(turns.value.map((entry) => entry.items[0]?.payload)).toEqual([
      expect.objectContaining({ text: 'Previous tail' }),
      expect.objectContaining({ text: 'Next reply' })
    ]);
  });

  it('Routes continuous Run deltas to the newest Turn rather than an older higher Segment', () => {
    const { turns, controller } = state([
      { ...turn('SUCCEEDED'), id: 'old:segment:3', turnId: 'old', segmentIndex: 3 },
      { ...turn(), id: 'new:segment:0', turnId: 'new', segmentIndex: 0 }
    ]);
    controller.mergeTextDelta('run-1', { itemId: 'reply', text: 'New reply' }, 10);
    controller.flushPendingTextDeltas();
    expect(turns.value[0]?.items).toEqual([]);
    expect(turns.value[1]?.items[0]?.payload).toMatchObject({ text: 'New reply' });
  });

  it('Updates an earlier Turn in place without moving it past a newer user message', () => {
    const old = { ...turn('SUCCEEDED'), id: 'old:segment:3', turnId: 'old', segmentIndex: 3 };
    const current = { ...turn(), id: 'new:segment:0', turnId: 'new', segmentIndex: 0 };
    const { turns, controller } = state([old, current]);
    controller.mergeLatest({
      turns: [
        {
          ...old,
          items: [
            {
              id: 'old-reply',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: 'Final' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 10
    });
    expect(turns.value.map((entry) => entry.id)).toEqual([old.id, current.id]);
    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Final' });
  });

  it('Does not append an older history window after a newer live Turn', () => {
    const current = { ...turn(), id: 'new:segment:0', turnId: 'new', segmentIndex: 0 };
    const { turns, controller } = state([current]);
    controller.markLive(current, 12);

    expect(
      controller.mergeLatest({
        turns: [{ ...turn('SUCCEEDED'), id: 'old:segment:0', turnId: 'old', segmentIndex: 0 }],
        nextCursor: null,
        snapshotSequence: 11
      })
    ).toBe(false);
    expect(turns.value.map((entry) => entry.id)).toEqual([current.id]);
  });

  it('Places older history before the live Turn when a Runtime overlay hydrates the window', () => {
    const old = { ...turn('SUCCEEDED'), id: 'old:segment:0', turnId: 'old', segmentIndex: 0 };
    const current = { ...turn(), id: 'new:segment:0', turnId: 'new', segmentIndex: 0 };
    const { turns, controller } = state([current]);
    controller.markLive(current, 10);

    controller.mergeLatest({
      source: 'runtime',
      turns: [old, current],
      nextCursor: null,
      snapshotSequence: 12
    });
    expect(turns.value.map((entry) => entry.id)).toEqual([old.id, current.id]);
  });

  it('Uses explicit delta identity and creates its Segment within the owning Turn', () => {
    const { turns, controller } = state([
      { ...turn(), id: 'old:segment:0', turnId: 'old', segmentIndex: 0 },
      { ...turn(), id: 'new:segment:0', turnId: 'new', segmentIndex: 0 }
    ]);
    controller.mergeTextDelta(
      'run-1',
      {
        turnId: 'old',
        segmentId: 'old:segment:1',
        segmentIndex: 1,
        itemId: 'reply',
        text: 'Old turn reply'
      },
      10
    );
    controller.flushPendingTextDeltas();
    expect(turns.value.map((entry) => entry.id)).toEqual([
      'old:segment:0',
      'old:segment:1',
      'new:segment:0'
    ]);
    expect(turns.value[1]?.turnId).toBe('old');
    expect(turns.value[1]?.items[0]?.payload).toMatchObject({ text: 'Old turn reply' });
    expect(turns.value[2]?.items).toEqual([]);
  });

  it('Rebases queued deltas and sequence guards at an authoritative snapshot', () => {
    const { turns, controller } = state();
    controller.mergeTextDelta('run-1', { itemId: 'reply', text: 'Covered' }, 5);
    controller.replaceAuthoritative({
      turns: [
        {
          ...turn(),
          items: [
            {
              id: 'reply',
              kind: 'assistant_message',
              status: 'IN_PROGRESS',
              payload: { text: 'Covered' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 5
    });
    controller.flushPendingTextDeltas();
    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Covered' });
    expect(controller.mergeTextDelta('run-1', { itemId: 'reply', text: 'Duplicate' }, 5)).toBe(
      false
    );
    controller.mergeTextDelta('run-1', { itemId: 'reply', text: ' newer' }, 7);
    controller.replaceAuthoritative({
      turns: [
        {
          ...turn(),
          items: [
            {
              id: 'reply',
              kind: 'assistant_message',
              status: 'IN_PROGRESS',
              payload: { text: 'Covered' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 6
    });
    controller.flushPendingTextDeltas();
    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Covered newer' });
  });

  it('Keeps only uncovered chunks when a frame batch straddles the snapshot boundary', () => {
    const { turns, controller } = state();
    controller.mergeTextDelta('run-1', { itemId: 'reply', text: 'Covered' }, 5);
    controller.mergeTextDelta('run-1', { itemId: 'reply', text: ' newer' }, 7);
    controller.replaceAuthoritative({
      turns: [
        {
          ...turn(),
          items: [
            {
              id: 'reply',
              kind: 'assistant_message',
              status: 'IN_PROGRESS',
              payload: { text: 'Covered' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 6
    });
    controller.flushPendingTextDeltas();
    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Covered newer' });
  });

  it('Does not infer a missing Turn identity from a Segment ID string', () => {
    const { turns, controller } = state([
      { ...turn(), id: 'turn-1:segment:0', turnId: 'turn-1', segmentIndex: 0 }
    ]);
    expect(
      controller.mergeTextDelta(
        'run-1',
        {
          segmentId: 'turn-1:segment:1',
          segmentIndex: 1,
          itemId: 'reply',
          text: 'Unknown'
        },
        10
      )
    ).toBe(false);
    controller.flushPendingTextDeltas();
    expect(turns.value).toHaveLength(1);
    expect(turns.value[0]?.items).toEqual([]);
  });

  it('Clears pending deltas and old sequence guards when restoring a cached selection', () => {
    const { turns, controller } = state();
    controller.mergeTextDelta('run-1', { itemId: 'reply', text: 'Old' }, 100);
    controller.flushPendingTextDeltas();
    controller.mergeTextDelta('run-1', { itemId: 'reply', text: ' stale' }, 101);
    turns.value = [turn()];
    controller.restore(turns.value);
    controller.mergeTextDelta('run-1', { itemId: 'reply', text: 'Fresh' }, 1);
    controller.flushPendingTextDeltas();
    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Fresh' });
  });

  it('Keeps multiple Turns from the same continuous Run distinct instead of collapsing them by runId', () => {
    const { turns, controller } = state([]);
    controller.mergeLatest({
      turns: [
        {
          ...turn('SUCCEEDED'),
          id: 'turn-first',
          items: [
            {
              id: 'user-first',
              kind: 'user_message',
              status: 'COMPLETED',
              payload: { clientMessageId: 'message-first', text: 'First message' }
            }
          ]
        },
        {
          ...turn('RUNNING'),
          id: 'turn-second',
          items: [
            {
              id: 'user-second',
              kind: 'user_message',
              status: 'COMPLETED',
              payload: { clientMessageId: 'message-second', text: 'Second message' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 2,
      source: 'runtime',
      readAt: 2,
      latestVisibleAt: 2
    });

    expect(turns.value.map((candidate) => candidate.id)).toEqual(['turn-first', 'turn-second']);
  });

  it('Buffers recent Segments through 30, then shrinks to 15 and requests one cursor reconstruction', () => {
    const initial = Array.from({ length: 15 }, (_, index) => ({
      ...turn('SUCCEEDED'),
      id: `turn-${index + 1}`,
      runId: `run-${index + 1}`,
      startedAt: index + 1
    }));
    const overflow = vi.fn();
    const { turns, nextCursor, controller } = state(initial, overflow);

    controller.mergeLatest({
      turns: [{ ...turn(), id: 'turn-16', runId: 'run-16', startedAt: 16 }],
      nextCursor: 'older',
      snapshotSequence: 16
    });
    controller.mergeTextDelta('run-16', { text: 'Continue output' }, 17);
    controller.flushPendingTextDeltas();

    expect(turns.value).toHaveLength(16);
    expect(nextCursor.value).toBe('older');
    expect(overflow).not.toHaveBeenCalled();

    controller.mergeLatest({
      turns: Array.from({ length: 15 }, (_, index) => ({
        ...turn(),
        id: `turn-${index + 17}`,
        runId: `run-${index + 17}`,
        startedAt: index + 17
      })),
      nextCursor: 'older',
      snapshotSequence: 32
    });

    expect(turns.value).toHaveLength(15);
    expect(turns.value[0]?.id).toBe('turn-17');
    expect(turns.value.at(-1)?.id).toBe('turn-31');
    expect(nextCursor.value).toBeNull();
    expect(overflow).toHaveBeenCalledOnce();
  });

  it('Replaces temporary extended history with the latest window and Node cursor', () => {
    const { turns, nextCursor, controller } = state(
      Array.from({ length: 40 }, (_, index) => ({
        ...turn('SUCCEEDED'),
        id: `old-${index + 1}`,
        runId: `old-run-${index + 1}`
      }))
    );

    controller.replaceRecent({
      source: 'official',
      turns: Array.from({ length: 15 }, (_, index) => ({
        ...turn('SUCCEEDED'),
        id: `recent-${index + 1}`,
        runId: `recent-run-${index + 1}`
      })),
      nextCursor: 'before-recent-1',
      snapshotSequence: 50
    });

    expect(turns.value).toHaveLength(15);
    expect(turns.value[0]?.id).toBe('recent-1');
    expect(nextCursor.value).toBe('before-recent-1');
  });

  it('Rejects a late recent-window response from overwriting newer live history and its cursor', () => {
    const current = { ...turn('SUCCEEDED'), completedAt: 100 };
    const { turns, nextCursor, controller } = state([current]);
    nextCursor.value = 'current-cursor';
    controller.restore(turns.value);
    controller.markLive(current, 100);

    expect(
      controller.replaceRecent({
        source: 'official',
        latestVisibleAt: 50,
        turns: [{ ...current, id: 'stale', runId: 'stale-run', completedAt: 50 }],
        nextCursor: 'stale-cursor',
        snapshotSequence: 50
      })
    ).toBe(false);
    expect(turns.value).toEqual([current]);
    expect(nextCursor.value).toBe('current-cursor');

    const replaceCached = vi.fn();
    const snapshot = createWorkbenchConversationSnapshotService({
      selectedSessionId: { value: 'session-1' } as never,
      replaceCurrent: controller.replaceAuthoritative,
      mergeCurrent: controller.mergeLatest,
      currentWindow: () => ({ turns: turns.value, nextCursor: nextCursor.value }),
      replaceCached
    });
    const authoritative = {
      source: 'official' as const,
      latestVisibleAt: 50,
      turns: [{ ...current, id: 'authoritative', runId: null, completedAt: 50 }],
      nextCursor: 'authoritative-cursor'
    };
    expect(snapshot.apply('session-1', authoritative)).toBe(true);
    expect(replaceCached).toHaveBeenCalledWith('session-1', authoritative);
    expect(turns.value.map((value) => value.id)).toEqual(['authoritative']);
    expect(nextCursor.value).toBe('authoritative-cursor');
  });

  it('Keeps both the visible window and its cache when an initial arrives behind live events', () => {
    const live = { ...turn(), id: 'live:segment:0', turnId: 'live', segmentIndex: 0 };
    const { turns, nextCursor, controller } = state([live]);
    nextCursor.value = 'live-cursor';
    controller.markLive(live, 12);
    const replaceCached = vi.fn();
    const snapshot = createWorkbenchConversationSnapshotService({
      selectedSessionId: { value: 'session-1' } as never,
      replaceCurrent: controller.replaceAuthoritative,
      mergeCurrent: controller.mergeLatest,
      currentWindow: () => ({ turns: turns.value, nextCursor: nextCursor.value }),
      replaceCached
    });
    expect(
      snapshot.apply('session-1', {
        turns: [{ ...turn('SUCCEEDED'), id: 'old:segment:0' }],
        nextCursor: 'old-cursor',
        snapshotSequence: 11
      })
    ).toBe(false);
    expect(turns.value.map((entry) => entry.id)).toEqual([live.id]);
    expect(nextCursor.value).toBe('live-cursor');
    expect(replaceCached).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ turns: [live], nextCursor: 'live-cursor' })
    );
  });

  it('keeps an idle send and streamed Agent reply when a later Watch snapshot covers only older history', () => {
    const previous = { ...turn('SUCCEEDED'), id: 'previous', runId: 'previous-run' };
    const active = {
      ...turn('RUNNING'),
      id: 'session-1:message:idle-send:segment:0',
      turnId: 'runtime-turn',
      segmentIndex: 0,
      items: [
        {
          id: 'user',
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { clientMessageId: 'idle-send', text: 'Request' }
        },
        {
          id: 'reply',
          kind: 'assistant_message',
          status: 'IN_PROGRESS',
          payload: { text: 'Live answer' }
        }
      ]
    };
    const { turns, nextCursor, controller } = state([previous, active]);
    const replaceCached = vi.fn();
    const snapshot = createWorkbenchConversationSnapshotService({
      selectedSessionId: { value: 'session-1' } as never,
      replaceCurrent: controller.replaceAuthoritative,
      mergeCurrent: controller.mergeLatest,
      currentWindow: () => ({ turns: turns.value, nextCursor: nextCursor.value }),
      replaceCached
    });
    snapshot.apply(
      'session-1',
      { turns: [previous], nextCursor: null, snapshotSequence: 10 },
      'refresh'
    );
    expect(turns.value.map((candidate) => candidate.id)).toEqual([previous.id, active.id]);
    expect(turns.value[1]?.items.map((item) => item.kind)).toEqual([
      'user_message',
      'assistant_message'
    ]);
    expect(replaceCached).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({ turns: [previous, active] })
    );
  });

  it('routes a late live delta by stable Segment ID after native history changes the Turn ID', () => {
    const id = 'message:idle-submission:segment:0';
    const { turns, controller } = state([
      { ...turn('RUNNING'), id, turnId: 'native-turn', runId: null, segmentIndex: 0, items: [] }
    ]);
    expect(
      controller.mergeTextDelta(
        'run-1',
        {
          turnId: 'runtime-turn',
          segmentId: id,
          segmentIndex: 0,
          itemId: 'run-1:reply',
          text: 'Live reply'
        },
        20
      )
    ).toBe(true);
    controller.flushPendingTextDeltas();
    expect(turns.value).toHaveLength(1);
    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Live reply' });
    expect(turns.value[0]?.runId).toBe('run-1');
  });

  it('Keeps Turns ordered from oldest to newest after a live merge', () => {
    const earlier = { ...turn('SUCCEEDED'), startedAt: 10, completedAt: 10 };
    const { turns, controller } = state([earlier]);

    controller.mergeLatest({
      turns: [
        {
          ...turn('SUCCEEDED'),
          id: 'turn-2',
          runId: 'run-2',
          startedAt: 20,
          completedAt: 20
        }
      ],
      nextCursor: null,
      snapshotSequence: 2
    });

    expect(turns.value.map((value) => value.id)).toEqual(['turn-1', 'turn-2']);
  });

  it('Does not let a late active Turn override the final projection of the same Run', () => {
    const terminal = { ...turn('SUCCEEDED'), startedAt: 2, completedAt: 7 };
    const { turns, controller } = state([terminal]);
    controller.markLive(terminal, 12);

    expect(
      controller.mergeLatest({
        turns: [{ ...terminal, status: 'RUNNING', completedAt: null }],
        nextCursor: null,
        snapshotSequence: 11,
        source: 'runtime',
        readAt: 8
      })
    ).toBe(false);
    expect(turns.value).toEqual([terminal]);
  });

  it('Merges live text deltas into the assistant item of the current Run', () => {
    const { turns, controller } = state();
    const receivedAt = Date.now();
    expect(controller.mergeTextDelta('run-1', { text: 'First ' }, 2)).toBe(true);
    expect(controller.mergeTextDelta('run-1', { text: 'second part' }, 3)).toBe(true);
    controller.flushPendingTextDeltas();
    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'First second part' });
    expect(turns.value[0]?.items[0]?.startedAt).toBeGreaterThanOrEqual(receivedAt);
  });

  it('Coalesces streaming text deltas until the next browser frame', () => {
    const turns = { value: [turn()] };
    const scheduled: Array<() => void> = [];
    const controller = createConversationProjectionService({
      turns: turns as never,
      nextCursor: { value: null } as never,

      onRecentWindowOverflow: vi.fn(),
      limitHistory: (values) => [...values],
      scheduleTextDeltaFlush: (flush) => {
        scheduled.push(flush);
        return () => undefined;
      }
    });

    expect(controller.mergeTextDelta('run-1', { itemId: 'assistant-1', text: 'one' }, 2)).toBe(
      true
    );
    expect(controller.mergeTextDelta('run-1', { itemId: 'assistant-1', text: ' two' }, 3)).toBe(
      true
    );
    expect(scheduled).toHaveLength(1);
    expect(turns.value[0]?.items).toEqual([]);

    scheduled[0]?.();

    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'one two' });
  });

  it('Flushes buffered deltas before applying a terminal item', () => {
    const turns = { value: [turn()] };
    let flush: (() => void) | undefined;
    const controller = createConversationProjectionService({
      turns: turns as never,
      nextCursor: { value: null } as never,

      onRecentWindowOverflow: vi.fn(),
      limitHistory: (values) => [...values],
      scheduleTextDeltaFlush: (operation) => {
        flush = operation;
        return () => (flush = undefined);
      }
    });

    controller.mergeTextDelta('run-1', { itemId: 'assistant-1', text: 'draft' }, 2);
    expect(
      controller.mergeItem(
        'run-1',
        {
          itemId: 'assistant-1',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'final' }
        },
        3
      )
    ).toBe(true);

    expect(flush).toBeUndefined();
    expect(turns.value[0]?.items[0]).toMatchObject({
      status: 'COMPLETED',
      payload: { text: 'final' }
    });
  });

  it('Rejects late Items and deltas from rewinding a terminal message to streaming', () => {
    const { turns, controller } = state();
    expect(
      controller.mergeItem(
        'run-1',
        {
          itemId: 'assistant-1',
          kind: 'assistant_message',
          status: 'IN_PROGRESS',
          payload: { text: 'Draft', format: 'markdown', model: null }
        },
        2
      )
    ).toBe(true);
    expect(
      controller.mergeItem(
        'run-1',
        {
          itemId: 'assistant-1',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Done', format: 'markdown', model: null }
        },
        3
      )
    ).toBe(true);

    expect(
      controller.mergeItem(
        'run-1',
        {
          itemId: 'assistant-1',
          kind: 'assistant_message',
          status: 'IN_PROGRESS',
          payload: { text: 'Stale', format: 'markdown', model: null }
        },
        2
      )
    ).toBe(false);
    expect(controller.mergeTextDelta('run-1', { itemId: 'assistant-1', text: ' late' }, 4)).toBe(
      false
    );
    expect(turns.value[0]?.items[0]).toMatchObject({
      id: 'assistant-1',
      status: 'COMPLETED',
      payload: { text: 'Done' }
    });
  });

  it('Preserves Run event times for live user and Agent Items', () => {
    const { turns, controller } = state();
    controller.mergeTextDelta('run-1', { text: 'Live reply' }, 2, 1_700_000_000_100);
    controller.mergeItem(
      'run-1',
      {
        itemId: 'user-2',
        kind: 'user_message',
        status: 'COMPLETED',
        startedAt: 1_700_000_000_150,
        completedAt: 1_700_000_000_175,
        payload: { text: 'Follow-up question' }
      },
      3,
      1_700_000_000_200
    );

    expect(turns.value[0]?.items).toEqual([
      expect.objectContaining({
        kind: 'assistant_message',
        startedAt: 1_700_000_000_100,
        completedAt: 1_700_000_000_200
      }),
      expect.objectContaining({
        kind: 'user_message',
        startedAt: 1_700_000_000_150,
        completedAt: 1_700_000_000_175
      })
    ]);
  });

  it('Updates context compaction in place from start to finish', () => {
    const { turns, controller } = state();
    controller.mergeItem(
      'run-1',
      {
        itemId: 'compaction-1',
        kind: 'context_compaction',
        status: 'IN_PROGRESS',
        payload: { phase: 'STARTED' }
      },
      2
    );
    controller.mergeItem(
      'run-1',
      {
        itemId: 'compaction-1',
        kind: 'context_compaction',
        status: 'COMPLETED',
        payload: { phase: 'COMPLETED' }
      },
      3
    );

    expect(turns.value[0]?.items).toEqual([
      expect.objectContaining({
        id: 'compaction-1',
        kind: 'context_compaction',
        status: 'COMPLETED',
        payload: { phase: 'COMPLETED' }
      })
    ]);
  });

  it('Stitches Codex reasoning by section index while preserving section order', () => {
    const { turns, controller } = state();
    for (const [sequence, index, text] of [
      [2, 1, 'Second segment'],
      [3, 0, 'First'],
      [4, 0, ' segment']
    ] as const) {
      controller.mergeItem(
        'run-1',
        {
          itemId: 'reasoning-1',
          kind: 'reasoning',
          status: 'IN_PROGRESS',
          merge: true,
          append: 'sections',
          payload: { representation: 'summary', sections: [{ index, text }] }
        },
        sequence
      );
      if (sequence === 2) {
        const initialGroup = conversationDisplayItems(turns.value[0]!.items)[0];
        expect(initialGroup?.type === 'reasoning_group' && initialGroup.preview?.text).toBe(
          'Second segment'
        );
      }
    }

    expect(turns.value[0]?.items[0]?.payload).toEqual({
      representation: 'summary',
      sections: [
        { index: 0, text: 'First segment' },
        { index: 1, text: 'Second segment' }
      ]
    });
    const group = conversationDisplayItems(turns.value[0]!.items)[0];
    expect(group?.type).toBe('reasoning_group');
    if (group?.type === 'reasoning_group') {
      expect(group.preview).toEqual({
        id: 'reasoning-1',
        text: 'First segment',
        representation: 'summary'
      });
    }
    controller.mergeItem(
      'run-1',
      {
        itemId: 'reasoning-1',
        kind: 'reasoning',
        status: 'COMPLETED',
        merge: true,
        append: 'sections',
        payload: { representation: 'summary', sections: [{ index: 1, text: ' finished' }] }
      },
      5
    );
    expect(turns.value[0]?.status).toBe('RUNNING');
    expect(turns.value[0]?.items[0]?.status).toBe('COMPLETED');
    const completedGroup = conversationDisplayItems(turns.value[0]!.items)[0];
    expect(completedGroup?.type === 'reasoning_group' && completedGroup.text).toBe(
      'First segment\n\nSecond segment finished'
    );
    expect(completedGroup?.type === 'reasoning_group' && completedGroup.preview?.text).toBe(
      'First segment'
    );
  });

  it('Creates new Agent segments after non-text Item delimiters while preserving event order', () => {
    const { turns, controller } = state();
    controller.mergeTextDelta('run-1', { text: 'Check first.' }, 2);
    controller.mergeItem(
      'run-1',
      {
        itemId: 'command-1',
        kind: 'command_execution',
        status: 'COMPLETED',
        payload: { command: 'pwd' }
      },
      3
    );
    controller.mergeTextDelta('run-1', { text: 'Check complete.' }, 4);
    controller.mergeItem(
      'run-1',
      {
        itemId: 'command-1',
        kind: 'command_execution',
        status: 'COMPLETED',
        merge: true,
        payload: { outputPreview: '/workspace\ncompleted' }
      },
      5
    );
    controller.mergeTextDelta('run-1', { text: 'Results confirmed.' }, 6);
    controller.mergeItem(
      'run-1',
      {
        itemId: 'plan-1',
        kind: 'plan',
        status: 'COMPLETED',
        payload: { explanation: 'Implementation starts.' }
      },
      7
    );

    expect(turns.value[0]?.items.map((item) => item.kind)).toEqual([
      'assistant_message',
      'command_execution',
      'assistant_message',
      'assistant_message',
      'plan'
    ]);
  });

  it('Converges the preceding segments and aligns Rewind boundaries when a live Segment is created', () => {
    const { turns, controller } = state([
      {
        ...turn(),
        id: 'turn-1:segment:0',
        turnId: 'turn-1',
        segmentIndex: 0,
        rewind: { before: null, after: 'native-turn-1' }
      }
    ]);

    controller.mergeItem(
      'run-1',
      {
        itemId: 'tool-1',
        kind: 'tool_call',
        status: 'IN_PROGRESS',
        turnId: 'turn-1',
        segmentId: 'turn-1:segment:1',
        segmentIndex: 1,
        payload: { toolName: 'read' }
      },
      2
    );

    expect(turns.value).toHaveLength(2);
    expect(turns.value[0]).toMatchObject({
      id: 'turn-1:segment:0',
      status: 'SUCCEEDED'
    });
    expect(turns.value[0]?.rewind).toEqual({ before: null, after: 'native-turn-1' });
    expect(turns.value[1]).toMatchObject({
      id: 'turn-1:segment:1',
      status: 'RUNNING',
      rewind: { before: null, after: 'native-turn-1' }
    });
  });

  it('Creates a live Segment from the matching native Turn after history clears the managed Run ID', () => {
    const { turns, controller } = state([
      {
        ...turn(),
        id: 'turn-1:segment:0',
        turnId: 'turn-1',
        runId: null,
        segmentIndex: 0,
        items: []
      }
    ]);

    controller.mergeItem(
      'run-1',
      {
        itemId: 'tool-1',
        kind: 'tool_call',
        status: 'IN_PROGRESS',
        turnId: 'turn-1',
        segmentId: 'turn-1:segment:1',
        segmentIndex: 1,
        payload: { toolName: 'read' }
      },
      2
    );

    expect(turns.value).toHaveLength(2);
    expect(turns.value[1]).toMatchObject({
      id: 'turn-1:segment:1',
      turnId: 'turn-1',
      runId: 'run-1',
      segmentIndex: 1,
      items: [expect.objectContaining({ id: 'tool-1' })]
    });
  });

  it('Assigns sequence protection for a live Segment to the new Segment instead of the previous one', () => {
    const { turns, controller } = state([
      {
        ...turn(),
        id: 'turn-1:segment:0',
        turnId: 'turn-1',
        segmentIndex: 0,
        items: []
      }
    ]);

    controller.mergeItem(
      'run-1',
      {
        itemId: 'tool-live',
        kind: 'tool_call',
        status: 'IN_PROGRESS',
        turnId: 'turn-1',
        segmentId: 'turn-1:segment:1',
        segmentIndex: 1,
        payload: { toolName: 'read' }
      },
      10
    );
    controller.mergeLatest({
      turns: [
        {
          ...turn(),
          id: 'turn-1:segment:1',
          turnId: 'turn-1',
          segmentIndex: 1,
          items: []
        }
      ],
      nextCursor: null,
      snapshotSequence: 9,
      source: 'runtime',
      readAt: 1,
      latestVisibleAt: 1
    });

    expect(turns.value.find((entry) => entry.id === 'turn-1:segment:1')?.items).toEqual([
      expect.objectContaining({ id: 'tool-live' })
    ]);
  });

  it('Keeps a Turn ordered during historical patching when the live Segment time is incomplete', () => {
    const { turns, controller } = state([
      {
        ...turn('SUCCEEDED'),
        id: 'turn-1:segment:0',
        turnId: 'turn-1',
        segmentIndex: 0,
        startedAt: 100,
        items: []
      },
      {
        ...turn(),
        id: 'turn-1:segment:1',
        turnId: 'turn-1',
        segmentIndex: 1,
        startedAt: null,
        items: []
      }
    ]);

    controller.mergeLatest({
      turns: [{ ...turn(), id: 'turn-2', runId: 'run-2', startedAt: 200 }],
      nextCursor: null,
      snapshotSequence: 2,
      source: 'runtime',
      latestVisibleAt: 200
    });

    expect(turns.value.map((entry) => entry.id)).toEqual([
      'turn-1:segment:0',
      'turn-1:segment:1',
      'turn-2'
    ]);
  });

  it('Completes a live Segment start time when its first Item arrives', () => {
    const { turns, controller } = state([
      {
        ...turn(),
        id: 'turn-1:segment:0',
        turnId: 'turn-1',
        segmentIndex: 0,
        startedAt: null,
        items: []
      }
    ]);

    controller.mergeItem(
      'run-1',
      {
        itemId: 'tool-live',
        kind: 'tool_call',
        status: 'IN_PROGRESS',
        payload: { toolName: 'read' }
      },
      2,
      150
    );

    expect(turns.value[0]?.startedAt).toBe(150);
  });

  it('Writes final text to the maximum segmentIndex rather than the last array item when the array is temporarily out of order', () => {
    const { turns, controller } = state([
      {
        ...turn(),
        id: 'turn-1:segment:1',
        turnId: 'turn-1',
        segmentIndex: 1,
        items: []
      },
      {
        ...turn('SUCCEEDED'),
        id: 'turn-1:segment:0',
        turnId: 'turn-1',
        segmentIndex: 0,
        items: []
      }
    ]);

    controller.mergeTextDelta('run-1', { text: 'Final response' }, 3, 200);
    controller.flushPendingTextDeltas();

    expect(turns.value.find((entry) => entry.segmentIndex === 1)?.items).toEqual([
      expect.objectContaining({
        kind: 'assistant_message',
        payload: expect.objectContaining({ text: 'Final response' })
      })
    ]);
    expect(turns.value.find((entry) => entry.segmentIndex === 0)?.items).toEqual([]);
  });

  it('Truncates older live output while retaining the latest tail', () => {
    const { turns, controller } = state();
    controller.mergeTextDelta('run-1', { text: 'Old '.repeat(80_000) }, 2);
    controller.mergeTextDelta('run-1', { text: 'Latest tail' }, 3);
    controller.flushPendingTextDeltas();
    const payload = turns.value[0]?.items[0]?.payload as {
      text?: string;
      truncated?: boolean;
    };

    expect(payload.truncated).toBe(true);
    expect(payload.text?.length).toBeLessThanOrEqual(MAX_CONVERSATION_ITEM_TEXT_CHARACTERS);
    expect(payload.text).toContain('Older message content was truncated in this browser');
    expect(payload.text).toMatch(/Latest tail$/u);
  });

  it('Applies the same body limit to a giant terminal snapshot before reactive projection', () => {
    const { turns, controller } = state();
    controller.mergeLatest({
      turns: [
        {
          ...turn('SUCCEEDED'),
          items: [
            {
              id: 'assistant',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: `Old ${'content '.repeat(80_000)}Final` }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 10
    });
    const payload = turns.value[0]?.items[0]?.payload as {
      text?: string;
      truncated?: boolean;
    };

    expect(payload.truncated).toBe(true);
    expect(payload.text?.length).toBeLessThanOrEqual(MAX_CONVERSATION_ITEM_TEXT_CHARACTERS);
    expect(payload.text).toMatch(/Final$/u);
  });

  it('Does not let an older snapshot arriving after a live sequence overwrite displayed content', () => {
    const { turns, controller } = state();
    controller.mergeTextDelta('run-1', { text: 'Full Answer' }, 8);
    controller.mergeLatest({
      turns: [turn('RUNNING')],
      nextCursor: null,
      snapshotSequence: 7
    });
    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Full Answer' });
  });

  it('Accepts Node-authoritative content without comparing timestamps or text lengths', () => {
    const current: ConversationTurn = {
      ...turn('SUCCEEDED'),
      completedAt: 20,
      items: [
        {
          id: 'assistant',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Full final answer already shown' }
        }
      ]
    };
    const { turns, controller } = state([current]);

    controller.mergeLatest({
      source: 'official',
      latestVisibleAt: 10,
      turns: [
        {
          ...current,
          completedAt: 10,
          items: [
            {
              id: 'assistant',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: 'Old Answer' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 100
    });

    expect(turns.value[0]?.items[0]?.payload).toMatchObject({
      text: 'Old Answer'
    });
  });

  it('Replaces a live streaming body with a shorter complete body from the final snapshot', () => {
    const current: ConversationTurn = {
      ...turn('SUCCEEDED'),
      items: [
        {
          id: 'assistant',
          kind: 'assistant_message',
          status: 'IN_PROGRESS',
          payload: { text: 'Long Live Streaming Temporary Body' }
        }
      ]
    };
    const { turns, controller } = state([current]);

    controller.mergeLatest({
      turns: [
        {
          ...current,
          items: [
            {
              id: 'assistant',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: 'Final body' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 10
    });

    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Final body' });
  });

  it('Converges a live projection to the existing final-state body when a newer snapshot arrives', () => {
    const { turns, controller } = state();
    controller.mergeTextDelta('run-1', { text: 'Long real-time final body' }, 4);
    turns.value = turns.value.map((value) => ({
      ...value,
      status: 'SUCCEEDED',
      items: value.items.map((item) => ({ ...item, status: 'COMPLETED' }))
    }));

    controller.mergeLatest({
      turns: [
        {
          ...turn('SUCCEEDED'),
          items: [
            {
              id: 'assistant',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: 'Shorter final body' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 10
    });

    expect(turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'Shorter final body' });
  });

  it('Allows a newer final-state snapshot to replace a live projection with fewer normalized Items', () => {
    const current: ConversationTurn = {
      ...turn('SUCCEEDED'),
      completedAt: 10,
      items: [
        {
          id: 'tool-call',
          kind: 'tool_call',
          status: 'COMPLETED',
          payload: { text: 'Call' }
        },
        {
          id: 'tool-result',
          kind: 'tool_result',
          status: 'COMPLETED',
          payload: { text: 'Results' }
        }
      ]
    };
    const { turns, controller } = state([current]);

    controller.mergeLatest({
      source: 'runtime',
      latestVisibleAt: 20,
      turns: [
        {
          ...current,
          completedAt: 20,
          items: [
            {
              id: 'normalized-tool',
              kind: 'tool_call',
              status: 'COMPLETED',
              payload: { text: 'Call\nResults' }
            }
          ]
        }
      ],
      nextCursor: null,
      snapshotSequence: 100
    });

    expect(turns.value[0]?.items).toEqual([expect.objectContaining({ id: 'normalized-tool' })]);
  });

  it('Preserves projection references when Watch returns the same message page', () => {
    const current = {
      ...turn('SUCCEEDED'),
      completedAt: 20,
      items: [
        {
          id: 'assistant',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Final Answer' }
        }
      ]
    } satisfies ConversationTurn;
    const { turns, controller } = state([current]);
    const previous = turns.value;

    expect(
      controller.mergeLatest({
        source: 'official',
        latestVisibleAt: 20,
        turns: [structuredClone(current)],
        nextCursor: null,
        snapshotSequence: 100
      })
    ).toBe(false);
    expect(turns.value).toBe(previous);
  });

  it('Preserves the older page cursor when a native history snapshot matches cached content', () => {
    const cached = { ...turn('SUCCEEDED'), startedAt: 20, completedAt: 20 };
    const { turns, nextCursor, controller } = state([cached]);
    controller.restore(turns.value);

    expect(
      controller.mergeLatest({
        source: 'native',
        latestVisibleAt: 20,
        turns: [structuredClone(cached)],
        nextCursor: 'older-native-history',
        snapshotSequence: 100
      })
    ).toBe(false);

    expect(nextCursor.value).toBe('older-native-history');
  });

  it('Merges text fragments by native message ID and keeps adjacent Agent messages separate', () => {
    const { turns, controller } = state();

    controller.mergeTextDelta('run-1', { itemId: 'codex:message-1', text: 'Article ' }, 2);
    controller.mergeTextDelta('run-1', { itemId: 'codex:message-1', text: 'one' }, 3);
    controller.mergeItem(
      'run-1',
      {
        itemId: 'codex:message-1',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'Article one', format: 'markdown', model: null }
      },
      4
    );
    controller.mergeTextDelta('run-1', { itemId: 'codex:message-2', text: 'Article two' }, 5);
    controller.mergeItem(
      'run-1',
      {
        itemId: 'codex:message-2',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'Article two', format: 'markdown', model: null }
      },
      6
    );

    expect(
      turns.value[0]?.items
        .filter((item) => item.kind === 'assistant_message')
        .map((item) => ({ id: item.id, text: (item.payload as { text?: string }).text }))
    ).toEqual([
      { id: 'codex:message-1', text: 'Article one' },
      { id: 'codex:message-2', text: 'Article two' }
    ]);
  });
});
