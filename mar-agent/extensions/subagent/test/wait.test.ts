import { expect, it, vi } from 'vitest';
import { AgentError, type Agent, type AgentEvent, type AgentSession } from '@myagentroam/agent';
import type {
  ExtensionOperationContext,
  SessionExtensionContext
} from '@myagentroam/agent/extensions';
import { SessionObservations } from '../src/observations.js';
import { registerWait, waitForChild } from '../src/wait.js';

function setup(full = false) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const session = {
    id: 'child',
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return {
        activeExecutionId: 'execution',
        unsubscribe: () => {
          listeners.delete(listener);
        }
      };
    }
  } as AgentSession;
  const summaries = {
    parent: { id: 'parent', workspace: '/workspace', source: { type: 'user' } },
    child: {
      id: 'child',
      workspace: '/workspace',
      source: { type: 'user', parentSessionId: 'parent' }
    }
  };
  const agent = {
    sessionInputReceipt: async () => undefined,
    getSession: async (id: keyof typeof summaries) => summaries[id],
    openSession: async () => session
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  const observations = new SessionObservations(full);
  observations.observe(session);
  registerWait(context, agent, observations);
  const emit = (type: AgentEvent['type'], details: Record<string, unknown> = {}) => {
    const event = {
      type,
      text: 'progress',
      itemId: 'item',
      phase: 'commentary',
      ...details,
      eventId: 'event',
      sequence: 1,
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: 'child',
      executionId: 'execution'
    } as AgentEvent;
    for (const listener of [...listeners]) listener(event);
  };
  return { execute, observations, listeners, emit, agent, context };
}

it('returns the latest public message to a native progress waiter without terminal details', async () => {
  const test = setup(true);
  const pending = waitForChild(
    test.context,
    test.agent,
    test.observations,
    { agentId: 'child', waitFor: 'message', waitMs: 1000 },
    { signal: new AbortController().signal } as ExtensionOperationContext,
    'native'
  );
  await vi.waitFor(() => expect(test.listeners.size).toBe(2));
  test.emit('message.completed', { phase: 'commentary', text: 'progress' });
  expect((await pending).data).toMatchObject({
    waitOutcome: 'message',
    latestMessage: { phase: 'commentary', text: 'progress' },
    latestActivity: { kind: 'message', phase: 'commentary' }
  });
  test.observations.close();
});

it('selects the newest surviving creation for a cold default wait, not the most active child', async () => {
  const summary = (id: string, createdAt: string) => ({
    id,
    createdAt,
    workspace: '/workspace',
    title: id,
    source: { type: 'user', parentSessionId: 'parent' }
  });
  const old = summary('old-active', '2026-01-01');
  const deleted = summary('deleted', '2026-01-03');
  const newest = summary('newest', '2026-01-02');
  const session = {
    id: newest.id,
    subscribe: () => ({ unsubscribe() {} })
  } as unknown as AgentSession;
  const listSessions = vi.fn(async (input: { cursor?: string }) =>
    input.cursor ? { sessions: [newest] } : { sessions: [old, deleted], nextCursor: 'second' }
  );
  const agent = {
    observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} }),
    listSessions,
    getSession: async (id: string) => {
      if (id === 'parent') return { id, workspace: '/workspace', source: { type: 'user' } };
      if (id === deleted.id) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Deleted');
      return id === newest.id ? newest : old;
    },
    openSession: async () => session,
    sessionHistory: async () => ({
      entries: [
        {
          kind: 'event',
          event: {
            type: 'execution.completed',
            executionId: 'execution'
          }
        }
      ]
    }),
    sessionInputReceipt: async () => undefined
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  const observations = new SessionObservations();
  registerWait(context, agent, observations);
  expect(
    (await execute({ waitMs: 0 }, { signal: new AbortController().signal })).data
  ).toMatchObject({ agentId: 'newest', status: 'completed' });
  expect(listSessions).toHaveBeenCalledTimes(2);
  await expect(
    execute({ agentId: 'deleted', waitMs: 0 }, { signal: new AbortController().signal })
  ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_NOT_FOUND' });
  observations.close();
});

it('retains a fixed terminal fact even if another consumer acknowledges the event', async () => {
  const test = setup();
  const consume = () => {
    test.observations.acknowledgement('child')();
    test.listeners.delete(consume);
  };
  test.listeners.add(consume);
  const result = test.execute({ agentId: 'child' }, { signal: new AbortController().signal });
  await vi.waitFor(() => expect(test.listeners.size).toBe(3));
  const permissionStop = {
    action: 'ask',
    reason: 'Confirm action.',
    source: {
      sessionId: 'child',
      executionId: 'execution',
      callId: 'call',
      toolName: 'effect'
    }
  };
  test.emit('execution.completed', { permissionStop });
  expect((await result).data).toMatchObject({
    status: 'completed',
    waitOutcome: 'completion',
    permissionStop
  });
  expect(test.listeners.size).toBe(0);
  test.observations.close();
});

it('returns the owner receipt without consuming unread updates in a zero snapshot', async () => {
  const test = setup();
  test.observations.rememberReceipt('child', {
    clientMessageId: 'message',
    executionId: 'execution'
  });
  test.emit('message.completed');
  const facts = {
    clientMessageId: 'message',
    executionId: 'execution',
    turnId: 'turn',
    status: 'accepted' as const
  };
  const listeners = new Set<(event: AgentEvent) => void>();
  const session = {
    id: 'child',
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return { activeExecutionId: 'execution', unsubscribe: () => listeners.delete(listener) };
    }
  } as unknown as AgentSession;
  const agent = {
    getSession: async (id: string) => ({
      id,
      workspace: '/workspace',
      source: id === 'child' ? { type: 'user', parentSessionId: 'parent' } : { type: 'user' }
    }),
    openSession: async () => session,
    sessionInputReceipt: vi.fn(async () => facts)
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  registerWait(context, agent, test.observations);
  expect(
    (await execute({ agentId: 'child', waitMs: 0 }, { signal: new AbortController().signal })).data
  ).toMatchObject({ receipt: facts });
  expect(agent.sessionInputReceipt).toHaveBeenCalledWith('child', {
    clientMessageId: 'message',
    executionId: 'execution'
  });
  expect(test.observations.capture('child', 'execution')?.updates).toHaveLength(1);
});

function setupReceiptWait(executionId: string) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const session = {
    id: 'child',
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return { activeExecutionId: executionId, unsubscribe: () => listeners.delete(listener) };
    }
  } as unknown as AgentSession;
  const sessionInputReceipt = vi.fn();
  const agent = {
    getSession: async (id: string) => ({
      id,
      workspace: '/workspace',
      source: id === 'child' ? { type: 'user', parentSessionId: 'parent' } : { type: 'user' }
    }),
    openSession: async () => session,
    sessionInputReceipt
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  const observations = new SessionObservations();
  observations.observe(session);
  registerWait(context, agent, observations);
  const emit = (type: AgentEvent['type'], details: Record<string, unknown> = {}) => {
    const event = {
      type,
      eventId: 'event',
      sequence: 1,
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: 'child',
      executionId,
      ...details
    } as AgentEvent;
    for (const listener of [...listeners]) listener(event);
  };
  return { execute, observations, listeners, sessionInputReceipt, emit };
}

it('keeps the final Turn distinct from a receipt accepted in A and applied in B', async () => {
  const test = setupReceiptWait('execution-b');
  const receipt = {
    clientMessageId: 'message',
    executionId: 'execution-a',
    turnId: 'turn-a',
    status: 'applied',
    appliedExecutionId: 'execution-b',
    appliedTurnId: 'turn-b'
  };
  test.observations.rememberReceipt('child', {
    clientMessageId: 'message',
    executionId: 'execution-a'
  });
  test.sessionInputReceipt.mockResolvedValue(receipt);
  const waiting = test.execute({ agentId: 'child' }, { signal: new AbortController().signal });
  await vi.waitFor(() => expect(test.listeners.size).toBe(2));
  test.emit('message.completed', { phase: 'final_answer', text: 'result B', turnId: 'turn-b' });
  test.emit('execution.completed');
  expect((await waiting).data).toMatchObject({
    executionId: 'execution-b',
    summary: 'result B',
    turnId: 'turn-b',
    receipt
  });
  test.observations.close();
});

it('pins the receipt before a later send while an older Execution is being waited on', async () => {
  const test = setupReceiptWait('execution-a');
  const oldReceipt = {
    clientMessageId: 'old-message',
    executionId: 'execution-a',
    turnId: 'turn-a',
    status: 'accepted'
  };
  test.observations.rememberReceipt('child', {
    clientMessageId: 'old-message',
    executionId: 'execution-a'
  });
  test.sessionInputReceipt.mockResolvedValue(oldReceipt);
  const waiting = test.execute({ agentId: 'child' }, { signal: new AbortController().signal });
  await vi.waitFor(() => expect(test.listeners.size).toBe(2));
  test.observations.rememberReceipt('child', {
    clientMessageId: 'new-message',
    executionId: 'execution-b'
  });
  test.emit('message.completed', { phase: 'final_answer', text: 'result A', turnId: 'turn-a' });
  test.emit('execution.completed');
  expect((await waiting).data).toMatchObject({
    executionId: 'execution-a',
    summary: 'result A',
    turnId: 'turn-a',
    receipt: oldReceipt
  });
  expect(test.sessionInputReceipt).toHaveBeenCalledWith('child', {
    clientMessageId: 'old-message',
    executionId: 'execution-a'
  });
  test.observations.close();
});

it('does not consume a message when a completion wait is aborted', async () => {
  const test = setup();
  test.emit('message.completed');
  const controller = new AbortController();
  const result = test.execute({ agentId: 'child' }, { signal: controller.signal });
  await vi.waitFor(() => expect(test.listeners.size).toBe(2));
  controller.abort(new Error('cancelled wait'));
  await expect(result).rejects.toThrow('cancelled wait');
  expect(test.observations.capture('child', 'execution')?.updates).toEqual([
    { kind: 'message', value: 'progress' }
  ]);
  expect(test.listeners.size).toBe(1);
  test.observations.close();
});

it('retains the failure code when another consumer acknowledges the terminal event', async () => {
  const test = setup();
  const consume = () => {
    test.observations.acknowledgement('child')();
    test.listeners.delete(consume);
  };
  test.listeners.add(consume);
  const result = test.execute({ agentId: 'child' }, { signal: new AbortController().signal });
  await vi.waitFor(() => expect(test.listeners.size).toBe(3));
  test.emit('execution.failed', { code: 'MODEL_UNAVAILABLE', message: 'Model failed.' });
  expect((await result).data).toMatchObject({
    status: 'failed',
    errorCode: 'MODEL_UNAVAILABLE',
    errorMessage: 'Model failed.'
  });
  test.observations.close();
});

function groupSetup() {
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  const active = new Map([
    ['a', 'a-first'],
    ['b', 'b-first']
  ]);
  const sessions = new Map(
    ['a', 'b'].map((id) => {
      const registered = new Set<(event: AgentEvent) => void>();
      listeners.set(id, registered);
      return [
        id,
        {
          id,
          subscribe(listener: (event: AgentEvent) => void) {
            registered.add(listener);
            return {
              activeExecutionId: active.get(id),
              unsubscribe: () => {
                registered.delete(listener);
              }
            };
          }
        } as AgentSession
      ];
    })
  );
  const agent = {
    sessionInputReceipt: async () => undefined,
    getSession: async (id: string) => ({
      id,
      workspace: '/workspace',
      source: id === 'parent' ? { type: 'user' } : { type: 'user', parentSessionId: 'parent' }
    }),
    openSession: async (id: string) => sessions.get(id)!
  } as unknown as Agent;
  let execute!: (
    input: object,
    call: object
  ) => Promise<{ data: Record<string, unknown>; content: string }>;
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  const observations = new SessionObservations();
  for (const session of sessions.values()) observations.observe(session);
  registerWait(context, agent, observations);
  const emit = (id: string, type: AgentEvent['type'], executionId = active.get(id)!) => {
    const event = {
      type,
      text: `${id}-progress`,
      itemId: 'item',
      phase: 'commentary',
      eventId: 'event',
      sequence: 1,
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: id,
      executionId
    } as AgentEvent;
    for (const listener of [...listeners.get(id)!]) listener(event);
  };
  return { execute, observations, sessions, listeners, active, emit };
}

it('returns parseable bounded group content while retaining the full native result', async () => {
  const test = groupSetup();
  const waiting = test.execute(
    { agentIds: ['a', 'b'], mode: 'all' },
    { signal: new AbortController().signal }
  );
  await vi.waitFor(() => expect(test.listeners.get('b')?.size).toBe(2));
  for (const id of ['a', 'b']) {
    const send = (event: Partial<AgentEvent>) => {
      for (const listener of [...test.listeners.get(id)!])
        listener({
          sessionId: id,
          executionId: `${id}-first`,
          eventId: 'event',
          sequence: 1,
          timestamp: '2026-01-01T00:00:00Z',
          ...event
        } as AgentEvent);
    };
    send({ type: 'message.completed', phase: 'final_answer', text: 'x'.repeat(16000) });
    send({
      type: 'tool.completed',
      toolName: 'apply_patch',
      data: {
        files: Array.from({ length: 200 }, (_, index) => ({ path: `${index}-${'y'.repeat(100)}` }))
      }
    });
    send({ type: 'execution.completed' });
  }
  const result = await waiting;
  const model = JSON.parse(result.content);
  expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThan(40000);
  expect(model.agents).toHaveLength(2);
  expect(
    model.agents.every((agent: { changedFilesTruncated?: boolean }) => agent.changedFilesTruncated)
  ).toBe(true);
  const native = result.data.agents as Array<{ summary: string; changedFiles: string[] }>;
  expect(
    native.every((agent) => agent.summary.length === 16000 && agent.changedFiles.length === 200)
  ).toBe(true);
  test.observations.close();
});

it('keeps an all-wait pinned to original Executions and leaves later progress unread', async () => {
  const test = groupSetup();
  const result = test.execute(
    { agentIds: ['a', 'b'], mode: 'all' },
    { signal: new AbortController().signal }
  );
  await vi.waitFor(() => expect(test.listeners.get('b')?.size).toBe(2));
  test.emit('a', 'execution.completed', 'a-first');
  test.active.set('a', 'a-second');
  test.observations.observe(test.sessions.get('a')!);
  test.emit('a', 'message.completed', 'a-second');
  test.emit('b', 'execution.cancelled', 'b-first');
  expect((await result).data).toMatchObject({
    mode: 'all',
    waitFor: 'completion',
    waitOutcome: 'completion',
    agents: [
      { agentId: 'a', executionId: 'a-first', status: 'completed' },
      { agentId: 'b', executionId: 'b-first', status: 'cancelled' }
    ],
    pendingAgentIds: []
  });
  expect(test.observations.capture('a', 'a-second')?.updates).toEqual([
    { kind: 'message', value: 'a-progress' }
  ]);
  test.observations.close();
});

it('retains the fixed live terminal summary and files when another consumer acknowledges first', async () => {
  const test = groupSetup();
  const consume = (event: AgentEvent) => {
    if (event.type !== 'execution.completed') return;
    test.observations.acknowledgement('a')();
    test.listeners.get('a')?.delete(consume);
  };
  test.listeners.get('a')!.add(consume);
  const waiting = test.execute({ agentId: 'a' }, { signal: new AbortController().signal });
  await vi.waitFor(() => expect(test.listeners.get('a')?.size).toBe(3));
  const emit = (event: Partial<AgentEvent>) => {
    for (const listener of [...test.listeners.get('a')!])
      listener({
        sessionId: 'a',
        executionId: 'a-first',
        eventId: 'event',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00Z',
        ...event
      } as AgentEvent);
  };
  emit({
    type: 'message.completed',
    phase: 'final_answer',
    text: 'A complete answer',
    turnId: 'turn'
  });
  emit({
    type: 'tool.completed',
    toolName: 'apply_patch',
    data: { files: [{ path: 'changed.ts' }] }
  });
  emit({ type: 'execution.completed' });
  expect((await waiting).data).toMatchObject({
    status: 'completed',
    waitOutcome: 'completion',
    summary: 'A complete answer',
    turnId: 'turn',
    changedFiles: ['changed.ts']
  });
  test.observations.close();
});

it('preserves unread group progress for a zero snapshot and an aborted all-wait', async () => {
  const test = groupSetup();
  test.emit('a', 'message.completed', 'a-first');
  const snapshot = await test.execute(
    { agentIds: ['a', 'b'], mode: 'all', waitFor: 'message', waitMs: 0 },
    { signal: new AbortController().signal }
  );
  expect(snapshot.data).toMatchObject({ waitOutcome: 'snapshot', pendingAgentIds: ['b'] });
  expect(test.observations.capture('a', 'a-first')?.updates).toHaveLength(1);
  const controller = new AbortController();
  const waiting = test.execute(
    { agentIds: ['a', 'b'], mode: 'all', waitFor: 'message' },
    { signal: controller.signal }
  );
  await vi.waitFor(() => expect(test.listeners.get('b')?.size).toBe(2));
  controller.abort(new Error('group aborted'));
  await expect(waiting).rejects.toThrow('group aborted');
  expect(test.observations.capture('a', 'a-first')?.updates).toHaveLength(1);
  test.observations.close();
});

it.each([
  { agentId: 'a', agentIds: ['a'] },
  { agentIds: [] },
  { agentIds: ['a', 'a'] },
  { agentId: 'a', mode: 'all' }
])('rejects invalid wait selection without consuming progress: %j', async (input) => {
  const test = groupSetup();
  test.emit('a', 'message.completed');
  await expect(test.execute(input, { signal: new AbortController().signal })).rejects.toMatchObject(
    {
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    }
  );
  expect(test.observations.capture('a', 'a-first')?.updates).toEqual([
    { kind: 'message', value: 'a-progress' }
  ]);
  test.observations.close();
});

it('returns partial progress at the positive wait floor and consumes only that snapshot', async () => {
  vi.useFakeTimers();
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const test = groupSetup();
  try {
    test.emit('a', 'message.completed');
    const result = test.execute(
      { agentIds: ['a', 'b'], mode: 'all', waitMs: 1 },
      { signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(test.listeners.get('b')?.size).toBe(2));
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.observations.capture('a', 'a-first')?.updates).toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result).data).toMatchObject({
      waitOutcome: 'timeout',
      pendingAgentIds: ['a', 'b'],
      agents: [
        {
          agentId: 'a',
          waitOutcome: 'timeout',
          updates: [{ kind: 'message', value: 'a-progress' }]
        },
        { agentId: 'b', waitOutcome: 'timeout' }
      ]
    });
    expect(test.observations.capture('a', 'a-first')).toBeUndefined();
  } finally {
    test.observations.close();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  }
});

it('retries a historical terminal lookup after a transient read failure', async () => {
  const session = { id: 'child', subscribe: () => ({ unsubscribe() {} }) } as AgentSession;
  const history = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary history failure'))
    .mockResolvedValueOnce({
      entries: [{ kind: 'event', event: { type: 'execution.completed', executionId: 'finished' } }]
    });
  const agent = {
    sessionInputReceipt: async () => undefined,
    getSession: async (id: string) => ({
      id,
      workspace: 'work',
      source: { parentSessionId: id === 'child' ? 'parent' : undefined }
    }),
    openSession: async () => session,
    sessionHistory: history
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  const observations = new SessionObservations();
  registerWait(context, agent, observations);
  const input = { agentId: 'child', waitMs: 0 };
  const call = { signal: new AbortController().signal };
  await expect(execute(input, call)).rejects.toThrow('temporary history failure');
  expect((await execute(input, call)).data).toMatchObject({
    executionId: 'finished',
    status: 'completed'
  });
  expect(history).toHaveBeenCalledTimes(2);
  observations.close();
});

it('restores the latest cold terminal across history pages without mixing earlier Executions', async () => {
  const session = { id: 'child', subscribe: () => ({ unsubscribe() {} }) } as AgentSession;
  const history = vi.fn(async (_id: string, input: { cursor?: string }) => {
    if (!input.cursor)
      return {
        nextCursor: 'older',
        entries: [{ kind: 'event', event: { type: 'execution.completed', executionId: 'latest' } }]
      };
    if (input.cursor === 'older')
      return {
        nextCursor: 'oldest',
        entries: [
          { kind: 'event', event: { type: 'execution.started', executionId: 'latest' } },
          {
            kind: 'event',
            event: {
              type: 'message.completed',
              executionId: 'latest',
              phase: 'final_answer',
              text: 'Latest answer',
              turnId: 'latest-turn'
            }
          },
          {
            kind: 'event',
            event: {
              type: 'tool.completed',
              executionId: 'latest',
              toolName: 'apply_patch',
              data: { files: [{ path: 'latest.ts' }] }
            }
          }
        ]
      };
    throw new Error('must not read a previous Execution');
  });
  const agent = {
    sessionInputReceipt: async () => undefined,
    getSession: async (id: string) => ({
      id,
      workspace: 'work',
      source: { parentSessionId: id === 'child' ? 'parent' : undefined }
    }),
    openSession: async () => session,
    sessionHistory: history
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  const observations = new SessionObservations();
  registerWait(context, agent, observations);
  const call = { signal: new AbortController().signal };
  expect((await execute({ agentId: 'child' }, call)).data).toMatchObject({
    executionId: 'latest',
    status: 'completed',
    summary: 'Latest answer',
    turnId: 'latest-turn',
    changedFiles: ['latest.ts']
  });
  expect(history).toHaveBeenCalledTimes(2);
  observations.close();
});

it('does not consume a cold terminal if cancelled while loading an older history page', async () => {
  const session = { id: 'child', subscribe: () => ({ unsubscribe() {} }) } as AgentSession;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const agent = {
    sessionInputReceipt: async () => undefined,
    getSession: async (id: string) => ({
      id,
      workspace: 'work',
      source: { parentSessionId: id === 'child' ? 'parent' : undefined }
    }),
    openSession: async () => session,
    sessionHistory: async (_id: string, input: { cursor?: string }) => {
      if (!input.cursor)
        return {
          nextCursor: 'older',
          entries: [
            { kind: 'event', event: { type: 'execution.completed', executionId: 'latest' } }
          ]
        };
      entered();
      await gate;
      return {
        entries: [
          { kind: 'event', event: { type: 'execution.started', executionId: 'latest' } },
          {
            kind: 'event',
            event: {
              type: 'message.completed',
              executionId: 'latest',
              phase: 'final_answer',
              text: 'Unconsumed answer'
            }
          }
        ]
      };
    }
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  const context = {
    sessionId: 'parent',
    tools: {
      register(tool: { execute: typeof execute }) {
        execute = tool.execute;
      }
    }
  } as unknown as SessionExtensionContext;
  const observations = new SessionObservations();
  registerWait(context, agent, observations);
  const controller = new AbortController();
  const pending = execute({ agentId: 'child' }, { signal: controller.signal });
  await loading;
  controller.abort(new Error('cancelled during history load'));
  release();
  await expect(pending).rejects.toThrow('cancelled during history load');
  expect(
    (await execute({ agentId: 'child' }, { signal: new AbortController().signal })).data
  ).toMatchObject({ status: 'completed', summary: 'Unconsumed answer' });
  observations.close();
});

it.each(['ask', 'deny'] as const)(
  'restores a historical %s permission stop from its own execution',
  async (action) => {
    const session = { id: 'child', subscribe: () => ({ unsubscribe() {} }) } as AgentSession;
    const permissionStop = {
      action,
      reason: 'Confirm action.',
      source: {
        sessionId: 'child',
        executionId: 'finished',
        callId: 'call',
        toolName: 'effect'
      }
    };
    const agent = {
      sessionInputReceipt: async () => undefined,
      getSession: async (id: string) => ({
        id,
        workspace: 'work',
        source: { parentSessionId: id === 'child' ? 'parent' : undefined }
      }),
      openSession: async () => session,
      sessionHistory: async () => ({
        entries: [
          {
            kind: 'event',
            event: {
              type: 'message.completed',
              executionId: 'finished',
              phase: 'final_answer',
              text: 'Completed work',
              turnId: 'turn'
            }
          },
          {
            kind: 'event',
            event: {
              type: 'tool.completed',
              executionId: 'finished',
              toolName: 'apply_patch',
              data: { files: [{ path: 'file.ts' }] }
            }
          },
          {
            kind: 'event',
            event: { type: 'execution.completed', executionId: 'finished', permissionStop }
          }
        ]
      })
    } as unknown as Agent;
    let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
    const context = {
      sessionId: 'parent',
      tools: {
        register(tool: { execute: typeof execute }) {
          execute = tool.execute;
        }
      }
    } as unknown as SessionExtensionContext;
    const observations = new SessionObservations();
    registerWait(context, agent, observations);
    const call = { signal: new AbortController().signal };
    const snapshot = (await execute({ agentId: 'child', waitMs: 0 }, call)).data;
    expect(snapshot).toMatchObject({
      executionId: 'finished',
      status: 'completed',
      permissionStop
    });
    expect(snapshot).not.toHaveProperty('summary');
    expect(snapshot).not.toHaveProperty('changedFiles');
    expect((await execute({ agentId: 'child' }, call)).data).toMatchObject({
      executionId: 'finished',
      status: 'completed',
      permissionStop,
      summary: 'Completed work',
      turnId: 'turn',
      changedFiles: ['file.ts']
    });
    const repeated = (await execute({ agentId: 'child' }, call)).data;
    expect(repeated).toMatchObject({
      executionId: 'finished',
      status: 'completed',
      permissionStop
    });
    expect(repeated).not.toHaveProperty('summary');
    expect(repeated).not.toHaveProperty('changedFiles');
    observations.close();
  }
);

it('does not replay a terminal already consumed by automatic collection', async () => {
  const test = setup();
  test.emit('message.completed', { phase: 'final_answer', text: 'already collected' });
  test.emit('execution.completed');
  const collected = test.observations.collect(new AbortController().signal);
  expect(collected).toHaveLength(1);
  collected[0]!.acknowledge();
  const session = { id: 'child', subscribe: () => ({ unsubscribe() {} }) } as AgentSession;
  const agent = {
    sessionInputReceipt: async () => undefined,
    getSession: async (id: string) => ({
      id,
      workspace: 'work',
      source: { parentSessionId: id === 'child' ? 'parent' : undefined }
    }),
    openSession: async () => session,
    sessionHistory: async () => ({
      entries: [
        {
          kind: 'event',
          event: {
            type: 'message.completed',
            executionId: 'execution',
            phase: 'final_answer',
            text: 'already collected'
          }
        },
        { kind: 'event', event: { type: 'execution.completed', executionId: 'execution' } }
      ]
    })
  } as unknown as Agent;
  let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
  registerWait(
    {
      sessionId: 'parent',
      tools: {
        register(tool: { execute: typeof execute }) {
          execute = tool.execute;
        }
      }
    } as unknown as SessionExtensionContext,
    agent,
    test.observations
  );
  const result = (await execute({ agentId: 'child' }, { signal: new AbortController().signal }))
    .data;
  expect(result).toMatchObject({ executionId: 'execution', status: 'completed' });
  expect(result).not.toHaveProperty('summary');
  expect(result).not.toHaveProperty('updates');
  test.observations.close();
});

it.each([
  'execution.started',
  'execution.completed',
  'execution.failed',
  'execution.cancelled'
] as const)(
  'does not attribute an older permission stop to a newer %s execution',
  async (newType) => {
    const session = { id: 'child', subscribe: () => ({ unsubscribe() {} }) } as AgentSession;
    const permissionStop = {
      action: 'ask',
      reason: 'Old stop.',
      source: {
        sessionId: 'child',
        executionId: 'old',
        callId: 'call',
        toolName: 'effect'
      }
    };
    const agent = {
      sessionInputReceipt: async () => undefined,
      getSession: async (id: string) => ({
        id,
        workspace: 'work',
        source: { parentSessionId: id === 'child' ? 'parent' : undefined }
      }),
      sessionExecutionWasInterrupted: async () => true,
      openSession: async () => session,
      sessionHistory: async () => ({
        entries: [
          {
            kind: 'event',
            event: { type: 'execution.completed', executionId: 'old', permissionStop }
          },
          { kind: 'event', event: { type: newType, executionId: 'new', code: 'FAILED' } }
        ]
      })
    } as unknown as Agent;
    let execute!: (input: object, call: object) => Promise<{ data: Record<string, unknown> }>;
    const context = {
      sessionId: 'parent',
      tools: {
        register(tool: { execute: typeof execute }) {
          execute = tool.execute;
        }
      }
    } as unknown as SessionExtensionContext;
    const observations = new SessionObservations();
    registerWait(context, agent, observations);
    const result = execute(
      { agentId: 'child', waitMs: 0 },
      { signal: new AbortController().signal }
    );
    const data = (await result).data;
    expect(data).toMatchObject({
      executionId: 'new',
      ...(newType === 'execution.started' ? { status: 'interrupted' } : {})
    });
    expect(data.permissionStop).toBeUndefined();
    observations.close();
  }
);
