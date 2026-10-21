import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { ConversationHistoryService } from '../../src/service/conversation-history-service.js';
import { ConversationSegmentService } from '../../src/service/conversation-segment-service.js';
import { NodeDatabase } from '../../src/database.js';
import { codexOfficialTurn } from '../../src/runner/codex/conversation-parser.js';
import { conversationItemSchema } from '../../../packages/protocol/src/index.js';

it.each([
  { type: 'localImage', path: '/workspace/picture.png' },
  { type: 'image', url: 'data:image/png;base64,aGVsbG8=' }
])('preserves image-only official user messages and their Rewind target: %j', (content) => {
  const session = { id: 'session', externalSessionId: 'thread' } as Parameters<
    typeof codexOfficialTurn
  >[0];
  const register = vi.fn((images) =>
    images.map((image: { name: string; mime: string }, imageIndex: number) => ({
      name: image.name,
      mime: image.mime,
      runId: 'native-history:session',
      imageIndex
    }))
  );
  const turn = codexOfficialTurn(
    session,
    {
      id: 'turn',
      status: 'completed',
      items: [{ id: 'user', type: 'userMessage', content: [content] }]
    },
    0,
    undefined,
    register
  );
  expect(turn?.userItemId).not.toBeNull();
  expect(turn?.items).toContainEqual(
    expect.objectContaining({
      kind: 'user_message',
      payload: expect.objectContaining({
        text: '',
        attachments: [expect.objectContaining({ mime: 'image/png', imageIndex: 0 })]
      })
    })
  );
  expect(register).toHaveBeenCalledTimes(1);
  for (const item of turn!.items)
    expect(conversationItemSchema.parse(item).payload).toEqual(item.payload);
  expect(JSON.stringify(turn)).not.toContain('/workspace/picture.png');
  expect(JSON.stringify(turn)).not.toContain('aGVsbG8=');
});

it('retains the official failed-Turn error even when no message items were persisted', () => {
  const session = { id: 'session', externalSessionId: 'thread' } as Parameters<
    typeof codexOfficialTurn
  >[0];
  const turn = codexOfficialTurn(
    session,
    {
      id: 'failed-turn',
      status: 'failed',
      items: [],
      error: {
        message: 'The upstream service rejected this request.',
        codexErrorInfo: 'serverOverloaded'
      }
    },
    0,
    undefined
  );
  expect(turn?.status).toBe('FAILED');
  expect(turn?.items).toContainEqual(
    expect.objectContaining({
      kind: 'error',
      status: 'FAILED',
      payload: expect.objectContaining({
        code: 'CODEX_RUN_FAILED',
        message: 'The upstream service rejected this request.'
      })
    })
  );
  for (const item of turn!.items)
    expect(conversationItemSchema.parse(item).payload).toEqual(item.payload);
});

it.each(['image/*', `image/${'x'.repeat(129)}`])(
  'keeps invalid inline MIME %s as metadata without registering a private reader',
  (mime) => {
    const session = { id: 'session', externalSessionId: 'thread' } as Parameters<
      typeof codexOfficialTurn
    >[0];
    const register = vi.fn((images) =>
      images.map(({ name, mime }: { name: string; mime: string }) => ({ name, mime }))
    );
    const turn = codexOfficialTurn(
      session,
      {
        id: 'turn',
        status: 'completed',
        items: [
          {
            id: 'user',
            type: 'userMessage',
            content: [{ type: 'image', url: `data:${mime};base64,aGVsbG8=` }]
          }
        ]
      },
      0,
      undefined,
      register
    );
    expect(register.mock.calls[0]![0][0]).not.toHaveProperty('read');
    expect(
      (conversationItemSchema.parse(turn!.items[0]).payload as { attachments: unknown[] })
        .attachments
    ).toEqual([{ name: 'Image #1', mime: 'image/unknown' }]);
  }
);

it('does not duplicate a native Turn error already projected live', () => {
  const session = { id: 'session', externalSessionId: 'thread' } as Parameters<
    typeof codexOfficialTurn
  >[0];
  const native = {
    id: 'failed-turn',
    status: 'failed',
    items: [],
    error: { message: 'The upstream service rejected this request.' }
  };
  const managed = codexOfficialTurn(session, native, 0, undefined)!;
  expect(
    codexOfficialTurn(session, native, 0, managed)?.items.filter((item) => item.kind === 'error')
  ).toHaveLength(1);
});

it('bounds private inline image readers and retains metadata for unsupported references', () => {
  const session = { id: 'session', externalSessionId: 'thread' } as Parameters<
    typeof codexOfficialTurn
  >[0];
  const data = Buffer.alloc(4 * 1024 * 1024).toString('base64');
  const register = vi.fn((images: readonly { name: string; mime: string; read?: unknown }[]) =>
    images.map(({ name, mime }) => ({ name, mime }))
  );
  const turn = codexOfficialTurn(
    session,
    {
      id: 'image-turn',
      status: 'completed',
      items: [
        {
          id: 'user',
          type: 'userMessage',
          content: [
            ...Array.from({ length: 3 }, () => ({
              type: 'image',
              url: `data:image/png;base64,${data}`
            })),
            { type: 'image', url: 'https://example.invalid/unknown' },
            { type: 'image', fileId: 'private-file-id' },
            { type: 'image', url: 'data:image/png;base64,aGVsbG8=' }
          ]
        }
      ]
    },
    0,
    undefined,
    register
  );
  expect(register.mock.calls.flatMap(([images]) => images)).toHaveLength(5);
  expect(
    register.mock.calls.flatMap(([images]) => images).filter((image) => image.read !== undefined)
  ).toHaveLength(2);
  expect(JSON.stringify(turn)).not.toContain('data:image');
  expect(JSON.stringify(turn)).not.toContain('example.invalid');
  expect(JSON.stringify(turn)).not.toContain('private-file-id');
  for (const item of turn!.items)
    expect(conversationItemSchema.parse(item).payload).toEqual(item.payload);
});

it.each([
  ['inProgress', 'RUNNING'],
  ['completed', 'SUCCEEDED'],
  ['failed', 'FAILED'],
  ['interrupted', 'INTERRUPTED']
])('preserves official Codex Turn status %s without a managed Run', (nativeStatus, status) => {
  const session = { id: 'session', externalSessionId: 'thread' } as Parameters<
    typeof codexOfficialTurn
  >[0];
  const turn = codexOfficialTurn(
    session,
    {
      id: 'turn',
      status: nativeStatus,
      startedAt: 1,
      completedAt: 2,
      items: [
        {
          id: 'command',
          type: 'commandExecution',
          command: 'echo hello',
          status: nativeStatus
        }
      ]
    },
    0,
    undefined
  );
  expect(turn?.status).toBe(status);
  expect(turn?.completedAt).toBe(nativeStatus === 'inProgress' ? null : 2000);
  expect(turn?.items[0]?.status).toBe(
    nativeStatus === 'inProgress'
      ? 'IN_PROGRESS'
      : nativeStatus === 'completed'
        ? 'COMPLETED'
        : status
  );
});

it.each([
  { runtimeHistory: true, cursor: undefined, fallback: true },
  { runtimeHistory: false, cursor: undefined, fallback: false },
  { runtimeHistory: true, cursor: 'invalid', fallback: false }
])(
  'preserves accepted Runtime output without hiding persistent-history or cursor errors: %j',
  async ({ runtimeHistory, cursor, fallback }) => {
    const session = {
      id: 'session-history-failure',
      runner: 'codex',
      externalSessionId: 'native-history-failure',
      nativeControl: 'EXTERNAL'
    };
    const turns = runtimeHistory
      ? [
          {
            id: 'accepted-turn',
            sessionId: session.id,
            items: [],
            startedAt: 1,
            completedAt: 2
          }
        ]
      : [];
    const service = new ConversationHistoryService({
      runtime: {
        getAgentSession: () => (runtimeHistory ? session : undefined),
        listConversationTurns: () => ({ turns, nextCursor: null })
      },
      runners: {
        require: () => ({
          readConversationHistory: async () => {
            throw new Error('OFFICIAL_HISTORY_FAILURE');
          }
        })
      },
      snapshotSequence: () => 1,
      hasManagedActiveRun: () => false
    } as never);
    const read = service.read(session as never, cursor === undefined ? {} : { cursor });
    if (fallback) await expect(read).resolves.toMatchObject({ source: 'runtime', turns });
    else await expect(read).rejects.toThrow('OFFICIAL_HISTORY_FAILURE');
  }
);

it('does not identify distinct Turns by their shared Run when the submission ID is absent', async () => {
  const session = {
    id: 'session-shared-run',
    runner: 'codex',
    externalSessionId: 'thread-shared-run',
    nativeControl: 'MAR_MANAGED'
  };
  const turn = (id: string) => ({
    id,
    sessionId: session.id,
    runId: 'shared-run',
    status: 'SUCCEEDED',
    userItemId: `${id}:user`,
    model: null,
    effort: null,
    access: null,
    startedAt: 1,
    completedAt: 1,
    items: [
      {
        id: `${id}:user`,
        kind: 'user_message',
        payload: { text: id },
        startedAt: 1,
        completedAt: 1
      }
    ]
  });
  const service = new ConversationHistoryService({
    runtime: {
      getAgentSession: () => session,
      listConversationTurns: () => ({ turns: [turn('runtime-new')], nextCursor: null })
    },
    runners: {
      require: () => ({
        readConversationHistory: async (readers: { official(): Promise<unknown> }) => ({
          ...((await readers.official()) as object),
          source: 'official'
        })
      })
    },
    capabilities: () => ({}),
    attachments: {},
    snapshotSequence: () => 1,
    hasManagedActiveRun: () => false,
    setExternalActivity: () => undefined
  } as never);
  service.readOfficial = async () => ({ turns: [turn('official-old')], nextCursor: null }) as never;
  service.readNative = async () => undefined;

  const page = await service.read(session as never, { limit: 10 });
  expect(page.turns.map((value) => value.id)).toEqual(['official-old', 'runtime-new']);
});

it('keeps the scheduled source when official history replaces a live user message', async () => {
  const session = {
    id: 'thread-scheduled',
    runner: 'codex',
    externalSessionId: 'thread-scheduled',
    nativeControl: 'MAR_MANAGED'
  };
  const turn = (source?: 'SCHEDULED') => ({
    id: 'turn-scheduled',
    sessionId: session.id,
    runId: 'run-scheduled',
    status: 'SUCCEEDED',
    userItemId: 'user-scheduled',
    model: null,
    effort: null,
    access: null,
    startedAt: 1,
    completedAt: 2,
    items: [
      {
        id: 'user-scheduled',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: {
          text: 'Check status',
          clientMessageId: 'scheduled-occurrence',
          ...(source === undefined ? {} : { source })
        },
        startedAt: 1,
        completedAt: 1
      }
    ]
  });
  const service = new ConversationHistoryService({
    runtime: {
      getAgentSession: () => session,
      listConversationTurns: () => ({ turns: [turn('SCHEDULED')], nextCursor: null })
    },
    runners: {
      require: () => ({
        readConversationHistory: async (readers: { official(): Promise<unknown> }) => ({
          ...((await readers.official()) as object),
          source: 'official'
        })
      })
    },
    capabilities: () => ({}),
    attachments: {},
    snapshotSequence: () => 1,
    hasManagedActiveRun: () => false,
    setExternalActivity: () => undefined
  } as never);
  service.readOfficial = async () => ({ turns: [turn()], nextCursor: null }) as never;
  service.readNative = async () => undefined;
  const page = await service.read(session as never, { limit: 10 });
  expect(page.turns[0]?.items[0]?.payload).toMatchObject({
    text: 'Check status',
    source: 'SCHEDULED'
  });
});

it('Codex official history hides Composer image internals', () => {
  const session = {
    id: 'thread-official-image',
    runner: 'codex',
    externalSessionId: 'thread-official-image'
  } as Parameters<typeof codexOfficialTurn>[0];
  const turn = codexOfficialTurn(
    session,
    {
      id: 'turn-official-image',
      items: [
        {
          id: 'user-official-image',
          type: 'userMessage',
          content: [
            { type: 'text', text: 'view image' },
            {
              type: 'text',
              text: '<image name=[Image #1] path="/tmp/myagentroam-attachment-example/1.png">'
            },
            { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
            { type: 'text', text: '</image>' }
          ]
        }
      ]
    },
    0,
    undefined
  );

  expect(turn?.items[0]?.payload).toMatchObject({ text: 'view image' });
  expect(JSON.stringify(turn)).not.toContain('myagentroam-attachment');
});

it('preserves preceding live Agent text order when an official Codex plan converges', () => {
  const session = {
    id: 'thread-plan-order',
    externalSessionId: 'thread-plan-order'
  } as Parameters<typeof codexOfficialTurn>[0];
  const managed = {
    id: 'managed-turn',
    sessionId: session.id,
    runId: 'run-plan-order',
    userItemId: 'managed-user',
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    startedAt: 1,
    completedAt: 4,
    items: [
      {
        id: 'managed-user',
        sessionId: session.id,
        turnId: 'managed-turn',
        runId: 'run-plan-order',
        parentItemId: null,
        sourceSequence: 1,
        revision: 0,
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: 'create a plan', clientMessageId: 'message-plan-order' },
        startedAt: 1,
        completedAt: 1
      },
      {
        id: 'run-plan-order:assistant:2',
        sessionId: session.id,
        turnId: 'managed-turn',
        runId: 'run-plan-order',
        parentItemId: null,
        sourceSequence: 2,
        revision: 0,
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'I will inspect the current implementation first.' },
        startedAt: 2,
        completedAt: 2
      }
    ]
  } as Parameters<typeof codexOfficialTurn>[3];

  const turn = codexOfficialTurn(
    session,
    {
      id: 'native-plan-order',
      startedAt: '2026-08-21T00:00:00.000Z',
      completedAt: '2026-08-21T00:00:01.000Z',
      items: [
        {
          id: 'user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'create a plan' }]
        },
        { id: 'plan', type: 'plan', text: '1. Inspect. 2. Implement.' }
      ]
    },
    0,
    managed
  );

  expect(turn?.items.map((item) => item.kind)).toEqual([
    'user_message',
    'assistant_message',
    'plan'
  ]);
});

it('preserves tool/Agent order when official Codex history replaces a live tool', () => {
  const session = {
    id: 'thread-tool-order',
    externalSessionId: 'thread-tool-order'
  } as Parameters<typeof codexOfficialTurn>[0];
  const baseItem = {
    sessionId: session.id,
    turnId: 'managed-tool-turn',
    runId: 'run-tool-order',
    parentItemId: null,
    revision: 0,
    status: 'COMPLETED',
    startedAt: 1,
    completedAt: 1
  } as const;
  const managed = {
    id: 'managed-tool-turn',
    sessionId: session.id,
    runId: 'run-tool-order',
    userItemId: 'managed-tool-user',
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    startedAt: 1,
    completedAt: 4,
    items: [
      {
        ...baseItem,
        id: 'managed-tool-user',
        sourceSequence: 1,
        kind: 'user_message',
        payload: { text: 'check status', clientMessageId: 'message-tool-order' }
      },
      {
        ...baseItem,
        id: 'run-tool-order:assistant:2',
        sourceSequence: 2,
        kind: 'assistant_message',
        payload: { text: "I'll inspect first." }
      },
      {
        ...baseItem,
        id: 'run-tool-order:codex:call-status',
        sourceSequence: 3,
        kind: 'command_execution',
        payload: { command: 'git status', outputPreview: '' }
      },
      {
        ...baseItem,
        id: 'run-tool-order:assistant:4',
        sourceSequence: 4,
        kind: 'assistant_message',
        payload: { text: 'old reply' }
      }
    ]
  } as Parameters<typeof codexOfficialTurn>[3];

  const turn = codexOfficialTurn(
    session,
    {
      id: 'native-tool-order',
      startedAt: '2026-08-21T00:00:00.000Z',
      completedAt: '2026-08-21T00:00:01.000Z',
      items: [
        {
          id: 'user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'check status' }]
        },
        {
          type: 'function_call',
          call_id: 'call-status',
          name: 'exec',
          arguments: '{"cmd":"git status"}'
        },
        { id: 'agent', type: 'agentMessage', text: 'Workspace is clean.' }
      ]
    },
    0,
    managed
  );

  expect(turn?.items.map((item) => item.kind)).toEqual([
    'user_message',
    'assistant_message',
    'tool_call',
    'assistant_message'
  ]);
  expect(
    turn?.items
      .filter((item) => item.kind === 'assistant_message')
      .map((item) => (item.payload as { text?: string }).text)
  ).toEqual(["I'll inspect first.", 'Workspace is clean.']);
  expect(turn?.items.filter((item) => item.kind === 'tool_call')).toHaveLength(1);
});

it('preserves remaining stable-ID live messages when official Codex history backfills only some Agent messages', () => {
  const session = {
    id: 'thread-partial-agent-history',
    externalSessionId: 'thread-partial-agent-history'
  } as Parameters<typeof codexOfficialTurn>[0];
  const baseItem = {
    sessionId: session.id,
    turnId: 'managed-partial-agent-turn',
    runId: 'run-partial-agent-history',
    parentItemId: null,
    revision: 0,
    status: 'COMPLETED',
    startedAt: 1,
    completedAt: 1
  } as const;
  const managed = {
    id: 'managed-partial-agent-turn',
    sessionId: session.id,
    runId: 'run-partial-agent-history',
    userItemId: 'managed-partial-user',
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    startedAt: 1,
    completedAt: 10,
    items: [
      {
        ...baseItem,
        id: 'managed-partial-user',
        sourceSequence: 1,
        kind: 'user_message',
        payload: { text: 'continue checking', clientMessageId: 'message-partial-agent' }
      },
      ...['first live message', 'second live message', 'third live message'].map((text, index) => ({
        ...baseItem,
        id: `run-partial-agent-history:codex:agent-${index + 1}`,
        sourceSequence: index + 2,
        kind: 'assistant_message' as const,
        payload: { text }
      }))
    ]
  } as Parameters<typeof codexOfficialTurn>[3];

  const turn = codexOfficialTurn(
    session,
    {
      id: 'native-partial-agent-turn',
      status: 'inProgress',
      startedAt: '2026-08-26T00:00:00.000Z',
      items: [
        {
          id: 'user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'continue checking' }]
        },
        { id: 'agent-1', type: 'agentMessage', text: 'first message' }
      ]
    },
    0,
    managed
  );

  expect(
    turn?.items
      .filter((item) => item.kind === 'assistant_message')
      .map((item) => (item.payload as { text?: string }).text)
  ).toEqual(['first live message', 'second live message', 'third live message']);
});

it('replaces a longer streamed Codex Agent message with its completed official item by native ID', () => {
  const session = {
    id: 'thread-short-final',
    externalSessionId: 'thread-short-final'
  } as Parameters<typeof codexOfficialTurn>[0];
  const managed = {
    id: 'managed-short-final',
    sessionId: session.id,
    runId: 'run-short-final',
    userItemId: null,
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    startedAt: 1,
    completedAt: Date.parse('2026-08-26T00:00:10.000Z'),
    items: [
      {
        id: 'run-short-final:codex:agent-final',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'A much longer streamed version' }
      }
    ]
  } as unknown as Parameters<typeof codexOfficialTurn>[3];
  const turn = codexOfficialTurn(
    session,
    {
      id: 'turn-short-final',
      status: 'completed',
      completedAt: '2026-08-26T00:00:01.000Z',
      items: [{ id: 'agent-final', type: 'agentMessage', text: 'Final' }]
    },
    0,
    managed
  );
  expect(turn?.items.find((item) => item.kind === 'assistant_message')?.payload).toMatchObject({
    text: 'Final'
  });
});

describe('Node Workbench official-history lag compensation', () => {
  it('projects MAR Agent image-tool events through the real registry in live and historical views with controlled reads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-generated-image-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-mar-agent-generated-image');
    const workspacePath = join(home, 'workspace');
    const sessionId = 'mar-agent-image-session';
    const imageDirectory = join(home, '.mar', 'agent', 'sessions', sessionId, 'generated_images');
    const imageBytes = Buffer.from('generated-image-bytes');
    let connector: NodeConnector | undefined;
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(imageDirectory, { recursive: true });
      await writeFile(join(imageDirectory, 'image-call.png'), imageBytes);
      const workspace = database.saveWorkspace({
        path: workspacePath,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false },
          openCode: { available: false },
          marAgent: { available: true, version: '0.9.35' }
        }
      });
      const internals = connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
          createMessageRun(input: Record<string, unknown>): { run: { id: string } };
        };
        marAgentRunController: {
          project(runId: string, event: Record<string, unknown>): void;
        };
        nativeSessionWatchService: {
          emitRealtime(sessionId: string, event: { category: string; payload: unknown }): boolean;
        };
      };
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        externalSessionId: sessionId,
        nativeControl: 'MAR_MANAGED'
      });
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'message-image',
        content: 'generate an image'
      }).run;
      const emitted: Array<{ category: string; payload: unknown }> = [];
      vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime').mockImplementation(
        (_sessionId, event) => {
          emitted.push(event);
          return true;
        }
      );
      const eventBase = {
        timestamp: '2026-09-04T00:00:00.000Z',
        sessionId,
        executionId: 'execution-image',
        turnId: 'turn-image'
      };

      internals.marAgentRunController.project(run.id, {
        ...eventBase,
        eventId: 'image-started',
        sequence: 1,
        type: 'tool.started',
        toolName: 'codex_image_gen',
        callId: 'image-call',
        input: { prompt: 'A lighthouse in a storm.' }
      });
      internals.marAgentRunController.project(run.id, {
        ...eventBase,
        eventId: 'image-completed',
        sequence: 2,
        type: 'tool.completed',
        toolName: 'codex_image_gen',
        callId: 'image-call',
        summary: join(imageDirectory, 'image-call.png'),
        truncated: false,
        artifacts: [
          {
            kind: 'image',
            name: 'image-call.png',
            mimeType: 'image/png',
            byteSize: imageBytes.byteLength,
            sha256: 'a'.repeat(64),
            fileName: 'image-call.png'
          }
        ]
      });

      const realtimeItems = emitted.flatMap((event) => {
        if (
          event.category !== 'conversation' ||
          typeof event.payload !== 'object' ||
          event.payload === null ||
          !('item' in event.payload)
        )
          return [];
        return [(event.payload as { item: Record<string, unknown> }).item];
      });
      expect(realtimeItems.map((item) => item.status)).toEqual(['IN_PROGRESS', 'COMPLETED']);
      const completed = realtimeItems.at(-1);
      const liveImageRef = (
        completed?.payload as { attachments?: Array<{ imageRef?: string }> } | undefined
      )?.attachments?.[0]?.imageRef;
      expect(completed?.payload).toMatchObject({
        attachments: [
          {
            name: 'image-call.png',
            mime: 'image/png',
            runId: `native-history:${session.id}`,
            imageRef: expect.stringMatching(/^file:[^\s]+$/u)
          }
        ]
      });

      const page = (await operation(connector, 'session.turns.list', {
        sessionId: session.id,
        unit: 'SEGMENT'
      })) as {
        segments: Array<{
          items: Array<{ kind: string; payload: Record<string, unknown> }>;
        }>;
      };
      const historyTool = page.segments
        .flatMap((segment) => segment.items)
        .find((item) => item.kind === 'tool_call');
      expect(historyTool?.payload).toEqual(completed?.payload);
      await expect(
        operation(connector, 'run.image.read', {
          runId: `native-history:${session.id}`,
          imageRef: liveImageRef!
        })
      ).resolves.toMatchObject({
        image: { dataBase64: imageBytes.toString('base64') }
      });
      expect(JSON.stringify({ emitted, page })).not.toContain(home);
    } finally {
      await connector?.stop();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the completed MAR Agent stream authoritative until its Runtime is gone', async () => {
    const session = {
      id: 'session-failed-idle',
      externalSessionId: 'session-failed-idle',
      nativeControl: 'MAR_MANAGED',
      runner: 'mar-agent'
    } as const;
    const runtimeTurn = {
      id: 'runtime-failed-turn',
      sessionId: session.id,
      runId: 'run-failed-idle',
      userItemId: 'runtime-failed-user',
      status: 'FAILED',
      model: null,
      effort: null,
      access: null,
      startedAt: 1,
      completedAt: 2,
      items: [
        {
          id: 'runtime-failed-user',
          sessionId: session.id,
          turnId: 'runtime-failed-turn',
          runId: 'run-failed-idle',
          parentItemId: null,
          sourceSequence: 1,
          revision: 0,
          kind: 'user_message',
          status: 'COMPLETED',
          payload: {
            text: 'execute the task',
            clientMessageId: 'message-failed-idle',
            attachments: [
              {
                name: 'diagram.png',
                mime: 'image/png',
                byteSize: 3,
                runId: 'run-failed-idle',
                imageIndex: 0
              }
            ]
          },
          startedAt: 1,
          completedAt: 1
        },
        {
          id: 'run-failed-idle:runner-error',
          sessionId: session.id,
          turnId: 'runtime-failed-turn',
          runId: 'run-failed-idle',
          parentItemId: null,
          sourceSequence: 2,
          revision: 0,
          kind: 'error',
          status: 'FAILED',
          payload: { code: 'RUNNER_FAILED', message: 'Runner failed.' },
          startedAt: 2,
          completedAt: 2
        }
      ]
    } as const;
    const officialTurn = {
      ...runtimeTurn,
      id: 'official-failed-turn',
      runId: null,
      userItemId: 'official-failed-user',
      status: 'SUCCEEDED',
      items: [
        {
          ...runtimeTurn.items[0],
          id: 'official-failed-user',
          turnId: 'official-failed-turn',
          runId: null,
          payload: {
            text: 'execute the task',
            clientMessageId: 'message-failed-idle',
            attachments: [{ name: 'diagram.png', mime: 'image/png', byteSize: 3 }]
          }
        }
      ]
    } as const;
    let runtimeTurns: readonly unknown[] = [runtimeTurn];
    let officialTurns: readonly unknown[] = [officialTurn];
    let imageBase64: string | undefined = 'AQID';
    const service = new ConversationHistoryService({
      runtime: {
        getAgentSession: () => session,
        listConversationTurns: () => ({ turns: runtimeTurns, nextCursor: null })
      },
      runners: {
        require: () => ({
          acceptsTruncatedNativeHistory: () => false,
          readConversationHistory: async (readers: {
            native(): Promise<unknown>;
            official(): Promise<unknown>;
          }) => {
            const official = await readers.official();
            return official === undefined
              ? undefined
              : { ...(official as object), source: 'official' };
          }
        })
      },
      capabilities: () => ({}),
      attachments: {
        read: (runId: string, imageIndex: number) =>
          imageBase64 !== undefined && runId === 'run-failed-idle' && imageIndex === 0
            ? { name: 'diagram.png', mime: 'image/png', dataBase64: imageBase64 }
            : undefined
      },
      snapshotSequence: () => 1,
      hasManagedActiveRun: () => false,
      setExternalActivity: () => undefined
    } as never);
    const readOfficial = vi.fn(async () => ({ turns: officialTurns, nextCursor: null }) as never);
    service.readOfficial = readOfficial;
    service.readNative = async () => undefined;

    const page = await service.read(session as never, { limit: 10 });

    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]).toMatchObject({
      runId: 'run-failed-idle',
      status: 'FAILED'
    });
    expect(page.turns[0]?.items).toEqual(runtimeTurn.items);
    expect(readOfficial).toHaveBeenCalledOnce();

    officialTurns = [
      {
        ...officialTurn,
        status: 'FAILED',
        items: [
          officialTurn.items[0],
          {
            ...runtimeTurn.items[1],
            id: 'official-runner-error',
            payload: { code: 'OFFICIAL_FAILED', message: 'Official failure.' }
          }
        ]
      }
    ];
    const stillStreaming = await service.read(session as never, { limit: 10 });
    expect(stillStreaming.turns[0]?.items).toEqual(runtimeTurn.items);
    expect(readOfficial).toHaveBeenCalledTimes(2);

    runtimeTurns = [];
    const recovered = await service.read(session as never, { limit: 10 });
    expect(recovered.turns[0]?.items.filter((item) => item.kind === 'error')).toEqual([
      expect.objectContaining({
        id: 'official-runner-error',
        payload: { code: 'OFFICIAL_FAILED', message: 'Official failure.' }
      })
    ]);

    officialTurns = [officialTurn];
    imageBase64 = 'aW1hZ2U=';
    const mismatchedImage = await service.read(session as never, { limit: 10 });
    expect(mismatchedImage.turns[0]?.items[0]?.payload).toEqual(officialTurn.items[0]?.payload);

    runtimeTurns = [{ ...runtimeTurn, status: 'SUCCEEDED', items: [runtimeTurn.items[0]] }];
    imageBase64 = undefined;
    const subsequentSuccess = await service.read(session as never, { limit: 10 });
    expect(subsequentSuccess.turns[0]).toMatchObject({ status: 'SUCCEEDED' });
    expect(subsequentSuccess.turns[0]?.items.some((item) => item.kind === 'error')).toBe(false);
    expect(subsequentSuccess.turns[0]?.items[0]?.payload).toEqual(runtimeTurn.items[0]?.payload);
  });

  it('honors the configured native-first Runner source policy', async () => {
    const official = vi.fn(async () => undefined);
    const service = new ConversationHistoryService({
      runtime: {
        getAgentSession: () => undefined,
        listConversationTurns: () => ({ turns: [], nextCursor: null })
      },
      runners: {
        require: () => ({
          acceptsTruncatedNativeHistory: () => false,
          readConversationHistory: async (readers: {
            native(): Promise<unknown>;
            official(): Promise<unknown>;
          }) => {
            const native = await readers.native();
            if (native !== undefined) return { ...(native as object), source: 'native' };
            const fallback = await readers.official();
            return fallback === undefined
              ? undefined
              : { ...(fallback as object), source: 'official' };
          }
        })
      },
      capabilities: () => ({}),
      attachments: { registerNative: () => [] },
      snapshotSequence: () => 1,
      hasManagedActiveRun: () => false,
      setExternalActivity: () => undefined
    } as never);
    service.readNative = async () => ({
      runner: 'codex',
      externalSessionId: 'native-jsonl-first',
      cwd: '/workspace/jsonl-first',
      digest: 'jsonl-first',
      items: [{ kind: 'message', role: 'USER', text: 'JSONL content', createdAt: 1 }],
      lastActivityAt: 1,
      truncated: false
    });
    service.readOfficial = official;

    await expect(
      service.read(
        {
          id: 'session-jsonl-first',
          externalSessionId: 'native-jsonl-first',
          nativeControl: 'MAR_MANAGED',
          runner: 'codex',
          cwd: '/workspace/jsonl-first'
        } as never,
        { limit: 10 }
      )
    ).resolves.toMatchObject({ source: 'native', turns: [expect.any(Object)] });
    expect(official).not.toHaveBeenCalled();
  });

  it('returns the active Run in the first page and continues with earlier official history after the local window is exhausted', async () => {
    const turn = (id: string, startedAt: number) => ({
      id,
      sessionId: 'session-active-fast-history',
      runId: id,
      userItemId: null,
      status: id === 'runtime-active' ? 'RUNNING' : 'SUCCEEDED',
      model: null,
      effort: null,
      access: null,
      items: [],
      startedAt,
      completedAt: id === 'runtime-active' ? null : startedAt
    });
    const runtimeTurns = [turn('runtime-older', 20), turn('runtime-active', 30)];
    let resolveOfficial!: (value: { turns: ReturnType<typeof turn>[]; nextCursor: null }) => void;
    const official = new Promise<{ turns: ReturnType<typeof turn>[]; nextCursor: null }>(
      (resolve) => (resolveOfficial = resolve)
    );
    const service = new ConversationHistoryService({
      runtime: {
        getAgentSession: () => ({}),
        listConversationTurns: (input: { cursor?: string; limit?: number }) => {
          const end = input.cursor === undefined ? runtimeTurns.length : Number(input.cursor);
          const start = Math.max(0, end - (input.limit ?? 30));
          return {
            turns: runtimeTurns.slice(start, end),
            nextCursor: start > 0 ? String(start) : null
          };
        }
      },
      runners: {
        require: () => ({
          acceptsTruncatedNativeHistory: () => false,
          readConversationHistory: async (readers: {
            native(): Promise<unknown>;
            official(): Promise<unknown>;
          }) => {
            const native = await readers.native();
            if (native !== undefined) return { ...(native as object), source: 'native' };
            const official = await readers.official();
            return official === undefined
              ? undefined
              : { ...(official as object), source: 'official' };
          }
        })
      },
      capabilities: () => ({}),
      attachments: {},
      snapshotSequence: () => 1,
      hasManagedActiveRun: () => true,
      setExternalActivity: () => undefined
    } as never);
    const readOfficial = vi.fn(async () => official);
    service.readOfficial = readOfficial;
    service.readNative = async () => undefined;
    const session = {
      id: 'session-active-fast-history',
      externalSessionId: 'native-active-fast-history',
      nativeControl: 'MAR_MANAGED',
      runner: 'codex'
    } as never;

    const initial = await service.read(session, { limit: 1 });
    expect(initial).toMatchObject({
      source: 'runtime',
      turns: [expect.objectContaining({ id: 'runtime-active' })]
    });
    expect(initial.nextCursor).not.toBeNull();

    const segments = new ConversationSegmentService((target, input) => service.read(target, input));
    const segmentInitial = await segments.read(session, { limit: 10 });
    expect(segmentInitial.segments.map((entry) => entry.turnId)).toEqual([
      'runtime-older',
      'runtime-active'
    ]);
    expect(segmentInitial.deferredOlderHistory).toBe(true);
    expect(segmentInitial.nextCursor).not.toBeNull();
    expect(readOfficial).not.toHaveBeenCalled();

    const localOlder = await service.read(session, { limit: 1, cursor: initial.nextCursor! });
    expect(localOlder.turns.map((entry) => entry.id)).toEqual(['runtime-older']);
    expect(localOlder.nextCursor).not.toBeNull();
    expect(readOfficial).not.toHaveBeenCalled();

    resolveOfficial({
      turns: [
        turn('official-oldest', 10),
        turn('official-runtime-older', 20),
        turn('official-runtime-active', 30)
      ],
      nextCursor: null
    });
    await Promise.resolve();
    expect(segmentInitial.segments.map((entry) => entry.turnId)).toEqual([
      'runtime-older',
      'runtime-active'
    ]);
    const segmentOlder = await segments.read(session, {
      limit: 10,
      cursor: segmentInitial.nextCursor!
    });
    expect(readOfficial).toHaveBeenCalledTimes(1);
    expect(segmentOlder.segments.map((entry) => entry.turnId)).toEqual(['official-oldest']);
    expect(segmentOlder.nextCursor).toBeNull();
    expect(segmentOlder.deferredOlderHistory).toBeUndefined();

    const officialOlder = await service.read(session, {
      limit: 3,
      cursor: localOlder.nextCursor!
    });
    expect(officialOlder).toMatchObject({
      source: 'official',
      turns: [expect.objectContaining({ id: 'official-oldest' })],
      nextCursor: null
    });
  });

  it('reserves a slot for the newest local Turn not yet backfilled when the official page is full and returns a continuous cursor', async () => {
    const item = (id: string, turnId: string, text: string) => ({
      id,
      sessionId: 'session-page-limit',
      turnId,
      runId: turnId,
      parentItemId: null,
      sourceSequence: 1,
      revision: 0,
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text },
      startedAt: 1,
      completedAt: 1
    });
    const officialTurns = Array.from({ length: 10 }, (_, index) => ({
      id: `official-${index + 1}`,
      sessionId: 'session-page-limit',
      runId: `run-${index + 1}`,
      userItemId: null,
      status: 'SUCCEEDED',
      model: null,
      effort: null,
      access: null,
      items: [
        {
          ...item(`official-user-${index + 1}`, `run-${index + 1}`, `request-${index + 1}`),
          kind: 'user_message',
          payload: { text: `request-${index + 1}`, clientMessageId: `client-${index + 1}` }
        },
        item(`official-item-${index + 1}`, `run-${index + 1}`, 'official')
      ],
      startedAt: index + 1,
      completedAt: index + 1
    }));
    const localTurns = [
      {
        ...officialTurns[0]!,
        id: 'local-old',
        runId: 'run-old',
        items: [item('local-old-item', 'run-old', 'earlier local record')],
        startedAt: 0,
        completedAt: 0
      },
      ...officialTurns.map((turn, index) => ({
        ...turn,
        id: `local-${turn.runId}`,
        items:
          index === officialTurns.length - 1
            ? [
                ...turn.items,
                {
                  ...item('pending-input', turn.id, ''),
                  kind: 'user_input_request',
                  status: 'PENDING',
                  payload: { requestId: 'request-pending', questions: [] },
                  startedAt: 10,
                  completedAt: null
                },
                {
                  ...item('approval-item', turn.id, ''),
                  kind: 'approval_request',
                  status: 'COMPLETED',
                  payload: {
                    approvalId: 'approval-1',
                    approvalStatus: 'APPROVED',
                    approval: { tool: 'shell', command: 'pwd' }
                  },
                  startedAt: 10,
                  completedAt: 10
                }
              ]
            : turn.items
      })),
      {
        ...officialTurns[0]!,
        id: 'local-lag',
        runId: 'run-lag',
        items: [item('local-lag-item', 'run-lag', 'latest local reply')],
        startedAt: 11,
        completedAt: 11
      }
    ];
    const requestedLimits: number[] = [];
    const service = new ConversationHistoryService({
      runtime: {
        getAgentSession: () => ({}),
        listConversationTurns: () => ({ turns: localTurns, nextCursor: null })
      },
      runners: {
        require: () => ({
          acceptsTruncatedNativeHistory: () => false,
          readConversationHistory: async (readers: {
            native(): Promise<unknown>;
            official(): Promise<unknown>;
          }) => {
            const native = await readers.native();
            if (native !== undefined) return { ...(native as object), source: 'native' };
            const official = await readers.official();
            return official === undefined
              ? undefined
              : { ...(official as object), source: 'official' };
          }
        })
      },
      capabilities: () => ({}),
      attachments: {},
      snapshotSequence: () => 1,
      hasManagedActiveRun: () => false,
      setExternalActivity: () => undefined
    } as never);
    service.readOfficial = async (_session, input) => {
      const limit = input.limit ?? 30;
      requestedLimits.push(limit);
      return { turns: officialTurns.slice(-limit), nextCursor: `before-${11 - limit}` };
    };
    service.readNative = async () => undefined;

    const page = await service.read(
      {
        id: 'session-page-limit',
        externalSessionId: 'native-page-limit',
        runner: 'codex'
      } as never,
      { limit: 10 }
    );

    expect(requestedLimits).toEqual([10, 9]);
    expect(page.turns).toHaveLength(10);
    expect(page.turns.some((turn) => turn.id === 'local-old')).toBe(false);
    expect(page.turns.at(-1)?.id).toBe('local-lag');
    expect(
      page.turns.flatMap((turn) => turn.items).filter((entry) => entry.id === 'pending-input')
    ).toHaveLength(1);
    expect(
      page.turns.flatMap((turn) => turn.items).filter((entry) => entry.id === 'approval-item')
    ).toHaveLength(1);
    expect(page.nextCursor).toBe('before-2');
  });

  it('merges a completed local managed Turn after older official history', async () => {
    const database = new NodeDatabase(':memory:', 'node-official-history-lag');
    const workspace = database.saveWorkspace({
      path: '/workspace/official-history-lag',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown, status?: string): void;
      readOfficialCodexConversation(): Promise<{ turns: unknown[]; nextCursor: null }>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-history-lag'
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'history-lag-message',
      content: 'provide the final result'
    }).run;
    internals.emitRunEvent(run.id, 'text.delta', {
      text: 'final result not yet backfilled by official history'
    });
    internals.emitRunEvent(run.id, 'run.completed', { status: 'SUCCEEDED' }, 'SUCCEEDED');
    internals.conversationHistoryService.readOfficial = async () => ({
      turns: [
        {
          id: 'older-official-turn',
          sessionId: session.id,
          runId: null,
          userItemId: null,
          status: 'SUCCEEDED',
          model: null,
          effort: null,
          access: null,
          startedAt: 1,
          completedAt: 2,
          items: [
            {
              id: 'older-official-message',
              sessionId: session.id,
              turnId: 'older-official-turn',
              runId: null,
              parentItemId: null,
              sourceSequence: null,
              revision: 0,
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: 'earlier official record' },
              startedAt: 1,
              completedAt: 2
            }
          ]
        }
      ],
      nextCursor: null
    });

    const page = (await operation(connector, 'session.turns.list', { sessionId: session.id })) as {
      turns: { runId: string | null; items: { kind: string; payload: { text?: string } }[] }[];
    };

    expect(page.turns).toContainEqual(
      expect.objectContaining({
        runId: run.id,
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: 'assistant_message',
            payload: expect.objectContaining({
              text: 'final result not yet backfilled by official history'
            })
          })
        ])
      })
    );
    expect(page.turns).toHaveLength(2);
    connector.stop();
  });

  it('preserves the complete local managed Turn text when official history lags', async () => {
    const database = new NodeDatabase(':memory:', 'node-official-same-turn-lag');
    const workspace = database.saveWorkspace({
      path: '/workspace/official-same-turn-lag',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
        createExecution(runId: string): { id: string };
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown, status?: string): void;
      codexClient: {
        execution: { managedTurns: Map<string, { sessionId: string; runId: string }> };
        start(): Promise<void>;
        client: { start(): Promise<void>; listThreadTurns(threadId: string): Promise<unknown> };
        stop(): void;
      };
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'thread-same-turn-lag'
      });
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'same-turn-lag-message',
        content: 'provide the final result'
      }).run;
      const execution = internals.runtime.createExecution(run.id);
      internals.emitRunEvent(execution.id, 'text.delta', {
        text: 'complete final result from the live local stream'
      });
      internals.emitRunEvent(execution.id, 'run.completed', { status: 'SUCCEEDED' }, 'SUCCEEDED');
      internals.codexClient.execution.managedTurns.set('native-turn-same-id', {
        sessionId: session.id,
        runId: execution.id
      });
      Object.assign(internals.codexClient.client, {
        async start() {},
        async listThreadTurns(_threadId: string) {
          return {
            nextCursor: null,
            data: [
              {
                id: 'native-turn-same-id',
                itemsView: 'full',
                status: 'inProgress',
                startedAt: '2026-08-17T00:00:00.000Z',
                items: [
                  {
                    id: 'agent',
                    type: 'agentMessage',
                    text: 'stale official text'
                  }
                ]
              }
            ]
          };
        },
        stop() {}
      });
      const page = (await operation(connector, 'session.turns.list', {
        sessionId: session.id
      })) as {
        turns: { items: { kind: string; payload: { text?: string } }[] }[];
      };
      const text = page.turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.kind === 'assistant_message')
        .map((item) => item.payload.text)
        .join('\n');
      expect(text).toContain('complete final result from the live local stream');
      expect(text).not.toContain('stale official text');
    } finally {
      connector.stop();
    }
  });

  it('preserves image placeholder metadata on a local terminal tool card when official history lags', async () => {
    const database = new NodeDatabase(':memory:', 'node-official-generated-image-cache');
    const workspace = database.saveWorkspace({
      path: '/workspace/official-generated-image-cache',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
        createExecution(runId: string): { id: string };
      };
      emitConversationItem(runId: string, item: Record<string, unknown>): void;
      runAttachmentService: {
        append(runId: string, images: Record<string, string>[]): unknown;
        clear(runId: string): void;
      };
      codexClient: {
        execution: { managedTurns: Map<string, { sessionId: string; runId: string }> };
        start(): Promise<void>;
        client: { start(): Promise<void>; listThreadTurns(threadId: string): Promise<unknown> };
        stop(): void;
      };
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'thread-generated-image-cache'
      });
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'generated-image-cache',
        content: 'generate an image'
      }).run;
      const execution = internals.runtime.createExecution(run.id);
      internals.runAttachmentService.append(execution.id, [
        { name: 'generated-image-1.png', mime: 'image/png', dataBase64: 'aGVsbG8=' }
      ]);
      // Expired image bytes must not erase image placeholder metadata from the conversation item.
      internals.runAttachmentService.clear(execution.id);
      internals.emitConversationItem(execution.id, {
        itemId: 'codex:image-tool',
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: {
          title: 'imagegen',
          attachments: [
            {
              name: 'generated-image-1.png',
              mime: 'image/png',
              runId: execution.id,
              imageIndex: 0
            }
          ]
        }
      });
      internals.codexClient.execution.managedTurns.set('native-image-turn', {
        sessionId: session.id,
        runId: execution.id
      });
      Object.assign(internals.codexClient.client, {
        async start() {},
        async listThreadTurns(_threadId: string) {
          return {
            nextCursor: null,
            data: [
              {
                id: 'native-image-turn',
                itemsView: 'full',
                status: 'completed',
                startedAt: '2026-08-17T00:00:00.000Z',
                completedAt: '2026-08-17T00:00:01.000Z',
                items: [
                  {
                    type: 'function_call',
                    call_id: 'image-tool',
                    name: 'imagegen',
                    arguments: '{}'
                  }
                ]
              }
            ]
          };
        },
        stop() {}
      });
      const page = (await operation(connector, 'session.turns.list', {
        sessionId: session.id
      })) as {
        turns: { items: { kind: string; payload: { attachments?: unknown[] } }[] }[];
      };
      expect(page.turns[0]?.items).toContainEqual(
        expect.objectContaining({
          kind: 'tool_call',
          payload: expect.objectContaining({
            attachments: [expect.objectContaining({ runId: execution.id, imageIndex: 0 })]
          })
        })
      );
    } finally {
      connector.stop();
    }
  });
});

function operation(connector: NodeConnector, operation: string, data: unknown): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operation, data);
}
