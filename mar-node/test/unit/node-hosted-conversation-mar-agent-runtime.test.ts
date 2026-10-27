import { describe, expect, it, vi } from 'vitest';
import type { HostDescription, AgentHost } from '../../../mar-agent/src/host.js';
import type { AgentEvent, AgentSession } from '../../../mar-agent/src/index.js';
import { AgentError } from '../../../mar-agent/src/index.js';
import {
  conversationTurnSchema,
  type MarAgentRuntimeModelConfiguration
} from '../../../packages/protocol/src/index.js';
import {
  MarAgentHostedConversationRuntime,
  type HostedLocalAgentHostInput
} from '../../src/runner/mar-agent/hosted-conversation-runtime.js';
import type { NativeTranscriptImageAttachment } from '../../src/native-transcript-model.js';
import { MarAgentMcpClientPool } from '../../src/runner/mar-agent/mcp-client-pool.js';

describe('MAR Agent hosted conversation runtime', () => {
  it('reads resources only from the assigned hosted home and Session and closes failed reads', async () => {
    const readToolResultResource = vi
      .fn()
      .mockResolvedValueOnce({ content: 'immutable' })
      .mockRejectedValueOnce(new Error('MAR_AGENT_TOOL_RESOURCE_NOT_FOUND'));
    const close = vi.fn(async () => undefined);
    const openCatalog = vi.fn(async () => ({ readToolResultResource, close }));
    const runtime = new MarAgentHostedConversationRuntime({
      openCatalog: openCatalog as never,
      onEvent: () => undefined
    });
    const input = {
      homeDirectory: '/isolated/home',
      sessionId: 'assigned-session',
      resourceRef: 'c10a59dd-680f-46f6-9b75-31bfbd520506',
      maxBytes: 1024
    };
    await expect(runtime.readToolResultResource(input)).resolves.toEqual({ content: 'immutable' });
    expect(openCatalog).toHaveBeenCalledWith({ homeDirectory: '/isolated/home' });
    expect(readToolResultResource).toHaveBeenCalledWith('assigned-session', {
      resourceRef: input.resourceRef,
      maxBytes: 1024
    });
    await expect(runtime.readToolResultResource(input)).rejects.toThrow(
      'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND'
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('creates and reopens the assigned Session with the current isolated Host and consumes events', async () => {
    const sessionExecution = execution();
    const createdSession = session('session-1', sessionExecution);
    const reopenedSession = session('session-1', sessionExecution);
    const createdAgent = agent({ createSession: async () => createdSession });
    const reopenedAgent = agent({ openSession: async () => reopenedSession });
    const createAgent = vi
      .fn()
      .mockResolvedValueOnce(createdAgent)
      .mockResolvedValueOnce(reopenedAgent);
    const createHost = vi.fn((input: HostedLocalAgentHostInput) => host(input));
    const closeCatalog = vi.fn(async () => undefined);
    const listCatalog = vi.fn(async () => ({
      sessions: [
        {
          id: 'session-1',
          title: 'Generated report',
          workspace: '/workspace',
          createdAt: '2026-09-01T00:00:00.000Z',
          lastActivityAt: '2026-09-01T00:00:01.000Z'
        }
      ]
    }));
    const openCatalog = vi.fn(async () => ({
      list: listCatalog,
      close: closeCatalog
    }));
    const events: AgentEvent[] = [];
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: createAgent as never,
      createHost,
      openCatalog: openCatalog as never,
      now: () => 2_000,
      onEvent: (_conversationId, event) => {
        events.push(event);
      }
    });
    const processExecutor = { spawn: vi.fn() } as never;
    const onModelUsage = vi.fn();
    const pathMounts = [
      {
        logicalPath: '/workspace',
        physicalPath: '/private/template',
        writable: false
      }
    ];

    await expect(
      runtime.createSession({
        conversationId: 'conversation-1',
        homeDirectory: '/private/home',
        workspaceDirectory: '/private/work',
        systemInstruction: 'Use the hosted template.',
        defaultModelId: 'model-1',
        models: [model],
        pathMounts,
        processExecutor
      })
    ).resolves.toEqual({ sessionId: 'session-1' });
    expect(createdAgent.createSession).toHaveBeenCalledWith({
      workspace: '/workspace'
    });
    expect(createAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceMapping: {
          logicalPath: '/workspace',
          physicalPath: '/private/work'
        }
      })
    );
    const run = await runtime.startRun({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      onModelUsage,
      clientMessageId: 'message-1',
      userPrompt: 'Create a report.',
      prompt: 'Create a report.',
      attachmentIds: [],
      access: 'full-access',
      modelId: 'model-1',
      models: [model],
      systemInstruction: 'Use the hosted template.',
      homeDirectory: '/private/home',
      workspaceDirectory: '/private/work',
      temporaryDirectory: '/private/tmp/run-1',
      pathMounts,
      processExecutor,
      mcpServers: [],
      webAccess: false
    });

    expect(createHost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        homeDirectory: '/private/home',
        workspace: '/private/work',
        modelUsage: onModelUsage,
        processExecutor,
        restrictPaths: true,
        workspaceWritable: false,
        pathMounts: [
          ...pathMounts,
          {
            logicalPath: '/home/mar/.mar/agent/sessions/session-1/generated_images',
            physicalPath: '/private/home/.mar/agent/sessions/session-1/generated_images',
            writable: false
          }
        ],
        extensions: expect.objectContaining({ tools: [] })
      })
    );
    expect(createAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        models: [
          expect.objectContaining({
            id: 'model-1',
            defaultReasoningEffort: 'high'
          })
        ]
      })
    );
    expect(reopenedSession.run).toHaveBeenCalledWith({
      prompt: 'Create a report.',
      clientMessageId: 'message-1',
      modelId: 'model-1',
      permissionMode: 'full-access',
      images: []
    });
    expect(run.run).toEqual({
      id: 'execution-1',
      status: 'RUNNING',
      startedAt: 2_000,
      completedAt: null
    });
    await expect(run.completion).resolves.toEqual({
      status: 'SUCCEEDED',
      completedAt: 2_000,
      title: 'Generated report'
    });
    expect(openCatalog).toHaveBeenCalledWith({ homeDirectory: '/private/home' });
    expect(listCatalog).toHaveBeenCalledWith({ limit: 200 });
    expect(closeCatalog).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(['execution.started', 'execution.completed']);
    expect(run.cancel()).toBe(false);
  });

  it('injects the hosted web fetch provider only for web-enabled Runs', async () => {
    const webFetch = vi.fn(async () => ({ content: 'ok' }));
    const createHost = vi.fn((input: HostedLocalAgentHostInput) => host(input));
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: vi.fn(async () =>
        agent({ openSession: async () => session('session-1', execution()) })
      ) as never,
      createHost,
      webFetch,
      openCatalog: vi.fn(async () => ({
        list: vi.fn(async () => ({
          sessions: [
            {
              id: 'session-1',
              title: 'New session',
              workspace: '/workspace',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastActivityAt: '2026-09-01T00:00:01.000Z'
            }
          ]
        })),
        close: vi.fn(async () => undefined)
      })) as never
    });

    const run = await runtime.startRun({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      clientMessageId: 'message-web-fetch',
      userPrompt: 'Read the page.',
      prompt: 'Read the page.',
      attachmentIds: [],
      access: 'full-access',
      modelId: 'model-1',
      models: [model],
      systemInstruction: 'Hosted.',
      homeDirectory: '/private/home',
      workspaceDirectory: '/private/work',
      temporaryDirectory: '/private/tmp/run-web-fetch',
      pathMounts: [],
      processExecutor: { spawn: vi.fn() } as never,
      mcpServers: [],
      webAccess: true
    });
    await run.completion;

    expect(createHost).toHaveBeenCalledWith(
      expect.objectContaining({
        extensions: expect.objectContaining({
          tools: [expect.objectContaining({ name: 'web_fetch' })]
        })
      })
    );
    expect(webFetch).not.toHaveBeenCalled();
  });

  it('projects history only from the assigned HOME and keeps hosted model and access metadata', async () => {
    const close = vi.fn(async () => undefined);
    const readImage = vi.fn(async () => ({
      name: 'diagram.png',
      mimeType: 'image/png',
      byteSize: 3,
      dataBase64: 'AQID'
    }));
    const history = vi.fn(async () => ({
      entries: [
        {
          kind: 'user' as const,
          sequence: 1,
          timestamp: '2026-08-31T00:00:00.000Z',
          sessionId: 'session-1',
          executionId: 'execution-1',
          turnId: 'turn-1',
          text: 'Question',
          images: [
            {
              name: 'legacy.png',
              mimeType: 'image/png',
              byteSize: 2,
              readable: false
            },
            {
              name: 'diagram.png',
              mimeType: 'image/png',
              byteSize: 3,
              readable: true
            }
          ]
        },
        {
          kind: 'event' as const,
          sequence: 2,
          event: {
            eventId: 'event-2',
            sequence: 2,
            timestamp: '2026-08-31T00:00:01.000Z',
            sessionId: 'session-1',
            executionId: 'execution-1',
            turnId: 'turn-1',
            type: 'execution.completed' as const
          }
        }
      ]
    }));
    const openCatalog = vi.fn(async () => ({
      history,
      readImage,
      close
    }));
    const registerNativeImages = vi.fn(
      (
        runId: string,
        _roots: readonly string[],
        images: readonly NativeTranscriptImageAttachment[]
      ) =>
        images.map((image) => ({
          name: image.name,
          mime: image.mime,
          byteSize: image.byteSize,
          runId,
          imageRef: `reader:${encodeURIComponent(image.sourceId!)}`
        }))
    );
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: vi.fn() as never,
      createHost: vi.fn() as never,
      openCatalog: openCatalog as never,
      registerNativeImages
    });

    const page = await runtime.history({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      homeDirectory: '/private/home',
      modelId: 'model-1'
    });

    expect(openCatalog).toHaveBeenCalledWith({ homeDirectory: '/private/home' });
    expect(history).toHaveBeenCalledWith('session-1', { limit: 200 });
    expect(close).toHaveBeenCalledOnce();
    expect(page).toMatchObject({
      nextCursor: null,
      turns: [
        expect.objectContaining({
          id: 'turn-1',
          sessionId: 'session-1',
          runId: null,
          status: 'SUCCEEDED',
          model: 'model-1',
          effort: null,
          access: 'full-access',
          items: [
            expect.objectContaining({
              kind: 'user_message',
              payload: {
                clientMessageId: null,
                text: 'Question',
                contexts: [],
                delivery: 'ACCEPTED',
                attachments: [
                  {
                    name: 'legacy.png',
                    mime: 'image/png',
                    byteSize: 2
                  },
                  {
                    name: 'diagram.png',
                    mime: 'image/png',
                    byteSize: 3,
                    runId: 'native-history:hosted:conversation-1',
                    imageRef: 'reader:session-1%3A1%3A1'
                  }
                ]
              }
            })
          ]
        })
      ]
    });
    expect(() => page.turns.map((turn) => conversationTurnSchema.parse(turn))).not.toThrow();
    expect(JSON.stringify(page.turns)).not.toContain('"readable"');
    expect(readImage).not.toHaveBeenCalled();
    expect(registerNativeImages).toHaveBeenCalledWith(
      'native-history:hosted:conversation-1',
      [],
      [expect.objectContaining({ name: 'diagram.png', sourceId: 'session-1:1:1' })]
    );
    const registered = registerNativeImages.mock.calls[0]?.[2]?.[0];
    await expect(registered?.read?.()).resolves.toEqual({
      name: 'diagram.png',
      mime: 'image/png',
      dataBase64: 'AQID'
    });
    expect(openCatalog).toHaveBeenCalledTimes(2);
    expect(readImage).toHaveBeenCalledWith('session-1', { sequence: 1, imageIndex: 1 });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('pages complete hosted turns with a Session-bound opaque cursor', async () => {
    const close = vi.fn(async () => undefined);
    const history = vi.fn(
      async (
        _sessionId: string,
        input: { readonly limit?: number; readonly cursor?: string } = {}
      ) => {
        if (input.cursor === undefined)
          return {
            entries: [...historyEntries(2), ...historyEntries(3)],
            nextCursor: '3'
          };
        if (input.cursor === '3') return { entries: historyEntries(1) };
        throw new Error(`unexpected cursor: ${input.cursor}`);
      }
    );
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: vi.fn() as never,
      createHost: vi.fn() as never,
      openCatalog: vi.fn(async () => ({ history, close })) as never
    });

    const recent = await runtime.history({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      homeDirectory: '/private/home',
      modelId: 'model-1',
      limit: 2
    });
    expect(recent.turns.map((turn) => conversationTurnSchema.parse(turn).id)).toEqual([
      'turn-2',
      'turn-3'
    ]);
    expect(recent.nextCursor).toEqual(expect.any(String));
    expect(history).toHaveBeenNthCalledWith(1, 'session-1', { limit: 100 });
    expect(history).toHaveBeenNthCalledWith(2, 'session-1', { limit: 100, cursor: '3' });

    history.mockClear();
    const older = await runtime.history({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      homeDirectory: '/private/home',
      modelId: 'model-1',
      limit: 2,
      cursor: recent.nextCursor!
    });
    expect(older.turns.map((turn) => conversationTurnSchema.parse(turn).id)).toEqual(['turn-1']);
    expect(older.nextCursor).toBeNull();
    expect(history).toHaveBeenCalledWith('session-1', { limit: 100, cursor: '3' });

    await expect(
      runtime.history({
        conversationId: 'conversation-1',
        sessionId: 'session-other',
        homeDirectory: '/private/home',
        cursor: recent.nextCursor!
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_HISTORY_CURSOR_INVALID');
  });

  it('rolls back only the assigned Session in its isolated HOME and closes the catalog', async () => {
    const rollback = vi.fn(async () => ({
      id: 'session-1',
      title: 'Research',
      workspace: '/workspace',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastActivityAt: '2026-09-01T00:00:05.000Z'
    }));
    const close = vi.fn(async () => undefined);
    const openCatalog = vi.fn(async () => ({ rollback, close }));
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: vi.fn() as never,
      createHost: vi.fn() as never,
      openCatalog: openCatalog as never
    });

    await expect(
      runtime.rollback({
        conversationId: 'conversation-1',
        sessionId: 'session-1',
        homeDirectory: '/private/hosted-home',
        boundaryTurnId: 'turn-1'
      })
    ).resolves.toEqual({ lastActivityAt: Date.parse('2026-09-01T00:00:05.000Z') });
    expect(openCatalog).toHaveBeenCalledWith({ homeDirectory: '/private/hosted-home' });
    expect(rollback).toHaveBeenCalledWith('session-1', { boundaryTurnId: 'turn-1' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps MAR Agent rollback errors and still closes the isolated catalog', async () => {
    const close = vi.fn(async () => undefined);
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: vi.fn() as never,
      createHost: vi.fn() as never,
      openCatalog: vi.fn(async () => ({
        rollback: vi.fn(async () => {
          throw new AgentError(
            'MAR_AGENT_ROLLBACK_TARGET_INVALID',
            'Session rollback target was not found.'
          );
        }),
        close
      })) as never
    });

    await expect(
      runtime.rollback({
        conversationId: 'conversation-1',
        sessionId: 'session-1',
        homeDirectory: '/private/hosted-home',
        boundaryTurnId: null
      })
    ).rejects.toThrow('MAR_AGENT_ROLLBACK_TARGET_INVALID');
    expect(close).toHaveBeenCalledOnce();
  });

  it('registers generated images for hosted realtime and history without exposing native paths', async () => {
    const events = generatedImageEvents();
    const attachments = [
      {
        name: 'image-call.png',
        mime: 'image/png',
        runId: 'native-history:hosted:conversation-1',
        imageRef: 'file:session-1%3Aimage-call.png'
      }
    ];
    const registerNativeImages = vi.fn(() => attachments);
    const history = vi.fn(async () => ({
      entries: events.map((event) => ({
        kind: 'event' as const,
        sequence: event.sequence,
        event
      }))
    }));
    const openCatalog = vi.fn(async () => ({
      history,
      list: vi.fn(async () => ({
        sessions: [
          {
            id: 'session-1',
            title: 'Generated image',
            workspace: '/workspace',
            createdAt: '2026-09-03T00:00:00.000Z',
            lastActivityAt: '2026-09-03T00:00:03.000Z'
          }
        ]
      })),
      close: vi.fn(async () => undefined)
    }));
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: vi.fn(async () =>
        agent({ openSession: async () => session('session-1', execution(events)) })
      ) as never,
      createHost: (input) => host(input),
      openCatalog: openCatalog as never,
      registerNativeImages
    });
    const projected: Array<{ readonly kind: string; readonly payload: unknown }> = [];
    const run = await runtime.startRun({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      clientMessageId: 'message-image',
      userPrompt: 'Generate an image.',
      prompt: 'Generate an image.',
      attachmentIds: [],
      access: 'full-access',
      modelId: 'model-1',
      models: [model],
      systemInstruction: 'Hosted.',
      homeDirectory: '/private/home',
      workspaceDirectory: '/private/work',
      temporaryDirectory: '/private/tmp/run-image',
      pathMounts: [],
      processExecutor: { spawn: vi.fn() } as never,
      mcpServers: [],
      webAccess: false,
      onEvent: (event) => {
        projected.push(event);
      }
    });
    await run.completion;

    const realtimeTool = projected.find((event) => {
      if (event.kind !== 'ITEM') return false;
      const item = (
        event.payload as {
          readonly item?: { readonly kind?: string; readonly payload?: Record<string, unknown> };
        }
      ).item;
      return item?.kind === 'tool_call' && Array.isArray(item.payload?.attachments);
    })?.payload as
      | {
          readonly item?: {
            readonly payload?: Record<string, unknown>;
            readonly generatedImages?: unknown;
          };
        }
      | undefined;
    expect(realtimeTool?.item?.payload).toMatchObject({
      toolCategory: 'IMAGE_GENERATION',
      attachments
    });
    expect(realtimeTool?.item).not.toHaveProperty('generatedImages');
    expect(JSON.stringify(realtimeTool)).not.toContain('/private/home');

    const page = await runtime.history({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      homeDirectory: '/private/home',
      modelId: 'model-1'
    });
    const historyTool = (
      page.turns as Array<{
        readonly items: Array<{
          readonly kind: string;
          readonly payload: Record<string, unknown>;
          readonly generatedImages?: unknown;
        }>;
      }>
    )[0]?.items.find((item) => item.kind === 'tool_call');
    expect(historyTool?.payload).toEqual(realtimeTool?.item?.payload);
    expect(historyTool).not.toHaveProperty('generatedImages');
    const parsedHistoryTool = page.turns
      .map((turn) => conversationTurnSchema.parse(turn))
      .flatMap((turn) => turn.items)
      .find((item) => item.kind === 'tool_call');
    expect(parsedHistoryTool?.payload).toMatchObject({
      toolCategory: 'IMAGE_GENERATION',
      attachments
    });
    expect(registerNativeImages).toHaveBeenCalledWith(
      'native-history:hosted:conversation-1',
      ['/private/home/.mar/agent/sessions/session-1/generated_images'],
      [
        {
          name: 'image-call.png',
          mime: 'image/png',
          sourceId: 'session-1:image-call.png',
          localPath: '/private/home/.mar/agent/sessions/session-1/generated_images/image-call.png'
        }
      ]
    );
  });

  it('projects streaming DELTA and the terminal assistant ITEM with the same stable item ID', async () => {
    let continueExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      continueExecution = resolve;
    });
    const streamed = execution(
      [
        {
          eventId: 'event-stream-start',
          sequence: 1,
          timestamp: '2026-09-01T00:00:00.000Z',
          sessionId: 'session-1',
          executionId: 'execution-1',
          turnId: 'turn-1',
          type: 'execution.started',
          mode: 'run'
        },
        {
          eventId: 'event-stream-delta',
          sequence: 2,
          timestamp: '2026-09-01T00:00:01.000Z',
          sessionId: 'session-1',
          executionId: 'execution-1',
          turnId: 'turn-1',
          type: 'message.delta',
          itemId: 'message-native-1',
          delta: 'Partial',
          phase: 'final_answer'
        }
      ],
      {
        after: 2,
        promise: executionGate
      },
      [
        {
          eventId: 'event-stream-completed',
          sequence: 3,
          timestamp: '2026-09-01T00:00:02.000Z',
          sessionId: 'session-1',
          executionId: 'execution-1',
          turnId: 'turn-1',
          type: 'message.completed',
          itemId: 'message-native-1',
          phase: 'final_answer',
          text: 'Partial answer',
          modelId: 'review',
          modelName: 'Review Agent'
        },
        {
          eventId: 'event-stream-finish',
          sequence: 4,
          timestamp: '2026-09-01T00:00:03.000Z',
          sessionId: 'session-1',
          executionId: 'execution-1',
          turnId: 'turn-1',
          type: 'execution.completed'
        }
      ]
    );
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: vi.fn(async () =>
        agent({ openSession: async () => session('session-1', streamed) })
      ) as never,
      createHost: (input) => host(input),
      openCatalog: vi.fn(async () => ({
        list: vi.fn(async () => ({
          sessions: [
            {
              id: 'session-1',
              title: 'New session',
              workspace: '/workspace',
              createdAt: '2026-09-01T00:00:00.000Z',
              lastActivityAt: '2026-09-01T00:00:03.000Z'
            }
          ]
        })),
        close: vi.fn(async () => undefined)
      })) as never
    });
    const projected: Array<{ readonly kind: string; readonly payload: unknown }> = [];

    const run = await runtime.startRun({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      clientMessageId: 'message-stream',
      userPrompt: 'Stream.',
      prompt: 'Stream.\n\nAttachments:\n- /workspace/inbox/input.txt',
      attachmentIds: [],
      access: 'full-access',
      modelId: 'model-1',
      models: [model],
      systemInstruction: 'Hosted.',
      homeDirectory: '/private/home',
      workspaceDirectory: '/private/work',
      temporaryDirectory: '/private/tmp/run-stream',
      pathMounts: [],
      processExecutor: { spawn: vi.fn() } as never,
      mcpServers: [],
      webAccess: false,
      onEvent: (event) => {
        projected.push(event);
      }
    });
    await vi.waitFor(() => expect(projected.some((event) => event.kind === 'DELTA')).toBe(true));
    expect(streamed.completed()).toBe(false);

    const user = projected.find(
      (event) =>
        event.kind === 'ITEM' &&
        (event.payload as { readonly item?: { readonly kind?: string } }).item?.kind ===
          'user_message'
    )?.payload as
      | {
          readonly item: {
            readonly itemId: string;
            readonly status: string;
            readonly payload: {
              readonly clientMessageId: string;
              readonly text: string;
              readonly contexts: readonly unknown[];
              readonly delivery: string;
            };
          };
        }
      | undefined;
    expect(user?.item).toEqual({
      itemId: 'turn-1:user',
      kind: 'user_message',
      status: 'COMPLETED',
      payload: {
        clientMessageId: 'message-stream',
        text: 'Stream.',
        contexts: [],
        delivery: 'ACCEPTED'
      }
    });

    continueExecution();
    await run.completion;

    const delta = projected.find((event) => event.kind === 'DELTA')?.payload as {
      readonly itemId: string;
    };
    const item = projected.find(
      (event) =>
        event.kind === 'ITEM' &&
        (event.payload as { readonly item?: { readonly kind?: string } }).item?.kind ===
          'assistant_message'
    )?.payload as {
      readonly item: { readonly itemId: string };
    };
    expect(delta.itemId).toBe(item.item.itemId);
  });

  it('closes the Execution MCP pool when Host creation fails', async () => {
    const close = vi.fn(async () => undefined);
    const connect = vi.spyOn(MarAgentMcpClientPool, 'connect').mockResolvedValue({
      definitions: () => [],
      call: vi.fn(),
      close
    } as never);
    const runtime = new MarAgentHostedConversationRuntime({
      createAgent: vi.fn() as never,
      createHost: () => {
        throw new Error('HOST_CREATE_FAILED');
      },
      openCatalog: vi.fn() as never
    });

    await expect(
      runtime.startRun({
        conversationId: 'conversation-1',
        sessionId: 'session-1',
        clientMessageId: 'message-host-failure',
        userPrompt: 'Run.',
        prompt: 'Run.',
        attachmentIds: [],
        access: 'full-access',
        modelId: 'model-1',
        models: [model],
        systemInstruction: 'Hosted.',
        homeDirectory: '/private/home',
        workspaceDirectory: '/private/work',
        temporaryDirectory: '/private/tmp/run-1',
        pathMounts: [],
        processExecutor: { spawn: vi.fn() } as never,
        mcpServers: [
          {
            name: 'remote',
            lifecycle: 'EXECUTION',
            transport: 'HTTP',
            url: 'https://mcp.example.test/tools'
          }
        ],
        webAccess: false
      })
    ).rejects.toThrow('HOST_CREATE_FAILED');
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

const model: MarAgentRuntimeModelConfiguration = {
  id: 'model-1',
  name: 'Model One',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  apiKey: 'secret',
  modelId: 'model-one',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  defaultReasoningEffort: 'high',
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

function agent(overrides: {
  readonly createSession?: () => Promise<AgentSession>;
  readonly openSession?: () => Promise<AgentSession>;
}) {
  return {
    createSession: vi.fn(overrides.createSession),
    openSession: vi.fn(overrides.openSession),
    listSessions: vi.fn(),
    getSession: vi.fn(async () => ({
      id: 'native-session',
      title: 'New session',
      workspace: '/workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      source: { type: 'user' as const },
      automaticTitlePending: false
    })),
    setSessionTitle: vi.fn(async () => true),
    deleteSession: vi.fn(),
    dispose: vi.fn(async () => undefined)
  };
}

function session(id: string, handle: ReturnType<typeof execution>): AgentSession {
  return {
    id,
    run: vi.fn(() => handle),
    steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
    plan: vi.fn(),
    compact: vi.fn(),
    cancel: vi.fn()
  };
}

function execution(
  events: AgentEvent[] = [
    {
      eventId: 'event-1',
      sequence: 1,
      timestamp: '2026-08-31T00:00:00.000Z',
      sessionId: 'session-1',
      executionId: 'execution-1',
      type: 'execution.started',
      mode: 'run'
    },
    {
      eventId: 'event-2',
      sequence: 2,
      timestamp: '2026-08-31T00:00:01.000Z',
      sessionId: 'session-1',
      executionId: 'execution-1',
      type: 'execution.completed'
    }
  ],
  pause?: {
    readonly after: number;
    readonly promise: Promise<void>;
  },
  remainingEvents: AgentEvent[] = []
) {
  let completed = false;
  return {
    executionId: 'execution-1',
    async *[Symbol.asyncIterator]() {
      for (const [index, event] of events.entries()) {
        yield event;
        if (pause?.after === index + 1) await pause.promise;
      }
      for (const event of remainingEvents) yield event;
      completed = true;
    },
    result: vi.fn(async () => ({
      executionId: 'execution-1',
      status: 'completed' as const,
      finalAnswer: 'Done'
    })),
    cancel: vi.fn(() => undefined),
    completed: () => completed
  };
}

function historyEntries(index: number) {
  const userSequence = index * 2 - 1;
  const completedSequence = index * 2;
  const timestamp = `2026-09-${String(index).padStart(2, '0')}T00:00:00.000Z`;
  return [
    {
      kind: 'user' as const,
      sequence: userSequence,
      timestamp,
      sessionId: 'session-1',
      executionId: `execution-${index}`,
      turnId: `turn-${index}`,
      text: `Question ${index}`
    },
    {
      kind: 'event' as const,
      sequence: completedSequence,
      event: {
        eventId: `event-${completedSequence}`,
        sequence: completedSequence,
        timestamp,
        sessionId: 'session-1',
        executionId: `execution-${index}`,
        turnId: `turn-${index}`,
        type: 'execution.completed' as const
      }
    }
  ];
}

function generatedImageEvents(): AgentEvent[] {
  return [
    {
      eventId: 'event-image-start',
      sequence: 1,
      timestamp: '2026-09-03T00:00:00.000Z',
      sessionId: 'session-1',
      executionId: 'execution-1',
      turnId: 'turn-1',
      type: 'execution.started',
      mode: 'run'
    },
    {
      eventId: 'event-image-tool-start',
      sequence: 2,
      timestamp: '2026-09-03T00:00:01.000Z',
      sessionId: 'session-1',
      executionId: 'execution-1',
      turnId: 'turn-1',
      type: 'tool.started',
      toolName: 'codex_image_gen',
      callId: 'image-call',
      input: { prompt: 'A lighthouse in a storm.' }
    },
    {
      eventId: 'event-image-tool-completed',
      sequence: 3,
      timestamp: '2026-09-03T00:00:02.000Z',
      sessionId: 'session-1',
      executionId: 'execution-1',
      turnId: 'turn-1',
      type: 'tool.completed',
      toolName: 'codex_image_gen',
      callId: 'image-call',
      summary: '/private/home/.mar/agent/sessions/session-1/generated_images/image-call.png',
      truncated: false,
      artifacts: [
        {
          kind: 'image',
          name: 'image-call.png',
          mimeType: 'image/png',
          byteSize: 68,
          sha256: 'a'.repeat(64),
          fileName: 'image-call.png'
        }
      ]
    },
    {
      eventId: 'event-image-finish',
      sequence: 4,
      timestamp: '2026-09-03T00:00:03.000Z',
      sessionId: 'session-1',
      executionId: 'execution-1',
      turnId: 'turn-1',
      type: 'execution.completed'
    }
  ];
}

function host(input: HostedLocalAgentHostInput): AgentHost {
  return {
    describe: vi.fn(async (): Promise<HostDescription> => ({
      apiVersion: '1.0',
      mode: 'node',
      homeDirectory: input.homeDirectory,
      platform: 'linux',
      architecture: 'x64',
      shell: { name: 'bash', path: '/bin/bash' },
      guaranteedCommands: {},
      capabilities: [],
      limits: { maxProcesses: 1, maxOutputBytes: 1, maxExecutionMs: 1 }
    })),
    executeTool: vi.fn(),
    emit: vi.fn(),
    dispose: vi.fn(async () => undefined)
  };
}
