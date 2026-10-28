import { describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession } from '../../src/database.js';
import type { NodeConversationTurn } from '../../src/runtime-model.js';
import type { ConversationHistoryPage } from '../../src/session/runner-native-session-parsers.js';
import {
  ConversationHistoryService,
  convergeConversationWatchPage
} from '../../src/service/conversation-history-service.js';
import { NativeSessionWatchService } from '../../src/service/native-session-watch-service.js';
import { ConversationSegmentService } from '../../src/service/conversation-segment-service.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';

const session = {
  id: 'shared-mar-session',
  runner: 'mar-agent',
  nativeControl: 'MAR_MANAGED',
  externalSessionId: 'shared-mar-session'
} as NodeAgentSession;

function turn(id: string, at: number, messageId = id, withRewind = true): NodeConversationTurn {
  return {
    id,
    sessionId: session.id,
    runId: null,
    userItemId: `${id}:user`,
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    startedAt: at,
    completedAt: at + 1,
    ...(withRewind ? { rewind: { before: null, after: id } } : {}),
    items: [
      {
        id: `${id}:user`,
        sessionId: session.id,
        turnId: id,
        runId: null,
        parentItemId: null,
        sourceSequence: at,
        revision: 0,
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: id, clientMessageId: messageId },
        startedAt: at,
        completedAt: at
      }
    ]
  };
}

function failedTurn(id: string, at: number, messageId = id): NodeConversationTurn {
  const value = turn(id, at, messageId, false);
  return {
    ...value,
    runId: `${id}:run`,
    status: 'FAILED',
    items: [
      ...value.items,
      {
        ...value.items[0]!,
        id: `${id}:error`,
        kind: 'error',
        status: 'FAILED',
        payload: { code: 'RUNNER_FAILED', message: 'The execution failed.' },
        startedAt: at + 1,
        completedAt: at + 1
      }
    ]
  };
}

function compactTurn(
  id: string,
  at: number,
  compactionId: string,
  runId: string | null = null
): NodeConversationTurn {
  const native = projectMarAgentHistory(session, [
    {
      kind: 'event',
      sequence: at,
      event: {
        type: 'context.compacted',
        eventId: `${compactionId}:completed`,
        sequence: at,
        timestamp: new Date(at).toISOString(),
        sessionId: session.id,
        executionId: `${compactionId}:execution`,
        turnId: id,
        compactionId
      }
    }
  ])[0]!;
  return {
    ...native,
    runId,
    status: 'SUCCEEDED',
    items: native.items.map((item) => ({
      ...item,
      runId,
      id: runId === null ? item.id : `${runId}:${item.id}`
    }))
  };
}

function fixture(local: NodeConversationTurn[], official: NodeConversationTurn[]) {
  let active = false;
  const readOfficial = vi.fn<ConversationHistoryService['readOfficial']>(async () => ({
    turns: official,
    nextCursor: null
  }));
  const service = new ConversationHistoryService({
    runtime: {
      getAgentSession: () => session,
      listConversationTurns: () => ({ turns: local, nextCursor: null })
    },
    runners: {
      require: () => ({
        readConversationHistory: async (readers: {
          official(): Promise<
            { turns: NodeConversationTurn[]; nextCursor: string | null } | undefined
          >;
        }) => {
          const page = await readers.official();
          return page === undefined ? undefined : { ...page, source: 'official' };
        }
      })
    },
    attachments: {},
    capabilities: () => ({}),
    snapshotSequence: () => 1,
    hasManagedActiveRun: () => active,
    setExternalActivity: () => undefined
  } as never);
  service.readOfficial = readOfficial;
  return {
    service,
    readOfficial,
    setActive: (value: boolean) => {
      active = value;
    }
  };
}

describe.each(['read', 'readHistoryPage'] as const)(
  'idle MAR Agent %s synchronization',
  (method) => {
    it('reconciles a manual compact with its item-only SDK Turn without duplication', async () => {
      const local = compactTurn('local-compact', 10, 'compact-1', 'local-run');
      const native = compactTurn('sdk-compact', 11, 'compact-1');
      const { service } = fixture([local], [native]);

      const page = await service[method](session, { limit: 10 });

      expect(page.turns).toEqual([local]);
      expect(page.turns.flatMap((value) => value.items)).toHaveLength(1);
    });

    it('reconciles lock failures before the SDK persists the user input without merging retries', async () => {
      const native = [1, 2].map(
        (attempt) =>
          projectMarAgentHistory(session, [
            {
              kind: 'event',
              sequence: attempt,
              event: {
                type: 'execution.failed',
                eventId: `failure-${attempt}`,
                sequence: attempt,
                timestamp: new Date(10 + attempt).toISOString(),
                sessionId: session.id,
                executionId: `execution-${attempt}`,
                turnId: `sdk-turn-${attempt}`,
                code: 'MAR_AGENT_SESSION_LOCKED',
                message: 'Session already has a writer.'
              }
            }
          ])[0]!
      );
      const local = native.map((value, index) => {
        const runtime = failedTurn(`local-${index}`, 10 + index);
        return {
          ...runtime,
          items: [
            runtime.items[0]!,
            ...value.items.map((item) => ({
              ...item,
              id: `${runtime.runId}:${item.id}`,
              turnId: runtime.id,
              runId: runtime.runId
            }))
          ]
        };
      });
      const { service } = fixture(local, native);

      for (let refresh = 0; refresh < 2; refresh++) {
        const page = await service[method](session, {});
        expect(page.turns).toEqual(local);
        expect(
          page.turns.flatMap((value) => value.items.filter((item) => item.kind === 'error'))
        ).toHaveLength(2);
        expect(page.turns.every((value) => value.rewind === undefined)).toBe(true);
      }

      const other = projectMarAgentHistory(session, [
        {
          kind: 'event',
          sequence: 3,
          event: {
            type: 'execution.failed',
            eventId: 'other-failure',
            sequence: 3,
            timestamp: new Date(13).toISOString(),
            sessionId: session.id,
            executionId: 'other-execution',
            turnId: 'other-node-turn',
            code: 'MAR_AGENT_SESSION_LOCKED',
            message: 'Session already has a writer.'
          }
        }
      ])[0]!;
      expect((await fixture(local, [...native, other]).service[method](session, {})).turns).toEqual(
        [...local, other]
      );
    });

    it('keeps consecutive manual compacts distinct even with equal timestamps', async () => {
      const local = compactTurn('local-compact', 10, 'compact-1', 'local-run');
      const native = compactTurn('sdk-compact', 10, 'compact-1');
      const next = compactTurn('other-node-compact', 10, 'compact-2');
      const { service } = fixture([local], [native, next]);

      const page = await service[method](session, { limit: 10 });

      expect(page.turns).toEqual([local, next]);
    });

    it('preserves live and native errors when reconciling an item-only compact', async () => {
      const native = compactTurn('sdk-compact', 10, 'compact-1');
      const local = {
        ...compactTurn('local-compact', 10, 'compact-1', 'local-run'),
        status: 'FAILED' as const
      };
      const error = {
        ...native.items[0]!,
        id: 'native-error',
        kind: 'error',
        status: 'FAILED',
        payload: { code: 'COMPACT_FAILED', message: 'Compaction failed.' }
      };
      const { service } = fixture([local], [{ ...native, items: [...native.items, error] }]);
      const page = await service[method](session, { limit: 10 });
      expect(page.turns).toHaveLength(1);
      expect(page.turns[0]).toMatchObject({ id: local.id, status: 'FAILED' });
      expect(page.turns[0]?.items).toEqual([
        ...local.items,
        { ...error, turnId: local.id, runId: local.runId }
      ]);

      const failedLocal = { ...local, items: page.turns[0]!.items };
      const withLiveError = fixture(
        [failedLocal],
        [{ ...native, items: [...native.items, error] }]
      );
      expect((await withLiveError.service[method](session, {})).turns).toEqual([failedLocal]);
    });

    it('does not correlate user Turns by an incidental shared Item identity', async () => {
      const local = turn('local', 10, 'local-input');
      const native = turn('native', 11, 'different-input');
      const compact = compactTurn('sdk-compact', 10, 'compact-1').items[0]!;
      const runtime = {
        ...local,
        runId: 'local-run',
        items: [...local.items, { ...compact, id: `local-run:${compact.id}` }]
      };
      const official = { ...native, items: [...native.items, compact] };
      const { service } = fixture([runtime], [official]);

      expect((await service[method](session, {})).turns).toHaveLength(2);
    });

    it.each(['different-run', 'different-kind', 'unprefixed', 'non-error'] as const)(
      'does not correlate a user Turn with an item-only Turn through %s identities',
      async (mode) => {
        const compact = compactTurn('sdk-turn', 11, 'compact-1');
        const native = {
          ...compact,
          items: compact.items.map((item) =>
            mode === 'non-error'
              ? item
              : {
                  ...item,
                  kind: 'error',
                  status: 'FAILED',
                  payload: {
                    code: 'MAR_AGENT_SESSION_LOCKED',
                    message: 'Session already has a writer.'
                  }
                }
          )
        };
        const local = failedTurn('local', 10);
        const runtime = {
          ...local,
          items: [
            local.items[0]!,
            ...native.items.map((item) => ({
              ...item,
              turnId: local.id,
              runId: local.runId,
              kind: mode === 'different-kind' ? 'assistant_message' : item.kind,
              id:
                mode === 'different-run'
                  ? `other-run:${item.id}`
                  : mode === 'unprefixed'
                    ? item.id
                    : `${local.runId}:${item.id}`
            }))
          ]
        };
        const { service } = fixture([runtime], [native]);

        expect((await service[method](session, {})).turns).toEqual([runtime, native]);
      }
    );

    it('reconciles a failed manual compact through its durable error Item', async () => {
      const native = projectMarAgentHistory(session, [
        {
          kind: 'event',
          sequence: 10,
          event: {
            type: 'execution.failed',
            eventId: 'compact-failed',
            sequence: 10,
            timestamp: new Date(10).toISOString(),
            sessionId: session.id,
            executionId: 'compact-execution',
            turnId: 'sdk-compact',
            code: 'COMPACT_FAILED',
            message: 'Compaction failed.'
          }
        }
      ])[0]!;
      const runtime = compactTurn('local-compact', 10, 'compact-1', 'local-run');
      const local = {
        ...runtime,
        status: 'FAILED' as const,
        items: [...runtime.items, ...native.items].map((item) => ({
          ...item,
          turnId: runtime.id,
          runId: runtime.runId,
          status: 'FAILED',
          id: item.runId === null ? `${runtime.runId}:${item.id}` : item.id
        }))
      };
      const { service } = fixture([local], [native]);

      expect((await service[method](session, {})).turns).toEqual([local]);
    });

    it.each(['different-run', 'different-kind', 'unprefixed', 'history-only'] as const)(
      'does not correlate item-only Turns with %s identities',
      async (mode) => {
        const native = compactTurn('sdk-compact', 10, 'compact-1');
        const local = compactTurn('local-compact', 10, 'compact-1', 'local-run');
        const other =
          mode === 'history-only'
            ? compactTurn('other-sdk-compact', 10, 'compact-1')
            : {
                ...local,
                items: local.items.map((item) => ({
                  ...item,
                  kind: mode === 'different-kind' ? 'assistant_message' : item.kind,
                  id:
                    mode === 'different-run'
                      ? `other-run:${native.items[0]!.id}`
                      : mode === 'unprefixed'
                        ? native.items[0]!.id
                        : item.id
                }))
              };
        const { service } = fixture([other], [native]);

        expect((await service[method](session, {})).turns).toHaveLength(2);
      }
    );

    it('includes another Node continuation without losing the matched local failure', async () => {
      const local = failedTurn('local', 10, 'shared-input');
      const officialLocal = turn('native-local', 10, 'shared-input');
      const newer = turn('other-node', 20);
      const { service, readOfficial } = fixture([local], [officialLocal, newer]);

      const page = await service[method](session, { limit: 10 });

      expect(page.turns.map((value) => value.id)).toEqual(['local', 'other-node']);
      expect(page.turns[0]).toMatchObject({
        runId: 'local:run',
        status: 'FAILED',
        rewind: officialLocal.rewind
      });
      expect(page.turns[0]?.items).toEqual(local.items);
      expect(page.turns[1]).toEqual(newer);
      expect(readOfficial).toHaveBeenCalledOnce();
    });

    it('keeps an unmatched local failure between older and newer persisted Turns', async () => {
      const old = turn('old', 1);
      const failure = failedTurn('local-only-failure', 10);
      const newer = turn('other-node', 20);
      const { service } = fixture([old, failure], [old, newer]);

      const page = await service[method](session, { limit: 10 });

      expect(page.turns.map((value) => value.id)).toEqual([
        'old',
        'local-only-failure',
        'other-node'
      ]);
      expect(page.turns[1]).toEqual(failure);
    });

    it('does not drop a local-only error before a later matched local Turn', async () => {
      const old = turn('old', 1);
      const failure = failedTurn('local-only-failure', 10);
      const laterLocal = turn('later-local', 20);
      const newer = turn('other-node', 30);
      const { service } = fixture([old, failure, laterLocal], [old, laterLocal, newer]);

      const page = await service[method](session, { limit: 10 });

      expect(page.turns.map((value) => value.id)).toEqual([
        'old',
        'local-only-failure',
        'later-local',
        'other-node'
      ]);
      expect(page.turns[1]?.items.at(-1)?.payload).toEqual(failure.items.at(-1)?.payload);
    });

    it('preserves the complete live reply while its persisted Turn is still incomplete', async () => {
      const value = turn('local', 10, 'shared-input');
      const local: NodeConversationTurn = {
        ...value,
        runId: 'local-run',
        items: [
          ...value.items,
          {
            ...value.items[0]!,
            id: 'live-reply',
            kind: 'assistant_message',
            payload: { text: 'Complete live reply' }
          }
        ]
      };
      const { service } = fixture(
        [local],
        [turn('native-local', 10, 'shared-input'), turn('other-node', 20)]
      );

      const page = await service[method](session, { limit: 10 });

      expect(page.turns[0]?.items).toEqual(local.items);
      expect(page.turns[0]?.runId).toBe('local-run');
      expect(page.turns.at(-1)?.id).toBe('other-node');
    });

    it.each(['unavailable', 'rejected'] as const)(
      'retains live errors when official history is %s',
      async (mode) => {
        const local = failedTurn('local', 10);
        const { service, readOfficial } = fixture([local], []);
        if (mode === 'unavailable') readOfficial.mockResolvedValue(undefined as never);
        else readOfficial.mockRejectedValue(new Error('SDK history temporarily unavailable'));

        const page = await service[method](session, { limit: 10 });

        expect(page.source).toBe('runtime');
        expect(page.turns).toEqual([local]);
      }
    );

    it('preserves an official error that has no local counterpart', async () => {
      const local = turn('old', 1);
      const failure = failedTurn('remote-failure', 20);
      const { service } = fixture([local], [local, failure]);

      const page = await service[method](session, { limit: 10 });

      expect(page.turns.at(-1)).toEqual(failure);
    });

    it('keeps an official error on a matched Turn when the live stream lacks it', async () => {
      const local = turn('local', 10, 'shared-input');
      const native = failedTurn('native-local', 10, 'shared-input');
      const { service } = fixture([local], [native, turn('other-node', 20)]);

      const page = await service[method](session, { limit: 10 });

      expect(page.turns[0]?.status).toBe('FAILED');
      expect(page.turns[0]?.items.filter((item) => item.kind === 'error')).toEqual([
        expect.objectContaining({ payload: native.items.at(-1)?.payload, turnId: local.id })
      ]);
    });

    it('keeps the same local error only once when it is also persisted', async () => {
      const local = failedTurn('local', 10, 'shared-input');
      const native = failedTurn('native-local', 10, 'shared-input');
      const { service } = fixture([local], [native, turn('other-node', 20)]);

      const page = await service[method](session, { limit: 10 });

      expect(page.turns[0]?.items.filter((item) => item.kind === 'error')).toEqual([
        local.items.at(-1)
      ]);
    });
  }
);

it('keeps active MAR Agent reads on the live stream', async () => {
  const local = turn('local', 10);
  const { service, readOfficial, setActive } = fixture([local], [local, turn('other-node', 20)]);
  setActive(true);

  const page = await service.read(session, { limit: 10 });

  expect(page.source).toBe('runtime');
  expect(page.turns).toEqual([local]);
  expect(readOfficial).not.toHaveBeenCalled();
});

it('uses persisted history for a starting Run before any local Turn exists', async () => {
  const old = turn('old', 1);
  const { service, setActive } = fixture([], [old]);
  setActive(true);

  const page = await service.readHistoryPage(session, { limit: 10 });

  expect(page.turns).toEqual([old]);
});

it('paginates local-only failures and remote continuations without losing or repeating Turns', async () => {
  const official = [turn('old', 1), turn('remote-middle', 20), turn('remote-latest', 30)];
  const failure = failedTurn('local-only-failure', 10);
  const { service, readOfficial } = fixture([official[0]!, failure], official);
  readOfficial.mockImplementation(async (_session, input) => {
    const end = input.cursor === undefined ? official.length : Number(input.cursor);
    const start = Math.max(0, end - (input.limit ?? 10));
    return { turns: official.slice(start, end), nextCursor: start > 0 ? String(start) : null };
  });
  const first = await service.read(session, { limit: 2 });
  expect(first.turns.map((value) => value.id)).toEqual(['remote-middle', 'remote-latest']);
  expect(first.nextCursor).not.toBeNull();
  const older = await service.read(session, { limit: 2, cursor: first.nextCursor! });
  expect(older.turns.map((value) => value.id)).toEqual(['old', 'local-only-failure']);
  expect(older.turns[1]?.items).toEqual(failure.items);
  expect(older.nextCursor).toBeNull();
});

it('preserves same-timestamp failure Turns across single-Turn pages', async () => {
  const official = [turn('old', 1), turn('remote-latest', 20)];
  const failures = [failedTurn('failure-a', 10), failedTurn('failure-b', 10)];
  const { service, readOfficial } = fixture([official[0]!, ...failures], official);
  readOfficial.mockImplementation(async (_session, input) => {
    const end = input.cursor === undefined ? official.length : Number(input.cursor);
    const start = Math.max(0, end - (input.limit ?? 10));
    return { turns: official.slice(start, end), nextCursor: start > 0 ? String(start) : null };
  });
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
    const page = await service.read(session, {
      limit: 1,
      ...(cursor === undefined ? {} : { cursor })
    });
    ids.unshift(...page.turns.map((value) => value.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  expect(ids).toEqual(['old', 'failure-a', 'failure-b', 'remote-latest']);
});

it('keeps local failures reachable through the browser Segment pagination boundary', async () => {
  const official = [turn('old', 1), turn('remote-middle', 20), turn('remote-latest', 30)];
  const failure = failedTurn('local-only-failure', 10);
  const { service, readOfficial } = fixture([official[0]!, failure], official);
  readOfficial.mockImplementation(async (_session, input) => {
    const end = input.cursor === undefined ? official.length : Number(input.cursor);
    const start = Math.max(0, end - (input.limit ?? 10));
    return { turns: official.slice(start, end), nextCursor: start > 0 ? String(start) : null };
  });
  const segments = new ConversationSegmentService((value, input) => service.read(value, input));
  const first = await segments.read(session, { limit: 2 });
  expect(first.segments.map((value) => value.turnId)).toEqual(['remote-middle', 'remote-latest']);
  const older = await segments.read(session, { limit: 2, cursor: first.nextCursor! });
  expect(older.segments.map((value) => value.turnId)).toEqual(['old', 'local-only-failure']);
  expect(
    older.segments.flatMap((segment) => segment.items).filter((item) => item.kind === 'error')
  ).toEqual([
    expect.objectContaining({
      id: failure.items.at(-1)?.id,
      payload: failure.items.at(-1)?.payload
    })
  ]);
  expect(older.nextCursor).toBeNull();
});

it('rejects malformed and cross-Session idle cursors instead of replacing errors', async () => {
  const { service } = fixture([failedTurn('local', 10)], [turn('old', 1), turn('other-node', 20)]);
  const first = await service.read(session, { limit: 1 });
  await expect(
    service.read({ ...session, id: 'another-session' }, { cursor: first.nextCursor! })
  ).rejects.toThrow('EVENT_CURSOR_INVALID');
  await expect(service.read(session, { cursor: 'mar-idle-history:1:invalid' })).rejects.toThrow(
    'EVENT_CURSOR_INVALID'
  );
});

it('continues an idle history cursor after a new local Run becomes active', async () => {
  const old = turn('old', 1);
  const failure = failedTurn('local-only-failure', 10);
  const { service, setActive } = fixture([old, failure], [old, turn('other-node', 20)]);
  const first = await service.read(session, { limit: 1 });
  setActive(true);

  const older = await service.read(session, { limit: 1, cursor: first.nextCursor! });

  expect(older.turns.map((value) => value.id)).toEqual(['local-only-failure']);
  expect(older.turns[0]?.items).toEqual(failure.items);
});

it('converges a runtime compact Watch to official history without appending its live duplicate', () => {
  const local = compactTurn('local-compact', 10, 'compact-1', 'local-run');
  const native = compactTurn('sdk-compact', 11, 'compact-1');
  const previous: ConversationHistoryPage = {
    turns: [local],
    nextCursor: null,
    source: 'runtime',
    snapshotSequence: 1,
    readAt: 10,
    latestVisibleAt: 10
  };
  const next: ConversationHistoryPage = {
    ...previous,
    turns: [native],
    source: 'official',
    readAt: 11,
    latestVisibleAt: 11
  };

  expect(convergeConversationWatchPage(previous, previous, next, 'runtime').page).toEqual(next);
  expect(convergeConversationWatchPage(next, next, previous, 'official').page).toEqual(next);
});

it('refreshes an idle Watch after another Node continues without erasing the local error', async () => {
  vi.useFakeTimers();
  const local = failedTurn('local', 10, 'shared-input');
  const official = [turn('native-local', 10, 'shared-input')];
  const { service } = fixture([local], official);
  const emitted = vi.fn();
  const watch = new NativeSessionWatchService({
    resolve: async () => session,
    managedActive: () => false,
    refreshActivity: async () => undefined,
    present: () => session,
    readPage: (value, limit) => service.read(value, { limit }),
    readHistoryPage: (value, limit) => service.readHistoryPage(value, { limit }),
    emitSession: () => undefined,
    emitPage: emitted
  });
  try {
    watch.watch(session);
    await vi.advanceTimersByTimeAsync(2_000);
    official.push(turn('other-node', 20));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(emitted).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({
        turns: [
          expect.objectContaining({ id: 'local', status: 'FAILED', items: local.items }),
          expect.objectContaining({ id: 'other-node' })
        ]
      })
    );
  } finally {
    watch.clear();
    vi.useRealTimers();
  }
});
