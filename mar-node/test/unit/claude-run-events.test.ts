vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  const { mockedWebSocket } = await import('./support/control-socket.js');
  return { ...actual, default: mockedWebSocket(actual.default) };
});
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope } from '../../../packages/protocol/src/index.js';
import {
  ClaudeAgentSdkAdapter,
  type ClaudeSdkBindings
} from '../../src/runner/claude/claude-agent-sdk.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { NodeDatabase } from '../../src/database.js';
import { normalizeClaudeTool } from '../../src/runner/claude/tool-normalizer.js';
import {
  preparedDatabase,
  attachSocket,
  bindings,
  permissionStream,
  publicConversationStream,
  capabilities,
  eventually
} from './support/claude-connector.js';

async function createTestWorkspacePath(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'mar-claude-run-events-'));
  onTestFinished(() => rm(workspacePath, { recursive: true, force: true }));
  return workspacePath;
}

describe('Claude events and approvals', () => {
  it('updates live subagent identities from tool results before projecting later controls', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-claude-subagent-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-1');
    database.saveWorkspace({ id: 'workspace-1', path: home, kind: 'DIRECTORY', gitSummary: null });
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'start', name: 'Agent', input: { description: 'Review' } }
          ]
        }
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        tool_use_result: { content: 'x'.repeat(12_000), agentId: 'child' },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'start', content: 'Agent started' }]
        }
      },
      {
        type: 'user',
        parent_tool_use_id: 'start',
        tool_use_result: { agentId: 'internal-child' },
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'internal-call',
              content: 'Private child tool output'
            }
          ]
        }
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'wait',
              name: 'TaskOutput',
              input: { task_id: 'child', block: true }
            }
          ]
        }
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        tool_use_result: { task_id: 'child', status: 'running' },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'wait', content: 'Wait timed out' }]
        }
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'missing-call', content: 'Unpaired output' }
          ]
        }
      },
      { type: 'result', subtype: 'success' }
    ];
    const stream = publicConversationStream();
    let index = 0;
    stream.next = async () =>
      index < messages.length
        ? { value: { ...messages[index++], session_id: 'native-subagent' } as never, done: false }
        : { value: undefined, done: true };
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities(),
      claudeClient: new ClaudeAgentSdkAdapter(bindings(() => stream))
    });
    attachSocket(connector);
    const internals = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<{ session: { id: string } }>;
      runEventService: { emit(...args: unknown[]): void };
    };
    const emitted = vi.spyOn(internals.runEventService, 'emit');
    try {
      const { session } = await internals.executeNodeOperation('session.create', {
        workspaceId: 'workspace-1',
        runner: 'claude-code',
        cwd: home
      });
      await internals.executeNodeOperation('session.message', {
        sessionId: session.id,
        clientMessageId: 'subagent',
        content: 'Review'
      });
      await vi.waitFor(() =>
        expect(emitted.mock.calls.some(([, type]) => type === 'run.completed')).toBe(true)
      );
      const items = emitted.mock.calls
        .filter(([, type]) => type === 'conversation.item')
        .map(([, , payload]) => payload);
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'COMPLETED',
            payload: expect.objectContaining({ subagentOperation: 'START', subagentId: 'child' })
          }),
          expect.objectContaining({
            status: 'COMPLETED',
            payload: expect.objectContaining({
              subagentOperation: 'STATUS',
              subagentId: 'child',
              subagentWait: true,
              title: 'Review'
            })
          })
        ])
      );
      expect(
        items.filter((item) => (item as { status: string }).status === 'COMPLETED')
      ).toHaveLength(2);
      expect(JSON.stringify(items)).not.toMatch(
        /Private child tool output|internal-child|Unpaired output/
      );
    } finally {
      await connector.stop();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    { metrics: { ttft_ms: 12.6 }, expected: 13 },
    { metrics: { ttft_ms: NaN, ttft_stream_ms: 42 }, expected: 42 },
    { metrics: { ttft_ms: -1, ttft_stream_ms: 0 }, expected: 0 },
    { metrics: { ttft_ms: Infinity, ttft_stream_ms: -1 }, expected: undefined }
  ])(
    'projects valid native TTFT as response latency without persisting performance: %j',
    async ({ metrics, expected }) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-claude-performance-'));
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      const database = new NodeDatabase(':memory:', 'node-1');
      database.saveWorkspace({
        id: 'workspace-1',
        path: workspace,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const stream = publicConversationStream();
      const next = stream.next.bind(stream);
      stream.next = async (...args) => {
        let result = await next(...args);
        // Isolate the native fallback from the independently observed semantic events.
        while (!result.done && result.value.type !== 'result') result = await next(...args);
        return result.done
          ? result
          : {
              ...result,
              value: result.value.type === 'result' ? { ...result.value, ...metrics } : result.value
            };
      };
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: capabilities(),
        claudeClient: new ClaudeAgentSdkAdapter(bindings(() => stream))
      });
      const sent = attachSocket(connector);
      const internals = connector as unknown as {
        executeNodeOperation(
          operation: string,
          input: unknown
        ): Promise<{
          session: { id: string };
          run?: { id: string };
        }>;
        runEventService: { emit(...args: unknown[]): void };
        runtime: NodeRuntimeState;
      };
      const emitted = vi.spyOn(internals.runEventService, 'emit');
      const append = vi.spyOn(internals.runtime, 'appendRunEvent');
      try {
        const { session } = await internals.executeNodeOperation('session.create', {
          workspaceId: 'workspace-1',
          runner: 'claude-code',
          cwd: workspace
        });
        await internals.executeNodeOperation('session.message', {
          sessionId: session.id,
          clientMessageId: 'performance',
          content: 'hello'
        });
        await vi.waitFor(() =>
          expect(emitted.mock.calls.some(([, type]) => type === 'run.completed')).toBe(true)
        );
        const frames = sent
          .filter((message) => message.type === 'workbench.event')
          .map((message) => message.payload.payload as Record<string, unknown>)
          .filter((payload) => payload?.performance !== undefined);
        expect(frames).toHaveLength(expected === undefined ? 0 : 1);
        if (expected !== undefined) {
          expect(frames[0]).toMatchObject({
            sessionId: 'native-public-session',
            performance: { latencyMs: expected }
          });
          expect(frames[0]?.performance).not.toHaveProperty('tokensPerSecond');
        }
        expect(append.mock.calls.some(([event]) => event.eventType === 'run.performance')).toBe(
          false
        );
      } finally {
        await connector.stop();
        await rm(home, { recursive: true, force: true });
      }
    }
  );

  it('normalizes command and structured file tools inside the Claude Runner', () => {
    expect(
      normalizeClaudeTool('Bash', { command: 'pwd' }, '/workspace', false, false)
    ).toMatchObject({
      kind: 'command_execution',
      payload: { command: 'pwd', output: { blocks: [{ channel: 'COMBINED', text: '/workspace' }] } }
    });
    expect(
      normalizeClaudeTool('Write', { file_path: 'src/new.ts' }, null, false, false)
    ).toMatchObject({
      kind: 'file_change',
      payload: { changes: [{ path: 'src/new.ts', change: 'MODIFIED' }] }
    });
    expect(normalizeClaudeTool('Edit', { file_path: '' }, null, false, false)).toMatchObject({
      kind: 'file_change',
      payload: { changes: [] }
    });
  });

  it('preserves the event order of multi-part Agent text, commands, and plans', () => {
    let now = 100;
    const runtime = new NodeRuntimeState(
      () => 'node-claude-order',
      (id) =>
        id === 'workspace-1'
          ? {
              id,
              path: '/workspace',
              kind: 'DIRECTORY',
              gitSummary: null,
              createdAt: 1,
              updatedAt: 1
            }
          : undefined,
      () => now++
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'claude-code',
      cwd: '/workspace'
    });
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'claude-order',
      content: 'make a plan'
    }).run;
    runtime.appendRunEvent({
      runId: run.id,
      sequence: 1,
      eventType: 'text.delta',
      payload: { text: 'I will check first.' },
      status: 'RUNNING'
    });
    runtime.appendRunEvent({
      runId: run.id,
      sequence: 2,
      eventType: 'conversation.item',
      payload: {
        itemId: 'claude-command:one',
        kind: 'command_execution',
        status: 'COMPLETED',
        payload: { command: 'pwd', outputPreview: '/workspace' }
      }
    });
    runtime.appendRunEvent({
      runId: run.id,
      sequence: 3,
      eventType: 'text.delta',
      payload: { text: 'Check complete.' }
    });
    runtime.appendRunEvent({
      runId: run.id,
      sequence: 4,
      eventType: 'conversation.item',
      payload: {
        itemId: 'claude-command:one',
        kind: 'command_execution',
        status: 'COMPLETED',
        merge: true,
        payload: { outputPreview: '/workspace\ncompleted' }
      }
    });
    runtime.appendRunEvent({
      runId: run.id,
      sequence: 5,
      eventType: 'text.delta',
      payload: { text: 'Result confirmed.' }
    });
    runtime.appendRunEvent({
      runId: run.id,
      sequence: 6,
      eventType: 'conversation.item',
      payload: {
        itemId: 'claude-plan:one',
        kind: 'plan',
        status: 'COMPLETED',
        payload: { explanation: 'Start implementation.', steps: [] }
      }
    });

    const items = runtime.listConversationTurns({ sessionId: session.id }).turns[0]?.items.slice(1);
    expect(items?.map((item) => item.kind)).toEqual([
      'assistant_message',
      'command_execution',
      'assistant_message',
      'assistant_message',
      'plan'
    ]);
    expect(
      items?.filter((item) => item.kind === 'assistant_message').map((item) => item.payload)
    ).toEqual([
      expect.objectContaining({ text: 'I will check first.' }),
      expect.objectContaining({ text: 'Check complete.' }),
      expect.objectContaining({ text: 'Result confirmed.' })
    ]);
  });

  it('forwards each Claude tool approval command and ends the Run only after all decisions', async () => {
    let captured: Parameters<ClaudeSdkBindings['query']>[0]['options'] | undefined;
    const database = preparedDatabase();
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      claudeClient: new ClaudeAgentSdkAdapter(
        bindings((input) => {
          captured = input.options;
          if (typeof input.prompt !== 'string') {
            void input.prompt[Symbol.asyncIterator]().next();
          }
          return permissionStream(async () => {
            await input.options.canUseTool?.('Bash', { command: 'pwd' }, {} as never);
            await input.options.canUseTool?.('Bash', { command: 'git status' }, {} as never);
          });
        })
      )
    });
    const sent = attachSocket(connector);
    const handle = (
      connector as unknown as { handleMessage(raw: string): void }
    ).handleMessage.bind(connector);
    // The legacy envelope must reference an already accepted Run in a registered Workspace.
    (
      connector as unknown as { runtime: { adoptRun(input: Record<string, unknown>): unknown } }
    ).runtime.adoptRun({
      runId: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'claude-code',
      cwd: '/workspace'
    });
    handle(
      JSON.stringify(
        createEnvelope('run.start', {
          runId: 'run-1',
          sessionId: 'session-1',
          runner: 'claude-code',
          input: 'hello',
          cwd: '/workspace'
        })
      )
    );
    await eventually(() => sent.some((message) => message.type === 'approval.request'));
    const approvalRequests = () => sent.filter((message) => message.type === 'approval.request');
    const firstApproval = approvalRequests()[0];
    expect(firstApproval?.payload).toMatchObject({
      runId: 'run-1',
      approvalId: expect.stringMatching(/^claude:/),
      payload: { toolName: 'Bash', input: { command: 'pwd' } }
    });
    const execute = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
      runtime: {
        listApprovals(runId: string): readonly {
          readonly id: string;
          readonly status: string;
          readonly payload: unknown;
        }[];
      };
    };
    await expect(
      execute.executeNodeOperation('session.get', { sessionId: 'native-session-1' })
    ).resolves.toMatchObject({
      session: { id: 'native-session-1', activity: 'MANAGED_ACTIVE' }
    });
    await execute.executeNodeOperation('run.approval.decide', {
      runId: 'run-1',
      approvalId: firstApproval?.payload.approvalId,
      decision: 'APPROVED'
    });
    await eventually(() => approvalRequests().length === 2);
    const secondApproval = approvalRequests()[1];
    expect(secondApproval?.payload).toMatchObject({
      runId: 'run-1',
      approvalId: expect.stringMatching(/^claude:/),
      payload: { toolName: 'Bash', input: { command: 'git status' } }
    });
    expect(secondApproval?.payload.approvalId).not.toBe(firstApproval?.payload.approvalId);
    expect(execute.runtime.listApprovals('run-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstApproval?.payload.approvalId,
          status: 'APPROVED',
          payload: { toolName: 'Bash', input: { command: 'pwd' } }
        }),
        expect.objectContaining({
          id: secondApproval?.payload.approvalId,
          status: 'PENDING',
          payload: { toolName: 'Bash', input: { command: 'git status' } }
        })
      ])
    );
    await execute.executeNodeOperation('run.approval.decide', {
      runId: 'run-1',
      approvalId: secondApproval?.payload.approvalId,
      decision: 'APPROVED'
    });
    await eventually(() =>
      sent.some(
        (message) =>
          message.type === 'workbench.event' &&
          message.payload.category === 'run' &&
          (message.payload.payload as { run?: { status?: string } }).run?.status === 'SUCCEEDED'
      )
    );
    expect(captured).toMatchObject({ cwd: '/workspace' });
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'session.external-id',
        payload: { sessionId: 'session-1', externalSessionId: 'native-session-1' }
      })
    );
    database.close();
  });

  it('creates an AskUserQuestion item and resumes the SDK Run after the answer', async () => {
    let permissionResult: unknown;
    let state = 0;
    const questionInput = {
      questions: [
        {
          question: 'Choose an implementation approach?',
          header: 'Implementation approach',
          options: [
            { label: 'Option A', description: 'Modify directly' },
            { label: 'Option B', description: 'Add tests first' }
          ],
          multiSelect: false
        }
      ]
    };
    const database = preparedDatabase();
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      claudeClient: new ClaudeAgentSdkAdapter(
        bindings(
          (input) =>
            ({
              async next() {
                if (state === 0) {
                  state = 1;
                  return {
                    value: {
                      type: 'assistant',
                      session_id: 'native-question-session',
                      message: {
                        content: [
                          {
                            type: 'tool_use',
                            id: 'ask-1',
                            name: 'AskUserQuestion',
                            input: questionInput
                          }
                        ]
                      }
                    } as never,
                    done: false
                  };
                }
                if (state === 1) {
                  state = 2;
                  permissionResult = await input.options.canUseTool?.(
                    'AskUserQuestion',
                    questionInput,
                    { toolUseID: 'ask-1' } as never
                  );
                  return {
                    value: {
                      type: 'result',
                      subtype: 'success',
                      session_id: 'native-question-session'
                    } as never,
                    done: false
                  };
                }
                return { value: undefined, done: true };
              },
              async return() {
                return { value: undefined, done: true };
              },
              async throw(error?: unknown) {
                throw error;
              },
              [Symbol.asyncIterator]() {
                return this;
              },
              async interrupt() {},
              async setPermissionMode() {},
              async setMcpServerPermissionMode() {
                return {};
              },
              async setModel() {},
              async rewindFiles() {
                return {} as never;
              },
              async supportedCommands() {
                return [];
              },
              async supportedModels() {
                return [];
              },
              async mcpServerStatus() {
                return [];
              },
              async accountInfo() {
                return {};
              },
              close() {}
            }) as never
        )
      )
    });
    const sent = attachSocket(connector);
    const handle = (
      connector as unknown as { handleMessage(raw: string): void }
    ).handleMessage.bind(connector);
    // The legacy envelope must reference an already accepted Run in a registered Workspace.
    (
      connector as unknown as { runtime: { adoptRun(input: Record<string, unknown>): unknown } }
    ).runtime.adoptRun({
      runId: 'run-question',
      sessionId: 'session-question',
      workspaceId: 'workspace-1',
      runner: 'claude-code',
      cwd: '/workspace'
    });
    handle(
      JSON.stringify(
        createEnvelope('run.start', {
          runId: 'run-question',
          sessionId: 'session-question',
          runner: 'claude-code',
          input: 'Start planning',
          cwd: '/workspace'
        })
      )
    );
    const userInputs = (
      connector as unknown as {
        claudeClient: {
          execution: {
            userInputs: Map<
              string,
              {
                readonly requestId: string;
                readonly questions: readonly { readonly allowOther?: boolean }[];
              }
            >;
          };
        };
      }
    ).claudeClient.execution.userInputs;
    await eventually(() => userInputs.size === 1);
    const request = [...userInputs.values()][0];
    const requestId = request?.requestId;
    expect(requestId).toMatch(/^claude:run-question:ask-1$/);
    const execute = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    await execute.executeNodeOperation('run.user-input.respond', {
      runId: 'run-question',
      requestId,
      answers: { 'claude-question-0': ['Custom approach'] }
    });
    await eventually(() =>
      sent.some(
        (message) =>
          message.type === 'workbench.event' &&
          message.payload.category === 'run' &&
          (message.payload.payload as { run?: { status?: string } }).run?.status === 'SUCCEEDED'
      )
    );
    expect(permissionResult).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...questionInput,
        answers: { 'Choose an implementation approach?': 'Custom approach' }
      }
    });
    expect(request?.questions[0]?.allowOther).toBe(true);
    connector.stop();
  });

  it('publishes a complete ConversationTurn after the Run reaches a terminal state', async () => {
    const database = preparedDatabase();
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const emitted = vi.fn();
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
        listConversationTurns(input: { readonly sessionId: string }): {
          readonly turns: readonly {
            readonly status: string;
            readonly items: readonly unknown[];
          }[];
        };
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown, status?: string): void;
      emitWorkbenchEvent(category: string, payload: unknown): void;
    };
    internals.emitWorkbenchEvent = emitted;
    const session = internals.runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'claude-code',
      cwd: '/workspace'
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'terminal-turn',
      content: 'return the complete conversation after completion'
    }).run;

    internals.emitRunEvent(run.id, 'text.delta', { text: 'final content' });
    internals.emitRunEvent(run.id, 'run.completed', {}, 'SUCCEEDED');

    const realtimeEvents = emitted.mock.calls
      .filter(([category]) => category === 'conversation')
      .map(([, payload]) => payload as { readonly event?: { readonly createdAt?: number } })
      .filter((payload) => payload.event !== undefined);
    expect(realtimeEvents).not.toHaveLength(0);
    expect(realtimeEvents.every((payload) => Number.isFinite(payload.event?.createdAt))).toBe(true);

    const finalTurn = internals.runtime
      .listConversationTurns({ sessionId: session.id })
      .turns.find((turn) => turn.status === 'SUCCEEDED');
    expect(finalTurn?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant_message',
          payload: expect.objectContaining({ text: 'final content' })
        })
      ])
    );
    connector.stop();
  });

  it('projects public Claude reasoning summaries and tool results without forwarding hidden reasoning events', async () => {
    const workspacePath = await createTestWorkspacePath();
    const database = new NodeDatabase(':memory:', 'node-1');
    database.saveWorkspace({
      id: 'workspace-1',
      path: workspacePath,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const stream = publicConversationStream();
    const next = stream.next.bind(stream);
    stream.next = async (...args) => {
      const result = await next(...args);
      if (result.done || result.value.type !== 'assistant') return result;
      return {
        ...result,
        value: {
          ...result.value,
          message: {
            ...result.value.message,
            content: [
              {
                type: 'thinking',
                thinking: 'First inspect the current directory.',
                signature: 'private-thinking-signature'
              },
              { type: 'tool_use', id: 'tool-pwd', name: 'Bash', input: { command: 'pwd' } },
              { type: 'text', text: 'The current directory is the workspace.', citations: [] },
              {
                type: 'tool_use',
                id: 'tool-after-text',
                name: 'Bash',
                input: { command: 'printf later' }
              },
              { type: 'redacted_thinking', data: 'private-redacted-data' },
              // Deliberately exercise a future block outside the installed SDK union.
              {
                type: 'future_content_block'
              } as unknown as (typeof result.value.message.content)[number]
            ]
          }
        }
      };
    };
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      claudeClient: new ClaudeAgentSdkAdapter(bindings(() => stream))
    });
    const emitted = vi.spyOn(
      (
        connector as unknown as {
          runEventService: { emit: (runId: string, eventType: string, payload: unknown) => void };
        }
      ).runEventService,
      'emit'
    );
    const execute = connector as unknown as {
      runtime: {
        listConversationTurns(input: { readonly sessionId: string }): {
          readonly turns: readonly {
            readonly items: readonly { kind: string; payload: unknown }[];
          }[];
        };
      };
      executeNodeOperation(
        operation: string,
        input: unknown
      ): Promise<{
        readonly session: { readonly id: string };
        readonly run?: { readonly id: string };
      }>;
    };
    const created = await execute.executeNodeOperation('session.create', {
      workspaceId: 'workspace-1',
      runner: 'claude-code',
      cwd: workspacePath
    });
    await execute.executeNodeOperation('session.message', {
      sessionId: created.session.id,
      clientMessageId: 'public-items',
      content: 'run a command and explain the result'
    });
    await eventually(() =>
      emitted.mock.calls.some(
        ([, eventType, payload]) =>
          eventType === 'conversation.item' && (payload as { kind?: unknown }).kind === 'reasoning'
      )
    );
    const items = emitted.mock.calls
      .filter(([, eventType]) => eventType === 'conversation.item')
      .map(([, , payload]) => payload) as readonly {
      kind: string;
      sourceItemId?: string;
      status?: string;
      payload: unknown;
    }[];
    const thinkingSourceItemId = JSON.stringify(['claude', 'assistant-public', 0]);
    const textSourceItemId = JSON.stringify(['claude', 'assistant-public', 2]);
    const orderedItems = items.filter(({ sourceItemId }) =>
      [
        thinkingSourceItemId,
        'claude-tool:tool-pwd',
        textSourceItemId,
        'claude-tool:tool-after-text'
      ].includes(sourceItemId ?? '')
    );
    expect(orderedItems.map(({ kind, sourceItemId }) => ({ kind, sourceItemId }))).toEqual([
      { kind: 'reasoning', sourceItemId: thinkingSourceItemId },
      { kind: 'command_execution', sourceItemId: 'claude-tool:tool-pwd' },
      { kind: 'assistant_message', sourceItemId: textSourceItemId },
      { kind: 'command_execution', sourceItemId: 'claude-tool:tool-after-text' }
    ]);
    expect(orderedItems[2]).toMatchObject({
      kind: 'assistant_message',
      payload: { text: 'The current directory is the workspace.' }
    });
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'reasoning',
          payload: {
            representation: 'visible_thinking',
            sections: [{ index: 0, text: 'First inspect the current directory.' }]
          }
        }),
        expect.objectContaining({
          kind: 'command_execution',
          payload: expect.objectContaining({ command: 'pwd' })
        }),
        expect.objectContaining({
          kind: 'command_execution',
          status: 'COMPLETED',
          payload: expect.objectContaining({
            output: { blocks: [{ channel: 'COMBINED', text: '/workspace\\n' }] }
          })
        }),
        expect.objectContaining({
          kind: 'unknown',
          payload: {
            sourceEventType: 'claude-code:future_content_block',
            label: 'Claude Code future_content_block'
          }
        })
      ])
    );
    expect(JSON.stringify(items)).not.toContain('hidden raw reasoning');
    expect(JSON.stringify(items)).not.toContain('Hidden raw reasoning');
    expect(JSON.stringify(items)).not.toContain('must not be displayed');
    expect(JSON.stringify(items)).not.toContain('private-thinking-signature');
    expect(JSON.stringify(items)).not.toContain('private-redacted-data');
    connector.stop();
  });

  it('normalizes complete Claude <proposed_plan> text into a plan card instead of ordinary text', async () => {
    const workspacePath = await createTestWorkspacePath();
    const database = new NodeDatabase(':memory:', 'node-1');
    database.saveWorkspace({
      id: 'workspace-1',
      path: workspacePath,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      claudeClient: new ClaudeAgentSdkAdapter(
        bindings(() => {
          let state = 0;
          return {
            async next() {
              if (state === 0) {
                state = 1;
                return {
                  value: {
                    type: 'assistant',
                    session_id: 'native-plan-session',
                    uuid: 'assistant-plan',
                    message: {
                      content: [
                        {
                          type: 'text',
                          text: '<proposed_plan>Read the configuration first, then generate a plan.</proposed_plan>'
                        }
                      ]
                    }
                  } as never,
                  done: false
                };
              }
              if (state === 1) {
                state = 2;
                return {
                  value: {
                    type: 'result',
                    subtype: 'success',
                    session_id: 'native-plan-session'
                  } as never,
                  done: false
                };
              }
              return { value: undefined, done: true };
            },
            async return() {
              return { value: undefined, done: true };
            },
            async throw(error?: unknown) {
              throw error;
            },
            [Symbol.asyncIterator]() {
              return this;
            },
            async interrupt() {
              return undefined;
            },
            async setPermissionMode() {},
            async setMcpServerPermissionMode() {
              return {};
            },
            async setModel() {},
            async supportedModels() {
              return [];
            },
            async setMaxThinkingTokens() {},
            async getContextUsage() {
              return {
                model: 'claude-sonnet',
                totalTokens: 1,
                maxTokens: 2,
                rawMaxTokens: 2,
                percentage: 50
              };
            },
            async initializationResult() {
              return {};
            },
            async close() {}
          } as never;
        })
      )
    });
    const emitted = vi.spyOn(
      (
        connector as unknown as {
          runEventService: { emit: (runId: string, eventType: string, payload: unknown) => void };
        }
      ).runEventService,
      'emit'
    );
    const execute = connector as unknown as {
      runtime: {
        listConversationTurns(input: { readonly sessionId: string }): {
          readonly turns: readonly {
            readonly items: readonly { kind: string; payload: unknown }[];
          }[];
        };
      };
      executeNodeOperation(
        operation: string,
        input: unknown
      ): Promise<{
        readonly session: { readonly id: string };
        readonly run?: { readonly id: string };
      }>;
    };
    const created = await execute.executeNodeOperation('session.create', {
      workspaceId: 'workspace-1',
      runner: 'claude-code',
      cwd: workspacePath
    });
    await execute.executeNodeOperation('session.message', {
      sessionId: created.session.id,
      clientMessageId: 'plan-items',
      content: 'Plan the configuration migration'
    });
    await eventually(() =>
      emitted.mock.calls.some(
        ([, eventType, payload]) =>
          eventType === 'conversation.item' && (payload as { kind?: unknown }).kind === 'plan'
      )
    );
    const items = emitted.mock.calls
      .filter(([, eventType]) => eventType === 'conversation.item')
      .map(([, , payload]) => payload) as readonly { kind: string; payload: unknown }[];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'plan',
          payload: expect.objectContaining({
            explanation: 'Read the configuration first, then generate a plan.'
          })
        })
      ])
    );
    expect(
      items?.some(
        (item) =>
          item.kind === 'assistant_message' &&
          JSON.stringify(item.payload).includes('proposed_plan')
      )
    ).toBe(false);
    connector.stop();
  });
});
