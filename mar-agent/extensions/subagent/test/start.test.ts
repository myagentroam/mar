import { expect, it, vi } from 'vitest';
import type { Agent } from '@myagentroam/agent';
import type { SessionExtensionContext } from '@myagentroam/agent/extensions';
import { registerStart, StartAdmission } from '../src/start.js';

function setup() {
  const controller = new AbortController();
  const input = {
    title: 'Child',
    description: 'Child',
    content: 'Do work',
    role: 'general-purpose'
  };
  const model = {
    id: 'model',
    conversationModel: true,
    subagentModel: true,
    reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: undefined
  };
  const run = vi.fn(() => ({
    executionId: 'child-execution',
    result: async () => ({ status: 'completed' })
  }));
  const createSession = vi.fn(async () => ({ id: 'child', run, plan: run }));
  const agent = {
    getSession: async () => ({ id: 'parent', workspace: '/workspace', source: { type: 'user' } }),
    observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
    createSession
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  const context = {
    sessionId: 'parent',
    session: { captureRequest: async () => ({ request: { modelId: 'model' } }) },
    models: { list: () => [model] },
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  registerStart(context, agent, new StartAdmission());
  const call = {
    signal: controller.signal,
    executionId: 'parent-execution',
    operationId: 'operation'
  };
  return { execute, input, call, controller, createSession, run, model };
}

it('maps content and effort to the native request and defaults only the standalone role', async () => {
  const test = setup();
  const { role: _role, ...input } = test.input;
  const result = await test.execute({ ...input, effort: 'high' }, test.call);
  expect(result.data).toEqual({
    agentId: 'child',
    start: { status: 'accepted', executionStatus: 'RUNNING' }
  });
  expect(test.run).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: expect.stringContaining('Do work'),
      modelId: 'model',
      reasoningEffort: 'high'
    })
  );
  expect(test.createSession).toHaveBeenCalledWith(
    expect.objectContaining({ source: expect.objectContaining({ role: 'general-purpose' }) })
  );
});

it.each([undefined, '', '   '])(
  'rejects an absent or blank title before child creation: %s',
  async (title) => {
    const test = setup();
    await expect(test.execute({ ...test.input, title }, test.call)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    expect(test.createSession).not.toHaveBeenCalled();
    expect(test.run).not.toHaveBeenCalled();
  }
);

it('rejects a cancelled admission before creating a child', async () => {
  const test = setup();
  test.controller.abort(new Error('cancelled before create'));
  await expect(test.execute(test.input, test.call)).rejects.toThrow('cancelled before create');
  expect(test.createSession).not.toHaveBeenCalled();
  expect(test.run).not.toHaveBeenCalled();
});

it('reports the real unstarted child when cancellation races with creation', async () => {
  const test = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  test.createSession.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { id: 'child', run: test.run, plan: test.run };
  });
  const pending = test.execute(test.input, test.call);
  await entered.promise;
  test.controller.abort(new Error('cancelled during create'));
  release.resolve();
  expect((await pending).data).toMatchObject({
    agentId: 'child',
    start: { status: 'failed', code: 'MAR_AGENT_SUBAGENT_START_FAILED' }
  });
  expect(test.run).not.toHaveBeenCalled();
});

it('revalidates child model eligibility after creation and does not launch an ineligible child', async () => {
  const test = setup();
  test.createSession.mockImplementation(async () => {
    test.model.subagentModel = false;
    return { id: 'child', run: test.run, plan: test.run };
  });
  expect((await test.execute(test.input, test.call)).data).toMatchObject({
    agentId: 'child',
    start: { status: 'failed', code: 'MAR_AGENT_MODEL_DISABLED' }
  });
  expect(test.run).not.toHaveBeenCalled();
});
