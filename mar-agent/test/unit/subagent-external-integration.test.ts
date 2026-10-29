import { afterEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/index.js';
import {
  createSubagentExtension,
  SUBAGENT_NATIVE_SERVICE,
  type NativeSubagentClient
} from '../../extensions/subagent/src/index.js';
import type { AgentExtension } from '../../src/extensions/contracts.js';
import { answer, call, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';
import { effectiveInstructions } from './support/model-context.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { LocalAgentHost } from '../../src/host.js';
import { childResources } from '../../extensions/subagent/src/resources.js';

afterEach(cleanupCoreFixtures);

it('allows all six delegation tools in the live cell catalog and executes a programmatic call', async () => {
  let agent!: Agent;
  const names = [
    'agent_start',
    'agent_send',
    'agent_wait',
    'agent_stop',
    'agent_list',
    'agent_view'
  ];
  const setup = await fixture(
    [createSubagentExtension({ agent: () => agent })],
    (_request, index) =>
      index === 0
        ? call('code_exec', {
            code: "await tools.agent_list({}); observe.text(JSON.stringify({eligible:catalog.tools().filter((tool)=>tool.name.startsWith('agent_')).map((tool)=>tool.name),read:catalog.tools().some((tool)=>tool.name==='read')}));"
          })
        : answer(),
    true
  );
  agent = setup.agent;
  const run = setup.session.run({
    prompt: 'inspect the available tools',
    permissionMode: 'full-access'
  });
  const events = (async () => {
    const all = [];
    for await (const event of run) all.push(event);
    return all;
  })();
  expect((await run.result()).status).toBe('completed');
  const direct = setup.adapter.requests[0]!.tools.map((tool) => tool.name);
  expect(direct.filter((name) => names.includes(name))).toEqual([]);
  const completed = (await events).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'code_exec'
  );
  expect(completed?.type).toBe('tool.completed');
  if (completed?.type !== 'tool.completed') throw new Error('Missing cell result');
  const cell = JSON.parse(completed.summary) as { observations: Array<{ value: string }> };
  const observed = JSON.parse(cell.observations[0]!.value);
  expect(observed.eligible).toEqual(expect.arrayContaining(names));
  expect(observed.read).toBe(true);
});

it('automatically observes future direct children through the external extension', async () => {
  let agent!: Agent;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], () => answer());
  agent = setup.agent;
  expect(await setup.session.run({ prompt: 'activate parent' }).result()).toMatchObject({
    status: 'completed'
  });
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  expect(await child.run({ prompt: 'child work' }).result()).toMatchObject({ status: 'completed' });
  expect(await setup.session.run({ prompt: 'continue parent' }).result()).toMatchObject({
    status: 'completed'
  });
  const messages = setup.adapter.requests.at(-1)!.messages;
  const update = messages.find((message) => message.content.includes('<mar_subagent_update>'));
  expect(update?.content).toContain(child.id);
  expect(update?.content).toContain('execution.completed');
  expect(update?.content).toContain('done');
});

it('preserves a child completion arriving while the parent final message is being published', async () => {
  let agent!: Agent;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], () => answer());
  agent = setup.agent;
  expect((await setup.session.run({ prompt: 'activate parent' }).result()).status).toBe(
    'completed'
  );
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const emit = setup.host.emit.bind(setup.host);
  let gated = false;
  const spy = vi.spyOn(setup.host, 'emit').mockImplementation(async (event) => {
    if (
      !gated &&
      event.sessionId === setup.session.id &&
      event.type === 'message.completed' &&
      event.phase === 'final_answer'
    ) {
      gated = true;
      entered.resolve();
      await release.promise;
    }
    await emit(event);
  });
  try {
    const parent = setup.session.run({ prompt: 'return final while child finishes' });
    await entered.promise;
    expect(
      (await child.run({ prompt: 'finish child during final publication' }).result()).status
    ).toBe('completed');
    release.resolve();
    expect((await parent.result()).status).toBe('completed');
    spy.mockRestore();
    expect((await setup.session.run({ prompt: 'next parent request' }).result()).status).toBe(
      'completed'
    );
    const updates = setup.adapter.requests
      .at(-1)!
      .messages.filter((message) => message.content.includes('<mar_subagent_update>'));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.content).toContain(child.id);
    expect(updates[0]!.content).toContain('execution.completed');
  } finally {
    release.resolve();
    spy.mockRestore();
  }
});

it('keeps an active child execution on its captured instructions after the parent configuration changes', async () => {
  let agent!: Agent;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const child = request.messages.some(
      (message) => message.role === 'user' && message.content === 'hold delegated child'
    );
    if (child && !request.messages.some((message) => message.role === 'tool'))
      return call('sleep', { durationMs: 300 });
    return answer();
  });
  agent = setup.agent;
  agent.setSystemInstruction('ORIGINAL_HOST_INSTRUCTION');
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  const sleeping = Promise.withResolvers<void>();
  const running = child.run({ prompt: 'hold delegated child' });
  const reader = (async () => {
    for await (const event of running)
      if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
  })();
  await sleeping.promise;
  agent.setSystemInstruction('REPLACEMENT_HOST_INSTRUCTION');
  expect(
    (await setup.session.run({ prompt: 'continue parent with new instructions' }).result()).status
  ).toBe('completed');
  expect((await running.result()).status).toBe('completed');
  await reader;
  const childRequests = setup.adapter.requests.filter((request) =>
    request.messages.some(
      (message) => message.role === 'user' && message.content === 'hold delegated child'
    )
  );
  expect(childRequests).toHaveLength(2);
  for (const request of childRequests) {
    expect(effectiveInstructions(request)).toContain('ORIGINAL_HOST_INSTRUCTION');
    expect(effectiveInstructions(request)).not.toContain('REPLACEMENT_HOST_INSTRUCTION');
  }
  const parent = setup.adapter.requests.find((request) =>
    request.messages.some(
      (message) =>
        message.role === 'user' && message.content === 'continue parent with new instructions'
    )
  )!;
  expect(effectiveInstructions(parent)).toContain('REPLACEMENT_HOST_INSTRUCTION');
});

it('does not collect a direct child from another workspace into the parent context', async () => {
  let agent!: Agent;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], () => answer());
  agent = setup.agent;
  expect((await setup.session.run({ prompt: 'activate parent' }).result()).status).toBe(
    'completed'
  );
  const foreign = await agent.createSession({
    workspace: `${setup.home}/other`,
    parentSessionId: setup.session.id
  });
  expect((await foreign.run({ prompt: 'foreign child work' }).result()).status).toBe('completed');
  expect((await setup.session.run({ prompt: 'continue parent' }).result()).status).toBe(
    'completed'
  );
  const messages = setup.adapter.requests.at(-1)!.messages;
  expect(messages.some((message) => message.content.includes(foreign.id))).toBe(false);
});

it('admits an oversized escaped child result through the real Core context provider', async () => {
  let agent!: Agent;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) =>
    request.messages.some(
      (message) => message.role === 'user' && message.content.includes('child long result')
    )
      ? [
          { type: 'text.completed', itemId: 'final', text: '<'.repeat(8192) },
          { type: 'completed', reason: 'completed' }
        ]
      : answer()
  );
  agent = setup.agent;
  expect((await setup.session.run({ prompt: 'activate parent' }).result()).status).toBe(
    'completed'
  );
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  expect((await child.run({ prompt: 'child long result' }).result()).status).toBe('completed');
  expect((await setup.session.run({ prompt: 'continue parent' }).result()).status).toBe(
    'completed'
  );
  const update = setup.adapter.requests
    .at(-1)!
    .messages.find((message) => message.content.includes('<mar_subagent_update>'));
  expect(update).toBeDefined();
  expect(Buffer.byteLength(update!.content)).toBeLessThanOrEqual(32768);
  expect(update!.content).toContain('"summaryTruncated":true');
});

it('does not wake a sleeping parent when a child only reaches a terminal state', async () => {
  let agent!: Agent;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (
      text.includes('sleeping parent') &&
      !request.messages.some((message) => message.role === 'tool')
    )
      return call('sleep', { durationMs: 250 });
    if (text.includes('child without message')) return call('sleep', { durationMs: 300000 });
    return answer();
  });
  agent = setup.agent;
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  const childRun = child.run({ prompt: 'child without message' });
  const childSleeping = Promise.withResolvers<void>();
  const childListener = child.subscribe((event) => {
    if (event.type === 'tool.started' && event.toolName === 'sleep') childSleeping.resolve();
  });
  await childSleeping.promise;
  const parentRun = setup.session.run({ prompt: 'sleeping parent' });
  const parentSleeping = Promise.withResolvers<void>();
  const collected = (async () => {
    const events = [];
    for await (const event of parentRun) {
      events.push(event);
      if (event.type === 'tool.started' && event.toolName === 'sleep') parentSleeping.resolve();
    }
    return events;
  })();
  await parentSleeping.promise;
  childRun.cancel();
  expect((await childRun.result()).status).toBe('cancelled');
  expect((await parentRun.result()).status).toBe('completed');
  const sleep = (await collected).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'sleep'
  );
  expect(sleep).toMatchObject({ type: 'tool.completed', data: { wakeReason: 'elapsed' } });
  childListener.unsubscribe();
});

it('discovers an active child without reopening finished historical children', async () => {
  let agent!: Agent;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) =>
    request.messages.some((message) => message.role === 'user' && message.content === 'hold child')
      ? call('sleep', { durationMs: 300000 })
      : answer()
  );
  agent = setup.agent;
  const finished = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  expect(await finished.run({ prompt: 'finished child' }).result()).toMatchObject({
    status: 'completed'
  });
  const active = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  const execution = active.run({ prompt: 'hold child', permissionMode: 'full-access' });
  const sleeping = Promise.withResolvers<void>();
  const readEvents = (async () => {
    for await (const event of execution)
      if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
  })();
  await sleeping.promise;
  const opened = vi.spyOn(agent, 'openSession');
  expect(await setup.session.run({ prompt: 'activate parent' }).result()).toMatchObject({
    status: 'completed'
  });
  expect(opened).not.toHaveBeenCalled();
  expect(await setup.session.compact().result()).toMatchObject({ status: 'completed' });
  expect(await setup.session.run({ prompt: 'read retained resources' }).result()).toMatchObject({
    status: 'completed'
  });
  const resources =
    setup.adapter.requests
      .at(-1)!
      .messages.find((message) => message.content.includes('Child Sessions (use agent_list'))
      ?.content ?? '';
  expect(resources.includes(`"agentId":"${active.id}"`)).toBe(true);
  expect(resources.includes(`"agentId":"${finished.id}"`)).toBe(true);
  expect(resources.indexOf(active.id)).toBeLessThan(resources.indexOf(finished.id));
  expect(resources.includes('"status":"running"')).toBe(true);
  expect(resources.includes('"status":"completed"')).toBe(true);
  execution.cancel();
  expect(await execution.result()).toMatchObject({ status: 'cancelled' });
  await readEvents;
  expect(await setup.session.run({ prompt: 'continue parent' }).result()).toMatchObject({
    status: 'completed'
  });
  const update = setup.adapter.requests
    .at(-1)!
    .messages.find((message) => message.content.includes('<mar_subagent_update>'));
  expect(update?.content).toContain(active.id);
  expect(update?.content).toContain('execution.cancelled');
  expect(update?.content).not.toContain(finished.id);
  expect(await finished.run({ prompt: 'user continues child' }).result()).toMatchObject({
    status: 'completed'
  });
  expect(await setup.session.run({ prompt: 'continue again' }).result()).toMatchObject({
    status: 'completed'
  });
  const later = setup.adapter.requests
    .at(-1)!
    .messages.findLast((message) => message.content.includes('<mar_subagent_update>'));
  expect(later?.content).toContain(finished.id);
});

it('starts an eligible direct child through the independent extension', async () => {
  let agent!: Agent;
  const {
    agent: created,
    session,
    adapter
  } = await fixture([createSubagentExtension({ agent: () => agent })], (_request, index) =>
    index === 0
      ? call('agent_start', {
          title: 'Inspect',
          description: 'Inspect',
          prompt: 'Inspect the file',
          role: 'general-purpose'
        })
      : answer()
  );
  agent = created;
  await agent.reconfigureModels({ models: [{ ...adapter.configuration, subagentModel: true }] });
  let childId: string | undefined;
  const terminal = Promise.withResolvers<void>();
  const registration = agent.observeSessionExecutions((child) => {
    if (child.source.parentSessionId !== session.id) return;
    childId = child.id;
    child.subscribe((event) => {
      if (event.type === 'execution.completed') terminal.resolve();
    });
  });
  const parent = session.run({ prompt: 'delegate', permissionMode: 'auto' });
  const events: unknown[] = [];
  const readParent = (async () => {
    for await (const event of parent) events.push(event);
  })();
  expect(await parent.result()).toMatchObject({ status: 'completed' });
  await readParent;
  expect(
    childId,
    JSON.stringify(events.filter((event) => (event as { type?: string }).type?.startsWith('tool.')))
  ).toBeDefined();
  await terminal.promise;
  registration.unsubscribe();
  expect((await agent.getSession(childId!)).source).toMatchObject({
    type: 'subagent',
    parentSessionId: session.id,
    rootSessionId: session.id,
    description: 'Inspect'
  });
  expect(
    adapter.requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.includes('Inspect the file') &&
          message.content.includes('Message from the parent session.')
      )
    )
  ).toBe(true);
  const childRequest = adapter.requests.find((request) =>
    request.messages.some(
      (message) => message.role === 'user' && message.content.includes('Inspect the file')
    )
  )!;
  expect(effectiveInstructions(childRequest)).toContain('delegated subagent');
  expect(effectiveInstructions(childRequest)).not.toContain('non-recursive subagent');
  expect(childRequest.tools.some((tool) => tool.name === 'agent_start')).toBe(true);
  const sleep = childRequest.tools.find((tool) => tool.name === 'sleep')!;
  expect(sleep.inputSchema.properties).toHaveProperty('permission');
});

it('starts an eligible child from a real Code Mode cell with the supplied title', async () => {
  let agent!: Agent;
  const setup = await fixture(
    [createSubagentExtension({ agent: () => agent })],
    (_request, index) =>
      index === 0
        ? call('code_exec', {
            code: "const result = await tools.agent_start({title:'  Programmatic child  ',prompt:'inspect',role:'general-purpose'}); observe.text(result.data.agentId);"
          })
        : answer(),
    true
  );
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const execution = setup.session.run({ prompt: 'delegate', permissionMode: 'full-access' });
  const events = (async () => {
    const all = [];
    for await (const event of execution) all.push(event);
    return all;
  })();
  expect((await execution.result()).status).toBe('completed');
  const completed = (await events).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'code_exec'
  );
  expect(completed?.type).toBe('tool.completed');
  if (completed?.type !== 'tool.completed') throw new Error('Missing cell result');
  const cell = JSON.parse(completed.summary) as { observations: Array<{ value: string }> };
  const child = await agent.getSession(cell.observations[0]!.value);
  expect(child.title).toBe('Programmatic child');
  expect(child.source.parentSessionId).toBe(setup.session.id);
});

it.each([undefined, '', '   '])(
  'rejects model child title %j before Session creation',
  async (title) => {
    let agent!: Agent;
    const setup = await fixture(
      [createSubagentExtension({ agent: () => agent })],
      (_request, index) =>
        index === 0
          ? call('agent_start', {
              ...(title === undefined ? {} : { title }),
              prompt: 'child',
              role: 'general-purpose'
            })
          : answer()
    );
    agent = setup.agent;
    await agent.reconfigureModels({
      models: [{ ...setup.adapter.configuration, subagentModel: true }]
    });
    const execution = setup.session.run({ prompt: 'delegate', permissionMode: 'auto' });
    const events = (async () => {
      const all = [];
      for await (const event of execution) all.push(event);
      return all;
    })();
    await execution.result();
    expect(await events).toContainEqual(
      expect.objectContaining({ type: 'tool.failed', toolName: 'agent_start' })
    );
    expect((await agent.listSessions({ parentSessionId: setup.session.id })).sessions).toHaveLength(
      0
    );
  }
);

it('allows a child to delegate to a grandchild but rejects a fourth level before creation', async () => {
  let agent!: Agent;
  const called = new Set<string>();
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages
      .filter((item) => item.role === 'user')
      .map((item) => item.content)
      .join('\n');
    const level = text.includes('depth-three')
      ? 'three'
      : text.includes('depth-two')
        ? 'two'
        : 'one';
    if (!called.has(level)) {
      called.add(level);
      return call('agent_start', {
        title: `depth-${level}`,
        description: `depth-${level}`,
        prompt: level === 'one' ? 'depth-two' : level === 'two' ? 'depth-three' : 'depth-four',
        role: 'general-purpose'
      });
    }
    return answer();
  });
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const events: { type: string; code?: string; sessionId?: string }[] = [];
  const registration = agent.observeSessionExecutions((session) => {
    if (session.id === setup.session.id) return;
    session.subscribe((event) => {
      events.push(event);
    });
  });
  expect(
    await setup.session.run({ prompt: 'depth-one', permissionMode: 'auto' }).result()
  ).toMatchObject({ status: 'completed' });
  await vi.waitFor(
    () =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          code: 'MAR_AGENT_SUBAGENT_LIMIT'
        })
      ),
    { timeout: 5000 }
  );
  const children = await agent.listSessions({ parentSessionId: setup.session.id });
  expect(children.sessions).toHaveLength(1);
  const grandchildren = await agent.listSessions({ parentSessionId: children.sessions[0]!.id });
  expect(grandchildren.sessions).toHaveLength(1);
  expect(
    (await agent.listSessions({ parentSessionId: grandchildren.sessions[0]!.id })).sessions
  ).toHaveLength(0);
  registration.unsubscribe();
});

it('rejects an ineligible model before creating a child', async () => {
  let agent!: Agent;
  const { agent: created, session } = await fixture(
    [createSubagentExtension({ agent: () => agent })],
    (_request, index) =>
      index === 0
        ? call('agent_start', {
            title: 'Inspect',
            description: 'Inspect',
            prompt: 'Inspect the file',
            role: 'general-purpose'
          })
        : answer()
  );
  agent = created;
  const run = session.run({ prompt: 'delegate' });
  const events: { type: string; code?: string }[] = [];
  const reader = (async () => {
    for await (const event of run) events.push(event);
  })();
  await run.result();
  await reader;
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'tool.failed', code: 'MAR_AGENT_MODEL_DISABLED' })
  );
  expect((await agent.listSessions({ parentSessionId: session.id })).sessions).toEqual([]);
});

it.each(['agent_send', 'agent_stop', 'agent_wait', 'agent_view'] as const)(
  'rejects %s against an unrelated Session before opening it',
  async (name) => {
    let agent!: Agent;
    let foreignId = '';
    const setup = await fixture(
      [createSubagentExtension({ agent: () => agent })],
      (_request, index) =>
        index === 0
          ? call(name, {
              agentId: foreignId,
              ...(name === 'agent_send' ? { content: 'message' } : {}),
              ...(name === 'agent_view' ? { includeHistory: true } : {})
            })
          : answer()
    );
    agent = setup.agent;
    const foreign = await agent.createSession({ workspace: setup.home });
    foreignId = foreign.id;
    const opened = vi.spyOn(agent, 'openSession');
    const history = vi.spyOn(agent, 'sessionHistory');
    const run = setup.session.run({ prompt: 'try unrelated target' });
    const events = (async () => {
      const all = [];
      for await (const event of run) all.push(event);
      return all;
    })();
    expect((await run.result()).status).toBe('completed');
    expect(await events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolName: name,
        code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
      })
    );
    expect(opened).not.toHaveBeenCalledWith(foreignId);
    expect(history).not.toHaveBeenCalledWith(foreignId, expect.anything());
  }
);

it('rejects resuming an idle child while sixteen direct children are active', async () => {
  let agent!: Agent;
  let idleId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');
    if (text.includes('hold-active')) return call('sleep', { durationMs: 300000 });
    if (text.includes('resume-old') && !request.messages.some((message) => message.role === 'tool'))
      return call('agent_send', { agentId: idleId, content: 'Continue earlier work.' });
    return answer();
  });
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const idle = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  idleId = idle.id;
  expect((await idle.run({ prompt: 'earlier work' }).result()).status).toBe('completed');
  const executions = [];
  for (let i = 0; i < 16; i++) {
    const child = await agent.createSession({
      workspace: setup.home,
      parentSessionId: setup.session.id
    });
    executions.push(child.run({ prompt: 'hold-active', permissionMode: 'full-access' }));
  }
  try {
    const parent = setup.session.run({ prompt: 'resume-old' });
    const events: { type: string; code?: string }[] = [];
    const reader = (async () => {
      for await (const event of parent) events.push(event);
    })();
    await parent.result();
    await reader;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        code: 'MAR_AGENT_SUBAGENT_LIMIT'
      })
    );
    const registration = agent.observeSessionExecutions(() => {});
    expect(
      registration.sessions.filter((item) => item.source.parentSessionId === setup.session.id)
    ).toHaveLength(16);
    registration.unsubscribe();
  } finally {
    for (const execution of executions) execution.cancel();
    await Promise.all(executions.map((execution) => execution.result()));
  }
});

it('rejects an unsupported explicit child effort before creating a Session', async () => {
  let agent!: Agent;
  const setup = await fixture(
    [createSubagentExtension({ agent: () => agent })],
    (_request, index) =>
      index === 0
        ? call('agent_start', {
            title: 'Inspect',
            description: 'Inspect',
            prompt: 'Inspect',
            role: 'general-purpose',
            reasoningEffort: 'ultra'
          })
        : answer()
  );
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const run = setup.session.run({ prompt: 'delegate' });
  const events = (async () => {
    const values = [];
    for await (const event of run) values.push(event);
    return values;
  })();
  await run.result();
  expect(await events).toContainEqual(
    expect.objectContaining({
      type: 'tool.failed',
      code: 'MAR_AGENT_SUBAGENT_REASONING_EFFORT_UNAVAILABLE'
    })
  );
  expect((await agent.listSessions({ parentSessionId: setup.session.id })).sessions).toEqual([]);
});

it('lists children and reads public history without opening historical Sessions', async () => {
  let agent!: Agent;
  let childId = '';
  let mode: 'list' | 'view' | undefined;
  let invoked = false;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], () => {
    if (mode && !invoked) {
      invoked = true;
      return mode === 'list'
        ? call('agent_list', {})
        : call('agent_view', { agentId: childId, includeHistory: true });
    }
    return answer();
  });
  agent = setup.agent;
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  expect(await child.run({ prompt: 'historical child' }).result()).toMatchObject({
    status: 'completed'
  });
  const open = vi.spyOn(agent, 'openSession');
  for (const prompt of ['query children', 'view child']) {
    mode = prompt === 'query children' ? 'list' : 'view';
    invoked = false;
    const run = setup.session.run({ prompt });
    const events = (async () => {
      const all = [];
      for await (const event of run) all.push(event);
      return all;
    })();
    expect(await run.result()).toMatchObject({ status: 'completed' });
    const collected = await events;
    const receipt = collected.find(
      (event) =>
        event.type === 'tool.completed' &&
        event.toolName === (prompt === 'query children' ? 'agent_list' : 'agent_view')
    );
    if (receipt?.type !== 'tool.completed')
      throw new Error(
        `Query receipt missing for ${prompt}: ${JSON.stringify(collected.filter((event) => event.type.startsWith('tool.')))}`
      );
    expect(receipt.summary).toContain(childId);
    if (prompt === 'view child') expect(receipt.summary).toContain('historical child');
  }
  expect(open).not.toHaveBeenCalled();
});

it('explicitly waits on a finished child using persisted terminal history without replaying its message', async () => {
  let agent!: Agent;
  let childId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (
      text.includes('wait for child') &&
      !request.messages.some((message) => message.role === 'tool')
    )
      return call('agent_wait', { agentId: childId });
    return answer();
  });
  agent = setup.agent;
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  expect(await child.run({ prompt: 'finish before parent attaches' }).result()).toMatchObject({
    status: 'completed'
  });
  const parent = setup.session.run({ prompt: 'wait for child' });
  const events = (async () => {
    const all = [];
    for await (const event of parent) all.push(event);
    return all;
  })();
  expect(await parent.result()).toMatchObject({ status: 'completed' });
  const completed = (await events).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
  );
  if (completed?.type !== 'tool.completed') throw new Error('Wait receipt missing');
  expect(JSON.parse(completed.summary)).toMatchObject({
    agentId: childId,
    status: 'completed',
    waitFor: 'completion',
    waitOutcome: 'completion'
  });
  expect(JSON.parse(completed.summary)).not.toHaveProperty('updates');
});

it.each([0, 1])('rejects a wait for a child which has never run (waitMs=%i)', async (waitMs) => {
  let agent!: Agent;
  let childId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) =>
    request.messages.some((message) => message.role === 'tool')
      ? answer()
      : call('agent_wait', { agentId: childId, waitMs })
  );
  agent = setup.agent;
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  const run = setup.session.run({ prompt: 'wait for never-run child' });
  const events = (async () => {
    const all = [];
    for await (const event of run) all.push(event);
    return all;
  })();
  expect(await run.result()).toMatchObject({ status: 'completed' });
  expect(await events).toContainEqual(
    expect.objectContaining({
      type: 'tool.failed',
      toolName: 'agent_wait',
      code: 'MAR_AGENT_SUBAGENT_EXECUTION_NOT_FOUND'
    })
  );
});

it('reports to a warm idle parent without opening or steering it', async () => {
  let agent!: Agent;
  let parentId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (
      text.includes('report upward') &&
      !request.messages.some((message) => message.role === 'tool')
    )
      return call('agent_send', { agentId: parentId, content: 'upward report' });
    return answer();
  });
  agent = setup.agent;
  parentId = setup.session.id;
  expect(await setup.session.run({ prompt: 'warm parent' }).result()).toMatchObject({
    status: 'completed'
  });
  const child = await agent.createSession({ workspace: setup.home, parentSessionId: parentId });
  const open = vi.spyOn(agent, 'openSession');
  const steer = vi.spyOn(setup.session, 'steer');
  const run = child.run({ prompt: 'report upward' });
  const events = (async () => {
    const all = [];
    for await (const event of run) all.push(event);
    return all;
  })();
  expect(await run.result()).toMatchObject({ status: 'completed' });
  expect(
    (await events).some(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_send'
    )
  ).toBe(true);
  expect(open).not.toHaveBeenCalledWith(parentId);
  expect(steer).not.toHaveBeenCalled();
  expect(await setup.session.run({ prompt: 'continue parent' }).result()).toMatchObject({
    status: 'completed'
  });
  expect(
    setup.adapter.requests
      .at(-1)!
      .messages.some((message) => message.content.includes('upward report'))
  ).toBe(true);
});

it('rejects upward reports to a cold parent without opening it', async () => {
  let agent!: Agent;
  let parentId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) =>
    request.messages.some((message) => message.role === 'tool')
      ? answer()
      : call('agent_send', { agentId: parentId, content: 'report' })
  );
  agent = setup.agent;
  parentId = setup.session.id;
  const child = await agent.createSession({ workspace: setup.home, parentSessionId: parentId });
  const open = vi.spyOn(agent, 'openSession');
  const run = child.run({ prompt: 'report upward' });
  const events = (async () => {
    const all = [];
    for await (const event of run) all.push(event);
    return all;
  })();
  await run.result();
  expect(await events).toContainEqual(
    expect.objectContaining({
      type: 'tool.failed',
      toolName: 'agent_send',
      code: 'MAR_AGENT_SUBAGENT_PARENT_IDLE'
    })
  );
  expect(open).not.toHaveBeenCalledWith(parentId);
});

it('does not steer or wake a running parent when its child reports upward', async () => {
  let agent!: Agent;
  let parentId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (
      text.includes('child report') &&
      !request.messages.some((message) => message.role === 'tool')
    )
      return call('agent_send', { agentId: parentId, content: 'live report' });
    return call('sleep', { durationMs: 300000 });
  });
  agent = setup.agent;
  parentId = setup.session.id;
  const sleeping = Promise.withResolvers<void>();
  const parentEvents = setup.session.subscribe((event) => {
    if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
  });
  const parent = setup.session.run({ prompt: 'parent hold' });
  await sleeping.promise;
  const steer = vi.spyOn(setup.session, 'steer');
  const child = await agent.createSession({ workspace: setup.home, parentSessionId: parentId });
  const reported = Promise.withResolvers<void>();
  const childEvents = child.subscribe((event) => {
    if (event.type === 'tool.completed' && event.toolName === 'agent_send') reported.resolve();
  });
  const childRun = child.run({ prompt: 'child report' });
  await reported.promise;
  const raced = await Promise.race([
    parent.result().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50))
  ]);
  expect(raced).toBe('pending');
  expect(steer).not.toHaveBeenCalled();
  parent.cancel();
  childRun.cancel();
  await Promise.all([parent.result(), childRun.result()]);
  parentEvents.unsubscribe();
  childEvents.unsubscribe();
});

it('waits for the fixed live child execution and returns its cancellation', async () => {
  let agent!: Agent;
  let childId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (text.includes('wait parent'))
      return request.messages.some((message) => message.role === 'tool')
        ? answer()
        : call('agent_wait', { agentId: childId });
    return call('sleep', { durationMs: 300000 });
  });
  agent = setup.agent;
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  const sleeping = Promise.withResolvers<void>();
  const childEvents = child.subscribe((event) => {
    if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
  });
  const childRun = child.run({ prompt: 'hold child' });
  await sleeping.promise;
  const waiting = Promise.withResolvers<void>();
  const parentEvents = setup.session.subscribe((event) => {
    if (event.type === 'tool.started' && event.toolName === 'agent_wait') waiting.resolve();
  });
  const parent = setup.session.run({ prompt: 'wait parent' });
  const events = (async () => {
    const all = [];
    for await (const event of parent) all.push(event);
    return all;
  })();
  await waiting.promise;
  childRun.cancel();
  expect(await childRun.result()).toMatchObject({ status: 'cancelled' });
  expect(await parent.result()).toMatchObject({ status: 'completed' });
  const completed = (await events).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
  );
  if (completed?.type !== 'tool.completed') throw new Error('Wait receipt missing');
  expect(JSON.parse(completed.summary)).toMatchObject({
    agentId: childId,
    executionId: childRun.executionId,
    status: 'cancelled',
    waitOutcome: 'completion',
    waitFor: 'completion'
  });
  childEvents.unsubscribe();
  parentEvents.unsubscribe();
});

it.each(['append', 'replace'] as const)(
  'delivers %s guidance to a live child with a correlated receipt',
  async (delivery) => {
    let agent!: Agent;
    let childId = '';
    const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
      const text = request.messages.map((message) => message.content).join('\n');
      if (text.includes('root send'))
        return request.messages.some((message) => message.role === 'tool')
          ? answer()
          : call('agent_send', { agentId: childId, content: 'Please continue', delivery });
      return text.includes('Please continue') ? answer() : call('sleep', { durationMs: 300000 });
    });
    agent = setup.agent;
    await agent.reconfigureModels({
      models: [{ ...setup.adapter.configuration, subagentModel: true }]
    });
    const child = await agent.createSession({
      workspace: setup.home,
      parentSessionId: setup.session.id
    });
    childId = child.id;
    const sleeping = Promise.withResolvers<void>();
    const subscription = child.subscribe((event) => {
      if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
    });
    const childRun = child.run({ prompt: 'long child' });
    await sleeping.promise;
    const parent = setup.session.run({ prompt: 'root send' });
    const events = (async () => {
      const all = [];
      for await (const event of parent) all.push(event);
      return all;
    })();
    expect(await parent.result()).toMatchObject({ status: 'completed' });
    const completed = (await events).find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_send'
    );
    expect(completed?.type).toBe('tool.completed');
    if (completed?.type !== 'tool.completed') throw new Error('Send receipt missing');
    const receipt = JSON.parse(completed.summary) as {
      agentId: string;
      executionId: string;
      delivery: string;
      messageId: string;
      turnId: string;
      deliveryStatus: string;
    };
    expect(receipt).toMatchObject({
      agentId: childId,
      delivery: delivery === 'append' ? 'accepted' : 'started',
      messageId: expect.any(String),
      turnId: expect.any(String),
      deliveryStatus: 'accepted'
    });
    expect(await childRun.result()).toMatchObject(
      delivery === 'append' ? { status: 'completed', finalAnswer: 'done' } : { status: 'cancelled' }
    );
    const successor = child.joinExecution(receipt.executionId);
    if (successor)
      expect(await successor).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(
      setup.adapter.requests.some((request) =>
        request.messages.some((message) => message.content.includes('Please continue'))
      )
    ).toBe(true);
    const entries = (await agent.sessionHistory(childId)).entries.filter(
      (entry) => entry.kind === 'user'
    );
    const guidance = entries.find((entry) => entry.text.includes('Please continue'));
    expect(guidance).toMatchObject({
      clientMessageId: receipt.messageId,
      turnId: receipt.turnId,
      executionId: receipt.executionId
    });
    expect(guidance?.turnId === entries[0]?.turnId).toBe(delivery === 'append');
    subscription.unsubscribe();
  }
);

it('continues an idle child through its existing Session and history', async () => {
  let agent!: Agent;
  let childId = '';
  let send = false;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], () => {
    if (send) {
      send = false;
      return call('agent_send', { agentId: childId, content: 'Continue the earlier task.' });
    }
    return answer();
  });
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  expect(await child.run({ prompt: 'Earlier task' }).result()).toMatchObject({
    status: 'completed'
  });
  send = true;
  const parent = setup.session.run({ prompt: 'continue child' });
  const events = (async () => {
    const all = [];
    for await (const event of parent) all.push(event);
    return all;
  })();
  expect(await parent.result()).toMatchObject({ status: 'completed' });
  const collected = await events;
  const receipt = collected.find(
    (event) => event.type === 'tool.completed' && event.toolName === 'agent_send'
  );
  if (receipt?.type !== 'tool.completed')
    throw new Error(
      `Send receipt missing: ${JSON.stringify(collected.filter((event) => event.type.startsWith('tool.')))}`
    );
  expect(JSON.parse(receipt.summary)).toMatchObject({ agentId: childId, delivery: 'started' });
  expect(JSON.parse(receipt.summary)).toMatchObject({
    messageId: expect.any(String),
    turnId: expect.any(String),
    deliveryStatus: 'accepted'
  });
  const executionId = JSON.parse(receipt.summary).executionId as string;
  const result = child.joinExecution(executionId);
  if (result) expect(await result).toMatchObject({ status: 'completed' });
  const history = await agent.sessionHistory(childId);
  expect(
    history.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.text)
  ).toEqual([
    expect.stringContaining('Earlier task'),
    expect.stringContaining('Continue the earlier task.')
  ]);
});

it('recovers a proven input receipt for a cold child after an Agent restart', async () => {
  let agent!: Agent;
  let childId = '';
  let action: 'send' | 'wait' | undefined;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], () => {
    const next = action;
    action = undefined;
    if (next === 'send')
      return call('agent_send', { agentId: childId, content: 'Continue the child.' });
    if (next === 'wait') return call('agent_wait', { agentId: childId, waitMs: 0 });
    return answer();
  });
  agent = setup.agent;
  const model = { ...setup.adapter.configuration, subagentModel: true };
  await agent.reconfigureModels({ models: [model] });
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  await child.run({ prompt: 'Initial task' }).result();
  action = 'send';
  const sent = setup.session.run({ prompt: 'deliver' });
  const sentEvents = (async () => {
    const all = [];
    for await (const event of sent) all.push(event);
    return all;
  })();
  await sent.result();
  const sentEvent = (await sentEvents).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'agent_send'
  );
  if (sentEvent?.type !== 'tool.completed') throw new Error('Missing send receipt');
  const receipt = JSON.parse(sentEvent.summary) as {
    messageId: string;
    executionId: string;
    turnId: string;
  };
  const execution = child.joinExecution(receipt.executionId);
  if (execution) await execution;
  const parentId = setup.session.id;
  expect(
    await agent.sessionInputReceipt(childId, {
      executionId: receipt.executionId,
      source: { sessionId: parentId, extensionId: 'subagent' }
    })
  ).toMatchObject({
    clientMessageId: receipt.messageId
  });
  const userChild = await agent.createSession({ workspace: setup.home, parentSessionId: parentId });
  await userChild
    .run({ prompt: 'Direct user input', clientMessageId: 'unattributed-input' })
    .result();
  await agent.dispose();
  agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: setup.home, workspace: setup.home }),
      models: [model],
      extensions: [createSubagentExtension({ agent: () => agent })]
    },
    () => setup.adapter
  );
  try {
    const parent = await agent.openSession(parentId);
    action = 'wait';
    const waiting = parent.run({ prompt: 'inspect receipt' });
    const events = (async () => {
      const all = [];
      for await (const event of waiting) all.push(event);
      return all;
    })();
    expect((await waiting.result()).status).toBe('completed');
    const waited = (await events).find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
    );
    if (waited?.type !== 'tool.completed') throw new Error('Missing wait result');
    expect(JSON.parse(waited.summary).receipt).toMatchObject({
      clientMessageId: receipt.messageId,
      executionId: receipt.executionId,
      status: 'applied'
    });
    childId = userChild.id;
    action = 'wait';
    const other = parent.run({ prompt: 'inspect another child' });
    const otherEvents = (async () => {
      const all = [];
      for await (const event of other) all.push(event);
      return all;
    })();
    await other.result();
    const otherWait = (await otherEvents).find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
    );
    if (otherWait?.type !== 'tool.completed') throw new Error('Missing other wait result');
    expect(JSON.parse(otherWait.summary)).not.toHaveProperty('receipt');
  } finally {
    await agent.dispose();
  }
});

it('does not replace a parent send receipt with another client or user input in the same cold execution', async () => {
  let agent!: Agent;
  let childId = '';
  let action: 'send' | 'wait' | undefined;
  const clients = new Map<string, NativeSubagentClient>();
  const consumer: AgentExtension = {
    id: 'other-native-consumer',
    apiVersion: '1.0',
    serviceDependencies: [{ key: SUBAGENT_NATIVE_SERVICE }],
    attachSession(context) {
      clients.set(context.sessionId, context.services.consume(SUBAGENT_NATIVE_SERVICE)!.open());
    }
  };
  const setup = await fixture(
    [createSubagentExtension({ agent: () => agent }), consumer],
    (request) => {
      const next = action;
      action = undefined;
      if (next === 'send')
        return call('agent_send', { agentId: childId, content: 'Parent input.' });
      if (next === 'wait') return call('agent_wait', { agentId: childId, waitMs: 0 });
      return request.messages.some((message) => message.content.includes('hold child'))
        ? call('sleep', { durationMs: 300000 })
        : answer();
    }
  );
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  const sleeping = Promise.withResolvers<void>();
  const subscription = child.subscribe((event) => {
    if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
  });
  const run = child.run({ prompt: 'hold child' });
  await sleeping.promise;
  action = 'send';
  const sent = setup.session.run({ prompt: 'parent sends' });
  const events = (async () => {
    const all = [];
    for await (const event of sent) all.push(event);
    return all;
  })();
  await sent.result();
  const delivered = (await events).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'agent_send'
  );
  if (delivered?.type !== 'tool.completed') throw new Error('Missing parent send');
  const receipt = JSON.parse(delivered.summary) as { messageId: string };
  const other = await clients
    .get(setup.session.id)!
    .message({ agentId: childId, message: 'Other client input.' });
  expect(other.executionId).toBe(run.executionId);
  expect(
    await child.steer({
      expectedExecutionId: run.executionId,
      clientMessageId: 'user-message',
      prompt: 'User input after parent.'
    })
  ).toMatchObject({ status: 'accepted' });
  run.cancel();
  await run.result();
  subscription.unsubscribe();
  const parentId = setup.session.id;
  const model = { ...setup.adapter.configuration, subagentModel: true };
  await agent.dispose();
  agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: setup.home, workspace: setup.home }),
      models: [model],
      extensions: [createSubagentExtension({ agent: () => agent })]
    },
    () => setup.adapter
  );
  try {
    const parent = await agent.openSession(parentId);
    action = 'wait';
    const waiting = parent.run({ prompt: 'inspect' });
    const waitEvents = (async () => {
      const all = [];
      for await (const event of waiting) all.push(event);
      return all;
    })();
    await waiting.result();
    const waited = (await waitEvents).find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
    );
    if (waited?.type !== 'tool.completed') throw new Error('Missing wait result');
    expect(JSON.parse(waited.summary).receipt).toMatchObject({
      clientMessageId: receipt.messageId
    });
  } finally {
    await agent.dispose();
  }
});

it('restores the caller receipt after a programmatic send and Agent restart', async () => {
  let agent!: Agent;
  let childId = '';
  let action: 'send' | 'wait' | undefined;
  const setup = await fixture(
    [createSubagentExtension({ agent: () => agent })],
    () => {
      const next = action;
      action = undefined;
      if (!next) return answer();
      const args =
        next === 'send'
          ? { agentId: childId, content: 'Programmatic input.' }
          : { agentId: childId, waitMs: 0 };
      return call('code_exec', {
        code: `const result = await tools.agent_${next}(${JSON.stringify(args)}); observe.text(JSON.stringify(result.data));`
      });
    },
    true
  );
  agent = setup.agent;
  const model = { ...setup.adapter.configuration, subagentModel: true };
  await agent.reconfigureModels({ models: [model] });
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  await child.run({ prompt: 'Initial task' }).result();
  const invoke = async (session: typeof setup.session, next: 'send' | 'wait') => {
    action = next;
    const run = session.run({ prompt: next, permissionMode: 'full-access' });
    const events = (async () => {
      const all = [];
      for await (const event of run) all.push(event);
      return all;
    })();
    expect((await run.result()).status).toBe('completed');
    const completed = (await events).find(
      (event) => event.type === 'tool.completed' && event.toolName === 'code_exec'
    );
    if (completed?.type !== 'tool.completed') throw new Error('Missing code execution result');
    const cell = JSON.parse(completed.summary) as { observations: Array<{ value: string }> };
    return JSON.parse(cell.observations[0]!.value);
  };
  const sent = (await invoke(setup.session, 'send')) as { messageId: string; executionId: string };
  const execution = child.joinExecution(sent.executionId);
  if (execution) await execution;
  const parentId = setup.session.id;
  await agent.dispose();
  agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: setup.home, workspace: setup.home }),
      models: [model],
      extensions: [createSubagentExtension({ agent: () => agent })]
    },
    () => setup.adapter
  );
  try {
    const parent = await agent.openSession(parentId);
    expect(await invoke(parent, 'wait')).toMatchObject({
      receipt: {
        clientMessageId: sent.messageId,
        executionId: sent.executionId
      }
    });
  } finally {
    await agent.dispose();
  }
});

it('chooses the latest created cold child for an untargeted wait after an older child runs again', async () => {
  let agent!: Agent;
  let wait = false;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], () => {
    if (!wait) return answer();
    wait = false;
    return call('agent_wait', { waitMs: 0 });
  });
  agent = setup.agent;
  const older = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  await older.run({ prompt: 'old first run' }).result();
  // Session timestamps have millisecond precision; ensure distinct creation times.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  await newer.run({ prompt: 'new child' }).result();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await older.run({ prompt: 'old later run' }).result();
  const rootId = setup.session.id;
  await agent.dispose();
  agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: setup.home, workspace: setup.home }),
      models: [setup.adapter.configuration],
      extensions: [createSubagentExtension({ agent: () => agent })]
    },
    () => setup.adapter
  );
  try {
    const root = await agent.openSession(rootId);
    wait = true;
    const run = root.run({ prompt: 'inspect children' });
    const events = (async () => {
      const all = [];
      for await (const event of run) all.push(event);
      return all;
    })();
    expect((await run.result()).status).toBe('completed');
    const completed = (await events).find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
    );
    if (completed?.type !== 'tool.completed') throw new Error('Missing wait result');
    expect(JSON.parse(completed.summary)).toMatchObject({ agentId: newer.id, status: 'completed' });
  } finally {
    await agent.dispose();
  }
});

it('uses real Session activity order for the sixteen recent child resources', async () => {
  let agent!: Agent;
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], () => answer());
  agent = setup.agent;
  const children = [];
  for (let index = 0; index < 17; index++) {
    const child = await agent.createSession({
      workspace: setup.home,
      parentSessionId: setup.session.id
    });
    expect((await child.run({ prompt: `initial child ${index}` }).result()).status).toBe(
      'completed'
    );
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect((await children[0]!.run({ prompt: 'old child runs again' }).result()).status).toBe(
    'completed'
  );
  const [resource] = await childResources(
    agent,
    setup.session.id,
    new AbortController().signal,
    () => false
  );
  const data = JSON.parse(resource!.slice(resource!.indexOf('{'))) as {
    children: Array<{ agentId: string }>;
  };
  expect(data.children).toHaveLength(16);
  expect(data.children[0]?.agentId).toBe(children[0]!.id);
  expect(data.children.some((child) => child.agentId === children[1]!.id)).toBe(false);
});

it('projects a real child final answer and changed file from public history', async () => {
  let agent!: Agent;
  let childId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');
    if (text.includes('inspect child result'))
      return request.messages.some((message) => message.role === 'tool')
        ? answer()
        : call('agent_wait', { agentId: childId });
    if (!request.messages.some((message) => message.role === 'tool'))
      return call('apply_patch', {
        patch: '*** Begin Patch\n*** Add File: child-created.txt\n+child content\n*** End Patch'
      });
    return [
      { type: 'text.completed', itemId: 'answer', text: 'Finished child work.' },
      { type: 'completed', reason: 'completed' }
    ];
  });
  agent = setup.agent;
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  expect((await child.run({ prompt: 'child task' }).result()).status).toBe('completed');
  const rootId = setup.session.id;
  await agent.dispose();
  agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: setup.home, workspace: setup.home }),
      models: [setup.adapter.configuration],
      extensions: [createSubagentExtension({ agent: () => agent })]
    },
    () => setup.adapter
  );
  try {
    const root = await agent.openSession(rootId);
    const run = root.run({ prompt: 'inspect child result' });
    const events = (async () => {
      const all = [];
      for await (const event of run) all.push(event);
      return all;
    })();
    expect((await run.result()).status).toBe('completed');
    const receipt = (await events).find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
    );
    if (receipt?.type !== 'tool.completed') throw new Error('Missing wait receipt');
    expect(JSON.parse(receipt.summary)).toMatchObject({
      status: 'completed',
      summary: 'Finished child work.',
      changedFiles: [expect.stringContaining('child-created.txt')],
      turnId: expect.any(String)
    });
  } finally {
    await agent.dispose();
  }
});

it.each(['completed', 'cancelled'] as const)(
  'restores a %s child after Agent restart without replaying old progress',
  async (previous) => {
    let agent!: Agent;
    let childId = '';
    const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
      const text = request.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n');
      if (
        text.includes('parent restart') &&
        !request.messages.some((message) => message.role === 'tool')
      )
        return call('agent_send', { agentId: childId, content: 'Resume after restart.' });
      if (
        previous === 'cancelled' &&
        text.includes('hold before restart') &&
        !text.includes('Resume after restart.')
      )
        return call('sleep', { durationMs: 300000 });
      return answer();
    });
    agent = setup.agent;
    const model = { ...setup.adapter.configuration, subagentModel: true };
    await agent.reconfigureModels({ models: [model] });
    const child = await agent.createSession({
      workspace: setup.home,
      parentSessionId: setup.session.id
    });
    childId = child.id;
    const first = child.run({
      prompt: previous === 'cancelled' ? 'hold before restart' : 'earlier child'
    });
    if (previous === 'cancelled') {
      const ready = Promise.withResolvers<void>();
      const subscription = child.subscribe((event) => {
        if (event.type === 'tool.started' && event.toolName === 'sleep') ready.resolve();
      });
      await ready.promise;
      first.cancel();
      subscription.unsubscribe();
    }
    expect((await first.result()).status).toBe(previous);
    const rootId = setup.session.id;
    await agent.dispose();
    agent = await createAgentWithAdapter(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: setup.home, workspace: setup.home }),
        models: [model],
        extensions: [createSubagentExtension({ agent: () => agent })]
      },
      () => setup.adapter
    );
    try {
      const root = await agent.openSession(rootId);
      const run = root.run({ prompt: 'parent restart' });
      const events = (async () => {
        const all = [];
        for await (const event of run) all.push(event);
        return all;
      })();
      expect((await run.result()).status).toBe('completed');
      const receipt = (await events).find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_send'
      );
      if (receipt?.type !== 'tool.completed') throw new Error('Missing resume receipt');
      const result = JSON.parse(receipt.summary) as {
        agentId: string;
        delivery: string;
        executionId: string;
      };
      expect(result).toMatchObject({ agentId: childId, delivery: 'started' });
      const parentRequest = setup.adapter.requests.find((request) =>
        request.messages.some(
          (message) => message.role === 'user' && message.content === 'parent restart'
        )
      )!;
      expect(
        parentRequest.messages.some((message) => message.content.includes('<mar_subagent_update>'))
      ).toBe(false);
      const joined = (await agent.openSession(childId)).joinExecution(result.executionId);
      if (joined) expect((await joined).status).toBe('completed');
      const history = await agent.sessionHistory(childId);
      expect(
        history.entries.some(
          (entry) => entry.kind === 'user' && entry.text.includes('Resume after restart.')
        )
      ).toBe(true);
    } finally {
      await agent.dispose();
    }
  }
);

it.each(['single', 'default', 'group'] as const)(
  'accepts nullable optional wait fields in the assembled extension (%s)',
  async (selection) => {
    let agent!: Agent;
    let childId = '';
    const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
      const isParent = request.messages.some(
        (message) => message.role === 'user' && message.content === 'nullable wait'
      );
      if (isParent && !request.messages.some((message) => message.role === 'tool'))
        return call('agent_wait', {
          agentId: selection === 'single' ? childId : null,
          agentIds: selection === 'group' ? [childId] : null,
          mode: null,
          waitFor: null,
          waitMs: 0
        });
      return answer();
    });
    agent = setup.agent;
    const child = await agent.createSession({
      workspace: setup.home,
      parentSessionId: setup.session.id
    });
    childId = child.id;
    expect((await child.run({ prompt: 'finished child' }).result()).status).toBe('completed');
    const run = setup.session.run({ prompt: 'nullable wait' });
    const events = (async () => {
      const all = [];
      for await (const event of run) all.push(event);
      return all;
    })();
    expect((await run.result()).status).toBe('completed');
    const completed = (await events).find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
    );
    if (completed?.type !== 'tool.completed') throw new Error('Missing wait result');
    expect(JSON.parse(completed.summary)).toMatchObject(
      selection === 'group'
        ? {
            mode: 'any',
            waitFor: 'completion',
            waitOutcome: 'snapshot',
            agents: [{ agentId: childId }]
          }
        : { agentId: childId, waitFor: 'completion', waitOutcome: 'snapshot' }
    );
  }
);

it('keeps an idle explore child in read-only plan mode when continuing', async () => {
  let agent!: Agent;
  let childId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (
      text.includes('continue explore') &&
      !request.messages.some((message) => message.role === 'tool')
    )
      return call('agent_send', { agentId: childId, content: 'Inspect the next file.' });
    return answer();
  });
  agent = setup.agent;
  await agent.reconfigureModels({
    models: [{ ...setup.adapter.configuration, subagentModel: true }]
  });
  const child = await agent.createSession({
    workspace: setup.home,
    source: {
      type: 'subagent',
      parentSessionId: setup.session.id,
      rootSessionId: setup.session.id,
      parentExecutionId: 'parent-execution',
      role: 'explore',
      description: 'Inspect'
    }
  });
  childId = child.id;
  let onStarted!: (event: AgentEvent) => void;
  const childStarted = new Promise<AgentEvent>((resolve) => {
    onStarted = resolve;
  });
  const subscription = child.subscribe((event) => {
    if (event.type === 'execution.started') onStarted(event);
  });
  const parent = setup.session.run({ prompt: 'continue explore' });
  const events = (async () => {
    const values = [];
    for await (const event of parent) values.push(event);
    return values;
  })();
  await parent.result();
  expect(
    (await events).some(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_send'
    )
  ).toBe(true);
  const started = await childStarted;
  expect(started).toMatchObject({ type: 'execution.started', mode: 'plan' });
  await child.joinExecution(started.executionId);
  subscription.unsubscribe();
});

it('stops the exact live direct-child Execution and waits for cleanup', async () => {
  let agent!: Agent;
  let childId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (text.includes('root stop'))
      return request.messages.some((message) => message.role === 'tool')
        ? answer()
        : call('agent_stop', { agentId: childId });
    return call('sleep', { durationMs: 300000 });
  });
  agent = setup.agent;
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  const sleeping = Promise.withResolvers<void>();
  const subscription = child.subscribe((event) => {
    if (event.type === 'tool.started' && event.toolName === 'sleep') sleeping.resolve();
  });
  const childRun = child.run({ prompt: 'long child' });
  await sleeping.promise;
  const parent = setup.session.run({ prompt: 'root stop' });
  const events = (async () => {
    const all = [];
    for await (const event of parent) all.push(event);
    return all;
  })();
  expect(await parent.result()).toMatchObject({ status: 'completed' });
  const completed = (await events).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'agent_stop'
  );
  expect(completed?.type).toBe('tool.completed');
  if (completed?.type !== 'tool.completed') throw new Error('Stop receipt missing');
  expect(JSON.parse(completed.summary)).toMatchObject({
    agentId: childId,
    executionId: childRun.executionId,
    status: 'cancelled'
  });
  expect(await childRun.result()).toMatchObject({ status: 'cancelled' });
  expect(child.joinExecution(childRun.executionId)).toBeUndefined();
  subscription.unsubscribe();
});

it('returns the latest terminal status when the model stops an idle child', async () => {
  let agent!: Agent;
  let childId = '';
  const setup = await fixture([createSubagentExtension({ agent: () => agent })], (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (text.includes('stop idle child'))
      return request.messages.some((message) => message.role === 'tool')
        ? answer()
        : call('agent_stop', { agentId: childId });
    return answer();
  });
  agent = setup.agent;
  const child = await agent.createSession({
    workspace: setup.home,
    parentSessionId: setup.session.id
  });
  childId = child.id;
  const childRun = child.run({ prompt: 'finish child' });
  expect((await childRun.result()).status).toBe('completed');
  const parent = setup.session.run({ prompt: 'stop idle child' });
  const events = (async () => {
    const all = [];
    for await (const event of parent) all.push(event);
    return all;
  })();
  expect((await parent.result()).status).toBe('completed');
  const completed = (await events).find(
    (event) => event.type === 'tool.completed' && event.toolName === 'agent_stop'
  );
  if (completed?.type !== 'tool.completed') throw new Error('Stop receipt missing');
  expect(JSON.parse(completed.summary)).toMatchObject({
    agentId: childId,
    executionId: childRun.executionId,
    status: 'completed'
  });
});
