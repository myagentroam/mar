import { describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import type { NodeConversationTurn } from '../../src/runtime-model.js';
import { ConversationObservation } from '../../src/service/conversation-observation.js';

const session = { id: 'bounded-observation' } as NodeAgentSession;
const turns: NodeConversationTurn[] = Array.from({ length: 40 }, (_, index) => ({
  id: `turn-${index}`,
  sessionId: session.id,
  runId: null,
  userItemId: null,
  status: 'SUCCEEDED',
  model: null,
  effort: null,
  access: null,
  items: [],
  startedAt: index,
  completedAt: index + 1
}));

function page(limit: number) {
  return {
    turns: turns.slice(-limit),
    source: 'official' as const,
    nextCursor: limit < turns.length ? `before-${turns.length - limit}` : null,
    snapshotSequence: 0,
    readAt: 0,
    latestVisibleAt: 0
  };
}

describe('Conversation observation read windows', () => {
  it('does not reuse an in-flight periodic tail for the terminal handoff', async () => {
    let active = true;
    const pending = Promise.withResolvers<void>();
    const readPage = vi.fn(async (_session: NodeAgentSession, limit: number) => {
      if (limit === 10) await pending.promise;
      return {
        ...page(limit),
        source: active ? ('runtime' as const) : ('official' as const),
        turns: page(limit).turns.map((turn) =>
          active ? turn : { ...turn, rewind: { before: null, after: turn.id } }
        )
      };
    });
    const observation = new ConversationObservation(session, {
      hasActiveRun: () => active,
      readPage,
      refreshActivity: async () => undefined
    });
    try {
      await observation.initial();
      active = false;
      const periodic = observation.refresh();
      await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2));
      const terminal = observation.observe({
        sequence: 1,
        category: 'session',
        payload: { session: { id: session.id, activity: 'IDLE' } }
      });
      pending.resolve();
      const [, update] = await Promise.all([periodic, terminal]);
      expect(update).toMatchObject({ handoff: true, snapshot: true });
      expect(update?.page.turns).toHaveLength(30);
      expect(readPage.mock.calls.map((call) => call[1])).toEqual([30, 10, 30]);
    } finally {
      pending.resolve();
      observation.close();
    }
  });

  it('keeps the full convergence window after a temporary Runtime fallback', async () => {
    let active = true;
    let persisted = false;
    const readPage = vi.fn(async (_session: NodeAgentSession, limit: number) => ({
      ...page(limit),
      source: persisted ? ('official' as const) : ('runtime' as const),
      turns: page(limit).turns.map((turn) =>
        persisted ? { ...turn, rewind: { before: null, after: turn.id } } : turn
      )
    }));
    const observation = new ConversationObservation(session, {
      hasActiveRun: () => active,
      readPage,
      refreshActivity: async () => undefined
    });
    try {
      await observation.initial();
      active = false;
      const fallback = await observation.observe({
        sequence: 1,
        category: 'session',
        payload: { session: { id: session.id, activity: 'IDLE' } }
      });
      expect(fallback?.page.turns).toEqual(turns.slice(-30));
      persisted = true;
      const recovered = await observation.refresh();
      expect(recovered).toMatchObject({ handoff: true, snapshot: true });
      expect(recovered?.page.turns).toHaveLength(30);
      expect(recovered?.page.turns.every((turn) => turn.rewind !== undefined)).toBe(true);
      expect(readPage.mock.calls.map((call) => call[1])).toEqual([30, 30, 30]);
    } finally {
      observation.close();
    }
  });

  it('hands off the full terminal window instead of only the recent emission tail', async () => {
    let active = true;
    const readPage = vi.fn(async (_session: NodeAgentSession, limit: number) => ({
      ...page(limit),
      source: active ? ('runtime' as const) : ('official' as const),
      turns: page(limit).turns.map((turn) =>
        active ? turn : { ...turn, rewind: { before: null, after: turn.id } }
      )
    }));
    const observation = new ConversationObservation(session, {
      hasActiveRun: () => active,
      readPage,
      refreshActivity: async () => undefined
    });
    try {
      expect((await observation.initial())?.page.turns).toHaveLength(30);
      active = false;
      const update = await observation.observe({
        sequence: 1,
        category: 'session',
        payload: { session: { id: session.id, activity: 'IDLE' } }
      });
      expect(update).toMatchObject({ handoff: true, snapshot: true });
      expect(update?.page.turns).toHaveLength(30);
      expect(update?.page.turns.every((turn) => turn.rewind !== undefined)).toBe(true);
      expect(readPage.mock.calls.map((call) => call[1])).toEqual([30, 30]);
      expect((await observation.refresh())?.changed).toBe(false);
    } finally {
      observation.close();
    }
  });

  it.each([
    [3, 30, [3, 30]],
    [30, 3, [30]],
    [3, 3, [3]]
  ] as const)(
    'shares only sufficient in-flight initial reads: %i then %i',
    async (firstLimit, secondLimit, expectedReads) => {
      const pending = Promise.withResolvers<void>();
      const readPage = vi.fn(async (_session: NodeAgentSession, limit: number) => {
        if (readPage.mock.calls.length === 1) await pending.promise;
        return page(limit);
      });
      const observation = new ConversationObservation(session, {
        hasActiveRun: () => false,
        readPage,
        refreshActivity: async () => undefined
      });
      try {
        const first = observation.initial(firstLimit);
        await vi.waitFor(() => expect(readPage).toHaveBeenCalledOnce());
        const second = observation.initial(secondLimit);
        pending.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(readPage.mock.calls.map((call) => call[1])).toEqual(expectedReads);
        expect(firstResult?.page.turns).toEqual(turns.slice(-firstLimit));
        expect(secondResult?.page.turns.slice(-secondLimit)).toEqual(turns.slice(-secondLimit));
        expect(secondResult?.page.nextCursor).not.toBeNull();
      } finally {
        pending.resolve();
        observation.close();
      }
    }
  );

  it('retries a failed bounded initial without reusing its failed read', async () => {
    const readPage = vi
      .fn(async (_session: NodeAgentSession, limit: number) => page(limit))
      .mockRejectedValueOnce(new Error('history unavailable'));
    const observation = new ConversationObservation(session, {
      hasActiveRun: () => false,
      readPage,
      refreshActivity: async () => undefined
    });
    try {
      await expect(observation.initial(3)).rejects.toThrow('history unavailable');
      expect((await observation.initial(3))?.page.turns).toEqual(turns.slice(-3));
      expect(readPage.mock.calls.map((call) => call[1])).toEqual([3, 3]);
    } finally {
      observation.close();
    }
  });

  it('keeps full initial coverage when different subscribers wait for a periodic read', async () => {
    const pending = Promise.withResolvers<void>();
    const readPage = vi.fn(async (_session: NodeAgentSession, limit: number) => {
      if (limit === 10) await pending.promise;
      return page(limit);
    });
    const observation = new ConversationObservation(session, {
      hasActiveRun: () => false,
      readPage,
      refreshActivity: async () => undefined
    });
    try {
      await observation.initial(3);
      const periodic = observation.refresh();
      await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2));
      const segmentInitial = observation.initial(3);
      const turnInitial = observation.initial();
      pending.resolve();
      const [, segmentResult, turnResult] = await Promise.all([
        periodic,
        segmentInitial,
        turnInitial
      ]);
      expect(segmentResult?.page.turns.slice(-3)).toEqual(turns.slice(-3));
      expect(turnResult?.page.turns).toEqual(turns.slice(-30));
    } finally {
      pending.resolve();
      observation.close();
    }
  });

  it('publishes new content after an empty initial window', async () => {
    const readPage = vi.fn(async () => page(3));
    readPage.mockResolvedValueOnce({ ...page(3), turns: [], nextCursor: null });
    const observation = new ConversationObservation(session, {
      hasActiveRun: () => false,
      readPage,
      refreshActivity: async () => undefined
    });
    try {
      await observation.initial(3);
      expect((await observation.refresh())?.changed).toBe(true);
      expect((await observation.refresh())?.changed).toBe(false);
    } finally {
      observation.close();
    }
  });

  it('retains observed coverage when a renewed initial requests a smaller window', async () => {
    let updatedIndex = -1;
    const readPage = vi.fn(async (_session: NodeAgentSession, limit: number) => ({
      ...page(limit),
      turns: turns
        .slice(-limit)
        .map((turn) =>
          turn.id === turns[updatedIndex]?.id ? { ...turn, completedAt: 1000 } : turn
        )
    }));
    const observation = new ConversationObservation(session, {
      hasActiveRun: () => false,
      readPage,
      refreshActivity: async () => undefined
    });
    try {
      await observation.initial(3);
      expect((await observation.refresh())?.changed).toBe(false);
      const reopened = await observation.initial(3);
      expect(reopened?.changed).toBe(false);
      expect(reopened?.page.turns.slice(-3)).toEqual(turns.slice(-3));
      expect(readPage.mock.calls.map((call) => call[1])).toEqual([3, 10, 10]);
      expect((await observation.refresh())?.changed).toBe(false);
      updatedIndex = 30;
      expect((await observation.refresh())?.changed).toBe(true);
      expect((await observation.refresh())?.changed).toBe(false);
      updatedIndex = 39;
      expect((await observation.initial(3))?.changed).toBe(true);
      expect((await observation.refresh())?.changed).toBe(false);
    } finally {
      observation.close();
    }
  });

  it.each([39, 30])(
    'still detects changes to Turn %i while expanding or after expansion',
    async (index) => {
      let updated = false;
      const readPage = vi.fn(async (_session: NodeAgentSession, limit: number) => ({
        ...page(limit),
        turns: turns
          .slice(-limit)
          .map((turn) =>
            updated && turn.id === turns[index]!.id ? { ...turn, completedAt: 1000 } : turn
          )
      }));
      const observation = new ConversationObservation(session, {
        hasActiveRun: () => false,
        readPage,
        refreshActivity: async () => undefined
      });
      try {
        await observation.initial(3);
        if (index === 30) expect((await observation.refresh())?.changed).toBe(false);
        updated = true;
        expect((await observation.refresh())?.changed).toBe(true);
        expect((await observation.refresh())?.changed).toBe(false);
      } finally {
        observation.close();
      }
    }
  );
});
