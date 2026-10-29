import { executionActivity } from './support/execution-activity.js';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SteerResult } from '@myagentroam/agent';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { MarAgentManagedRunController } from '../../src/runner/mar-agent/managed-run-controller.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import type { RunnerSteerInput } from '../../src/runner/contracts.js';
import type { MarAgentRuntimeModelConfiguration } from '../../../packages/protocol/src/index.js';

const entry = {
  kind: 'user' as const,
  recordId: 'canonical-record',
  sequence: 19,
  timestamp: '2026-10-19T00:00:00.000Z',
  sessionId: 'native-session',
  executionId: 'sdk-execution',
  turnId: 'sdk-turn',
  clientMessageId: 'guidance',
  text: 'visible guidance'
};

describe('MAR native steer integration', () => {
  it('binds the Node execution to its SDK target and rejects only incompatible explicit configuration', async () => {
    const release = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const handle = {
      executionId: 'sdk-execution',
      async *[Symbol.asyncIterator]() {
        await release.promise;
        yield* [];
      },
      result: async () => ({
        executionId: 'sdk-execution',
        status: 'completed' as const,
        finalAnswer: 'done'
      }),
      cancel
    };
    const steer = vi.fn(async (): Promise<SteerResult> => ({ status: 'accepted', entry }));
    const session = {
      id: 'native-session',
      run: vi.fn(() => handle),
      plan: vi.fn(() => handle),
      compact: vi.fn(() => handle),
      cancel: vi.fn(),
      steer
    };
    const createAgent = vi.fn(async () => ({
      createSession: vi.fn(async () => session),
      openSession: vi.fn(async () => session),
      listSessions: vi.fn(),
      getSession: vi.fn(async () => ({
        id: session.id,
        title: 'Test',
        workspace: '/workspace',
        source: { type: 'user' as const },
        automaticTitlePending: false
      })),
      setSessionTitle: vi.fn(),
      setSystemInstruction: vi.fn(),
      reconfigureModels: vi.fn(),
      extensionDiagnostics: () => [],
      deleteSession: vi.fn(),
      clearSession: vi.fn(),
      dispose: vi.fn()
    }));
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
    const controller = new MarAgentManagedRunController(new MarAgentRunner(), host, {
      createAgent: createAgent as never,
      modelFactory: { create: () => [] } as never
    });
    const model: MarAgentRuntimeModelConfiguration = {
      id: 'test',
      name: 'Test',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'test' },
      modelId: 'test',
      contextWindowTokens: 10000,
      maxOutputTokens: 1000,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
      hostedWebSearch: false,
      enabled: true
    };
    const run = (controller as unknown as { run(input: unknown): Promise<void> }).run.bind(
      controller
    );
    const running = run({
      runId: 'node-execution',
      sessionId: session.id,
      externalSessionId: session.id,
      input: 'initial',
      cwd: '/workspace',
      model,
      models: [model],
      effort: '',
      access: 'full-access',
      mode: 'run',
      mcpServers: [],
      images: []
    });
    try {
      await vi.waitFor(() => expect(session.run).toHaveBeenCalledOnce());
      const request: RunnerSteerInput = {
        expectedExecutionId: 'node-execution',
        prompt: entry.text,
        modelText: 'model guidance',
        clientMessageId: entry.clientMessageId,
        model: 'test',
        effort: 'low',
        access: 'full-access',
        collaborationMode: 'default',
        images: []
      };
      for (const override of [
        { expectedExecutionId: 'other' },
        { model: 'other' },
        { effort: 'high' },
        { access: 'auto' },
        { collaborationMode: 'plan' as const }
      ])
        expect(await controller.steer({ ...request, ...override })).toEqual({
          status: 'notAccepted'
        });
      expect(steer).not.toHaveBeenCalled();
      expect(await controller.steer(request)).toMatchObject({
        status: 'accepted',
        item: { kind: 'user_message', payload: { text: entry.text } }
      });
      expect(steer).toHaveBeenCalledExactlyOnceWith({
        expectedExecutionId: handle.executionId,
        prompt: entry.text,
        modelText: 'model guidance',
        clientMessageId: entry.clientMessageId,
        images: []
      });
      for (const inherited of [{ model: '' }, { effort: '' }])
        expect(await controller.steer({ ...request, ...inherited })).toMatchObject({
          status: 'accepted'
        });
      expect(steer).toHaveBeenCalledTimes(3);
      expect(cancel).not.toHaveBeenCalled();
      expect(session.run).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await running;
      await controller.dispose();
    }
  });

  it('merges receipt and live echo once and preserves its identity in Catalog history projection', () => {
    const runtime = new NodeRuntimeState(
      () => 'node',
      () => ({
        id: 'workspace',
        path: '/workspace',
        kind: 'DIRECTORY',
        gitSummary: null,
        createdAt: 1,
        updatedAt: 1
      })
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace',
      runner: 'mar-agent',
      cwd: '/workspace'
    });
    const accepted = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'initial',
      content: 'initial'
    });
    const execution = runtime.createExecution(accepted.run.id);
    const normalizer = new MarAgentConversationNormalizer();
    runtime.appendRunEvent({
      runId: execution.id,
      sequence: 1,
      eventType: 'text.delta',
      payload: { itemId: 'stream-answer', text: 'half-' }
    });
    const live = normalizer.normalize({
      ...entry,
      eventId: 'live-event',
      type: 'input.received',
      entry
    } as AgentEvent)[0]!;
    for (const [index, item] of [normalizer.input(entry), live].entries())
      runtime.appendRunEvent({
        runId: execution.id,
        sequence: index + 2,
        eventType: 'conversation.item',
        payload: item
      });
    const turn = runtime.conversationTurnForRun(accepted.run!.id)!;
    expect(turn.items.filter((item) => item.id === live.itemId)).toHaveLength(1);
    expect(turn.items.find((item) => item.kind === 'assistant_message')).toMatchObject({
      status: 'IN_PROGRESS',
      payload: { text: 'half-' }
    });
    runtime.appendRunEvent({
      runId: execution.id,
      sequence: 4,
      eventType: 'text.delta',
      payload: { itemId: 'stream-answer', text: 'rest' }
    });
    expect(
      runtime
        .conversationTurnForRun(accepted.run!.id)!
        .items.filter((item) => item.kind === 'assistant_message')
    ).toMatchObject([{ status: 'IN_PROGRESS', payload: { text: 'half-rest' } }]);
    const history = projectMarAgentHistory(session, [entry])[0]!;
    expect(history.items[0]!.id).toBe(live.itemId);
    expect(history.items[0]!.payload).toMatchObject({
      text: entry.text,
      clientMessageId: entry.clientMessageId
    });
    expect(turn.id).toBe(execution.turnId);
  });
});
