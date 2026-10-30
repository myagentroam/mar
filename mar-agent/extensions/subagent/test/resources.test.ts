import { expect, it, vi } from 'vitest';
import { AgentError, type Agent, type AgentLiveSession } from '@myagentroam/agent';
import type {
  ExtensionSessionContextProvider,
  SessionExtensionContext
} from '@myagentroam/agent/extensions';
import { createSubagentExtension } from '../src/index.js';
import { childResources } from '../src/resources.js';

it('projects all live children before at most sixteen recent terminal children', async () => {
  const summaries = Array.from({ length: 20 }, (_, index) => ({
    id: `done-${index}`,
    title: `Finished ${index}`,
    workspace: 'work',
    source: { parentSessionId: 'parent' }
  }));
  const active = {
    id: 'active-old',
    workspace: 'work',
    source: { parentSessionId: 'parent' },
    subscribe: () => ({ activeExecutionId: 'live-execution', unsubscribe() {} })
  } as AgentLiveSession;
  let provider!: ExtensionSessionContextProvider;
  const agent = {
    observeSessionExecutions: () => ({ sessions: [active], unsubscribe() {} }),
    getSession: async (id: string) =>
      id === 'parent'
        ? { id, workspace: 'work' }
        : { id, title: 'Active task', workspace: 'work', source: { parentSessionId: 'parent' } },
    listSessions: async () => ({ sessions: summaries }),
    sessionHistory: async (id: string) => ({
      entries: [
        { kind: 'event', event: { type: 'execution.completed', executionId: `${id}-execution` } }
      ]
    })
  } as unknown as Agent;
  const context = {
    sessionId: 'parent',
    services: {
      provide(_key: unknown, value: typeof provider) {
        if (value.resources) provider = value;
      }
    },
    tools: { register() {} },
    hooks: { intercept() {} }
  } as unknown as SessionExtensionContext;
  const dispose = (await createSubagentExtension({ agent: () => agent }).attachSession!(
    context
  )) as () => Promise<void>;
  try {
    const [resource] = await provider.resources!(new AbortController().signal);
    const parsed = JSON.parse(resource!.slice(resource!.indexOf('{'))) as {
      children: Array<{ agentId: string; status: string }>;
    };
    expect(parsed.children).toHaveLength(17);
    expect(parsed.children[0]).toMatchObject({ agentId: 'active-old', status: 'running' });
    expect(parsed.children.slice(1).map((child) => child.agentId)).toEqual(
      summaries.slice(0, 16).map((child) => child.id)
    );
    expect(parsed.children.slice(1).every((child) => child.status === 'completed')).toBe(true);
  } finally {
    await dispose();
  }
});

it('keeps a newly registered child and does not mistake a foreign lock for a terminal', async () => {
  const source = {
    type: 'subagent',
    parentSessionId: 'parent',
    rootSessionId: 'parent',
    description: 'Child',
    role: 'general-purpose'
  } as const;
  const snapshot = { activeExecutionId: 'running', unsubscribe: vi.fn() };
  const live = { id: 'new', workspace: '/work', source, subscribe: () => snapshot };
  let listener!: (session: typeof live) => void;
  const parent = { id: 'parent', workspace: '/work', source: { type: 'user' }, title: 'Parent' };
  const agent = {
    getSession: vi.fn(async (id: string) =>
      id === 'parent' ? parent : { ...live, title: 'Child' }
    ),
    observeSessionExecutions: (notify: typeof listener) => {
      listener = notify;
      return { sessions: [], unsubscribe: vi.fn() };
    },
    listSessions: async () => {
      listener(live);
      return { sessions: [{ ...live, id: 'foreign', title: 'Foreign' }] };
    },
    sessionHistory: async () => ({
      entries: [
        {
          kind: 'event',
          event: {
            type: 'execution.started',
            executionId: 'foreign-execution'
          }
        }
      ]
    }),
    sessionExecutionWasInterrupted: async () => {
      throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Locked');
    }
  } as unknown as Agent;
  const resources = await childResources(
    agent,
    'parent',
    new AbortController().signal,
    () => false
  );
  const projection = JSON.parse(resources[0]!.slice(resources[0]!.indexOf('{'))) as {
    children: Array<{ agentId: string; status: string }>;
    truncated: boolean;
  };
  expect(projection.children).toEqual([
    expect.objectContaining({ agentId: 'new', status: 'running' })
  ]);
  expect(projection.truncated).toBe(true);
});

it('fills the terminal budget after a discovered child disappears', async () => {
  const children = Array.from({ length: 17 }, (_, index) => ({
    id: `child-${index}`,
    workspace: '/work',
    title: `Child ${index}`,
    source: { type: 'user', parentSessionId: 'parent' }
  }));
  const agent = {
    getSession: async () => ({ id: 'parent', workspace: '/work' }),
    observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
    listSessions: async () => ({ sessions: children }),
    sessionHistory: async (id: string) => {
      if (id === 'child-0') throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Deleted');
      return {
        entries: [{ kind: 'event', event: { type: 'execution.completed', executionId: id } }]
      };
    }
  } as unknown as Agent;
  const resources = await childResources(
    agent,
    'parent',
    new AbortController().signal,
    () => false
  );
  const projection = JSON.parse(resources[0]!.slice(resources[0]!.indexOf('{'))) as {
    children: Array<{ agentId: string }>;
  };
  expect(projection.children.map((child) => child.agentId)).toEqual(
    children.slice(1).map((child) => child.id)
  );
});

it('propagates a genuine history failure and permits a later successful resource read', async () => {
  const child = {
    id: 'child',
    workspace: '/work',
    title: 'Child',
    source: { type: 'user', parentSessionId: 'parent' }
  };
  const failure = new Error('History unavailable');
  const sessionHistory = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({
      entries: [{ kind: 'event', event: { type: 'execution.completed', executionId: 'execution' } }]
    });
  const unsubscribe = vi.fn();
  const agent = {
    getSession: async () => ({ id: 'parent', workspace: '/work' }),
    observeSessionExecutions: () => ({ sessions: [], unsubscribe }),
    listSessions: async () => ({ sessions: [child] }),
    sessionHistory
  } as unknown as Agent;
  await expect(
    childResources(agent, 'parent', new AbortController().signal, () => false)
  ).rejects.toBe(failure);
  const [resource] = await childResources(
    agent,
    'parent',
    new AbortController().signal,
    () => false
  );
  expect(JSON.parse(resource!.slice(resource!.indexOf('{')))).toMatchObject({
    children: [{ agentId: 'child', status: 'completed' }]
  });
  expect(sessionHistory).toHaveBeenCalledTimes(2);
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

it('stops a cancelled resource scan before reading the next child', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const history = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { entries: [] };
  });
  const agent = {
    getSession: async () => ({ id: 'parent', workspace: 'work' }),
    observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
    listSessions: async () => ({
      sessions: ['first', 'second'].map((id) => ({
        id,
        workspace: 'work',
        title: id,
        source: { type: 'user', parentSessionId: 'parent' }
      }))
    }),
    sessionHistory: history
  } as unknown as Agent;
  const abort = new AbortController();
  const pending = childResources(agent, 'parent', abort.signal, () => false);
  await entered.promise;
  abort.abort(new Error('Resource scan cancelled'));
  release.resolve();
  await expect(pending).rejects.toThrow('Resource scan cancelled');
  expect(history).toHaveBeenCalledTimes(1);
});
