import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, CodexAppServerRpcError } from '../../src/codex-app-server.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import {
  codexLiveConversationItem,
  codexOfficialItem,
  codexOfficialConversationPage
} from '../../src/runner/codex/conversation-parser.js';
import { resolveCodexNotificationRun } from '../../src/runner/codex/managed-run-controller.js';
import {
  capabilities,
  captureSocket,
  codexProfileClientFactory,
  eventually
} from './support/codex-connector.js';
async function primeCodexProfile(connector: NodeConnector): Promise<void> {
  await (
    connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    }
  ).executeNodeOperation('runner.profiles.list', {});
}
describe('Codex input, commands, and event projection', () => {
  it('routes events by native Turn during abort-and-resend without mixing them into the old Run', () => {
    const runs = new Map([
      ['old-run', { threadId: 'thread-1', turnId: 'old-turn' }],
      ['current-run', { threadId: 'thread-1', turnId: 'current-turn' }]
    ]);
    expect(
      resolveCodexNotificationRun(runs, {
        threadId: 'thread-1',
        turnId: 'current-turn'
      })?.[0]
    ).toBe('current-run');
    expect(
      resolveCodexNotificationRun(runs, {
        threadId: 'thread-1',
        turnId: 'unknown-turn'
      })
    ).toBeUndefined();
  });
  it('binds turn/started only to the latest unbound Run on the same thread when it precedes the start response', () => {
    const runs = new Map([
      ['old-run', { threadId: 'thread-1', turnId: 'old-turn' }],
      ['current-run', { threadId: 'thread-1' }]
    ]);
    expect(
      resolveCodexNotificationRun(runs, {
        threadId: 'thread-1',
        turnId: 'current-turn',
        allowUnboundFallback: true
      })?.[0]
    ).toBe('current-run');
    expect(
      resolveCodexNotificationRun(runs, {
        threadId: 'thread-1',
        turnId: 'current-turn'
      })
    ).toBeUndefined();
  });
  it('reuses one Item for Codex context-compaction start and completion while preserving dynamic state', () => {
    const started = codexLiveConversationItem(
      { id: 'compaction-1', type: 'contextCompaction' },
      false
    );
    const completed = codexLiveConversationItem(
      { id: 'compaction-1', type: 'contextCompaction' },
      true
    );
    expect(started).toMatchObject({
      itemId: 'codex:compaction-1',
      kind: 'context_compaction',
      status: 'IN_PROGRESS',
      payload: { phase: 'STARTED' }
    });
    expect(completed).toMatchObject({
      itemId: 'codex:compaction-1',
      kind: 'context_compaction',
      status: 'COMPLETED',
      payload: { phase: 'COMPLETED' }
    });
  });

  it('projects Codex sleep as a tool with its requested duration in live and official history', () => {
    const sleep = { id: 'sleep-1', type: 'sleep', durationMs: 1_250 };
    const started = codexLiveConversationItem(sleep, false);
    const completed = codexLiveConversationItem(sleep, true);
    const official = codexOfficialItem(
      { id: 'session-1' } as never,
      'turn-1',
      sleep,
      0,
      0,
      null,
      null
    );
    const payload = {
      namespace: 'clock',
      toolName: 'clock.sleep',
      inputSummary: '1250 ms'
    };
    expect(started).toMatchObject({
      itemId: 'codex:sleep-1',
      kind: 'tool_call',
      status: 'IN_PROGRESS',
      payload
    });
    expect(completed).toMatchObject({
      itemId: 'codex:sleep-1',
      kind: 'tool_call',
      status: 'COMPLETED',
      payload
    });
    expect(official).toMatchObject({ kind: 'tool_call', payload });
    expect(codexLiveConversationItem({ id: 'sleep-2', type: 'sleep' }, true)).toMatchObject({
      kind: 'tool_call',
      payload: { inputSummary: null }
    });
  });

  it.each([
    [
      { type: 'imageView', path: '/workspace/chart.png' },
      'tool_call',
      { toolName: 'view_image', inputSummary: '/workspace/chart.png' }
    ],
    [
      {
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        prompt: 'Inspect the parser',
        model: 'gpt-6-sol',
        reasoningEffort: 'high',
        receiverThreadIds: ['agent-1'],
        agentsStates: {}
      },
      'tool_call',
      {
        toolName: 'spawn_agent',
        subagentOperation: 'START',
        subagentId: 'agent-1',
        subagentModelId: 'gpt-6-sol',
        subagentReasoningEffort: 'high'
      }
    ],
    [
      { type: 'hookPrompt', fragments: [{ hookRunId: 'hook-1', text: 'private prompt' }] },
      'warning',
      { code: 'CODEX_HOOK_PROMPT', message: 'Hook prompt added (1 fragment).' }
    ],
    [
      { type: 'enteredReviewMode', review: 'Changes' },
      'warning',
      { code: 'CODEX_REVIEW_STARTED', message: 'Entered review mode: Changes' }
    ],
    [
      { type: 'exitedReviewMode', review: 'Changes' },
      'warning',
      { code: 'CODEX_REVIEW_ENDED', message: 'Exited review mode: Changes' }
    ]
  ] as const)(
    'projects Codex %s through live and official conversation items',
    (value, kind, payload) => {
      const item = { id: `item-${value.type}`, ...value };
      expect(codexLiveConversationItem(item, true)).toMatchObject({ kind, payload });
      expect(
        codexOfficialItem({ id: 'session-1' } as never, 'turn-1', item, 0, 0, null, null)
      ).toMatchObject({ kind, payload });
    }
  );

  it('preserves an interrupted Codex collaboration call as an interrupted tool', () => {
    const item = {
      id: 'collab-interrupted',
      type: 'collabAgentToolCall',
      tool: 'wait',
      status: 'interrupted',
      receiverThreadIds: ['agent-1'],
      agentsStates: {}
    };
    expect(codexLiveConversationItem(item, true)).toMatchObject({
      kind: 'tool_call',
      status: 'INTERRUPTED',
      payload: { toolName: 'wait_agent' }
    });
    expect(
      codexOfficialItem({ id: 'session-1' } as never, 'turn-1', item, 0, 0, null, null)
    ).toMatchObject({ kind: 'tool_call', status: 'INTERRUPTED' });
  });

  it('preserves an unfinished collaboration call in both live and official history', () => {
    const value = {
      id: 'waiting',
      type: 'collabAgentToolCall',
      tool: 'wait',
      status: 'inProgress',
      receiverThreadIds: ['child']
    };
    expect(codexLiveConversationItem(value, false)?.status).toBe('IN_PROGRESS');
    expect(
      codexOfficialItem({ id: 'session' } as never, 'turn', value, 0, 0, null, null)?.status
    ).toBe('IN_PROGRESS');
  });

  it.each(['started', 'completed', 'interacted', 'interrupted'])(
    'does not invent a control call from child activity %s',
    (kind) => {
      const value = { id: 'activity', type: 'subAgentActivity', kind, agentThreadId: 'child' };
      expect(codexLiveConversationItem(value, true)).toBeUndefined();
      expect(
        codexOfficialItem({ id: 'session' } as never, 'turn', value, 0, 0, null, null)
      ).toBeUndefined();
    }
  );

  it('does not present a multi-agent wait as if it targeted only the first agent', () => {
    const item = codexLiveConversationItem(
      {
        id: 'collab-wait-many',
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: ['agent-1', 'agent-2'],
        agentsStates: {}
      },
      true
    );
    expect(item).toMatchObject({
      kind: 'tool_call',
      payload: {
        subagentOperation: 'STATUS',
        subagentId: null,
        inputSummary: '{"receiverThreadIds":["agent-1","agent-2"]}'
      }
    });
  });

  it('converts reasoning, commands, file changes, and image generation consistently from official history', () => {
    const page = codexOfficialConversationPage(
      {
        id: 'session-history-reasoning',
        workspaceId: 'workspace-history-reasoning',
        runner: 'codex',
        cwd: '/workspace/history-reasoning',
        externalSessionId: 'thread-history-reasoning'
      } as never,
      {
        thread: {
          id: 'thread-history-reasoning',
          turns: [
            {
              id: 'turn-history-reasoning',
              startedAt: '2026-08-22T00:00:00.000Z',
              completedAt: '2026-08-22T00:00:01.000Z',
              items: [
                { id: 'reasoning-history', type: 'reasoning', summary: [] },
                {
                  id: 'command-history',
                  type: 'commandExecution',
                  command: 'pwd',
                  cwd: '/workspace/history-reasoning',
                  aggregatedOutput: '/workspace/history-reasoning\n',
                  exitCode: 0
                },
                {
                  id: 'custom-command-history',
                  call_id: 'custom-command-call',
                  type: 'custom_tool_call',
                  name: 'exec_command',
                  input: { cmd: 'git status --short' }
                },
                {
                  id: 'custom-command-output-history',
                  call_id: 'custom-command-call',
                  type: 'custom_tool_call_output',
                  output: [{ type: 'input_text', text: ' M src/a.ts\n' }]
                },
                {
                  id: 'change-history',
                  type: 'fileChange',
                  changes: [{ path: 'src/a.ts', kind: 'update' }]
                },
                {
                  id: 'image-history',
                  type: 'imageGeneration',
                  revisedPrompt: 'generate an architecture diagram',
                  status: 'completed'
                }
              ]
            }
          ]
        }
      },
      {},
      () => undefined
    );
    expect(page?.turns[0]?.items).toEqual([
      expect.objectContaining({ kind: 'reasoning_summary', payload: { sections: [] } }),
      expect.objectContaining({
        kind: 'command_execution',
        payload: expect.objectContaining({ command: 'pwd', exitCode: 0 })
      }),
      expect.objectContaining({
        kind: 'command_execution',
        payload: expect.objectContaining({
          command: 'git status --short',
          outputPreview: ' M src/a.ts\n'
        })
      }),
      expect.objectContaining({ kind: 'file_change' }),
      expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({
          toolName: 'imagegen',
          toolCategory: 'IMAGE_GENERATION'
        })
      })
    ]);
    expect(page?.turns[0]?.rewind).toEqual({ before: null, after: 'turn-history-reasoning' });
  });
  it('projects one context-compaction card for two native records from the same compaction', () => {
    const page = codexOfficialConversationPage(
      {
        id: 'session-history-compaction',
        workspaceId: 'workspace-history-compaction',
        runner: 'codex',
        cwd: '/workspace/history-compaction',
        externalSessionId: 'thread-history-compaction'
      } as never,
      {
        thread: {
          id: 'thread-history-compaction',
          turns: [
            {
              id: 'turn-history-compaction',
              items: [
                { type: 'contextCompaction' },
                { type: 'contextCompaction' },
                {
                  id: 'message-after-compaction',
                  type: 'agentMessage',
                  text: 'continue execution'
                },
                { type: 'contextCompaction' }
              ]
            }
          ]
        }
      },
      {},
      () => undefined
    );
    expect(page?.turns[0]?.items.map((item) => item.kind)).toEqual([
      'context_compaction',
      'assistant_message',
      'context_compaction'
    ]);
  });
  it('replaces a live compaction item when official compaction has a different native ID', () => {
    const page = codexOfficialConversationPage(
      {
        id: 'session-history-compaction-reconcile',
        workspaceId: 'workspace-history-compaction-reconcile',
        runner: 'codex',
        cwd: '/workspace/history-compaction-reconcile',
        externalSessionId: 'thread-history-compaction-reconcile'
      } as never,
      {
        thread: {
          id: 'thread-history-compaction-reconcile',
          turns: [
            {
              id: 'turn-history-compaction-reconcile',
              items: [{ id: 'official-compaction', type: 'contextCompaction' }]
            }
          ]
        }
      },
      {},
      () =>
        ({
          id: 'managed-turn',
          sessionId: 'session-history-compaction-reconcile',
          runId: 'run-history-compaction-reconcile',
          status: 'SUCCEEDED',
          items: [
            {
              id: 'run-history-compaction-reconcile:live-compaction',
              turnId: 'managed-turn',
              runId: 'run-history-compaction-reconcile',
              kind: 'context_compaction',
              status: 'COMPLETED',
              payload: { phase: 'COMPLETED' }
            },
            {
              id: 'run-history-compaction-reconcile:local-tool',
              turnId: 'managed-turn',
              runId: 'run-history-compaction-reconcile',
              kind: 'tool_call',
              status: 'COMPLETED',
              payload: { title: 'local tool' }
            }
          ]
        }) as never
    );
    expect(page?.turns[0]?.items.filter((item) => item.kind === 'context_compaction')).toHaveLength(
      1
    );
    expect(page?.turns[0]?.items[0]?.id).toContain('official-compaction');
    expect(page?.turns[0]?.items.map((item) => item.kind)).toEqual([
      'context_compaction',
      'tool_call'
    ]);
  });

  it('keeps additional real compaction items when official history contains fewer than the live stream', () => {
    const page = codexOfficialConversationPage(
      {
        id: 'session-history-compaction-count',
        workspaceId: 'workspace-history-compaction-count',
        runner: 'codex',
        cwd: '/workspace/history-compaction-count',
        externalSessionId: 'thread-history-compaction-count'
      } as never,
      {
        thread: {
          id: 'thread-history-compaction-count',
          turns: [
            {
              id: 'turn-history-compaction-count',
              items: [{ id: 'official-compaction', type: 'contextCompaction' }]
            }
          ]
        }
      },
      {},
      () =>
        ({
          id: 'managed-turn',
          sessionId: 'session-history-compaction-count',
          runId: 'run-history-compaction-count',
          status: 'SUCCEEDED',
          items: [
            {
              id: 'run-history-compaction-count:live-compaction-1',
              turnId: 'managed-turn',
              runId: 'run-history-compaction-count',
              kind: 'context_compaction',
              status: 'COMPLETED',
              payload: { phase: 'COMPLETED' }
            },
            {
              id: 'run-history-compaction-count:live-compaction-2',
              turnId: 'managed-turn',
              runId: 'run-history-compaction-count',
              kind: 'context_compaction',
              status: 'COMPLETED',
              payload: { phase: 'COMPLETED' }
            }
          ]
        }) as never
    );

    expect(page?.turns[0]?.items.filter((item) => item.kind === 'context_compaction')).toHaveLength(
      2
    );
  });
  it('caches image base64 per Run and allows controlled reads for one hour after termination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myagentroam-run-image-cache-'));
    const database = new NodeDatabase(':memory:', 'node-run-image-cache');
    const workspace = database.saveWorkspace({
      id: 'workspace-run-image-cache',
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      config: {
        serverUrl: 'http://localhost',
        allowedRoots: [root],
        dataDirectory: join(root, 'node-data')
      },
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        start: async () => undefined,
        stop: () => undefined,
        configureEnvironment: () => undefined,
        startThread: async () => ({ thread: { id: 'thread-image-cache' } }),
        startTurn: async () => ({ turn: { id: 'turn-image-cache' } })
      } as unknown as CodexAppServerClient
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
      runAttachmentService: { expire(runId: string): void };
    };
    try {
      const created = (await internals.executeNodeOperation('session.create', {
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path
      })) as { readonly session: { readonly id: string } };
      const attachmentId = '55b57a95-a246-4f49-a084-adbe7aeb6a14';
      const uploaded = (await internals.executeNodeOperation('workspace.files.upload.create', {
        workspaceId: workspace.id,
        name: 'diagram.svg',
        mime: 'image/svg+xml',
        size: 6,
        overwrite: false,
        composerAttachmentId: attachmentId
      })) as { readonly upload: { readonly uploadId: string } };
      await internals.executeNodeOperation('workspace.files.upload.chunk', {
        workspaceId: workspace.id,
        uploadId: uploaded.upload.uploadId,
        offset: 0,
        dataBase64: 'PHN2Zy8+'
      });
      await internals.executeNodeOperation('workspace.files.upload.complete', {
        workspaceId: workspace.id,
        uploadId: uploaded.upload.uploadId
      });
      const message = (await internals.executeNodeOperation('session.message', {
        sessionId: created.session.id,
        clientMessageId: 'run-image-cache',
        content: 'view image',
        deliveryIntent: 'QUEUE',
        attachmentIds: [attachmentId]
      })) as { readonly run: { readonly id: string } };
      const projectedTurns = sent.flatMap((event) => {
        if (event.type !== 'workbench.event' || event.payload.category !== 'conversation')
          return [];
        const payload = event.payload.payload as { turn?: unknown };
        return payload.turn === undefined ? [] : [payload.turn];
      });
      expect(projectedTurns.at(-1)).toMatchObject({
        items: [
          expect.objectContaining({
            kind: 'user_message',
            payload: expect.objectContaining({
              attachments: [expect.objectContaining({ name: 'diagram.svg', mime: 'image/svg+xml' })]
            })
          })
        ]
      });
      await expect(
        internals.executeNodeOperation('run.image.read', {
          runId: message.run.id,
          imageIndex: 0
        })
      ).resolves.toEqual({
        image: { name: 'diagram.svg', mime: 'image/svg+xml', dataBase64: 'PHN2Zy8+' }
      });
      vi.useFakeTimers();
      internals.runAttachmentService.expire(message.run.id);
      await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
      await expect(
        internals.executeNodeOperation('run.image.read', {
          runId: message.run.id,
          imageIndex: 0
        })
      ).resolves.toEqual({
        image: { name: 'diagram.svg', mime: 'image/svg+xml', dataBase64: 'PHN2Zy8+' }
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(
        internals.executeNodeOperation('run.image.read', {
          runId: message.run.id,
          imageIndex: 0
        })
      ).rejects.toThrow('RUN_IMAGE_NOT_FOUND');
    } finally {
      vi.useRealTimers();
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns and publishes the formal session ID only after obtaining the native thread ID', async () => {
    const startThread = vi.fn(async () => ({ thread: { id: 'thread-native-start' } }));
    const configureEnvironment = vi.fn<CodexAppServerClient['configureEnvironment']>();
    const database = new NodeDatabase(':memory:', 'node-native-session-start');
    const workspace = database.saveWorkspace({
      id: 'workspace-native-start',
      path: '/workspace/native-start',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        configureEnvironment,
        start: async () => undefined,
        startThread,
        startTurn: async () => ({ turn: { id: 'turn-native-start' } }),
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };

    const result = (await internals.executeNodeOperation('session.start', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      clientMessageId: 'native-first-message',
      content: 'first message'
    })) as {
      readonly session: { readonly id: string };
      readonly run: { readonly id: string; readonly sessionId: string };
      readonly turn: {
        readonly sessionId: string;
        readonly runId: string;
        readonly items: readonly { readonly kind: string; readonly payload: { text?: string } }[];
      };
    };

    expect(result.session.id).toBe('thread-native-start');
    expect(result.run.sessionId).toBe('thread-native-start');
    expect(result.turn).toMatchObject({
      sessionId: 'thread-native-start',
      runId: result.run.id,
      items: [{ kind: 'user_message', payload: { text: 'first message' } }]
    });
    const repeated = (await internals.executeNodeOperation('session.start', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      clientMessageId: 'native-first-message',
      content: 'first message'
    })) as { readonly session: { readonly id: string }; readonly run: { readonly id: string } };
    expect(repeated.session.id).toBe('thread-native-start');
    expect(repeated.run.id).toBe(result.run.id);
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(configureEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ MAR_CTL_CONTEXT_REQUIRED: '1' })
    );
    const sessionEvents = sent.filter(
      (message) => message.type === 'workbench.event' && message.payload.category === 'session'
    );
    expect(sessionEvents.length).toBeGreaterThan(0);
    expect(
      sessionEvents.every(
        (message) =>
          (message.payload.payload as { session?: { id?: string } }).session?.id ===
          'thread-native-start'
      )
    ).toBe(true);
    connector.stop();
  });

  it('does not publish a transient queue item for Ctrl+Enter replacement from an idle session', async () => {
    const startTurn = vi.fn(async () => ({ turn: { id: 'turn-idle-replace-queue' } }));
    const database = new NodeDatabase(':memory:', 'node-idle-replace-queue');
    const workspace = database.saveWorkspace({
      id: 'workspace-idle-replace-queue',
      path: '/workspace/idle-replace-queue',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        configureEnvironment: () => undefined,
        start: async () => undefined,
        startThread: async () => ({ thread: { id: 'thread-idle-replace-queue' } }),
        startTurn,
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    await primeCodexProfile(connector);
    const execute = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    const created = (await execute.executeNodeOperation('session.create', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    })) as { readonly session: { readonly id: string } };

    const result = await execute.executeNodeOperation('session.message', {
      sessionId: created.session.id,
      clientMessageId: 'idle-replace-message',
      content: 'execute immediately',
      deliveryIntent: 'REPLACE_CURRENT'
    });

    expect(result).toMatchObject({ delivery: 'STARTED' });
    await eventually(() => startTurn.mock.calls.length === 1);
    const queueSnapshots = sent.flatMap((message) => {
      if (message.type !== 'workbench.event' || message.payload.category !== 'queue') return [];
      const payload = message.payload.payload as { queue?: { items?: readonly unknown[] } };
      return payload.queue?.items ?? [];
    });
    expect(queueSnapshots).toEqual([]);
    connector.stop();
  });

  it('publishes only the rebuilt native identity when the first Turn of a new thread lacks rollout data', async () => {
    const startThread = vi
      .fn<CodexAppServerClient['startThread']>()
      .mockResolvedValueOnce({ thread: { id: 'thread-missing-rollout' } })
      .mockResolvedValueOnce({ thread: { id: 'thread-recovered' } });
    const startTurn = vi
      .fn<CodexAppServerClient['startTurn']>()
      .mockRejectedValueOnce(
        new CodexAppServerRpcError({
          code: -32600,
          message: 'no rollout found for thread id thread-missing-rollout'
        })
      )
      .mockResolvedValueOnce({ turn: { id: 'turn-recovered' } });
    const start = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    const stop = vi.fn();
    const database = new NodeDatabase(':memory:', 'node-native-session-rollout-retry');
    const workspace = database.saveWorkspace({
      id: 'workspace-native-rollout-retry',
      path: '/workspace/native-rollout-retry',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        configureEnvironment: () => undefined,
        start,
        restart,
        startThread,
        startTurn,
        stop
      } as unknown as CodexAppServerClient
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    await primeCodexProfile(connector);
    const execute = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };

    const result = (await execute.executeNodeOperation('session.start', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      clientMessageId: 'rollout-retry-first-message',
      content: 'first message'
    })) as { readonly session: { readonly id: string } };

    expect(result.session.id).toBe('thread-recovered');
    expect(startThread).toHaveBeenCalledTimes(2);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(
      sent.some(
        (message) =>
          message.type === 'session.external-id' &&
          (message.payload as { externalSessionId?: string }).externalSessionId ===
            'thread-missing-rollout'
      )
    ).toBe(false);
    connector.stop();
  });

  it("retries the original ID after restarting App Server when an old thread's rollout fails to load", async () => {
    const resumeThread = vi
      .fn<CodexAppServerClient['resumeThread']>()
      .mockRejectedValueOnce(
        new CodexAppServerRpcError({
          code: -32600,
          message: 'no rollout found for thread id thread-existing'
        })
      )
      .mockResolvedValueOnce({ thread: { id: 'thread-existing' } });
    const startTurn = vi.fn<CodexAppServerClient['startTurn']>(async () => ({
      turn: { id: 'turn-existing-recovered' }
    }));
    const start = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    const stop = vi.fn();
    const database = new NodeDatabase(':memory:', 'node-existing-session-rollout-retry');
    const workspace = database.saveWorkspace({
      id: 'workspace-existing-rollout-retry',
      path: '/workspace/existing-rollout-retry',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        configureEnvironment: () => undefined,
        start,
        restart,
        resumeThread,
        startTurn,
        stop
      } as unknown as CodexAppServerClient
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      runtime: { createAgentSession(input: Record<string, unknown>): { readonly id: string } };
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      id: 'thread-existing',
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-existing',
      nativeControl: 'MAR_MANAGED',
      model: 'gpt-5.6-sol',
      effort: 'high',
      access: 'full-access'
    });

    await internals.executeNodeOperation('session.message', {
      sessionId: session.id,
      clientMessageId: 'existing-rollout-retry-message',
      content: 'continue'
    });
    await eventually(() => startTurn.mock.calls.length === 1);

    expect(resumeThread).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    connector.stop();
  });

  it('does not restart the shared App Server while another Codex Run exists', async () => {
    const restart = vi.fn(async () => undefined);
    const runner = new CodexRunner({
      restart,
      onNotification: () => () => undefined
    } as unknown as CodexAppServerClient);
    runner.prepareEnvironment({}, 'run-rollout-recovery');
    runner.prepareEnvironment({}, 'run-concurrent');
    try {
      await expect(
        runner.recoverMissingRollout(
          'run-rollout-recovery',
          new CodexAppServerRpcError({
            code: -32600,
            message: 'no rollout found for thread id thread-existing'
          })
        )
      ).resolves.toBe(false);
      expect(restart).not.toHaveBeenCalled();
    } finally {
      runner.releaseEnvironment('run-rollout-recovery');
      runner.releaseEnvironment('run-concurrent');
    }
  });

  it('confirms an equal Codex title after the first Turn and does not refresh it for later messages', async () => {
    const startThread = vi.fn(async () => ({ thread: { id: 'thread-title-echo' } }));
    const startTurn = vi
      .fn()
      .mockResolvedValueOnce({ turn: { id: 'turn-title-echo' } })
      .mockResolvedValueOnce({ turn: { id: 'turn-title-second' } });
    const listThreads = vi.fn(async () => ({
      data: [
        {
          id: 'thread-title-echo',
          source: 'vscode',
          cwd: '/workspace/title-echo',
          name: 'first temporary title'
        }
      ]
    }));
    let notification: Parameters<CodexAppServerClient['onNotification']>[0] | undefined;
    const database = new NodeDatabase(':memory:', 'node-codex-title-echo');
    const workspace = database.saveWorkspace({
      id: 'workspace-codex-title-echo',
      path: '/workspace/title-echo',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: (listener: Parameters<CodexAppServerClient['onNotification']>[0]) => {
          notification = listener;
          return () => undefined;
        },
        configureEnvironment: () => undefined,
        start: async () => undefined,
        startThread,
        resumeThread: async () => ({ thread: { id: 'thread-title-echo' } }),
        startTurn,
        listThreads,
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
      runtime: {
        getAgentSession(
          id: string
        ): { readonly runnerTitle: string | null; readonly titleSource: string } | undefined;
        activeSessionRun(id: string): unknown;
      };
    };
    try {
      await internals.executeNodeOperation('session.start', {
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        clientMessageId: 'codex-title-echo',
        content: 'first temporary title'
      });
      await eventually(() => startTurn.mock.calls.length === 1);
      notification?.({
        method: 'turn/completed',
        params: {
          threadId: 'thread-title-echo',
          turn: { id: 'turn-title-echo', status: 'completed' }
        }
      });

      await eventually(
        () => internals.runtime.getAgentSession('thread-title-echo')?.titleSource === 'RUNNER'
      );
      expect(listThreads).toHaveBeenCalledTimes(1);
      expect(
        sent.some(
          (message) =>
            message.type === 'workbench.event' &&
            message.payload.category === 'session' &&
            (
              message.payload.payload as {
                session?: { runnerTitle?: string | null; titleSource?: string };
              }
            ).session?.titleSource === 'RUNNER'
        )
      ).toBe(true);
      await eventually(() => internals.runtime.activeSessionRun('thread-title-echo') === undefined);

      await internals.executeNodeOperation('session.message', {
        sessionId: 'thread-title-echo',
        clientMessageId: 'codex-title-second',
        content: 'second user message'
      });
      await eventually(() => startTurn.mock.calls.length === 2);
      notification?.({
        method: 'turn/completed',
        params: {
          threadId: 'thread-title-echo',
          turn: { id: 'turn-title-second', status: 'completed' }
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(listThreads).toHaveBeenCalledTimes(1);
      expect(internals.runtime.getAgentSession('thread-title-echo')).toMatchObject({
        runnerTitle: 'first temporary title',
        titleSource: 'RUNNER'
      });
    } finally {
      connector.stop();
    }
  });

  it('cleans up the bootstrap session and identity waiter when first-message validation fails', async () => {
    const database = new NodeDatabase(':memory:', 'node-native-session-failure');
    const workspace = database.saveWorkspace({
      id: 'workspace-native-failure',
      path: '/workspace/native-failure',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        start: async () => undefined,
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
      runtime: { listAgentSessions(): readonly unknown[] };
    };

    await expect(
      internals.executeNodeOperation('session.start', {
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        clientMessageId: 'invalid-first-message',
        content: 'attachment does not exist',
        attachmentIds: ['00000000-0000-4000-8000-000000000001']
      })
    ).rejects.toThrow('COMPOSER_ATTACHMENT_UNAVAILABLE');
    await Promise.resolve();

    expect(internals.runtime.listAgentSessions()).toHaveLength(0);
    connector.stop();
  });
});
