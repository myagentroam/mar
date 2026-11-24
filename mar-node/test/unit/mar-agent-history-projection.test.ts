import type { AgentEvent, AgentSessionHistoryEntry } from '@myagentroam/agent';
import { describe, expect, it } from 'vitest';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';

const session = {
  id: 'session',
  runner: 'mar-agent',
  modelId: null,
  effort: null,
  access: null
} as NodeAgentSession;

describe('MAR Agent history projection', () => {
  it('replays only a Thought title and never a legacy summary', () => {
    const title = '确认单写入者约束';
    const legacy = {
      ...eventBase(2, 'thought-turn'),
      type: 'thought.recorded',
      callId: 'legacy',
      summary: 'Old body is not a title'
    } as unknown as AgentEvent;
    const turns = projectMarAgentHistory(session, [
      entry({ ...eventBase(1, 'thought-turn'), type: 'thought.recorded', callId: 'new', title }),
      entry(legacy)
    ]);
    expect(turns[0]?.items.map(({ kind, payload }) => ({ kind, payload }))).toEqual([
      {
        kind: 'reasoning',
        payload: { representation: 'summary', sections: [{ index: 0, text: title }] }
      }
    ]);
  });

  it('bounds lookup and copy work as distinct items accumulate in a long Turn', () => {
    const size = 4_000;
    const entries = Array.from({ length: size }, (_, index) =>
      message(index + 1, 'long-turn', `message-${index}`, `Reply ${index}`)
    );
    const isProjectedPrefix = (items: readonly unknown[]) => {
      const first = items[0] as { id?: string; turnId?: string } | undefined;
      return first?.turnId === 'long-turn' && first.id === 'mar-agent-message:message-0';
    };
    let lookupCandidates = 0;
    let copiedItems = 0;
    const findIndex = Array.prototype.findIndex;
    const iterate = Array.prototype[Symbol.iterator];

    // Measure cumulative array work on the projected prefix, not on input or normalizer arrays.
    // Every lookup here is a miss, so findIndex examines the whole prefix. Spread copies it all.
    let turns: ReturnType<typeof projectMarAgentHistory>;
    try {
      Array.prototype.findIndex = function (...args: Parameters<typeof findIndex>) {
        if (isProjectedPrefix(this)) lookupCandidates += this.length;
        return findIndex.apply(this, args);
      };
      Array.prototype[Symbol.iterator] = function () {
        if (isProjectedPrefix(this)) copiedItems += this.length;
        return iterate.call(this);
      };
      turns = projectMarAgentHistory(session, entries);
    } finally {
      Array.prototype.findIndex = findIndex;
      Array.prototype[Symbol.iterator] = iterate;
    }

    expect(turns[0]?.items.map((item) => item.id)).toEqual(
      entries.map((_, index) => `mar-agent-message:message-${index}`)
    );
    expect.soft(lookupCandidates, 'candidates examined during lookup').toBeLessThanOrEqual(size);
    expect.soft(copiedItems, 'items copied from the accumulated array').toBeLessThanOrEqual(size);
  });

  it('updates the original item slot and start time without affecting another Turn with the same ID', () => {
    const turns = projectMarAgentHistory(session, [
      message(1, 'first', 'shared', 'Original reply'),
      message(2, 'second', 'shared', 'Independent reply'),
      message(3, 'first', 'later', 'Next reply'),
      message(4, 'first', 'shared', 'Updated reply'),
      message(5, 'third', 'shared', 'Third reply')
    ]);

    expect(turns.map(({ id, rewind }) => [id, rewind])).toEqual([
      ['first', { before: null, after: 'first' }],
      ['second', { before: 'first', after: 'second' }],
      ['third', { before: 'second', after: 'third' }]
    ]);
    expect(
      turns.map(({ items }) =>
        items.map(({ id, payload, startedAt, completedAt }) => ({
          id,
          payload,
          startedAt,
          completedAt
        }))
      )
    ).toMatchObject([
      [
        {
          id: 'mar-agent-message:shared',
          payload: { text: 'Updated reply' },
          startedAt: 1_000,
          completedAt: 4_000
        },
        { id: 'mar-agent-message:later', payload: { text: 'Next reply' } }
      ],
      [
        { id: 'mar-agent-message:shared', payload: { text: 'Independent reply' }, startedAt: 2_000 }
      ],
      [{ id: 'mar-agent-message:shared', payload: { text: 'Third reply' }, startedAt: 5_000 }]
    ]);
  });

  it('retains Compact mode and anchor when the terminal payload omits both', () => {
    const [turn] = projectMarAgentHistory(session, [
      message(1, 'turn', 'anchor', 'Before Compact'),
      entry({
        ...eventBase(2, 'turn'),
        type: 'context.compacting',
        compactionId: 'compact',
        async: true,
        stage: 'GENERATING',
        anchor: { kind: 'message', id: 'anchor' }
      }),
      message(3, 'turn', 'tail', 'After the anchor'),
      entry({
        ...eventBase(4, 'turn'),
        type: 'context.compacted',
        compactionId: 'compact',
        retainedContext: true
      })
    ]);

    expect(turn?.items.map(({ id }) => id)).toEqual([
      'mar-agent-message:anchor',
      'mar-agent-compact:compact',
      'mar-agent-message:tail'
    ]);
    const compact = turn?.items[1];
    expect(compact).toMatchObject({ status: 'COMPLETED', startedAt: 2_000, completedAt: 4_000 });
    expect(compact?.payload).toEqual({
      phase: 'COMPLETED',
      summary: null,
      mode: 'BACKGROUND',
      anchorItemId: 'mar-agent-message:anchor',
      retainedContext: true
    });
  });
});

function message(
  sequence: number,
  turnId: string,
  itemId: string,
  text: string
): AgentSessionHistoryEntry {
  return entry({
    ...eventBase(sequence, turnId),
    type: 'message.completed',
    itemId,
    phase: 'commentary',
    modelId: 'model',
    modelName: 'Model',
    text
  });
}

function eventBase(sequence: number, turnId: string) {
  return {
    eventId: `event-${sequence}`,
    sequence,
    timestamp: new Date(sequence * 1_000).toISOString(),
    sessionId: session.id,
    executionId: `execution-${turnId}`,
    turnId
  };
}

function entry(event: AgentEvent): AgentSessionHistoryEntry {
  return { kind: 'event', sequence: event.sequence, event };
}
