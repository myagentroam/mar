import { describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession } from '../../src/database.js';
import type { NodeConversationTurn } from '../../src/runtime-model.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import type { AbstractRunner } from '../../src/runner/abstract-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { ConversationHistoryService } from '../../src/service/conversation-history-service.js';
import { ConversationObservation } from '../../src/service/conversation-observation.js';

function turn(
  id: string,
  messageId: unknown = id,
  overrides: Partial<NodeConversationTurn> = {}
): NodeConversationTurn {
  return {
    id,
    sessionId: 'rewind-session',
    runId: `run:${id}`,
    userItemId: `${id}:user`,
    status: 'SUCCEEDED',
    model: 'live-model',
    effort: 'high',
    access: 'workspace-write',
    startedAt: 10,
    completedAt: 20,
    items: [
      {
        id: `${id}:user`,
        sessionId: 'rewind-session',
        turnId: id,
        runId: `run:${id}`,
        parentItemId: null,
        sourceSequence: null,
        revision: 0,
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { clientMessageId: messageId, text: 'identical user text' },
        startedAt: 10,
        completedAt: 10
      },
      {
        id: `${id}:assistant`,
        sessionId: 'rewind-session',
        turnId: id,
        runId: `run:${id}`,
        parentItemId: null,
        sourceSequence: null,
        revision: 0,
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: `accepted live reply for ${id}` },
        startedAt: 15,
        completedAt: 20
      }
    ],
    ...overrides
  };
}

function fixture(
  turns: readonly NodeConversationTurn[],
  native: readonly NodeConversationTurn[],
  nextCursor: string | null = null,
  runner: AbstractRunner = new CodexRunner()
) {
  const session = {
    id: 'rewind-session',
    runner: runner.name,
    externalSessionId: 'native-session',
    nativeControl: 'MAR_MANAGED'
  } as NodeAgentSession;
  let managedActive = true;
  const service = new ConversationHistoryService({
    runtime: {
      getAgentSession: () => session,
      listConversationTurns: () => ({ turns, nextCursor, historyComplete: true })
    },
    runners: new RunnerRegistry([runner]),
    snapshotSequence: () => 42,
    hasManagedActiveRun: () => managedActive
  } as never);
  const official = vi.spyOn(service, 'readOfficial').mockResolvedValue({
    turns: native,
    nextCursor: null
  });
  const nativeRead = vi.spyOn(service, 'readNative').mockResolvedValue(undefined);
  return {
    session,
    service,
    official,
    nativeRead,
    setActive: (value: boolean) => (managedActive = value)
  };
}

const rewind = { before: 'native-before', after: 'native-after' };

describe('Managed conversation Rewind supplementation', () => {
  it('fills only missing terminal boundaries while retaining the entire Runtime page', async () => {
    const existing = { before: null, after: 'accepted-boundary' };
    const turns = [
      turn('existing', 'existing', { rewind: existing }),
      turn('missing'),
      turn('cancelled', 'cancelled', { status: 'CANCELLED' }),
      turn('running', 'running', { status: 'RUNNING' })
    ];
    const native = turns.map((value) =>
      turn(`native:${value.id}`, value.id, {
        runId: null,
        model: 'stale-model',
        items: [value.items[0]!],
        rewind
      })
    );
    const { service, session, official, nativeRead } = fixture(turns, native);
    const readAt = Date.now();
    const page = await service.read(session, {});

    expect(page).toEqual({
      source: 'runtime',
      snapshotSequence: 42,
      readAt: expect.any(Number),
      latestVisibleAt: 20,
      nextCursor: null,
      deferredOlderHistory: true,
      turns: [turns[0], { ...turns[1], rewind }, { ...turns[2], rewind }, turns[3]]
    });
    expect(page.readAt).toBeGreaterThanOrEqual(readAt);
    expect(official).toHaveBeenCalledExactlyOnceWith(session, { limit: 30 });
    expect(nativeRead).not.toHaveBeenCalled();
    expect(turns[1]?.rewind).toBeUndefined();
    expect(turns[0]?.rewind).toBe(existing);
  });

  it('matches message identity rather than text, requires a native user Item and keeps first-match order', async () => {
    const turns = [
      turn('local-a', 'message-a'),
      turn('local-b', 'message-b'),
      turn('local-c', 'message-c')
    ];
    const { service, session } = fixture(turns, [
      turn('native-wrong', 'other-message', { rewind }),
      turn('native-no-user', 'message-b', { rewind, userItemId: null }),
      turn('native-no-rewind', 'message-c'),
      turn('native-a', 'message-a', { rewind }),
      turn('native-a-later', 'message-a', { rewind: { before: null, after: 'later' } })
    ]);
    const page = await service.read(session, {});
    expect(page.turns).toEqual([{ ...turns[0], rewind }, turns[1], turns[2]]);
  });

  it.each(['reject', 'empty', 'unavailable', 'lagging'] as const)(
    'keeps accepted Runtime content when the history reader is %s',
    async (result) => {
      const turns = [turn('local')];
      const { service, session, official } = fixture(turns, []);
      if (result === 'reject') official.mockRejectedValue(new Error('HISTORY_UNAVAILABLE'));
      if (result === 'unavailable') official.mockResolvedValue(undefined);
      if (result === 'lagging')
        official.mockResolvedValue({
          turns: [turn('older', 'older', { rewind })],
          nextCursor: null
        });
      expect((await service.read(session, {})).turns).toEqual(turns);
      expect(official).toHaveBeenCalledOnce();
    }
  );

  it.each([31, 500])(
    'bounds one supplemental read by the full %i-Turn window, not candidate count',
    async (count) => {
      const turns = Array.from({ length: count }, (_, index) =>
        turn(`local-${index}`, `message-${index}`, index === 0 ? {} : { rewind })
      );
      const { service, session, official } = fixture(turns, [
        turn('native', 'message-0', { rewind })
      ]);
      const page = await service.read(session, { limit: 500 });
      expect(page.turns[0]).toEqual({ ...turns[0], rewind });
      expect(official).toHaveBeenCalledExactlyOnceWith(session, {
        limit: Math.min(500, count + 1)
      });
    }
  );

  it.each([
    { label: 'existing boundaries', turns: [turn('local', 'local', { rewind })] },
    { label: 'nonterminal Turns', turns: [turn('local', 'local', { status: 'RUNNING' })] },
    { label: 'absent message identity', turns: [turn('local', null)] },
    { label: 'empty message identity', turns: [turn('local', '')] },
    { label: 'non-string message identity', turns: [turn('local', 12)] },
    { label: 'no Turns', turns: [] }
  ])('does not read supplemental history with $label', async ({ turns }) => {
    const { service, session, official } = fixture(turns, []);
    expect((await service.read(session, {})).turns).toEqual(turns);
    expect(official).not.toHaveBeenCalled();
  });

  it('does not read supplemental history without a native Session', async () => {
    const turns = [turn('local')];
    const { service, session, official } = fixture(turns, []);
    expect((await service.read({ ...session, externalSessionId: null }, {})).turns).toEqual(turns);
    expect(official).not.toHaveBeenCalled();
  });

  it.each([new ClaudeCodeRunner(), new OpenCodeRunner(), new MarAgentRunner()])(
    'keeps the $name default supplemental hook free of history IO',
    async (runner) => {
      const turns = [turn('local')];
      const { service, session, official, nativeRead } = fixture(turns, [], null, runner);
      expect((await service.read(session, {})).turns).toEqual(turns);
      expect(official).not.toHaveBeenCalled();
      expect(nativeRead).not.toHaveBeenCalled();
    }
  );

  it('does not supplement inactive Codex Sessions even when eligible Turns exist', async () => {
    const { session } = fixture([], []);
    const readHistory = vi.fn();
    const result = await new CodexRunner().readConversationRewind({
      session,
      turns: [turn('local')],
      managedActive: false,
      firstPage: true,
      readHistory
    });
    expect([...result]).toEqual([]);
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('applies supplements only to missing boundaries of Turns already in the page', async () => {
    const existing = { before: null, after: 'accepted-boundary' };
    const turns = [turn('existing', 'existing', { rewind: existing }), turn('missing')];
    const runner = new CodexRunner();
    vi.spyOn(runner, 'readConversationRewind').mockResolvedValue(
      new Map([
        ['existing', rewind],
        ['missing', rewind],
        ['not-in-this-page', rewind]
      ])
    );
    const { service, session, official } = fixture(turns, [], null, runner);
    expect((await service.read(session, {})).turns).toEqual([turns[0], { ...turns[1], rewind }]);
    expect(official).not.toHaveBeenCalled();
  });

  it('discards a supplemented page when its Observation closes during the native read', async () => {
    const { service, session, official } = fixture([turn('local')], []);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    official.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { turns: [turn('native', 'local', { rewind })], nextCursor: null };
    });
    const observation = new ConversationObservation(session, {
      managedActive: () => true,
      refreshActivity: async () => undefined,
      readPage: (current, limit) => service.read(current, { limit })
    });
    const read = observation.refresh('initial');
    await entered.promise;
    observation.close();
    gate.resolve();
    expect(await read).toBeUndefined();
    expect(await observation.initial()).toBeUndefined();
    expect(official).toHaveBeenCalledOnce();
  });

  it.each(['FAILED', 'INTERRUPTED', 'LOST'])(
    'supplements the missing boundary of a %s Turn without replacing its failure content',
    async (status) => {
      const local = turn('local', 'message', { status });
      const { service, session } = fixture([local], [turn('native', 'message', { rewind })]);
      expect((await service.read(session, {})).turns).toEqual([{ ...local, rewind }]);
    }
  );

  it('does not supplement a Runtime cursor page, including after the active Run ends', async () => {
    const turns = [turn('local')];
    const { service, session, official, setActive } = fixture(turns, [], 'older-runtime');
    // Return an actual service cursor without advancing to the official-history stage.
    const first = await service.read(session, {});
    expect(first.nextCursor).not.toBeNull();
    official.mockClear();
    for (const active of [true, false]) {
      setActive(active);
      expect((await service.read(session, { cursor: first.nextCursor! })).turns).toEqual(turns);
      expect(official).not.toHaveBeenCalled();
    }
  });
});
