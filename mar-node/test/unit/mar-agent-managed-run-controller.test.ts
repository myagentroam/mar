import { executionActivity } from './support/execution-activity.js';
import { MarAgentRuntimeModelFactory } from '../../src/runner/mar-agent/runtime-model-factory.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  MarAgentManagedRunController,
  resolveRunModels
} from '../../src/runner/mar-agent/managed-run-controller.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import type { NodeAgentSession } from '../../src/database.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import {
  conversationItemSchema,
  type MarAgentRuntimeModelConfiguration,
  type RuntimeCredentialTicket
} from '../../../packages/protocol/src/index.js';
import type { ClientToolDefinition, AgentHost } from '../../../mar-agent/src/host.js';
import type { AgentEvent } from '../../../mar-agent/src/index.js';

type CreateAgent = NonNullable<
  NonNullable<ConstructorParameters<typeof MarAgentManagedRunController>[2]>['createAgent']
>;

const base = {
  eventId: 'event',
  sequence: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
  sessionId: 'session',
  executionId: 'execution',
  turnId: 'turn'
};

describe('MAR Agent managed run projection', () => {
  it('forwards an immediate command owner into the managed Run', async () => {
    const host = {
      ...executionActivity(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit: vi.fn(),
      emitItem: vi.fn(),
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn()
    };
    const controller = new MarAgentManagedRunController(new MarAgentRunner(), host);
    const run = vi
      .spyOn(
        controller as unknown as {
          run(input: unknown): Promise<void>;
        },
        'run'
      )
      .mockResolvedValue();
    const model: MarAgentRuntimeModelConfiguration = {
      id: 'coding',
      name: 'Coding',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'secret' },
      modelId: 'coding',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };

    await controller.executeCommand(
      {
        id: 'session',
        runner: 'mar-agent',
        cwd: '/workspace',
        externalSessionId: 'native-session',
        nativeControl: 'MAR_MANAGED',
        model: 'coding',
        effort: null,
        access: 'full-access'
      } as NodeAgentSession,
      { id: 'compact' } as never,
      '/compact',
      {
        secretEnvironment: {},
        executionContext: new MarAgentRunner().prepareExecutionContext({ marAgentModel: model }),
        initiatedByUserId: 7
      }
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session',
        mode: 'compact',
        initiatedByUserId: 7
      })
    );

    controller.start({
      type: 'run.start',
      id: 'message',
      payload: {
        runner: 'mar-agent',
        runId: 'run-start',
        sessionId: 'session',
        input: 'continue',
        cwd: '/workspace',
        model: 'coding',
        access: 'auto',
        marAgentModel: model
      }
    } as never);
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session', access: 'auto', mode: 'run' })
    );
    const permissionStop = {
      action: 'ask' as const,
      reason: 'Confirm before changing files.',
      source: {
        sessionId: 'session',
        executionId: 'execution',
        callId: 'blocked-call',
        toolName: 'write_file'
      }
    };
    (
      controller as unknown as {
        project(runId: string, event: AgentEvent): void;
      }
    ).project('run-start', {
      eventId: 'event',
      sequence: 1,
      timestamp: '2026-10-15T00:00:00.000Z',
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      type: 'tool.failed',
      toolName: 'write_file',
      callId: 'blocked-call',
      code: 'MAR_AGENT_PERMISSION_ASK',
      message: permissionStop.reason,
      permissionStop
    });
    const projectedItem = host.emitItem.mock.calls.at(-1)?.[1];
    expect(projectedItem).toMatchObject({ kind: 'tool_call', permissionStop });
    expect(projectedItem?.payload).not.toHaveProperty('permissionStop');
  });

  it('renews a Session runtime lease at Execution admission before asynchronous setup', async () => {
    vi.useFakeTimers();
    try {
      let blockDispose = false;
      let releaseBlockedDispose: (() => void) | undefined;
      const dispose = vi.fn(async () => {
        if (!blockDispose) return;
        await new Promise<void>((resolve) => (releaseBlockedDispose = resolve));
      });
      const handle = () => ({
        executionId: 'execution',
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          executionId: 'execution',
          status: 'completed' as const,
          finalAnswer: 'done'
        }),
        cancel: vi.fn()
      });
      const session = {
        id: 'native-session',
        subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
        joinExecution: () => undefined,
        run: vi.fn(handle),
        steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
        plan: vi.fn(handle),
        compact: vi.fn(handle),
        cancel: vi.fn()
      };
      const createAgent = vi.fn(async () => ({
        createSession: vi.fn(async () => session),
        openSession: vi.fn(async () => session),
        listSessions: vi.fn(),
        sessionHistory: vi.fn(async () => ({ entries: [] })),
        sessionInputReceipt: vi.fn(async () => undefined),
        sessionExecutionWasInterrupted: vi.fn(async () => false),
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
        deleteSessions: vi.fn(),
        clearSession: vi.fn(),
        setSystemInstruction: vi.fn(),
        reconfigureModels: vi.fn(async () => undefined),
        extensionDiagnostics: () => [],
        observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
        dispose
      }));
      const controller = new MarAgentManagedRunController(
        new MarAgentRunner(),
        {
          ...executionActivity(),
          adopt: vi.fn(),
          promote: vi.fn(),
          syncTitle: vi.fn(),
          emit: vi.fn(),
          emitItem: vi.fn(),
          run: vi.fn(),
          commandState: vi.fn(),
          setCommandState: vi.fn(),
          clearCommandState: vi.fn(),
          commandStates: vi.fn(() => []),
          webSearch: vi.fn()
        },
        { createAgent }
      );
      const current: MarAgentRuntimeModelConfiguration = {
        id: 'coding',
        name: 'Coding',
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl: 'https://example.test',
        credential: { type: 'INLINE_API_KEY', value: 'secret' },
        modelId: 'coding',
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        titleGeneration: false,
        codeMode: false,
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true
      };
      const model = resolveRunModels(current, [current])[0]!;
      const run = (
        controller as unknown as {
          run(input: unknown): Promise<void>;
        }
      ).run.bind(controller);
      const input = {
        sessionId: 'native-session',
        input: 'continue',
        cwd: '/workspace',
        model,
        models: [model],
        effort: '',
        access: 'full-access' as const,
        mode: 'run' as const,
        externalSessionId: 'native-session',
        mcpServers: [] as const,
        images: [] as const
      };

      await run({ ...input, runId: 'run-1' });
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      const continuation = run({ ...input, runId: 'run-2' });
      vi.advanceTimersByTime(1);
      await Promise.resolve();

      expect(createAgent).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
      await continuation;
      expect(session.run).toHaveBeenCalledTimes(2);

      blockDispose = true;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(dispose).toHaveBeenCalledTimes(1);
      const takeover = run({ ...input, runId: 'run-3' });
      await Promise.resolve();
      expect(createAgent).toHaveBeenCalledTimes(1);
      blockDispose = false;
      releaseBlockedDispose?.();
      await takeover;
      expect(createAgent).toHaveBeenCalledTimes(2);
      await run({ ...input, runId: 'run-4', personalInstructions: 'changed' });
      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(dispose).toHaveBeenCalledTimes(1);
      const latestAgent = await createAgent.mock.results.at(-1)!.value;
      expect(latestAgent.setSystemInstruction).toHaveBeenCalledWith('changed');
      await controller.releaseSession('native-session');
      expect(dispose).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(dispose).toHaveBeenCalledTimes(2);
      await controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes the Session runtime available before publishing a terminal continuation event', async () => {
    const dispose = vi.fn(async () => undefined);
    let execution = 0;
    let permissionStopNext = false;
    const handle = () => {
      const executionId = `execution-${++execution}`;
      const permissionStop = permissionStopNext
        ? {
            action: 'ask' as const,
            reason: 'Confirm before changing files.',
            source: {
              sessionId: 'native-session',
              executionId,
              callId: 'blocked-call',
              toolName: 'apply_patch'
            }
          }
        : undefined;
      permissionStopNext = false;
      return {
        executionId,
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          executionId,
          status: 'completed' as const,
          finalAnswer: permissionStop === undefined ? 'done' : '',
          ...(permissionStop === undefined ? {} : { permissionStop })
        }),
        cancel: vi.fn()
      };
    };
    const session = {
      id: 'native-session',
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      joinExecution: () => undefined,
      run: vi.fn(handle),
      steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
      plan: vi.fn(handle),
      compact: vi.fn(handle),
      cancel: vi.fn()
    };
    const createAgent = vi.fn(async () => ({
      createSession: vi.fn(async () => session),
      openSession: vi.fn(async () => session),
      listSessions: vi.fn(),
      sessionHistory: vi.fn(async () => ({ entries: [] })),
      sessionInputReceipt: vi.fn(async () => undefined),
      sessionExecutionWasInterrupted: vi.fn(async () => false),
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
      deleteSessions: vi.fn(),
      clearSession: vi.fn(),
      setSystemInstruction: vi.fn(),
      reconfigureModels: vi.fn(async () => undefined),
      extensionDiagnostics: () => [],
      observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
      dispose
    }));
    let startContinuation: (() => void) | undefined;
    const host = {
      ...executionActivity(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit: vi.fn((runId: string, _eventType: string, _payload: unknown, status?: string) => {
        if (runId === 'run-1' && status === 'SUCCEEDED') startContinuation?.();
      }),
      emitItem: vi.fn(),
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn()
    };
    const controller = new MarAgentManagedRunController(new MarAgentRunner(), host, {
      createAgent
    });
    const current: MarAgentRuntimeModelConfiguration = {
      id: 'coding',
      name: 'Coding',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'secret' },
      modelId: 'coding',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const model = resolveRunModels(current, [current])[0]!;
    const run = (
      controller as unknown as {
        run(input: unknown): Promise<void>;
      }
    ).run.bind(controller);
    const input = {
      sessionId: 'native-session',
      input: 'continue goal',
      cwd: '/workspace',
      model,
      models: [model],
      effort: '',
      access: 'full-access' as const,
      mode: 'run' as const,
      externalSessionId: 'native-session',
      mcpServers: [] as const,
      images: [] as const
    };
    let continuation: Promise<void> | undefined;
    startContinuation = () => {
      continuation = run({ ...input, runId: 'run-2' });
    };

    try {
      await run({ ...input, runId: 'run-1' });
      await continuation;

      expect(session.run).toHaveBeenCalledTimes(2);
      expect(session.run).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ permissionMode: 'full-access' })
      );
      expect(createAgent).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
      expect(host.emit).not.toHaveBeenCalledWith(
        'run-2',
        'run.failed',
        expect.objectContaining({ message: 'MAR_AGENT_SESSION_RUNTIME_ACTIVE' }),
        'FAILED'
      );

      permissionStopNext = true;
      await run({ ...input, runId: 'run-3', access: 'auto' });
      expect(session.run).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ permissionMode: 'auto' })
      );
      expect(host.emit).toHaveBeenCalledWith(
        'run-3',
        'run.completed',
        expect.objectContaining({
          status: 'INTERRUPTED',
          code: 'MAR_AGENT_PERMISSION_ASK',
          message: 'Confirm before changing files.'
        }),
        'INTERRUPTED'
      );
      await run({ ...input, runId: 'run-4', access: 'auto', mode: 'plan' });
      expect(session.plan).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: 'auto' })
      );
    } finally {
      await controller.dispose();
    }
  });

  it('rebinds Execution-scoped MCP without disposing the warm Session runtime', async () => {
    const dispose = vi.fn(async () => undefined);
    const observed: Array<{ executionId: string; tools: string[]; content: string }> = [];
    const executionIds: string[] = [];
    let execution = 0;
    const createAgent: CreateAgent = vi.fn(async (options) => {
      const session = {
        id: 'native-session',
        subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
        joinExecution: () => undefined,
        run: vi.fn(() => {
          const executionId = `sdk-execution-${++execution}`;
          executionIds.push(executionId);
          return {
            executionId,
            async *[Symbol.asyncIterator]() {},
            result: async () => {
              const tools =
                (await options.host.listMcpTools?.({
                  sessionId: 'native-session',
                  executionId,
                  claimExecutionScope: true
                })) ?? [];
              const output = await options.host.callMcpTool?.(
                {
                  name: 'mcp__execution_server__echo',
                  arguments: { value: executionId }
                },
                new AbortController().signal,
                { sessionId: 'native-session', executionId }
              );
              observed.push({
                executionId,
                tools: tools.map((tool: ClientToolDefinition) => tool.name),
                content: output?.content ?? ''
              });
              return {
                executionId,
                status: 'completed' as const,
                finalAnswer: 'done'
              };
            },
            cancel: vi.fn()
          };
        }),
        steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
        plan: vi.fn(),
        compact: vi.fn(),
        cancel: vi.fn()
      };
      return {
        createSession: vi.fn(async () => session),
        openSession: vi.fn(async () => session),
        listSessions: vi.fn(),
        sessionHistory: vi.fn(async () => ({ entries: [] })),
        sessionInputReceipt: vi.fn(async () => undefined),
        sessionExecutionWasInterrupted: vi.fn(async () => false),
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
        deleteSessions: vi.fn(),
        clearSession: vi.fn(),
        setSystemInstruction: vi.fn(),
        reconfigureModels: vi.fn(async () => undefined),
        extensionDiagnostics: () => [],
        observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
        dispose
      };
    });
    const controller = new MarAgentManagedRunController(
      new MarAgentRunner(),
      {
        ...executionActivity(),
        adopt: vi.fn(),
        promote: vi.fn(),
        syncTitle: vi.fn(),
        emit: vi.fn(),
        emitItem: vi.fn(),
        run: vi.fn(),
        commandState: vi.fn(),
        setCommandState: vi.fn(),
        clearCommandState: vi.fn(),
        commandStates: vi.fn(() => []),
        webSearch: vi.fn()
      },
      { createAgent }
    );
    const current: MarAgentRuntimeModelConfiguration = {
      id: 'coding',
      name: 'Coding',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'secret' },
      modelId: 'coding',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const model = resolveRunModels(current, [current])[0]!;
    const run = (
      controller as unknown as {
        run(input: unknown): Promise<void>;
      }
    ).run.bind(controller);
    const mcpServer = (capability: string) => ({
      name: 'execution server',
      transport: 'STDIO' as const,
      command: process.execPath,
      args: [fileURLToPath(new URL('../support/mar-agent-mcp-server.mjs', import.meta.url))],
      environment: { CAPABILITY: capability },
      lifecycle: 'EXECUTION' as const
    });
    const input = {
      sessionId: 'native-session',
      input: 'continue',
      cwd: process.cwd(),
      model,
      models: [model],
      effort: '',
      access: 'full-access' as const,
      mode: 'run' as const,
      externalSessionId: 'native-session',
      images: [] as const
    };

    try {
      await run({ ...input, runId: 'run-1', mcpServers: [mcpServer('first')] });
      const createdHost = (createAgent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
        .host as AgentHost;
      await expect(
        createdHost.callMcpTool?.(
          { name: 'mcp__execution_server__echo', arguments: { value: 'stale' } },
          new AbortController().signal,
          { sessionId: 'native-session', executionId: executionIds[0]! }
        )
      ).rejects.toMatchObject({ code: 'MAR_AGENT_MCP_FAILED' });

      await run({ ...input, runId: 'run-2', mcpServers: [mcpServer('second')] });

      expect(createAgent).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
      expect(observed).toEqual([
        {
          executionId: 'sdk-execution-1',
          tools: ['mcp__execution_server__echo'],
          content: '{"value":"sdk-execution-1"}'
        },
        {
          executionId: 'sdk-execution-2',
          tools: ['mcp__execution_server__echo'],
          content: '{"value":"sdk-execution-2"}'
        }
      ]);
      await run({
        ...input,
        runId: 'run-3',
        secretEnvironment: {
          MAR_CTL_CONTEXT_REQUIRED: '1',
          MAR_CTL_USER_TOKEN: 'execution-credential',
          MAR_CTL_SERVER_URL: 'https://server.test',
          MAR_CTL_NODE_ID: 'node',
          MAR_CTL_WORKSPACE_ID: 'workspace'
        },
        mcpServers: [
          mcpServer('third'),
          { ...mcpServer('hidden'), name: 'mar_schedule', command: 'must-not-start-schedule-mcp' }
        ]
      });
      expect(observed.at(-1)?.tools).toEqual(['mcp__execution_server__echo']);
      await run({
        ...input,
        runId: 'run-4',
        mcpServers: [mcpServer('fourth'), { ...mcpServer('fallback'), name: 'mar_schedule' }]
      });
      expect(observed.at(-1)?.tools).toContain('mcp__mar_schedule__echo');
    } finally {
      await controller.dispose();
    }
  });

  it('rebinds Computer Use through the retained MAR Session lifecycle', async () => {
    const close = vi.fn(async () => undefined);
    const releaseSession = vi.fn(async () => undefined);
    const disposeComputerUse = vi.fn(async () => undefined);
    const calls: string[] = [];
    const computerUse = {
      support: vi.fn(),
      reset: vi.fn(async () => undefined),
      bind: vi.fn(async () => ({
        tools: [
          {
            name: 'mcp__mar_computer__exec',
            description: 'Computer Use',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'mcp__mar_computer__wait',
            description: 'Wait for Computer Use',
            inputSchema: { type: 'object', properties: {} }
          }
        ],
        call: vi.fn(async (_call: unknown) => {
          calls.push('called');
          return { content: 'observed' };
        }),
        close
      })),
      releaseSession,
      dispose: disposeComputerUse
    };
    let execution = 0;
    const createAgent: CreateAgent = vi.fn(async (options) => {
      const session = {
        id: 'native-session',
        subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
        joinExecution: () => undefined,
        run: vi.fn(() => {
          const executionId = `sdk-execution-${++execution}`;
          return {
            executionId,
            async *[Symbol.asyncIterator]() {},
            result: async () => {
              const tools =
                (await options.host.listMcpTools?.({
                  sessionId: 'native-session',
                  executionId,
                  claimExecutionScope: true
                })) ?? [];
              expect(tools.map((tool: ClientToolDefinition) => tool.name)).toContain(
                'mcp__mar_computer__exec'
              );
              const catalog = await options.host.listMcpToolCatalog?.({
                sessionId: 'native-session',
                executionId,
                claimExecutionScope: true
              });
              expect(
                catalog?.tools.map(
                  ({
                    definition,
                    rawName
                  }: {
                    definition: ClientToolDefinition;
                    rawName: string;
                  }) => [definition.name, rawName]
                )
              ).toEqual([
                ['mcp__mar_computer__exec', 'exec'],
                ['mcp__mar_computer__wait', 'wait']
              ]);
              const extensions = await options.host.listExecutionExtensions?.({
                sessionId: 'native-session',
                executionId,
                claimExecutionScope: true
              });
              expect(
                extensions?.skills?.map(
                  (skill: import('@myagentroam/agent/host').HostSkill) => skill.name
                )
              ).toContain('computer-use');
              await options.host.callMcpTool?.(
                { name: 'mcp__mar_computer__exec', arguments: { code: '' } },
                new AbortController().signal,
                { sessionId: 'native-session', executionId }
              );
              return {
                executionId,
                status: 'completed' as const,
                finalAnswer: 'done'
              };
            },
            cancel: vi.fn()
          };
        }),
        steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
        plan: vi.fn(),
        compact: vi.fn(),
        cancel: vi.fn()
      };
      return {
        createSession: vi.fn(async () => session),
        openSession: vi.fn(async () => session),
        listSessions: vi.fn(),
        sessionHistory: vi.fn(async () => ({ entries: [] })),
        sessionInputReceipt: vi.fn(async () => undefined),
        sessionExecutionWasInterrupted: vi.fn(async () => false),
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
        deleteSessions: vi.fn(),
        clearSession: vi.fn(),
        setSystemInstruction: vi.fn(),
        reconfigureModels: vi.fn(async () => undefined),
        extensionDiagnostics: () => [],
        observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
        dispose: vi.fn(async () => undefined)
      };
    });
    const controller = new MarAgentManagedRunController(
      new MarAgentRunner(),
      {
        ...executionActivity(),
        adopt: vi.fn(),
        promote: vi.fn(),
        syncTitle: vi.fn(),
        emit: vi.fn(),
        emitItem: vi.fn(),
        run: vi.fn(),
        commandState: vi.fn(),
        setCommandState: vi.fn(),
        clearCommandState: vi.fn(),
        commandStates: vi.fn(() => []),
        webSearch: vi.fn()
      },
      { createAgent, computerUse, resourceIdleTtlMs: 20 }
    );
    const current: MarAgentRuntimeModelConfiguration = {
      id: 'coding',
      name: 'Coding',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'secret' },
      modelId: 'coding',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT', 'IMAGE'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const model = resolveRunModels(current, [current])[0]!;
    const run = (
      controller as unknown as {
        run(input: unknown): Promise<void>;
      }
    ).run.bind(controller);
    const input = {
      sessionId: 'temporary-session',
      input: 'continue',
      cwd: '/workspace',
      model,
      models: [model],
      effort: '',
      access: 'full-access' as const,
      mode: 'run' as const,
      externalSessionId: 'native-session',
      mcpServers: [] as const,
      images: [] as const,
      computerUseEnabled: true
    };

    await run({ ...input, runId: 'run-1' });
    await run({ ...input, runId: 'run-2' });

    expect(computerUse.bind).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runId: 'run-1', sessionId: 'native-session' })
    );
    expect(computerUse.bind).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: 'run-2', sessionId: 'native-session' })
    );
    expect(calls).toEqual(['called', 'called']);
    expect(close).toHaveBeenCalledTimes(2);
    expect(releaseSession).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(releaseSession).toHaveBeenCalledWith('native-session');
    await controller.dispose();
    expect(disposeComputerUse).toHaveBeenCalledTimes(1);
  });

  it('rebinds a dynamic runtime ticket without releasing retained Session resources', async () => {
    const dispose = vi.fn();
    const reconfigureModels = vi.fn(async () => undefined);
    const handle = () => ({
      executionId: 'execution',
      async *[Symbol.asyncIterator]() {},
      result: async () => ({
        executionId: 'execution',
        status: 'completed' as const,
        finalAnswer: 'done'
      }),
      cancel: vi.fn()
    });
    const session = {
      id: 'native-session',
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      joinExecution: () => undefined,
      run: vi.fn(handle),
      steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
      plan: vi.fn(handle),
      compact: vi.fn(handle),
      cancel: vi.fn()
    };
    const createAgent = vi.fn(async () => ({
      createSession: vi.fn(async () => session),
      openSession: vi.fn(async () => session),
      listSessions: vi.fn(),
      sessionHistory: vi.fn(async () => ({ entries: [] })),
      sessionInputReceipt: vi.fn(async () => undefined),
      sessionExecutionWasInterrupted: vi.fn(async () => false),
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
      deleteSessions: vi.fn(),
      clearSession: vi.fn(),
      setSystemInstruction: vi.fn(),
      reconfigureModels,
      extensionDiagnostics: () => [],
      observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
      dispose
    }));
    const modelFactory = {
      create: vi.fn(() => [])
    };
    const controller = new MarAgentManagedRunController(
      new MarAgentRunner(),
      {
        ...executionActivity(),
        adopt: vi.fn(),
        promote: vi.fn(),
        syncTitle: vi.fn(),
        emit: vi.fn(),
        emitItem: vi.fn(),
        run: vi.fn(),
        commandState: vi.fn(),
        setCommandState: vi.fn(),
        clearCommandState: vi.fn(),
        commandStates: vi.fn(() => []),
        webSearch: vi.fn()
      },
      { createAgent, modelFactory }
    );
    const run = (
      controller as unknown as {
        run(input: unknown): Promise<void>;
      }
    ).run.bind(controller);
    const firstModel = runtimeTicketModel('scope-1', 'ticket-1');
    const secondModel = runtimeTicketModel('scope-2', 'ticket-2');
    for (const model of [firstModel, secondModel]) {
      Object.assign(model, {
        imageGeneration: {
          provider: 'CODEX',
          config: { modelId: 'gpt-image-2' },
          imageModelId: 'gpt-image-2',
          generateEndpoint: 'https://chatgpt.com/backend-api/codex/images/generations',
          editEndpoint: 'https://chatgpt.com/backend-api/codex/images/edits',
          httpVersion: '1.1',
          credential: model.credential
        }
      });
    }
    const input = {
      sessionId: 'native-session',
      input: 'continue',
      cwd: '/workspace',
      model: firstModel,
      models: [firstModel],
      runtimeScopeId: 'scope-1',
      effort: '',
      access: 'full-access' as const,
      mode: 'run' as const,
      externalSessionId: 'native-session',
      mcpServers: [] as const,
      images: [] as const
    };

    await run({ ...input, runId: 'run-1' });
    await run({
      ...input,
      runId: 'run-2',
      model: secondModel,
      models: [secondModel],
      runtimeScopeId: 'scope-2'
    });

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(reconfigureModels).toHaveBeenCalledWith({
      models: [],
      defaultModelId: 'coding'
    });
    expect(modelFactory.create).toHaveBeenLastCalledWith([secondModel], {
      runtimeScopeId: 'scope-2',
      executionId: 'run-2'
    });
    await controller.dispose();
  });

  it('closes dynamic providers that the SDK rejects during Session runtime rebinding', async () => {
    const dispose = vi.fn();
    const rejectedProvider = {
      acquire: vi.fn(async () => {
        throw new Error('not used');
      }),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const rejectedImageProvider = { ...rejectedProvider, close: vi.fn(async () => undefined) };
    const replacementModels: import('../../src/runner/mar-agent/runtime-model-factory.js').MarAgentRuntimeModel[] =
      [
        {
          id: 'coding',
          name: 'Coding',
          protocol: 'OPENAI_RESPONSES',
          baseUrl: 'https://models.example.test/v1',
          credentialProvider: rejectedProvider,
          imageGeneration: {
            provider: 'CODEX',
            config: {},
            imageModelId: 'gpt-image-2',
            generateEndpoint: 'https://chatgpt.com/backend-api/codex/images/generations',
            editEndpoint: 'https://chatgpt.com/backend-api/codex/images/edits',
            httpVersion: '1.1',
            credentialProvider: rejectedImageProvider
          },
          modelId: 'gpt-5.6',
          contextWindowTokens: 200_000,
          maxOutputTokens: 4_096,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: [],
          titleGeneration: false,
          codeMode: false,
          hostedWebSearch: false,
          responsesPreviousResponseId: false,
          enabled: true
        }
      ];
    const handle = () => ({
      executionId: 'execution',
      async *[Symbol.asyncIterator]() {},
      result: async () => ({
        executionId: 'execution',
        status: 'completed' as const,
        finalAnswer: 'done'
      }),
      cancel: vi.fn()
    });
    const session = {
      id: 'native-session',
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      joinExecution: () => undefined,
      run: vi.fn(handle),
      steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
      plan: vi.fn(handle),
      compact: vi.fn(handle),
      cancel: vi.fn()
    };
    const reconfigureModels = vi.fn(async () => {
      throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
    });
    const createAgent = vi.fn(async () => ({
      createSession: vi.fn(async () => session),
      openSession: vi.fn(async () => session),
      listSessions: vi.fn(),
      sessionHistory: vi.fn(async () => ({ entries: [] })),
      sessionInputReceipt: vi.fn(async () => undefined),
      sessionExecutionWasInterrupted: vi.fn(async () => false),
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
      deleteSessions: vi.fn(),
      clearSession: vi.fn(),
      setSystemInstruction: vi.fn(),
      reconfigureModels,
      extensionDiagnostics: () => [],
      observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
      dispose
    }));
    const modelFactory = {
      create: vi.fn().mockReturnValueOnce([]).mockReturnValueOnce(replacementModels)
    };
    const controller = new MarAgentManagedRunController(
      new MarAgentRunner(),
      {
        ...executionActivity(),
        adopt: vi.fn(),
        promote: vi.fn(),
        syncTitle: vi.fn(),
        emit: vi.fn(),
        emitItem: vi.fn(),
        run: vi.fn(),
        commandState: vi.fn(),
        setCommandState: vi.fn(),
        clearCommandState: vi.fn(),
        commandStates: vi.fn(() => []),
        webSearch: vi.fn()
      },
      { createAgent, modelFactory }
    );
    const run = (
      controller as unknown as {
        run(input: unknown): Promise<void>;
      }
    ).run.bind(controller);
    const firstModel = runtimeTicketModel('scope-1', 'ticket-1');
    const secondModel = runtimeTicketModel('scope-2', 'ticket-2');
    const input = {
      sessionId: 'native-session',
      input: 'continue',
      cwd: '/workspace',
      model: firstModel,
      models: [firstModel],
      runtimeScopeId: 'scope-1',
      effort: '',
      access: 'full-access' as const,
      mode: 'run' as const,
      externalSessionId: 'native-session',
      mcpServers: [] as const,
      images: [] as const
    };

    await run({ ...input, runId: 'run-1' });
    await run({
      ...input,
      runId: 'run-2',
      model: secondModel,
      models: [secondModel],
      runtimeScopeId: 'scope-2'
    });

    expect(reconfigureModels).toHaveBeenCalledOnce();
    expect(rejectedProvider.close).toHaveBeenCalledOnce();
    expect(rejectedImageProvider.close).toHaveBeenCalledOnce();
    await controller.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('forwards Composer image names and pixels into the MAR Agent SDK input', () => {
    const controller = new MarAgentManagedRunController(new MarAgentRunner(), {
      ...executionActivity(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit: vi.fn(),
      emitItem: vi.fn(),
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn()
    });
    const run = vi
      .spyOn(
        controller as unknown as {
          run(input: unknown): Promise<void>;
        },
        'run'
      )
      .mockResolvedValue();

    controller.start({
      payload: {
        runner: 'mar-agent',
        runId: 'image-run',
        sessionId: 'image-session',
        input: 'view the image',
        cwd: process.cwd(),
        model: 'vision',
        marAgentModel: {
          id: 'vision',
          name: 'Vision',
          protocol: 'ANTHROPIC_MESSAGES',
          baseUrl: 'https://example.test',
          credential: { type: 'INLINE_API_KEY', value: 'secret' },
          modelId: 'vision',
          contextWindowTokens: 200_000,
          maxOutputTokens: 4096,
          inputCapabilities: ['TEXT', 'IMAGE'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: [],
          hostedWebSearch: false,
          responsesPreviousResponseId: false,
          enabled: true
        },
        attachments: [{ name: 'diagram.png', mime: 'image/png', dataBase64: 'aW1hZ2U=' }]
      }
    } as never);

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ name: 'diagram.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }]
      })
    );
  });

  it('updates models but rebuilds a retained Session runtime when the Host environment changes', async () => {
    const environmentKey = 'MAR_AGENT_RUNTIME_FINGERPRINT_TEST';
    const previous = process.env[environmentKey];
    const dispose = vi.fn();
    const reconfigureModels = vi.fn(async () => undefined);
    const handle = () => ({
      executionId: 'execution',
      async *[Symbol.asyncIterator]() {},
      result: async () => ({
        executionId: 'execution',
        status: 'completed' as const,
        finalAnswer: 'done'
      }),
      cancel: vi.fn()
    });
    const session = {
      id: 'native-session',
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      joinExecution: () => undefined,
      run: vi.fn(handle),
      steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
      plan: vi.fn(handle),
      compact: vi.fn(handle),
      cancel: vi.fn()
    };
    const createAgent = vi.fn(async () => ({
      createSession: vi.fn(async () => session),
      openSession: vi.fn(async () => session),
      listSessions: vi.fn(),
      sessionHistory: vi.fn(async () => ({ entries: [] })),
      sessionInputReceipt: vi.fn(async () => undefined),
      sessionExecutionWasInterrupted: vi.fn(async () => false),
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
      deleteSessions: vi.fn(),
      clearSession: vi.fn(),
      setSystemInstruction: vi.fn(),
      reconfigureModels,
      extensionDiagnostics: () => [],
      observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
      dispose
    }));
    const controller = new MarAgentManagedRunController(
      new MarAgentRunner(),
      {
        ...executionActivity(),
        adopt: vi.fn(),
        promote: vi.fn(),
        syncTitle: vi.fn(),
        emit: vi.fn(),
        emitItem: vi.fn(),
        run: vi.fn(),
        commandState: vi.fn(),
        setCommandState: vi.fn(),
        clearCommandState: vi.fn(),
        commandStates: vi.fn(() => []),
        webSearch: vi.fn()
      },
      { createAgent }
    );
    const current: MarAgentRuntimeModelConfiguration = {
      id: 'coding',
      name: 'Coding',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'secret' },
      modelId: 'coding',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const model = resolveRunModels(current, [current])[0]!;
    const run = (
      controller as unknown as {
        run(input: unknown): Promise<void>;
      }
    ).run.bind(controller);
    const input = {
      sessionId: 'native-session',
      input: 'continue',
      cwd: '/workspace',
      model,
      models: [model],
      effort: '',
      access: 'full-access' as const,
      mode: 'run' as const,
      externalSessionId: 'native-session',
      mcpServers: [] as const,
      images: [] as const
    };

    try {
      process.env[environmentKey] = 'first';
      await run({ ...input, runId: 'run-1' });
      await run({ ...input, runId: 'run-2' });
      expect(createAgent).toHaveBeenCalledTimes(1);

      process.env[environmentKey] = 'second';
      await run({ ...input, runId: 'run-3' });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(createAgent).toHaveBeenCalledTimes(2);

      const switchedConfiguration: MarAgentRuntimeModelConfiguration = {
        ...current,
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6-Luna',
        protocol: 'OPENAI_RESPONSES',
        modelId: 'gpt-5.6-luna'
      };
      const switchedModel = resolveRunModels(switchedConfiguration, [switchedConfiguration])[0]!;
      await run({
        ...input,
        runId: 'run-4',
        model: switchedModel,
        models: [switchedModel]
      });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(reconfigureModels).toHaveBeenCalledOnce();
      expect(reconfigureModels).toHaveBeenCalledWith({
        models: expect.arrayContaining([expect.objectContaining({ id: switchedModel.id })]),
        defaultModelId: switchedModel.id
      });
      await run({
        ...input,
        runId: 'run-personal-git',
        secretEnvironment: {
          GIT_AUTHOR_NAME: 'Personal Git User',
          MAR_GIT_TOKEN: 'test-capability'
        }
      });
      expect(createAgent).toHaveBeenCalledTimes(3);
      await run({
        ...input,
        runId: 'run-personal-git-other-user',
        secretEnvironment: { GIT_AUTHOR_NAME: 'Other Git User', MAR_GIT_TOKEN: 'other-capability' }
      });
      expect(createAgent).toHaveBeenCalledTimes(4);
    } finally {
      if (previous === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previous;
      await controller.dispose();
    }
  });

  it.each(['releaseSession', 'dispose'] as const)(
    'waits for in-flight runtime creation before %s completes',
    async (operation) => {
      let finishCreateAgent: (() => void) | undefined;
      const createAgentGate = new Promise<void>((resolve) => (finishCreateAgent = resolve));
      const dispose = vi.fn();
      const imageProvider = {
        acquire: vi.fn(async () => {
          throw new Error('unused');
        }),
        invalidate: vi.fn(),
        close: vi.fn(async () => undefined)
      };
      const factory = new MarAgentRuntimeModelFactory({
        resolve: async () => {
          throw new Error('unused');
        }
      });
      const handle = () => ({
        executionId: 'execution',
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          executionId: 'execution',
          status: 'completed' as const,
          finalAnswer: 'done'
        }),
        cancel: vi.fn()
      });
      const session = {
        id: 'native-session',
        subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
        joinExecution: () => undefined,
        run: vi.fn(handle),
        steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
        plan: vi.fn(handle),
        compact: vi.fn(handle),
        cancel: vi.fn()
      };
      const createAgent = vi.fn(async () => {
        await createAgentGate;
        return {
          createSession: vi.fn(async () => session),
          openSession: vi.fn(async () => session),
          listSessions: vi.fn(),
          sessionHistory: vi.fn(async () => ({ entries: [] })),
          sessionInputReceipt: vi.fn(async () => undefined),
          sessionExecutionWasInterrupted: vi.fn(async () => false),
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
          deleteSessions: vi.fn(),
          clearSession: vi.fn(),
          setSystemInstruction: vi.fn(),
          reconfigureModels: vi.fn(async () => undefined),
          extensionDiagnostics: () => [],
          observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
          dispose
        };
      });
      const controller = new MarAgentManagedRunController(
        new MarAgentRunner(),
        {
          ...executionActivity(),
          adopt: vi.fn(),
          promote: vi.fn(),
          syncTitle: vi.fn(),
          emit: vi.fn(),
          emitItem: vi.fn(),
          run: vi.fn(),
          commandState: vi.fn(),
          setCommandState: vi.fn(),
          clearCommandState: vi.fn(),
          commandStates: vi.fn(() => []),
          webSearch: vi.fn()
        },
        {
          createAgent,
          modelFactory: {
            create: (configurations, context) =>
              factory.create(configurations, context).map((model) => ({
                ...model,
                imageGeneration: {
                  provider: 'BYTED_ARK',
                  config: {},
                  imageModelId: 'test-image',
                  generateEndpoint: 'https://example.test/images/generations',
                  editEndpoint: 'https://example.test/images/generations',
                  httpVersion: '1.1' as const,
                  credentialProvider: imageProvider
                }
              }))
          }
        }
      );
      const current: MarAgentRuntimeModelConfiguration = {
        id: 'coding',
        name: 'Coding',
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl: 'https://example.test',
        credential: { type: 'INLINE_API_KEY', value: 'secret' },
        modelId: 'coding',
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true
      };
      const model = resolveRunModels(current, [current])[0]!;
      const run = (
        controller as unknown as {
          run(input: unknown): Promise<void>;
        }
      ).run.bind(controller);
      const runPromise = run({
        runId: 'run',
        sessionId: 'native-session',
        input: 'continue',
        cwd: '/workspace',
        model,
        models: [model],
        effort: '',
        access: 'full-access',
        mode: 'run',
        externalSessionId: 'native-session',
        mcpServers: [],
        images: []
      });
      await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));

      let releaseSettled = false;
      const releasePromise = (
        operation === 'dispose' ? controller.dispose() : controller.releaseSession('native-session')
      ).then(() => {
        releaseSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(releaseSettled).toBe(false);

      finishCreateAgent?.();
      await Promise.all([releasePromise, runPromise]);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(imageProvider.close).toHaveBeenCalledTimes(1);
      if (operation === 'releaseSession') await controller.dispose();
    }
  );

  it('keeps exec and exec_wait calls independent with their own process snapshots', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const started = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'exec',
      callId: 'start-call',
      input: { command: 'pnpm test', cwd: '/workspace' }
    });
    const running = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'exec',
      callId: 'start-call',
      summary: 'running',
      truncated: false,
      data: {
        status: 'running',
        processId: 'process-1',
        stdout: 'first',
        stderr: '',
        truncated: false,
        stdoutBytes: 5,
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      }
    });
    const pollStarted = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'exec_wait',
      callId: 'poll-call',
      input: { action: 'poll', processId: 'process-1' }
    });
    const completed = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'exec_wait',
      callId: 'poll-call',
      summary: 'done',
      truncated: false,
      data: {
        status: 'completed',
        processId: 'process-1',
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        truncated: false,
        stdoutBytes: 7,
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      }
    });

    expect(started[0]).toMatchObject({
      itemId: 'mar-agent-tool:start-call',
      kind: 'command_execution',
      status: 'IN_PROGRESS'
    });
    expect(running[0]).toMatchObject({
      itemId: 'mar-agent-tool:start-call',
      kind: 'command_execution',
      status: 'COMPLETED',
      payload: { command: 'pnpm test', outputPreview: 'first', exitCode: null }
    });
    expect(pollStarted).toEqual([
      expect.objectContaining({
        itemId: 'mar-agent-tool:poll-call',
        kind: 'command_execution',
        status: 'IN_PROGRESS',
        payload: expect.objectContaining({ command: 'exec_wait' })
      })
    ]);
    expect(completed[0]).toMatchObject({
      itemId: 'mar-agent-tool:poll-call',
      kind: 'command_execution',
      status: 'COMPLETED',
      payload: { command: 'exec_wait', outputPreview: 'ok', exitCode: 0 }
    });
    const replayStarted = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'exec_wait',
      callId: 'replay-call',
      input: { action: 'poll', processId: 'process-1' }
    });
    const [replayed] = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'exec_wait',
      callId: 'replay-call',
      summary: 'cached',
      truncated: false,
      data: {
        status: 'completed',
        processId: 'process-1',
        stdout: 'first\nok',
        stderr: '',
        exitCode: 0,
        truncated: false,
        cached: true,
        stdoutBytes: 7,
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      }
    });
    expect(replayed).toMatchObject({
      itemId: 'mar-agent-tool:replay-call',
      status: 'COMPLETED',
      payload: { outputPreview: 'first\nok', exitCode: 0 }
    });
    expect(running[0]?.payload.outputPreview).toBe('first');
    expect(completed[0]?.payload.outputPreview).toBe('ok');
    expectNormalizedItemsValid([
      ...started,
      ...running,
      ...pollStarted,
      ...completed,
      ...replayStarted,
      replayed!
    ]);
  });

  it('projects structured Todo state into the shared task-list protocol item', () => {
    const [taskList] = new MarAgentConversationNormalizer().normalize({
      ...base,
      type: 'todo.updated',
      revision: 1,
      items: [
        { id: 'one', step: 'Inspect', status: 'pending' },
        { id: 'two', step: 'Implement', status: 'in_progress' },
        { id: 'three', step: 'Verify', status: 'completed' }
      ]
    });

    expect(taskList).toMatchObject({
      itemId: 'mar-agent-todo-list:event',
      kind: 'todo_list',
      status: 'COMPLETED',
      payload: {
        items: [
          { id: 'one', text: 'Inspect', status: 'PENDING' },
          { id: 'two', text: 'Implement', status: 'IN_PROGRESS' },
          { id: 'three', text: 'Verify', status: 'COMPLETED' }
        ]
      }
    });
    expectNormalizedItemsValid(taskList === undefined ? [] : [taskList]);
  });

  it('projects each Todo write into an independent task-list card by event identity', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const first = normalizer.normalize({
      ...base,
      eventId: 'todo-event-1',
      type: 'todo.updated',
      revision: 1,
      items: [{ id: 'one', step: 'Inspect', status: 'in_progress' }]
    });
    const second = normalizer.normalize({
      ...base,
      eventId: 'todo-event-2',
      executionId: 'later-execution',
      type: 'todo.updated',
      revision: 2,
      items: [{ id: 'one', step: 'Inspect', status: 'completed' }]
    });

    expect(first[0]?.itemId).toBe('mar-agent-todo-list:todo-event-1');
    expect(second[0]?.itemId).toBe('mar-agent-todo-list:todo-event-2');
    expect(first[0]?.itemId).not.toBe(second[0]?.itemId);
    expect(first[0]?.merge).toBeUndefined();
    expect(second[0]?.merge).toBeUndefined();
    expectNormalizedItemsValid([...first, ...second]);
  });

  it('keeps apply_patch as a regular tool projection when structured results are absent from old history', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const started = normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'apply_patch',
      callId: 'legacy-patch'
    } as AgentEvent);
    const completed = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'apply_patch',
      callId: 'legacy-patch',
      summary: 'patched'
    } as AgentEvent);

    expect(started[0]?.kind).toBe('tool_call');
    expect(completed[0]).toMatchObject({
      itemId: started[0]?.itemId,
      kind: 'tool_call',
      payload: { outputSummary: 'patched' }
    });
  });

  it('projects file state only from structured apply_patch results and expands move operations', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'apply_patch',
      callId: 'patch-call',
      input: { patch: 'unstable text must not be parsed' }
    });
    const [item] = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'apply_patch',
      callId: 'patch-call',
      summary: 'ignored summary',
      truncated: false,
      data: {
        files: [
          { path: 'added.ts', operation: 'added', addedLines: 1, deletedLines: 0 },
          { path: 'deleted.ts', operation: 'deleted', addedLines: 0, deletedLines: 2 },
          { path: 'unknown.ts', operation: 'unknown' },
          { path: '', operation: 'modified', addedLines: 0, deletedLines: 0 },
          {
            path: 'old.ts',
            targetPath: 'new.ts',
            operation: 'moved',
            addedLines: 0,
            deletedLines: 0
          }
        ]
      }
    } as unknown as AgentEvent);

    expect(item).toMatchObject({
      kind: 'file_change',
      payload: {
        changes: [
          { path: 'added.ts', change: 'ADDED' },
          { path: 'deleted.ts', change: 'DELETED' },
          { path: 'unknown.ts', change: 'MODIFIED' },
          { path: 'old.ts', change: 'DELETED' },
          { path: 'new.ts', change: 'ADDED' }
        ]
      }
    });
    expectNormalizedItemsValid(item === undefined ? [] : [item]);
  });

  it('registers image attachments only after Node registration and reuses the same reference for realtime and history', () => {
    const started: AgentEvent = {
      ...base,
      type: 'tool.started',
      toolName: 'codex_image_gen',
      callId: 'image-call',
      input: { prompt: 'A lighthouse in a storm.' }
    };
    const completed: AgentEvent = {
      ...base,
      eventId: 'image-completed',
      sequence: 2,
      type: 'tool.completed',
      toolName: 'codex_image_gen',
      callId: 'image-call',
      summary: '/private/session/generated_images/image-call.png',
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
    };
    const normalized = new MarAgentConversationNormalizer();
    const [startedItem] = normalized.normalize(started);
    expect(startedItem).toMatchObject({
      kind: 'tool_call',
      status: 'IN_PROGRESS',
      payload: { toolCategory: 'IMAGE_GENERATION' }
    });
    const [pending] = normalized.normalize(completed);
    expect(pending).toMatchObject({
      kind: 'tool_call',
      payload: { toolCategory: 'IMAGE_GENERATION' },
      generatedImages: [
        {
          name: 'image-call.png',
          mime: 'image/png',
          byteSize: 68,
          fileName: 'image-call.png'
        }
      ]
    });
    expect(pending?.payload).not.toHaveProperty('attachments');
    expect(JSON.stringify(pending?.payload)).not.toContain('/private/session');

    const attachments = [
      {
        name: 'image-call.png',
        mime: 'image/png',
        runId: 'native-history:node-session',
        imageIndex: 0
      }
    ];
    const registerGeneratedImages = vi.fn(() => attachments);
    const emitItem = vi.fn();
    const controller = new MarAgentManagedRunController(new MarAgentRunner('/node/home'), {
      ...executionActivity(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit: vi.fn(),
      emitItem,
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn(),
      registerGeneratedImages
    });
    const project = (event: AgentEvent) =>
      (
        controller as unknown as {
          project(runId: string, event: AgentEvent): void;
        }
      ).project('managed-run', event);
    project(started);
    project(completed);

    expect(registerGeneratedImages).toHaveBeenCalledWith('managed-run', 'session', [
      {
        name: 'image-call.png',
        mime: 'image/png',
        byteSize: 68,
        fileName: 'image-call.png'
      }
    ]);
    const realtimePayload = emitItem.mock.calls.at(-1)?.[1].payload;
    expect(realtimePayload).toMatchObject({
      toolCategory: 'IMAGE_GENERATION',
      attachments
    });
    expect(JSON.stringify(realtimePayload)).not.toContain('/node/home');

    const historyRegistration = vi.fn(() => attachments);
    const historyItem = projectMarAgentHistory(
      {
        id: 'node-session',
        runner: 'mar-agent',
        externalSessionId: 'session',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      [started, completed].map((event) => ({
        kind: 'event' as const,
        sequence: event.sequence,
        event
      })),
      { registerGeneratedImages: historyRegistration }
    )[0]?.items[0];

    expect(historyRegistration).toHaveBeenCalledWith('session', [
      {
        name: 'image-call.png',
        mime: 'image/png',
        byteSize: 68,
        fileName: 'image-call.png'
      }
    ]);
    expect(historyItem?.payload).toEqual(realtimePayload);
  });

  it('allows only the current MAR Session generated_images directory into the native image root', () => {
    const runner = new MarAgentRunner('/node/home');
    const session = {
      id: 'node-session',
      runner: 'mar-agent',
      cwd: '/workspace',
      externalSessionId: 'native-session'
    } as NodeAgentSession;
    const attachments = [
      {
        name: 'image-call.png',
        mime: 'image/png',
        runId: 'native-history:node-session',
        imageIndex: 0
      }
    ];
    const register = vi.fn(() => attachments);
    runner.setGeneratedImageRegistrar(register);

    expect(runner.nativeImageRoots(session)).toEqual([
      '/workspace',
      '/node/home/.mar/agent/sessions/native-session/generated_images'
    ]);
    expect(
      runner.registerGeneratedImages(session, 'native-session', [
        {
          name: 'image-call.png',
          mime: 'image/png',
          byteSize: 68,
          fileName: 'image-call.png'
        }
      ])
    ).toEqual(attachments);
    expect(register).toHaveBeenCalledWith(session, [
      {
        sourceId: 'native-session:image-call.png',
        name: 'image-call.png',
        mime: 'image/png',
        localPath: '/node/home/.mar/agent/sessions/native-session/generated_images/image-call.png'
      }
    ]);
    expect(
      runner.registerGeneratedImages(session, 'different-session', [
        {
          name: 'image-call.png',
          mime: 'image/png',
          byteSize: 68,
          fileName: 'image-call.png'
        }
      ])
    ).toEqual([]);
  });

  it('reuses the MAR Normalizer for history and produces the same exec projection as realtime events', () => {
    const started: AgentEvent = {
      ...base,
      type: 'tool.started',
      toolName: 'exec',
      callId: 'command-call',
      input: { action: 'start', command: 'pwd' }
    };
    const result = {
      status: 'completed' as const,
      stdout: '/workspace',
      stderr: '',
      exitCode: 0,
      truncated: false,
      stdoutBytes: 10,
      stderrBytes: 0,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    };
    const completed: AgentEvent = {
      ...base,
      eventId: 'completed',
      sequence: 2,
      type: 'tool.completed',
      toolName: 'exec',
      callId: 'command-call',
      summary: JSON.stringify(result),
      truncated: false,
      data: {
        status: result.status,
        exitCode: result.exitCode,
        truncated: result.truncated,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        stdoutDroppedBytes: result.stdoutDroppedBytes,
        stderrDroppedBytes: result.stderrDroppedBytes
      }
    };
    const realtime = new MarAgentConversationNormalizer();
    const realtimeItem = [started, { ...completed, data: result }]
      .flatMap((event) => realtime.normalize(event))
      .at(-1);
    const historyItem = projectMarAgentHistory(
      {
        id: 'session',
        runner: 'mar-agent',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession,
      [started, completed].map((event) => ({
        kind: 'event' as const,
        sequence: event.sequence,
        event
      }))
    )[0]?.items[0];

    expect(historyItem).toMatchObject({
      id: realtimeItem?.itemId,
      kind: 'command_execution',
      status: 'COMPLETED',
      payload: {
        command: 'pwd',
        outputPreview: '/workspace',
        exitCode: 0,
        truncated: false
      }
    });
  });
});

function runtimeTicketModel(
  runtimeScopeId: string,
  nonce: string
): MarAgentRuntimeModelConfiguration {
  const ticket: RuntimeCredentialTicket = {
    userId: 1,
    credentialId: 'credential-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    sessionId: 'native-session',
    runtimeScopeId,
    allowedModelIds: ['coding'],
    issuedAt: 1_000,
    expiresAt: 3_601_000,
    nonce,
    signature: 'a'.repeat(64)
  };
  return {
    id: 'coding',
    name: 'Coding',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://models.example.test/v1',
    credential: {
      type: 'RUNTIME_TICKET',
      credentialId: 'credential-1',
      ticket
    },
    modelId: 'gpt-5.6',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  };
}

function expectNormalizedItemsValid(
  items: readonly ReturnType<MarAgentConversationNormalizer['normalize']>[number][]
): void {
  for (const item of items)
    expect(
      conversationItemSchema.safeParse({
        id: item.itemId,
        sessionId: 'session',
        turnId: 'turn',
        runId: 'run',
        parentItemId: null,
        sourceSequence: 1,
        revision: 0,
        status: item.status,
        startedAt: 1,
        completedAt: item.status === 'IN_PROGRESS' ? null : 2,
        kind: item.kind,
        payload: item.payload
      }).success
    ).toBe(true);
}
