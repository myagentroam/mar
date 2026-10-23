import { describe, expect, it, vi } from 'vitest';
import {
  ConversationSegmentService,
  conversationSegmentIdentityForItem,
  conversationSegments
} from '../../src/service/conversation-segment-service.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { capabilities, captureSocket } from './support/codex-connector.js';

function item(id: string, kind: string) {
  const payload: Record<string, unknown> =
    kind === 'assistant_message'
      ? { text: id, format: 'markdown', model: null }
      : kind === 'user_message'
        ? { clientMessageId: null, text: id, contexts: [], delivery: 'ACCEPTED' }
        : { text: id };
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    parentItemId: null,
    sourceSequence: 1,
    revision: 0,
    kind,
    status: 'COMPLETED',
    payload,
    startedAt: 1,
    completedAt: 1
  };
}

function turn(id: string, kinds: readonly string[]) {
  return {
    id,
    sessionId: 'session-1',
    runId: `run-${id}`,
    userItemId: null,
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    items: kinds.map((kind, index) => ({ ...item(`${id}-${index}`, kind), turnId: id })),
    startedAt: 1,
    completedAt: 2
  };
}

describe('Node Conversation Segment', () => {
  it('preserves the final Turn completion time without changing earlier segment boundaries', () => {
    const original = turn('finished', [
      'user_message',
      'assistant_message',
      'tool_call',
      'assistant_message'
    ]);
    const segments = conversationSegments({ ...original, runId: null, completedAt: 9000 });
    expect(segments.map((segment) => segment.completedAt)).toEqual([1, 9000]);
    expect(segments.map((segment) => segment.turnId)).toEqual(['finished', 'finished']);
    expect(segments.every((segment) => segment.runId === null)).toBe(true);
    const withoutEnd = conversationSegments({ ...original, runId: null, completedAt: null });
    expect(withoutEnd.at(-1)?.completedAt).toBeNull();
  });

  it('keeps the Segment identity stable when Runtime and native history use different Turn IDs', () => {
    const runtime = structuredClone(turn('runtime-turn', ['user_message']));
    const official = structuredClone(turn('native-turn', ['user_message']));
    runtime.items[0]!.payload = {
      ...runtime.items[0]!.payload,
      clientMessageId: 'submission-1'
    };
    official.items[0]!.payload = {
      ...official.items[0]!.payload,
      clientMessageId: 'submission-1'
    };

    expect(conversationSegments(runtime)[0]?.id).toBe(conversationSegments(official)[0]?.id);
    expect(
      conversationSegmentIdentityForItem(runtime, runtime.items[0]!.id, 'user_message')
    ).toEqual({
      id: conversationSegments(runtime)[0]!.id,
      index: 0
    });

    const distinct = structuredClone(turn('another-native-turn', ['user_message']));
    distinct.items[0]!.payload = {
      ...distinct.items[0]!.payload,
      clientMessageId: 'submission-2'
    };
    expect(conversationSegments(distinct)[0]?.id).not.toBe(conversationSegments(runtime)[0]?.id);
  });

  it('keeps the first submission identity when a bootstrap Session is promoted to its native ID', () => {
    const bootstrap = structuredClone(turn('runtime-turn', ['user_message']));
    const native = structuredClone(turn('native-turn', ['user_message']));
    bootstrap.sessionId = 'bootstrap-session';
    native.sessionId = 'native-session';
    bootstrap.items[0]!.payload.clientMessageId = 'initial-submission';
    native.items[0]!.payload.clientMessageId = 'initial-submission';

    expect(conversationSegments(bootstrap)[0]?.id).toBe(conversationSegments(native)[0]?.id);
    expect(
      conversationSegmentIdentityForItem(bootstrap, bootstrap.items[0]!.id, 'user_message').id
    ).toBe(conversationSegments(native)[0]?.id);
  });

  it('derives an empty first Segment for an empty Turn and preserves the pagination boundary', () => {
    const segments = conversationSegments(turn('turn-empty', []));
    expect(segments).toEqual([
      expect.objectContaining({
        id: 'turn-empty:segment:0',
        turnId: 'turn-empty',
        index: 0,
        items: []
      })
    ]);
  });

  it('ends the current Segment at Agent output and returns stable boundaries for history and realtime Items', () => {
    const baseTurn = turn('turn-1', [
      'user_message',
      'reasoning_summary',
      'assistant_message',
      'tool_call',
      'assistant_message',
      'user_input_request'
    ]);
    const managedTurn: Parameters<typeof conversationSegments>[0] = {
      ...baseTurn,
      status: 'RUNNING',
      rewind: { before: null, after: 'native-turn-1' },
      items: baseTurn.items.map((entry, index) => (index === 5 ? { ...entry, runId: null } : entry))
    };
    const segments = conversationSegments(managedTurn);

    expect(segments.map((segment) => segment.items.map((entry) => entry.kind))).toEqual([
      ['user_message', 'reasoning_summary', 'assistant_message'],
      ['tool_call', 'assistant_message'],
      ['user_input_request']
    ]);
    expect(segments[1]?.id).toBe('turn-1:segment:1');
    expect(segments[1]?.items.every((entry) => entry.segmentIndex === 1)).toBe(true);
    expect(
      segments
        .flatMap((segment) => segment.items)
        .every((entry) => entry.runId === managedTurn.runId)
    ).toBe(true);
    expect(segments.map((segment) => segment.status)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'RUNNING'
    ]);
    expect(segments.map((segment) => segment.rewind)).toEqual([
      { before: null, after: 'native-turn-1' },
      { before: null, after: 'native-turn-1' },
      { before: null, after: 'native-turn-1' }
    ]);
    expect(
      conversationSegmentIdentityForItem(
        turn('turn-1', ['assistant_message', 'tool_call']),
        'turn-1-1'
      )
    ).toEqual({ id: 'turn-1:segment:1', index: 1 });
    const lateToolTurn = turn('turn-1', ['tool_call', 'assistant_message']) as never as {
      runId: string;
      items: Array<{ id: string }>;
    };
    lateToolTurn.items[0]!.id = `${lateToolTurn.runId}:tool-1`;
    expect(
      conversationSegmentIdentityForItem(lateToolTurn as never, 'tool-1', 'tool_call')
    ).toEqual({ id: 'turn-1:segment:0', index: 0 });
    expect(
      conversationSegmentIdentityForItem(
        turn('turn-1', ['assistant_message', 'tool_call']),
        'new-item'
      )
    ).toEqual({ id: 'turn-1:segment:1', index: 1 });
    expect(
      conversationSegmentIdentityForItem(
        turn('turn-1', ['assistant_message']),
        'completed-agent-item',
        'assistant_message'
      )
    ).toEqual({ id: 'turn-1:segment:0', index: 0 });
    expect(
      conversationSegmentIdentityForItem(
        turn('turn-1', ['assistant_message', 'tool_call']),
        'next-agent-item',
        'assistant_message'
      )
    ).toEqual({ id: 'turn-1:segment:1', index: 1 });
  });

  it('keeps consecutive Agent messages in one Segment and creates a new boundary before a later non-Agent Item', () => {
    const segments = conversationSegments(
      turn('turn-continuous-agent', [
        'user_message',
        'assistant_message',
        'assistant_message',
        'tool_call',
        'assistant_message',
        'assistant_message'
      ])
    );

    expect(segments.map((segment) => segment.items.map((entry) => entry.kind))).toEqual([
      ['user_message', 'assistant_message', 'assistant_message'],
      ['tool_call', 'assistant_message', 'assistant_message']
    ]);
    expect(
      conversationSegmentIdentityForItem(
        turn('turn-continuous-agent', ['assistant_message']),
        'next-agent',
        'assistant_message'
      )
    ).toEqual({ id: 'turn-continuous-agent:segment:0', index: 0 });
    expect(
      conversationSegmentIdentityForItem(
        turn('turn-agent-then-tool', ['assistant_message']),
        'next-tool',
        'tool_call'
      )
    ).toEqual({ id: 'turn-agent-then-tool:segment:1', index: 1 });
  });

  it('sends only the normalized realtime Item without repeating the existing large Turn', () => {
    const database = new NodeDatabase(':memory:', 'conversation-segment-item-patch');
    const workspace = database.saveWorkspace({
      path: '/workspace-segment-item-patch',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
        createQueueItem(input: Record<string, unknown>): unknown;
        claimNextQueueItem(sessionId: string): { turn: { id: string } } | undefined;
      };
      nativeSessionWatchService: {
        emitRealtime(sessionId: string, event: { category: string; payload: unknown }): boolean;
      };
      runEventService: { flushPendingText(runId: string): void };
      emitRunEvent(
        runId: string,
        eventType: string,
        payload: unknown,
        status?: 'STARTING' | 'RUNNING'
      ): void;
      emitConversationItem(runId: string, item: unknown): void;
    };
    const emitRealtime = vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime');
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'segment-item-patch',
      content: 'Test Item delta'
    }).run;
    internals.emitRunEvent(run.id, 'run.started', {}, 'STARTING');
    internals.emitRunEvent(run.id, 'run.running', {}, 'RUNNING');
    internals.emitConversationItem(run.id, {
      itemId: 'large-tool',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: { outputSummary: 'x'.repeat(256 * 1024) }
    });
    emitRealtime.mockClear();

    internals.emitRunEvent(run.id, 'text.delta', { text: 'Continue' });
    internals.runEventService.flushPendingText(run.id);

    expect(emitRealtime).toHaveBeenCalledOnce();
    const deltaPayload = emitRealtime.mock.calls[0]?.[1].payload as Record<string, unknown>;
    expect(deltaPayload).toEqual(
      expect.objectContaining({
        sessionId: session.id,
        delta: expect.objectContaining({
          runId: run.id,
          text: 'Continue',
          turnId: expect.any(String),
          segmentId: expect.stringContaining(':segment:'),
          segmentIndex: expect.any(Number)
        })
      })
    );
    expect(deltaPayload).not.toHaveProperty('turn');
    expect(deltaPayload).not.toHaveProperty('segments');
    expect(JSON.stringify(deltaPayload).length).toBeLessThan(2_000);
    emitRealtime.mockClear();

    internals.emitConversationItem(run.id, {
      itemId: 'small-tool',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: { outputSummary: 'Completed' }
    });

    expect(emitRealtime).toHaveBeenCalledOnce();
    const event = emitRealtime.mock.calls[0]?.[1];
    const payload = event?.payload as Record<string, unknown>;
    expect(event?.category).toBe('conversation');
    expect(payload).toEqual(
      expect.objectContaining({
        sessionId: session.id,
        runId: run.id,
        item: expect.objectContaining({
          itemId: `${run.id}:small-tool`,
          kind: 'tool_call',
          status: 'COMPLETED',
          segmentId: expect.stringContaining(':segment:'),
          segmentIndex: expect.any(Number),
          payload: { outputSummary: 'Completed' }
        })
      })
    );
    expect(payload).not.toHaveProperty('turn');
    expect(payload).not.toHaveProperty('segments');
    expect(JSON.stringify(payload).length).toBeLessThan(2_000);

    internals.runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'segment-next-message',
      content: 'Next message in the same Run'
    });
    const next = internals.runtime.claimNextQueueItem(session.id)!;
    internals.emitRunEvent(run.id, 'run.running', {}, 'RUNNING');
    emitRealtime.mockClear();
    internals.emitRunEvent(run.id, 'text.delta', { itemId: 'next-reply', text: 'Next reply' });
    internals.runEventService.flushPendingText(run.id);
    internals.emitConversationItem(run.id, {
      itemId: 'next-reply',
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: 'Next reply', format: 'markdown', model: null }
    });
    const nextSegmentId = conversationSegments(next.turn as never)[0]!.id;
    expect(emitRealtime.mock.calls.map(([, event]) => event.payload)).toEqual([
      expect.objectContaining({
        delta: expect.objectContaining({
          runId: run.id,
          turnId: next.turn.id,
          segmentId: nextSegmentId,
          segmentIndex: 0,
          itemId: `${run.id}:next-reply`
        })
      }),
      expect.objectContaining({
        item: expect.objectContaining({
          turnId: next.turn.id,
          segmentId: nextSegmentId,
          segmentIndex: 0,
          itemId: `${run.id}:next-reply`
        })
      })
    ]);

    connector.stop();
  });

  it('reads an opaque cursor continuously within a Turn and across earlier Turn pages', async () => {
    const pages = new Map([
      [
        '',
        {
          turns: [
            turn('turn-2', ['user_message', 'assistant_message']),
            turn('turn-3', [
              'user_message',
              'assistant_message',
              'tool_call',
              'assistant_message',
              'reasoning_summary',
              'assistant_message'
            ])
          ],
          nextCursor: 'older-turns'
        }
      ],
      [
        'older-turns',
        {
          turns: [turn('turn-1', ['user_message', 'assistant_message'])],
          nextCursor: null
        }
      ]
    ]);
    const readTurns = vi.fn(async (_session, input) => ({
      ...(pages.get(input.cursor ?? '') ?? { turns: [], nextCursor: null }),
      snapshotSequence: 10,
      source: 'official' as const,
      readAt: 20,
      latestVisibleAt: 30
    }));
    const service = new ConversationSegmentService(readTurns as never);
    const session = { id: 'session-1' } as never;

    const latest = await service.read(session, { limit: 2 });
    expect(latest.segments.map((segment) => segment.id)).toEqual([
      'turn-3:segment:1',
      'turn-3:segment:2'
    ]);
    expect(latest.nextCursor).not.toBeNull();

    const middle = await service.read(session, { limit: 2, cursor: latest.nextCursor! });
    expect(middle.segments.map((segment) => segment.id)).toEqual([
      'turn-2:segment:0',
      'turn-3:segment:0'
    ]);

    const oldest = await service.read(session, { limit: 2, cursor: middle.nextCursor! });
    expect(oldest.segments.map((segment) => segment.id)).toEqual(['turn-1:segment:0']);
    expect(oldest.nextCursor).toBeNull();
  });

  it('resumes the containing Turn page instead of replaying newer history', async () => {
    const history = Array.from({ length: 100 }, (_, index) =>
      turn(`turn-${index}`, ['user_message', 'assistant_message', 'tool_call', 'assistant_message'])
    );
    const readTurns = vi.fn(async (_session, input) => {
      const end = input.cursor === undefined ? history.length : Number(input.cursor);
      const start = Math.max(0, end - input.limit);
      return {
        turns: history.slice(start, end),
        nextCursor: start === 0 ? null : String(start),
        snapshotSequence: 1,
        source: 'official' as const,
        readAt: 1,
        latestVisibleAt: 1
      };
    });
    const service = new ConversationSegmentService(readTurns as never);
    const session = { id: 'session-1' } as never;
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.read(session, {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor })
      });
      seen.unshift(...page.segments.map((segment) => segment.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(history.flatMap(conversationSegments).map((segment) => segment.id));
    expect(readTurns.mock.calls[0]?.[1].limit).toBe(3);
    expect(readTurns.mock.calls.slice(1).every(([, input]) => input.limit === 1)).toBe(true);
    expect(readTurns.mock.calls.length).toBeLessThan(180);
  });

  it('accepts legacy boundaries but rejects malformed Turn-page positions', async () => {
    const readTurns = vi.fn(async () => ({
      turns: [turn('turn-1', ['user_message', 'assistant_message', 'tool_call'])],
      nextCursor: null,
      snapshotSequence: 1,
      source: 'official' as const,
      readAt: 1,
      latestVisibleAt: 1
    }));
    const service = new ConversationSegmentService(readTurns);
    const legacy = { version: 1, sessionId: 'session-1', beforeSegmentId: 'turn-1:segment:1' };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(
      (await service.read({ id: 'session-1' } as never, { cursor: encode(legacy) })).segments[0]?.id
    ).toBe('turn-1:segment:0');
    readTurns.mockClear();
    await expect(
      service.read({ id: 'session-1' } as never, { cursor: encode({ ...legacy, turnCursor: 42 }) })
    ).rejects.toThrow('EVENT_CURSOR_INVALID');
    expect(readTurns).not.toHaveBeenCalled();
  });

  it('rejects a cursor for another session or a nonexistent boundary', async () => {
    const service = new ConversationSegmentService(async () => ({
      turns: [turn('turn-1', ['assistant_message'])],
      nextCursor: null,
      snapshotSequence: 1,
      source: 'runtime',
      readAt: 1,
      latestVisibleAt: 1
    }));
    const cursor = Buffer.from(
      JSON.stringify({ version: 1, sessionId: 'other', beforeSegmentId: 'missing' })
    ).toString('base64url');

    await expect(service.read({ id: 'session-1' } as never, { cursor })).rejects.toThrow(
      'EVENT_CURSOR_INVALID'
    );
  });

  it('streams derived Segments without replaying a complete successful Runner Turn', () => {
    const database = new NodeDatabase(':memory:', 'conversation-segment-terminal');
    const workspace = database.saveWorkspace({
      path: '/workspace-segment-terminal',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent);
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
      };
      emitRunEvent(
        runId: string,
        eventType: string,
        payload: unknown,
        status?: 'STARTING' | 'RUNNING' | 'SUCCEEDED'
      ): void;
      emitConversationItem(runId: string, item: unknown): void;
      emitWorkbenchEvent(category: string, payload: unknown): void;
      nativeSessionWatchService: {
        emitRealtime(sessionId: string, event: { category: string; payload: unknown }): boolean;
      };
    };
    const emitRealtime = vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime');
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'segment-terminal',
      content: 'Test Segment'
    }).run;
    internals.emitRunEvent(run.id, 'run.started', {}, 'STARTING');
    internals.emitRunEvent(run.id, 'run.running', {}, 'RUNNING');
    internals.emitRunEvent(run.id, 'text.delta', { text: 'Completed' });
    internals.emitConversationItem(run.id, {
      itemId: 'tool-1',
      kind: 'tool_call',
      status: 'IN_PROGRESS',
      payload: { toolName: 'read' }
    });
    internals.emitRunEvent(run.id, 'text.delta', { text: 'Continue and complete' });
    internals.emitConversationItem(run.id, {
      itemId: 'tool-1',
      kind: 'tool_call',
      status: 'COMPLETED',
      merge: true,
      payload: { outputSummary: 'Read completed' }
    });
    internals.emitRunEvent(run.id, 'run.completed', { status: 'SUCCEEDED' }, 'SUCCEEDED');

    const toolEvents = emitRealtime.mock.calls.flatMap(([, event]) => {
      const payload = event.payload as { item?: { itemId?: string } };
      return payload.item?.itemId === `${run.id}:tool-1` ? [payload.item] : [];
    });
    expect(toolEvents).toEqual([
      expect.objectContaining({
        turnId: expect.any(String),
        segmentId: expect.stringContaining(':segment:1'),
        segmentIndex: 1,
        status: 'IN_PROGRESS'
      }),
      expect.objectContaining({
        turnId: expect.any(String),
        segmentId: expect.stringContaining(':segment:1'),
        segmentIndex: 1,
        status: 'COMPLETED'
      })
    ]);

    expect(
      emitRealtime.mock.calls.some(([, event]) => {
        const payload = event.payload as {
          turn?: { runId?: string };
          segments?: Array<{ items?: Array<{ kind?: string }> }>;
        };
        return (
          payload.turn?.runId === run.id &&
          payload.segments?.some((segment) =>
            segment.items?.some((item) => item.kind === 'tool_call')
          ) === true
        );
      })
    ).toBe(false);
    (connector as unknown as { socket: unknown }).socket = undefined;
    connector.stop();
  });

  it('publishes exactly one complete Turn convergence frame for rejection and interruption terminal states', () => {
    const database = new NodeDatabase(':memory:', 'conversation-segment-terminal-dedup');
    const workspace = database.saveWorkspace({
      path: '/workspace-segment-terminal-dedup',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
      };
      nativeSessionWatchService: {
        emitRealtime(sessionId: string, event: { category: string; payload: unknown }): boolean;
      };
      emitRunEvent(
        runId: string,
        eventType: string,
        payload: unknown,
        status: 'FAILED' | 'INTERRUPTED'
      ): void;
    };
    const emitRealtime = vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime');
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });

    for (const [eventType, status] of [
      ['run.rejected', 'FAILED'],
      ['run.interrupted', 'INTERRUPTED']
    ] as const) {
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: `terminal-dedup-${eventType}`,
        content: `Test ${eventType}`
      }).run;
      emitRealtime.mockClear();

      internals.emitRunEvent(run.id, eventType, { code: 'TEST_TERMINAL' }, status);

      const fullTurnFrames = emitRealtime.mock.calls
        .map(([, event]) => event)
        .filter(
          (event) =>
            event.category === 'conversation' &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            'turn' in event.payload
        );
      expect(fullTurnFrames).toHaveLength(1);
      expect(fullTurnFrames[0]?.payload).toEqual(
        expect.objectContaining({ turn: expect.objectContaining({ runId: run.id }) })
      );
    }

    connector.stop();
  });

  it('does not fall back to a complete Turn for a Runner internal event without projection changes', () => {
    const database = new NodeDatabase(':memory:', 'conversation-segment-internal-event');
    const workspace = database.saveWorkspace({
      path: '/workspace-segment-internal-event',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
      };
      nativeSessionWatchService: {
        emitRealtime(sessionId: string, event: { category: string; payload: unknown }): boolean;
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown): void;
    };
    const emitRealtime = vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime');
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'internal-event',
      content: 'Test internal event'
    }).run;
    emitRealtime.mockClear();

    internals.emitRunEvent(run.id, 'channel.reply', { content: 'Received' });

    const conversationFrames = emitRealtime.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.category === 'conversation');
    expect(conversationFrames).toHaveLength(0);
    connector.stop();
  });
});
