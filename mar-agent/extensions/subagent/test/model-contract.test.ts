import { expect, it, vi } from 'vitest';
import { fromJSONSchema } from 'zod';
import type { Agent, AgentEvent } from '@myagentroam/agent';
import type {
  ExtensionOperationContext,
  SessionExtensionContext
} from '@myagentroam/agent/extensions';
import { registerStart, StartAdmission } from '../src/start.js';
import { registerControlTools } from '../src/control.js';
import { registerQueryTools } from '../src/query.js';
import { registerWait, waitForChild } from '../src/wait.js';
import { SessionObservations } from '../src/observations.js';

type Tool = {
  inputSchema: { properties: Record<string, unknown>; required?: string[] };
  execute(
    input: unknown,
    call: ExtensionOperationContext
  ): Promise<{ data?: unknown; content: string }>;
};

function fixture() {
  const tools = new Map<string, Tool>();
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: Tool & { name: string }) {
        tools.set(tool.name, tool);
      }
    }
  } as unknown as SessionExtensionContext;
  const terminal = {
    type: 'execution.failed',
    executionId: 'execution',
    sessionId: 'child',
    code: 'TEST_FAILURE',
    message: 'Child failed.',
    eventId: 'event',
    sequence: 1,
    timestamp: '2026-11-17T00:00:00Z'
  } as AgentEvent;
  const child = {
    id: 'child',
    workspace: '/workspace',
    source: { parentSessionId: 'parent' },
    subscribe: () => ({
      activeExecutionId: 'execution',
      terminalEvent: terminal,
      unsubscribe: vi.fn()
    })
  };
  const listSessions = vi.fn(async () => ({ sessions: [] }));
  const agent = {
    getSession: async (id: string) =>
      id === 'child' ? child : { workspace: '/workspace', source: {} },
    openSession: async () => child,
    sessionInputReceipt: async () => undefined,
    listSessions
  } as unknown as Agent;
  const observations = new SessionObservations();
  const admission = new StartAdmission();
  registerStart(context, agent, admission);
  registerControlTools(
    context,
    agent,
    observations,
    new Map([['parent', observations]]),
    admission
  );
  registerQueryTools(context, agent);
  registerWait(context, agent, observations);
  return { tools, context, agent, observations, listSessions };
}

it('uses common model parameters while keeping standalone capabilities explicit', () => {
  const test = fixture();
  const start = test.tools.get('agent_start')!.inputSchema;
  expect(start.required).toEqual(['title', 'content']);
  expect(start.properties).toHaveProperty('effort');
  expect(start.properties).not.toHaveProperty('prompt');
  expect(start.properties).not.toHaveProperty('reasoningEffort');
  expect(start.properties).toHaveProperty('role');
  const wait = test.tools.get('agent_wait')!.inputSchema;
  expect(wait.properties).not.toHaveProperty('agentId');
  expect(wait.properties.agentIds).toMatchObject({ maxItems: 8 });
  expect(Object.keys(test.tools.get('agent_stop')!.inputSchema.properties)).toEqual(['agentId']);
  expect(test.tools.get('agent_send')!.inputSchema.properties.delivery).toMatchObject({
    enum: ['append', 'replace', null]
  });
  expect(test.tools.get('agent_list')!.inputSchema.properties.scope).toMatchObject({
    enum: ['children', 'profile', null]
  });
  test.observations.close();
});

it('returns the same bounded agents array in model content and data without native identities', async () => {
  const test = fixture();
  const call = { signal: new AbortController().signal } as ExtensionOperationContext;
  try {
    const model = await test.tools
      .get('agent_wait')!
      .execute({ agentIds: ['child'], waitMs: 0 }, call);
    expect(model.data).toEqual(JSON.parse(model.content));
    expect(model.data).toMatchObject({
      mode: 'any',
      pendingAgentIds: [],
      agents: [
        {
          agentId: 'child',
          status: 'FAILED',
          waitOutcome: 'snapshot',
          errorCode: 'TEST_FAILURE'
        }
      ]
    });
    expect(model.content).not.toContain('executionId');
    const native = await waitForChild(
      test.context,
      test.agent,
      test.observations,
      { agentId: 'child', waitMs: 0 },
      call,
      'native'
    );
    expect(native.data).toMatchObject({
      agentId: 'child',
      executionId: 'execution',
      status: 'failed'
    });
  } finally {
    test.observations.close();
  }
});

it.each([{}, { scope: null, limit: null, cursor: null }])(
  'defaults child discovery to ten for %j without forwarding a cursor',
  async (input) => {
    const test = fixture();
    try {
      const tool = test.tools.get('agent_list')!;
      const parsed = fromJSONSchema(tool.inputSchema).parse(input);
      await tool.execute(parsed, {
        signal: new AbortController().signal
      } as ExtensionOperationContext);
      expect(test.listSessions).toHaveBeenCalledWith({ parentSessionId: 'parent', limit: 10 });
    } finally {
      test.observations.close();
    }
  }
);

it('accepts null for optional start and send parameters but still requires message content', () => {
  const test = fixture();
  try {
    const start = fromJSONSchema(test.tools.get('agent_start')!.inputSchema);
    const send = fromJSONSchema(test.tools.get('agent_send')!.inputSchema);
    const input = {
      title: 'Child',
      content: 'Work',
      description: null,
      role: null,
      modelId: null,
      effort: null
    };
    expect(start.safeParse(input).success).toBe(true);
    expect(start.safeParse({ ...input, content: null }).success).toBe(false);
    expect(send.safeParse({ agentId: 'child', content: 'Work', delivery: null }).success).toBe(
      true
    );
    expect(send.safeParse({ agentId: 'child', content: null, delivery: null }).success).toBe(false);
  } finally {
    test.observations.close();
  }
});
