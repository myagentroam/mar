import { expect, it, vi } from 'vitest';
import type { Agent, ExecutionResult } from '@myagentroam/agent';
import type { SessionExtensionContext } from '@myagentroam/agent/extensions';
import { registerControlTools } from '../src/control.js';
import { registerQueryTools } from '../src/query.js';
import type { SessionObservations } from '../src/observations.js';
import { StartAdmission } from '../src/start.js';

function setup() {
  const completion = Promise.withResolvers<ExecutionResult>();
  const acknowledge = vi.fn();
  let terminal: 'execution.completed' | 'execution.failed' | undefined;
  const child = {
    id: 'child',
    subscribe: () => ({
      activeExecutionId: 'old',
      ...(terminal ? { terminalEvent: { type: terminal, executionId: 'old' } } : {}),
      unsubscribe() {}
    }),
    cancel: vi.fn(async () => {}),
    joinExecution: vi.fn(() => completion.promise),
    steer: vi.fn(async () => ({ status: 'notAccepted' })),
    run: vi.fn(() => ({ executionId: 'new', turnId: 'new-turn' })),
    plan: vi.fn()
  };
  const agent = {
    getSession: async (id: string) => ({
      id,
      workspace: 'work',
      modelId: 'model',
      source: id === 'child' ? { type: 'subagent', parentSessionId: 'parent' } : { type: 'user' }
    }),
    openSession: async () => child,
    observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} })
  } as unknown as Agent;
  const observations = {
    acknowledgement: () => acknowledge,
    capture: () => undefined,
    rememberReceipt: vi.fn()
  } as unknown as SessionObservations;
  const tools = new Map<string, { execute(input: unknown, call: unknown): Promise<unknown> }>();
  const context = {
    sessionId: 'parent',
    models: {
      list: () => [
        {
          id: 'model',
          conversationModel: true,
          subagentModel: true,
          reasoningEfforts: [],
          defaultReasoningEffort: 'medium'
        }
      ]
    },
    tools: {
      register(tool: { name: string; execute(input: unknown, call: unknown): Promise<unknown> }) {
        tools.set(tool.name, tool);
      }
    }
  } as unknown as SessionExtensionContext;
  registerControlTools(context, agent, observations, new Map(), new StartAdmission());
  return {
    child,
    completion,
    acknowledge,
    tools,
    setTerminal: (status: 'completed' | 'failed') => {
      terminal = `execution.${status}`;
    }
  };
}

it('declares the discovery scope as a typed string enum', () => {
  const tools = new Map<string, { inputSchema: { properties: Record<string, unknown> } }>();
  const context = {
    tools: {
      register(tool: { name: string; inputSchema: { properties: Record<string, unknown> } }) {
        tools.set(tool.name, tool);
      }
    }
  } as unknown as SessionExtensionContext;
  registerQueryTools(context, {} as Agent);
  expect(tools.get('agent_list')?.inputSchema.properties.scope).toEqual({
    type: 'string',
    enum: ['children', 'profile']
  });
});

it('does not start replacement or acknowledge updates when the caller aborts during cleanup', async () => {
  const test = setup();
  const abort = new AbortController();
  const operation = test.tools
    .get('agent_send')!
    .execute({ agentId: 'child', content: 'next', delivery: 'replace' }, { signal: abort.signal });
  await vi.waitFor(() => expect(test.child.cancel).toHaveBeenCalledWith('old'));
  abort.abort(new Error('caller stopped waiting'));
  await expect(operation).rejects.toThrow('caller stopped waiting');
  test.completion.resolve({ status: 'cancelled' } as ExecutionResult);
  await Promise.resolve();
  expect(test.child.run).not.toHaveBeenCalled();
  expect(test.acknowledge).not.toHaveBeenCalled();
});

it('does not start a competing execution when an active child rejects append', async () => {
  const test = setup();
  await expect(
    test.tools
      .get('agent_send')!
      .execute({ agentId: 'child', content: 'next' }, { signal: new AbortController().signal })
  ).rejects.toMatchObject({ code: 'MAR_AGENT_SUBAGENT_INPUT_NOT_ACCEPTED' });
  expect(test.child.run).not.toHaveBeenCalled();
  expect(test.child.cancel).not.toHaveBeenCalled();
  expect(test.acknowledge).not.toHaveBeenCalled();
});

it('waits for a failed opening to settle before starting its replacement', async () => {
  const test = setup();
  const operation = test.tools
    .get('agent_send')!
    .execute(
      { agentId: 'child', content: 'next', delivery: 'replace' },
      { signal: new AbortController().signal }
    );
  await vi.waitFor(() => expect(test.child.cancel).toHaveBeenCalledWith('old'));
  expect(test.child.run).not.toHaveBeenCalled();
  test.completion.resolve({ status: 'failed', executionId: 'old' } as ExecutionResult);
  await expect(operation).resolves.toMatchObject({
    data: { delivery: 'started', executionId: 'new' }
  });
  expect(test.child.run).toHaveBeenCalledOnce();
  expect(test.acknowledge).toHaveBeenCalledOnce();
});

it.each(['completed', 'failed'] as const)(
  'joins a committed %s execution before starting the successor without cancelling it again',
  async (status) => {
    const test = setup();
    test.setTerminal(status);
    const operation = test.tools
      .get('agent_send')!
      .execute({ agentId: 'child', content: 'next' }, { signal: new AbortController().signal });
    await vi.waitFor(() => expect(test.child.joinExecution).toHaveBeenCalledWith('old'));
    expect(test.child.run).not.toHaveBeenCalled();
    expect(test.child.cancel).not.toHaveBeenCalled();
    test.completion.resolve({ status } as ExecutionResult);
    await expect(operation).resolves.toMatchObject({
      data: { delivery: 'started', executionId: 'new' }
    });
    expect(test.child.run).toHaveBeenCalledOnce();
    expect(test.acknowledge).toHaveBeenCalledOnce();
  }
);
