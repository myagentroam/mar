import { afterEach, expect, it, vi } from 'vitest';
import { AgentError, type Agent } from '../../src/index.js';
import type { AgentExtension } from '../../src/extensions/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { LocalAgentHost } from '../../src/host.js';
import {
  createSubagentExtension,
  SUBAGENT_NATIVE_SERVICE,
  type NativeSubagentClient
} from '../../extensions/subagent/src/index.js';
import { answer, call, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

it('restores native verification and read evidence from real child tool events without replaying them to the model', async () => {
  const setup = await setupNative((_request, index) =>
    index === 1
      ? call('read', { reads: [{ path: 'input.txt' }] })
      : index === 2
        ? call('exec', { command: 'printf verified' })
        : answer()
  );
  const client = setup.clients[0]!;
  const child = await setup.agent.createSession({
    workspace: setup.home,
    source: { type: 'user', parentSessionId: setup.session.id }
  });
  expect(
    (await child.run({ prompt: 'read and verify', permissionMode: 'full-access' }).result()).status
  ).toBe('completed');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const peer = await setup.agent.createSession({
    workspace: setup.home,
    source: { type: 'user', parentSessionId: setup.session.id }
  });
  expect((await peer.run({ prompt: 'second child' }).result()).status).toBe('completed');
  const listed = await client.list();
  expect(listed.map((item) => item.agentId)).toEqual([child.id, peer.id]);
  expect(listed.find((item) => item.agentId === child.id)).toMatchObject({
    evidence: [expect.objectContaining({ path: 'input.txt' })],
    verification: [expect.any(String)],
    latestMessage: { phase: 'final_answer', text: 'done' }
  });
  const waited = await client.wait({ agentId: child.id, waitMs: 1 });
  expect(waited).toMatchObject({
    status: 'completed',
    evidence: [expect.objectContaining({ path: 'input.txt' })],
    verification: [expect.any(String)],
    latestMessage: { phase: 'final_answer', text: 'done' }
  });
  const inspected = await client.inspect({ agentId: child.id });
  expect(inspected).toMatchObject({
    evidence: [expect.objectContaining({ path: 'input.txt' })],
    verification: [expect.any(String)],
    latestMessage: { phase: 'final_answer', text: 'done' }
  });
  expect(await client.wait({ agentId: child.id, waitMs: 1 })).not.toHaveProperty('evidence');
  expect((await setup.session.run({ prompt: 'collect child progress' }).result()).status).toBe(
    'completed'
  );
  const parentContext = JSON.stringify(setup.adapter.requests.at(-1)!.messages);
  expect(parentContext).toContain('mar_subagent_update');
  expect(parentContext).not.toContain('input.txt');
  expect(parentContext).not.toContain('printf verified');
  await client.close();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setupNative(
  script: Parameters<typeof fixture>[1],
  parentScript?: Parameters<typeof fixture>[1]
) {
  let agent!: Agent;
  const clients: NativeSubagentClient[] = [];
  const consumer: AgentExtension = {
    id: 'native-consumer',
    apiVersion: '1.0',
    serviceDependencies: [{ key: SUBAGENT_NATIVE_SERVICE }],
    attachSession(context) {
      const service = context.services.consume(SUBAGENT_NATIVE_SERVICE)!;
      clients.push(service.open(), service.open());
    }
  };
  const setup = await fixture(
    [createSubagentExtension({ agent: () => agent }), consumer],
    (request, index) =>
      parentScript &&
      request.messages.some(
        (message) => message.role === 'user' && message.content === 'model wait'
      )
        ? parentScript(request, index)
        : request.messages.some(
              (message) => message.role === 'user' && message.content === 'activate native service'
            )
          ? answer()
          : script(request, index)
  );
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  expect((await setup.session.run({ prompt: 'activate native service' }).result()).status).toBe(
    'completed'
  );
  return { ...setup, clients };
}

it('starts natively while idle without a fabricated parent execution or model input limits', async () => {
  const final = 'result-'.repeat(4000);
  const setup = await setupNative(() => [
    { type: 'text.completed', itemId: 'final', text: final },
    { type: 'completed', reason: 'completed' }
  ]);
  const result = await setup.clients[0]!.spawn({ prompt: 'a'.repeat(132000), background: false });
  expect(result).toMatchObject({
    status: 'completed',
    summary: final,
    waitOutcome: 'completion',
    modelId: setup.adapter.configuration.id,
    modelName: setup.adapter.configuration.name
  });
  const child = await setup.agent.getSession(String(result.agentId));
  expect(child.source).toMatchObject({
    type: 'subagent',
    parentSessionId: setup.session.id,
    parentOperationId: expect.any(String)
  });
  expect(child.source).not.toHaveProperty('parentExecutionId');
});

it('keeps native client terminal consumption independent from another client', async () => {
  const setup = await setupNative(() => answer());
  const first = setup.clients[0]!;
  const second = setup.clients[1]!;
  const started = await first.spawn({ prompt: 'Do the work.', waitFor: 'start' });
  expect(started).toMatchObject({
    modelId: setup.adapter.configuration.id,
    modelName: setup.adapter.configuration.name
  });
  const agentId = String(started.agentId);
  const complete = await first.wait({ agentId, untilSettled: true });
  expect(complete).toMatchObject({ status: 'completed', summary: 'done' });
  expect(await first.wait({ agentId, waitMs: 1 })).not.toHaveProperty('summary');
  expect(await second.wait({ agentId, untilSettled: true })).toMatchObject({ summary: 'done' });
});

it('keeps native delivery receipts scoped to the sending client', async () => {
  const setup = await setupNative(() => answer());
  const first = setup.clients[0]!;
  const second = setup.clients[1]!;
  const child = await first.spawn({ prompt: 'Initial work', background: false });
  const delivery = await first.message({ agentId: child.agentId, message: 'Continue work' });
  expect((await first.wait({ agentId: child.agentId, untilSettled: true })).receipt).toMatchObject({
    clientMessageId: delivery.messageId
  });
  expect(await second.wait({ agentId: child.agentId, waitMs: 0 })).not.toHaveProperty('receipt');
});

it('keeps native terminal consumption independent from automatic model collection and model wait', async () => {
  let agentId = '';
  const setup = await setupNative(
    () => answer(),
    (request) => {
      const modelWait = request.messages.some(
        (message) => message.role === 'user' && message.content === 'model wait'
      );
      return modelWait && !request.messages.some((message) => message.role === 'tool')
        ? call('agent_wait', { agentId, waitMs: 1 })
        : answer();
    }
  );
  const first = setup.clients[0]!;
  const second = setup.clients[1]!;
  const started = await first.spawn({ prompt: 'Work independently', background: false });
  agentId = started.agentId;
  expect(started).toHaveProperty('summary', 'done');
  const execution = setup.session.run({ prompt: 'model wait' });
  const events = (async () => {
    const all = [];
    for await (const event of execution) all.push(event);
    return all;
  })();
  expect((await execution.result()).status).toBe('completed');
  const wait = (await events).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
  );
  expect(wait).toMatchObject({ type: 'tool.completed' });
  if (wait?.type !== 'tool.completed') throw new Error('Missing model wait result');
  expect(JSON.parse(wait.summary)).toMatchObject({ agentId, status: 'completed' });
  expect(JSON.parse(wait.summary)).not.toHaveProperty('summary');
  expect(await second.wait({ agentId, untilSettled: true })).toMatchObject({
    status: 'completed',
    summary: 'done'
  });
  expect(await first.inspect({ agentId })).toMatchObject({ status: 'completed', summary: 'done' });
  expect(await first.inspect({ agentId })).toMatchObject({ status: 'completed', summary: 'done' });
  expect(await first.wait({ agentId, waitMs: 1 })).not.toHaveProperty('summary');
});

it('lists historical children with status without reopening their Sessions', async () => {
  const setup = await setupNative(() => answer());
  const client = setup.clients[0]!;
  const started = await client.spawn({
    prompt: 'Finished task',
    description: 'Finished child',
    background: false
  });
  const opened = vi.spyOn(setup.agent, 'openSession');
  expect(await client.list()).toContainEqual(
    expect.objectContaining({
      agentId: started.agentId,
      description: 'Finished child',
      status: 'completed'
    })
  );
  expect(opened).not.toHaveBeenCalled();
  opened.mockRestore();
});

it('skips a child deleted during native list while propagating genuine history failures', async () => {
  const setup = await setupNative(() => answer());
  const client = setup.clients[0]!;
  const gone = await client.spawn({ prompt: 'First', background: false });
  const remaining = await client.spawn({ prompt: 'Second', background: false });
  const original = setup.agent.sessionHistory.bind(setup.agent);
  const history = vi
    .spyOn(setup.agent, 'sessionHistory')
    .mockImplementation((id, options) =>
      id === gone.agentId
        ? Promise.reject(new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Deleted'))
        : original(id, options)
    );
  expect((await client.list()).map((item) => item.agentId)).toEqual([remaining.agentId]);
  history.mockImplementation((id, options) =>
    id === gone.agentId ? Promise.reject(new Error('HISTORY_READ_FAILED')) : original(id, options)
  );
  await expect(client.list()).rejects.toThrow('HISTORY_READ_FAILED');
  history.mockRestore();
});

it('stops a cancelled native listing after its shared history read and can list again', async () => {
  const setup = await setupNative(() => answer());
  const client = setup.clients[0]!;
  const first = await client.spawn({ prompt: 'First', background: false });
  const second = await client.spawn({ prompt: 'Second', background: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const entered = gate();
  const release = gate();
  const original = setup.agent.sessionHistory.bind(setup.agent);
  const reads: string[] = [];
  let blocked = true;
  const history = vi
    .spyOn(setup.agent, 'sessionHistory')
    .mockImplementation(async (id, options) => {
      reads.push(id);
      if (blocked) {
        entered.resolve();
        await release.promise;
      }
      return original(id, options);
    });
  const abort = new AbortController();
  const listing = client.list({ signal: abort.signal });
  try {
    await entered.promise;
    abort.abort(new Error('Listing cancelled'));
    blocked = false;
    release.resolve();
    await expect(listing).rejects.toThrow('Listing cancelled');
    expect(reads).toHaveLength(1);
    expect((await client.list()).map((item) => item.agentId)).toEqual([
      first.agentId,
      second.agentId
    ]);
  } finally {
    release.resolve();
    await Promise.allSettled([listing]);
    history.mockRestore();
  }
});

it('lets an attached extension submit a normal idle turn to its own child Session', async () => {
  let agent!: Agent;
  const contexts = new Map<string, Parameters<NonNullable<AgentExtension['attachSession']>>[0]>();
  const consumer: AgentExtension = {
    id: 'idle-child-consumer',
    apiVersion: '1.0',
    attachSession(context) {
      contexts.set(context.sessionId, context);
    }
  };
  const setup = await fixture([createSubagentExtension({ agent: () => agent }), consumer], () =>
    answer()
  );
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const parent = setup.session.run({ prompt: 'parent' });
  expect((await parent.result()).status).toBe('completed');
  const child = await agent.createSession({
    workspace: setup.home,
    source: {
      type: 'subagent',
      parentSessionId: setup.session.id,
      rootSessionId: setup.session.id,
      parentExecutionId: parent.executionId,
      role: 'general-purpose',
      description: 'child'
    }
  });
  expect((await child.run({ prompt: 'first' }).result()).status).toBe('completed');
  const receipt = await contexts
    .get(child.id)!
    .session!.submit({ text: 'follow up', delivery: 'idle', waitFor: 'start' });
  expect(receipt).toMatchObject({ executionId: expect.any(String) });
  const completion = child.joinExecution(receipt.executionId!);
  if (completion) expect((await completion).status).toBe('completed');
  const history = await agent.sessionHistory(child.id);
  expect(
    history.entries.some(
      (entry) => entry.kind === 'event' && entry.event.type === 'execution.completed'
    )
  ).toBe(true);
});

it('inspects the latest execution across history pages without consuming its result', async () => {
  const setup = await setupNative((request) =>
    request.messages.some(
      (message) => message.role === 'user' && message.content.includes('second execution')
    )
      ? [
          { type: 'text.completed', itemId: 'second', text: 'new result' },
          { type: 'completed', reason: 'completed' }
        ]
      : answer()
  );
  const client = setup.clients[0]!;
  const started = await client.spawn({ prompt: 'first execution', background: false });
  const agentId = started.agentId;
  const delivery = await client.message({ agentId, message: 'second execution' });
  expect(await client.wait({ agentId, untilSettled: true })).toMatchObject({
    summary: 'new result',
    receipt: { clientMessageId: delivery.messageId, turnId: delivery.turnId, status: 'applied' }
  });
  const history = setup.agent.sessionHistory.bind(setup.agent);
  const spy = vi
    .spyOn(setup.agent, 'sessionHistory')
    .mockImplementation((id, input) => history(id, { ...input, limit: 2 }));
  expect(await client.inspect({ agentId })).toMatchObject({
    status: 'completed',
    summary: 'new result'
  });
  expect(spy.mock.calls.length).toBeGreaterThan(1);
  expect(await client.wait({ agentId, waitMs: 1 })).not.toHaveProperty('summary');
  spy.mockRestore();
});

it('restores a cold terminal across real paginated Session history for an independent client', async () => {
  const setup = await setupNative(() => answer());
  const started = await setup.clients[0]!.spawn({ prompt: 'Finished task', background: false });
  const history = setup.agent.sessionHistory.bind(setup.agent);
  const spy = vi
    .spyOn(setup.agent, 'sessionHistory')
    .mockImplementation((id, input) => history(id, { ...input, limit: 2 }));
  const second = setup.clients[1]!;
  expect(await second.wait({ agentId: started.agentId, untilSettled: true })).toMatchObject({
    status: 'completed',
    summary: 'done'
  });
  expect(spy.mock.calls.length).toBeGreaterThan(1);
  expect(await second.wait({ agentId: started.agentId, waitMs: 1 })).not.toHaveProperty('summary');
  spy.mockRestore();
});

it('shares an in-flight child history page across native clients without sharing cancellation', async () => {
  const setup = await setupNative(() => answer());
  const started = await setup.clients[0]!.spawn({ prompt: 'Finished task', background: false });
  const entered = gate();
  const release = gate();
  const history = setup.agent.sessionHistory.bind(setup.agent);
  let callsBeforeRelease = 0;
  let blocked = true;
  const spy = vi.spyOn(setup.agent, 'sessionHistory').mockImplementation(async (id, input) => {
    if (id === started.agentId && blocked) {
      callsBeforeRelease++;
      entered.resolve();
      await release.promise;
    }
    return history(id, input);
  });
  const getSession = vi.spyOn(setup.agent, 'getSession');
  const abort = new AbortController();
  const first = setup.clients[0]!.wait({
    agentId: started.agentId,
    waitMs: 1,
    signal: abort.signal
  });
  await entered.promise;
  const second = setup.clients[1]!.wait({ agentId: started.agentId, waitMs: 1 });
  try {
    await vi.waitFor(() =>
      expect(
        getSession.mock.calls.filter(([id]) => id === started.agentId).length
      ).toBeGreaterThanOrEqual(2)
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(callsBeforeRelease).toBe(1);
    abort.abort();
    blocked = false;
    release.resolve();
    await expect(first).rejects.toBeDefined();
    await expect(second).resolves.toMatchObject({ status: 'completed', summary: 'done' });
  } finally {
    blocked = false;
    release.resolve();
    await Promise.allSettled([first, second]);
    spy.mockRestore();
    getSession.mockRestore();
  }
});

it('reports an interrupted historical Execution and can continue the same child Session', async () => {
  const setup = await setupNative(() => answer());
  const child = await setup.agent.createSession({
    workspace: setup.home,
    source: {
      type: 'subagent',
      parentSessionId: setup.session.id,
      rootSessionId: setup.session.id,
      parentExecutionId: 'previous-parent',
      role: 'general-purpose',
      description: 'Interrupted child'
    }
  });
  const store = await JsonlSessionStore.open(setup.home);
  try {
    await store.append(child.id, {
      type: 'execution.completed',
      executionId: 'old-execution',
      payload: {
        type: 'execution.completed',
        eventId: 'old-event',
        sequence: 1,
        timestamp: '2025-01-01T00:00:00Z',
        sessionId: child.id,
        executionId: 'old-execution'
      }
    });
    await store.append(child.id, {
      type: 'execution.started',
      executionId: 'interrupted-execution',
      turnId: 'interrupted-turn',
      payload: {
        type: 'execution.started',
        eventId: 'started-event',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: child.id,
        executionId: 'interrupted-execution',
        turnId: 'interrupted-turn',
        mode: 'normal'
      }
    });
  } finally {
    await store.close();
  }
  const client = setup.clients[0]!;
  expect(await client.wait({ agentId: child.id, untilSettled: true })).toMatchObject({
    executionId: 'interrupted-execution',
    status: 'interrupted',
    waitOutcome: 'completion'
  });
  expect(await client.list()).toContainEqual(
    expect.objectContaining({ agentId: child.id, status: 'interrupted' })
  );
  expect(await client.cancel({ agentId: child.id })).toMatchObject({ status: 'interrupted' });
  await client.message({ agentId: child.id, message: 'Continue the work.' });
  expect(await client.wait({ agentId: child.id, untilSettled: true })).toMatchObject({
    status: 'completed',
    summary: 'done'
  });
});

it('keeps an observed non-durable failure readable after its owner cannot acquire the Session lease', async () => {
  const setup = await setupNative(() => answer());
  const child = await setup.agent.createSession({
    workspace: setup.home,
    source: { type: 'user', parentSessionId: setup.session.id }
  });
  const older = await child.run({ prompt: 'Earlier durable execution' }).result();
  expect(older.status).toBe('completed');
  const store = await JsonlSessionStore.open(setup.home);
  const release = await store.acquireSessionLease(child.id, {});
  let released = false;
  try {
    const execution = child.run({ prompt: 'Cannot acquire the foreign lease' });
    const result = await execution.result();
    expect(result.status).toBe('failed');
    await release();
    released = true;
    const client = setup.clients[0]!;
    expect(await client.wait({ agentId: child.id, waitMs: 1 })).toMatchObject({
      executionId: result.executionId,
      status: 'failed'
    });
    expect(await setup.clients[1]!.wait({ agentId: child.id, waitMs: 1 })).toMatchObject({
      executionId: result.executionId,
      status: 'failed'
    });
    expect(await client.inspect({ agentId: child.id })).toMatchObject({
      executionId: result.executionId,
      status: 'failed'
    });
    expect(await client.list()).toContainEqual(
      expect.objectContaining({
        agentId: child.id,
        executionId: result.executionId,
        status: 'failed'
      })
    );
    expect((await setup.session.run({ prompt: 'collect child progress' }).result()).status).toBe(
      'completed'
    );
    expect(
      (await setup.session.run({ prompt: 'collect remaining child progress' }).result()).status
    ).toBe('completed');
    expect(JSON.stringify(setup.adapter.requests.at(-1)!.messages)).toContain(result.executionId);
    expect(await client.inspect({ agentId: child.id })).toMatchObject({
      executionId: result.executionId,
      status: 'failed'
    });
  } finally {
    if (!released) await release();
    await store.close();
  }
});

it('does not classify a foreign-owned Execution as interrupted', async () => {
  const setup = await setupNative(() => answer());
  const child = await setup.agent.createSession({
    workspace: setup.home,
    source: {
      type: 'subagent',
      parentSessionId: setup.session.id,
      rootSessionId: setup.session.id,
      parentExecutionId: 'previous-parent',
      role: 'general-purpose',
      description: 'Foreign-owned child'
    }
  });
  const store = await JsonlSessionStore.open(setup.home);
  try {
    await store.append(child.id, {
      type: 'execution.started',
      executionId: 'foreign-execution',
      payload: {
        type: 'execution.started',
        eventId: 'started-event',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: child.id,
        executionId: 'foreign-execution',
        mode: 'normal'
      }
    });
    const release = await store.acquireSessionLease(child.id, {});
    try {
      await expect(
        setup.clients[0]!.wait({ agentId: child.id, untilSettled: true })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
    } finally {
      await release();
    }
    expect(await setup.clients[0]!.wait({ agentId: child.id, untilSettled: true })).toMatchObject({
      executionId: 'foreign-execution',
      status: 'interrupted'
    });
  } finally {
    await store.close();
  }
});

it('does not adopt a pending Session resource while checking interruption', async () => {
  const setup = await setupNative(() => answer());
  const child = await setup.agent.createSession({
    workspace: setup.home,
    source: {
      type: 'subagent',
      parentSessionId: setup.session.id,
      rootSessionId: setup.session.id,
      parentExecutionId: 'previous-parent',
      role: 'general-purpose',
      description: 'Child with pending resource'
    }
  });
  const store = await JsonlSessionStore.open(setup.home);
  try {
    await store.append(child.id, {
      type: 'execution.started',
      executionId: 'previous-execution',
      payload: {
        type: 'execution.started',
        eventId: 'started-event',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: child.id,
        executionId: 'previous-execution',
        mode: 'normal'
      }
    });
    await store.writeToolResultResource(child.id, 'pending resource');
    await expect(
      setup.clients[0]!.wait({ agentId: child.id, untilSettled: true })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
    await expect(store.acquireSessionMaintenance(child.id, 'clear', {})).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_LOCKED'
    });
  } finally {
    await store.close();
  }
});

it('does not report a real foreign Agent execution as interrupted', async () => {
  const setup = await setupNative(() => answer());
  const child = await setup.agent.createSession({
    workspace: setup.home,
    source: {
      type: 'subagent',
      parentSessionId: setup.session.id,
      rootSessionId: setup.session.id,
      parentExecutionId: 'previous-parent',
      role: 'general-purpose',
      description: 'Foreign child'
    }
  });
  const entered = gate();
  const release = gate();
  const foreign = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: setup.home, workspace: setup.home }),
      models: [setup.adapter.configuration]
    },
    () => ({
      configuration: setup.adapter.configuration,
      async *start() {
        entered.resolve();
        await release.promise;
        yield* answer();
      }
    })
  );
  try {
    const foreignChild = await foreign.openSession(child.id);
    const execution = foreignChild.run({ prompt: 'Work in a different owner.' });
    await entered.promise;
    await expect(
      setup.clients[0]!.wait({ agentId: child.id, untilSettled: true })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
    release.resolve();
    expect((await execution.result()).status).toBe('completed');
    expect(await setup.clients[0]!.wait({ agentId: child.id, untilSettled: true })).toMatchObject({
      executionId: execution.executionId,
      status: 'completed',
      summary: 'done'
    });
  } finally {
    release.resolve();
    await foreign.dispose();
  }
});

it('propagates a historical read failure and allows a later native wait retry', async () => {
  const setup = await setupNative(() => answer());
  const client = setup.clients[0]!;
  const started = await client.spawn({ prompt: 'Finished task', background: false });
  const agentId = String(started.agentId);
  const history = setup.agent.sessionHistory.bind(setup.agent);
  let fail = true;
  const spy = vi.spyOn(setup.agent, 'sessionHistory').mockImplementation(async (id, input) => {
    if (id === agentId && fail) {
      fail = false;
      throw new Error('history unavailable');
    }
    return history(id, input);
  });
  await expect(client.wait({ agentId, waitMs: 1 })).rejects.toThrow('history unavailable');
  expect(await client.wait({ agentId, waitMs: 1 })).toMatchObject({ status: 'completed' });
  spy.mockRestore();
});

it('does not install a delayed history result after native client close', async () => {
  const setup = await setupNative(() => answer());
  const client = setup.clients[0]!;
  const started = await client.spawn({ prompt: 'Finished task', background: false });
  const agentId = String(started.agentId);
  const entered = gate();
  const release = gate();
  const history = setup.agent.sessionHistory.bind(setup.agent);
  const spy = vi.spyOn(setup.agent, 'sessionHistory').mockImplementation(async (id, input) => {
    if (id === agentId) {
      entered.resolve();
      await release.promise;
    }
    return history(id, input);
  });
  const waiting = client.wait({ agentId, waitMs: 1 });
  await entered.promise;
  const closing = client.close();
  release.resolve();
  await expect(waiting).rejects.toThrow();
  await closing;
  await expect(client.wait({ agentId })).rejects.toThrow();
  spy.mockRestore();
});

it('preserves the real enclosing execution and operation for a native call from an extension tool', async () => {
  let agent!: Agent;
  let spawned: Record<string, unknown> | undefined;
  const consumer: AgentExtension = {
    id: 'native-source-consumer',
    apiVersion: '1.0',
    serviceDependencies: [{ key: SUBAGENT_NATIVE_SERVICE }],
    attachSession(context) {
      const client = context.services.consume(SUBAGENT_NATIVE_SERVICE)!.open();
      context.tools.register({
        name: 'native_spawn_probe',
        description: 'Start a native child.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          spawned = await client.spawn({ prompt: 'Native child.', waitFor: 'start' });
          return { content: 'started' };
        }
      });
      return () => client.close();
    }
  };
  const setup = await fixture(
    [createSubagentExtension({ agent: () => agent }), consumer],
    (request) =>
      request.messages.some(
        (message) => message.role === 'user' && message.content === 'start natively'
      ) && !request.messages.some((message) => message.role === 'tool')
        ? call('native_spawn_probe', {})
        : answer()
  );
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const parent = setup.session.run({ prompt: 'start natively' });
  expect((await parent.result()).status).toBe('completed');
  const child = await agent.getSession(String(spawned!.agentId));
  expect(child.source).toMatchObject({
    type: 'subagent',
    parentSessionId: setup.session.id,
    parentExecutionId: parent.executionId,
    parentOperationId: expect.any(String),
    ownerInstanceId: expect.any(String),
    extensionId: 'native-source-consumer'
  });
});

it('binds idle clients to their actual consumers and retires a removed consumer', async () => {
  let agent!: Agent;
  let revision = '1';
  let includeA = true;
  const clients = new Map<string, NativeSubagentClient>();
  const provider = createSubagentExtension({ agent: () => agent });
  const consumer = (id: string): AgentExtension => ({
    id,
    apiVersion: '1.0',
    serviceDependencies: [{ key: SUBAGENT_NATIVE_SERVICE }],
    attachSession(context) {
      clients.set(id, context.services.consume(SUBAGENT_NATIVE_SERVICE)!.open());
    }
  });
  const a = consumer('consumer-a');
  const b = consumer('consumer-b');
  const setup = await fixture(
    { resolve: async () => ({ revision, extensions: [provider, ...(includeA ? [a] : []), b] }) },
    () => answer()
  );
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  expect((await setup.session.run({ prompt: 'activate' }).result()).status).toBe('completed');
  const oldA = clients.get('consumer-a')!;
  const oldB = clients.get('consumer-b')!;
  const first = await oldA.spawn({ prompt: 'first', background: false });
  const second = await oldB.spawn({ prompt: 'second', background: false });
  const firstSource = (await agent.getSession(String(first.agentId))).source;
  const secondSource = (await agent.getSession(String(second.agentId))).source;
  expect(firstSource).toMatchObject({
    extensionId: 'consumer-a',
    ownerInstanceId: expect.any(String)
  });
  expect(secondSource).toMatchObject({
    extensionId: 'consumer-b',
    ownerInstanceId: expect.any(String)
  });
  if (firstSource.type !== 'subagent' || secondSource.type !== 'subagent')
    throw new Error('Expected child sources.');
  expect(firstSource.ownerInstanceId).not.toBe(secondSource.ownerInstanceId);
  includeA = false;
  revision = '2';
  expect((await setup.session.run({ prompt: 'refresh' }).result()).status).toBe('completed');
  await expect(oldA.spawn({ prompt: 'after retirement' })).rejects.toThrow();
  const currentB = clients.get('consumer-b')!;
  expect(currentB).not.toBe(oldB);
  const third = await currentB.spawn({ prompt: 'still allowed', background: false });
  expect((await agent.getSession(String(third.agentId))).source).toMatchObject({
    extensionId: 'consumer-b'
  });
});

it('cancels an independent native wait without cancelling the registered child', async () => {
  const setup = await setupNative((request) =>
    request.messages.some((message) => message.role === 'tool')
      ? answer()
      : call('sleep', { durationMs: 300000 })
  );
  const client = setup.clients[0]!;
  const started = await client.spawn({ prompt: 'Hold.', waitFor: 'start' });
  const agentId = String(started.agentId);
  const child = await setup.agent.openSession(agentId);
  const signal = new AbortController();
  const waiting = client.wait({ agentId, untilSettled: true, signal: signal.signal });
  signal.abort(new Error('wait cancelled'));
  await expect(waiting).rejects.toThrow('wait cancelled');
  const current = child.subscribe(() => {});
  expect(current.activeExecutionId).toBe(started.executionId);
  current.unsubscribe();
  expect(await client.cancel({ agentId })).toMatchObject({ status: 'cancelled' });
});

it('cancels native spawn completion waiting without cancelling the admitted child', async () => {
  const setup = await setupNative((request) =>
    request.messages.some((message) => message.role === 'tool')
      ? answer()
      : call('sleep', { durationMs: 300000 })
  );
  const client = setup.clients[0]!;
  const registered = gate();
  let childId = '';
  const watch = setup.agent.observeSessionExecutions((session) => {
    if (session.source.parentSessionId === setup.session.id) {
      childId = session.id;
      registered.resolve();
    }
  });
  const abort = new AbortController();
  const spawn = client.spawn({
    prompt: 'Hold while waiting.',
    waitFor: 'completion',
    signal: abort.signal
  });
  await registered.promise;
  abort.abort(new Error('caller stopped waiting'));
  await expect(spawn).rejects.toThrow('caller stopped waiting');
  watch.unsubscribe();
  const child = await setup.agent.openSession(childId);
  const active = child.subscribe(() => {});
  expect(active.activeExecutionId).toBeDefined();
  active.unsubscribe();
  await client.cancel({ agentId: childId });
});

it('does not apply the model ten-second floor to a native wait', async () => {
  const setup = await setupNative((request) =>
    request.messages.some((message) => message.role === 'tool')
      ? answer()
      : call('sleep', { durationMs: 300000 })
  );
  const client = setup.clients[0]!;
  const started = await client.spawn({ prompt: 'Hold.', waitFor: 'start' });
  const result = await Promise.race([
    client.wait({ agentId: String(started.agentId), waitMs: 1 }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('native wait was floored')), 500)
    )
  ]);
  expect(result).toMatchObject({ waitOutcome: 'timeout' });
  await client.cancel({ agentId: String(started.agentId) });
});

it('joins a gated spawn on client close without leaving a late execution', async () => {
  const setup = await setupNative(() => answer());
  const client = setup.clients[0]!;
  const entered = gate();
  const release = gate();
  const create = setup.agent.createSession.bind(setup.agent);
  const spy = vi.spyOn(setup.agent, 'createSession').mockImplementation(async (input) => {
    if (input.source?.type === 'subagent') {
      entered.resolve();
      await release.promise;
    }
    return create(input);
  });
  const spawning = client.spawn({ prompt: 'gated spawn', waitFor: 'start' });
  await entered.promise;
  const closing = client.close();
  release.resolve();
  await expect(spawning).rejects.toThrow();
  await closing;
  spy.mockRestore();
  const page = await setup.agent.listSessions({ parentSessionId: setup.session.id });
  expect(page.sessions).toHaveLength(1);
  const child = await setup.agent.openSession(page.sessions[0]!.id);
  const snapshot = child.subscribe(() => {});
  expect(snapshot.activeExecutionId).toBeUndefined();
  snapshot.unsubscribe();
});

it('joins a gated resume on client close before an execution is handed off', async () => {
  const setup = await setupNative((request) =>
    request.messages.some(
      (message) => message.role === 'user' && message.content.includes('Resume and hold')
    ) && !request.messages.some((message) => message.role === 'tool')
      ? call('sleep', { durationMs: 300000 })
      : answer()
  );
  const client = setup.clients[0]!;
  const started = await client.spawn({ prompt: 'Initial task', background: false });
  const agentId = String(started.agentId);
  const child = await setup.agent.openSession(agentId);
  const entered = gate();
  const release = gate();
  let opens = 0;
  const open = setup.agent.openSession.bind(setup.agent);
  const spy = vi.spyOn(setup.agent, 'openSession').mockImplementation(async (id) => {
    const session = await open(id);
    if (id === agentId && ++opens === 1) {
      entered.resolve();
      await release.promise;
    }
    return session;
  });
  const sending = client.message({ agentId, message: 'Resume and hold' });
  await entered.promise;
  const closing = client.close();
  release.resolve();
  await expect(sending).rejects.toThrow();
  await closing;
  spy.mockRestore();
  const snapshot = child.subscribe(() => {});
  expect(snapshot.activeExecutionId).toBeUndefined();
  snapshot.unsubscribe();
});

it('does not cancel an already handed-off execution when its native client closes', async () => {
  const setup = await setupNative((request) =>
    request.messages.some(
      (message) => message.role === 'user' && message.content.includes('Resume and hold')
    ) && !request.messages.some((message) => message.role === 'tool')
      ? call('sleep', { durationMs: 300000 })
      : answer()
  );
  const client = setup.clients[0]!;
  const started = await client.spawn({ prompt: 'Initial task', background: false });
  const child = await setup.agent.openSession(String(started.agentId));
  const resumed = await client.message({ agentId: child.id, message: 'Resume and hold' });
  await client.close();
  const snapshot = child.subscribe(() => {});
  expect(snapshot.activeExecutionId).toBe(resumed.executionId);
  snapshot.unsubscribe();
  await child.cancel(String(resumed.executionId));
});

it('keeps a running child when clearing its parent retires the extension scope', async () => {
  const setup = await setupNative((request) =>
    request.messages.some((message) => message.role === 'tool')
      ? answer()
      : call('sleep', { durationMs: 300000 })
  );
  const client = setup.clients[0]!;
  const started = await client.spawn({ prompt: 'Child continues', waitFor: 'start' });
  const child = await setup.agent.openSession(String(started.agentId));
  await setup.agent.clearSession(setup.session.id);
  const snapshot = child.subscribe(() => {});
  expect(snapshot.activeExecutionId).toBe(started.executionId);
  snapshot.unsubscribe();
  await expect(client.spawn({ prompt: 'retired client' })).rejects.toThrow();
  await child.cancel(String(started.executionId));
});

it('does not retire a different native client’s resumed child execution', async () => {
  const setup = await setupNative((request) =>
    request.messages.some(
      (message) => message.role === 'user' && message.content.includes('other owner')
    ) && !request.messages.some((message) => message.role === 'tool')
      ? call('sleep', { durationMs: 300000 })
      : answer()
  );
  const [creator, resumer] = setup.clients;
  const started = await creator!.spawn({ prompt: 'Initial task', background: false });
  const agentId = String(started.agentId);
  const resumed = await resumer!.message({ agentId, message: 'continue as other owner' });
  expect(resumed).toMatchObject({ delivery: 'started' });
  await creator!.close();
  const child = await setup.agent.openSession(agentId);
  const snapshot = child.subscribe(() => {});
  expect(snapshot.activeExecutionId).toBe(resumed.executionId);
  snapshot.unsubscribe();
  await resumer!.cancel({ agentId });
});
