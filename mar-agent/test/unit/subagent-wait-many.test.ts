import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/runtime/events.js';
import type { ExecutionResult } from '../../src/runtime/contracts.js';
import { SubagentSessionController } from '../../src/subagent/session-controller.js';
import { executeAgentWait } from '../../src/tools/agent/agent-wait.js';
import type { ToolRuntimeContext } from '../../src/tools/runtime-context.js';
import type { ExtensionAgentsApi, ExtensionAgentCompletion } from '../../src/extensions.js';
import {
  fixture as sdkFixture,
  answer,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { createTestSubagents } from './support/subagent-controller.js';
import { normalizeContextGcSubagentSnapshot } from '../../src/session/context-gc-subagent.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await cleanupCoreFixtures();
});

describe('multi-agent SDK integration', () => {
  it.each(['completion', 'message'] as const)(
    'passes %s group waits through real model tool dispatch and durable events',
    async (waitFor) => {
      let parentCalls = 0;
      let groupResult: unknown;
      const facts: ExtensionAgentCompletion[] = [];
      const f = await sdkFixture(
        [
          {
            id: 'group-observer',
            apiVersion: '1.0',
            attachSession: (context) => {
              if (context.agents)
                context.hooks.observe('agent.completed', (fact) => {
                  facts.push(fact);
                });
            }
          }
        ],
        (request) => {
          if (
            request.messages.some(
              (message) =>
                message.role === 'user' &&
                /Inspect [ab] independently[.]/.test(String(message.content))
            )
          )
            return answer();
          if (parentCalls++ === 0)
            return [
              ...['a', 'b'].map((id) => ({
                type: 'client_tool.call' as const,
                name: 'agent_start',
                callId: id,
                arguments: {
                  description: `Inspect ${id}`,
                  prompt: `Inspect ${id} independently.`,
                  role: 'explore'
                }
              })),
              { type: 'completed', reason: 'tool_use' }
            ];
          if (parentCalls === 2) {
            const ids = request.messages
              .filter((message) => message.role === 'tool')
              .map((message) => JSON.parse(String(message.content)).agentId);
            expect(ids).toHaveLength(2);
            return [
              {
                type: 'client_tool.call',
                name: 'agent_wait',
                callId: 'group-wait',
                arguments: { agentIds: ids, mode: 'all', waitFor, waitMs: 300000 }
              },
              { type: 'completed', reason: 'tool_use' }
            ];
          }
          const resultMessage = request.messages.findLast((message) => message.role === 'tool');
          groupResult = JSON.parse(String(resultMessage?.content));
          return answer();
        },
        false,
        true
      );
      const execution = f.session.run({ prompt: 'Delegate both inspections and join.' });
      const events: AgentEvent[] = [];
      for await (const event of execution) events.push(event);
      const executionResult = await execution.result();
      expect(executionResult, JSON.stringify(executionResult)).toHaveProperty(
        'status',
        'completed'
      );
      expect(groupResult).toMatchObject({
        mode: 'all',
        waitFor,
        pendingAgentIds: []
      });
      const agents = (
        groupResult as { agents: Array<{ summary?: string; latestMessage?: { text: string } }> }
      ).agents;
      expect(agents).toHaveLength(2);
      for (const agent of agents) expect(agent.summary ?? agent.latestMessage?.text).toBe('done');
      if (waitFor === 'completion')
        expect(groupResult).toMatchObject({
          waitOutcome: 'completion',
          agents: [
            { status: 'completed', summary: 'done' },
            { status: 'completed', summary: 'done' }
          ]
        });
      const waitEvent = events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      );
      expect(waitEvent).toMatchObject({ data: groupResult });
      expect(facts.filter((fact) => fact.operation === 'wait')).toHaveLength(2);
      const store = await JsonlSessionStore.open(f.home);
      const records = await store.read(f.session.id);
      const durable = records.find(
        (record) => record.type === 'tool.completed' && record.payload.toolName === 'agent_wait'
      );
      expect(durable?.payload).toMatchObject({ data: { mode: 'all', pendingAgentIds: [] } });
      // A whole group must never be reclaimed as if it were one Agent's snapshot.
      if (waitEvent?.type !== 'tool.completed') throw new Error('Missing wait event.');
      expect(
        normalizeContextGcSubagentSnapshot(JSON.stringify(waitEvent.data), waitEvent, 'agent_wait')
      ).toBeUndefined();
    }
  );

  it('shares group waits across native and tool entry points without stealing each other’s terminal evidence', async () => {
    let api!: ExtensionAgentsApi;
    let modelIds: string[] | undefined;
    let modelWaited = false;
    let modelResult: unknown;
    const facts: ExtensionAgentCompletion[] = [];
    const f = await sdkFixture(
      [
        {
          id: 'native-groups',
          apiVersion: '1.0',
          attachSession: (context) => {
            if (context.agents) {
              api = context.agents;
              context.hooks.observe('agent.completed', (fact) => {
                facts.push(fact);
              });
            }
          }
        }
      ],
      (request) => {
        if (request.system.includes('non-recursive subagent') || !modelIds) return answer();
        if (!modelWaited) {
          modelWaited = true;
          return [
            {
              type: 'client_tool.call',
              name: 'agent_wait',
              callId: 'model-group',
              arguments: { agentIds: modelIds, mode: 'all', waitMs: 10000 }
            },
            { type: 'completed', reason: 'tool_use' }
          ];
        }
        modelResult = JSON.parse(
          String(request.messages.findLast((message) => message.role === 'tool')?.content)
        );
        return answer();
      },
      false,
      true
    );
    await f.session.run({ prompt: 'initialize' }).result();
    const a = await api.spawn({ prompt: 'first', background: false });
    const b = await api.spawn({ prompt: 'second', background: false });
    if (!('agentId' in a) || !('agentId' in b)) throw new Error('Expected children.');
    // Spawn has already observed native terminal evidence for this extension.
    const native = await api.wait({ agentIds: [a.agentId, b.agentId], mode: 'all', waitMs: 1000 });
    expect(native.waitOutcome).toBe('completion');
    expect(native.agents.every((agent) => agent.summary === undefined)).toBe(true);
    modelIds = [a.agentId, b.agentId];
    expect(await f.session.run({ prompt: 'Join the existing children.' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(modelResult).toMatchObject({
      agents: [
        { agentId: a.agentId, status: 'completed' },
        { agentId: b.agentId, status: 'completed' }
      ]
    });
    const updates = f.adapter.requests
      .flatMap((request) => request.messages)
      .filter(
        (message) =>
          message.contextKind === 'contextual' &&
          message.content.startsWith('<mar_subagent_update ')
      );
    for (const child of [a, b])
      expect(
        updates.some(
          (message) =>
            message.content.includes(child.agentId) &&
            message.content.includes('<summary>done</summary>') &&
            !message.content.includes('<message ')
        )
      ).toBe(true);
    for (const result of (modelResult as { agents: Record<string, unknown>[] }).agents)
      expect(result).not.toHaveProperty('summary');
    expect(facts.filter((fact) => fact.operation === 'wait')).toHaveLength(4);
    await expect(api.wait({ agentIds: [a.agentId], untilSettled: true })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
  });

  it('reports completion for already settled controller tasks even when waiting for messages', async () => {
    const scheduler = await createTestSubagents(async () => ({
      summary: 'done',
      changedFiles: [],
      evidence: [],
      verification: []
    }));
    cleanups.push(() => scheduler.dispose());
    const a = await scheduler.run({ description: 'a', prompt: 'a', role: 'explore' });
    const b = await scheduler.run({ description: 'b', prompt: 'b', role: 'explore' });
    expect(
      await scheduler.outputMany([a.agentId, b.agentId], { mode: 'all', waitMs: 10000 })
    ).toMatchObject({ waitOutcome: 'completion', pendingAgentIds: [] });
    await expect(
      scheduler.outputMany([a.agentId], { waitFor: 'message', waitMs: 10000 })
    ).resolves.toMatchObject({ waitOutcome: 'completion', pendingAgentIds: [] });
  });
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function childTurn(turnId: string) {
  const events: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let resolve!: (value: ExecutionResult) => void;
  const result = new Promise<ExecutionResult>((done) => (resolve = done));
  const finish = (status: ExecutionResult['status'] = 'completed') => {
    closed = true;
    wake?.();
    resolve({ executionId: turnId, status, finalAnswer: `finished ${turnId}` });
  };
  return {
    emit(event: AgentEvent) {
      events.push(event);
      wake?.();
    },
    message(text: string) {
      events.push({
        type: 'message.completed',
        itemId: text,
        turnId,
        phase: 'commentary',
        text,
        timestamp: new Date().toISOString()
      } as AgentEvent);
      wake?.();
    },
    finish,
    handle: {
      turnId,
      executionId: turnId,
      async *[Symbol.asyncIterator]() {
        while (!closed || events.length) {
          const event = events.shift();
          if (event) yield event;
          else if (!closed) await new Promise<void>((done) => (wake = done));
        }
      },
      result: () => result,
      cancel: () => finish('cancelled'),
      enqueueMessage: () => false
    }
  };
}

async function fixture() {
  let sequence = 0;
  const turns = new Map<string, ReturnType<typeof childTurn>>();
  const controller = await SubagentSessionController.open({
    parentSessionId: 'parent',
    rootSessionId: 'parent',
    backend: {
      createSession: async () => ({ id: `child-${++sequence}` }),
      deleteSession: async () => {},
      listChildren: async () => [],
      loadChild: async () => undefined
    }
  });
  cleanups.push(() => controller.dispose());
  await controller.beginParentExecution({
    executionId: 'parent-execution',
    modelId: 'model',
    reasoningEffort: 'low',
    models: new Map([
      [
        'model',
        { id: 'model', name: 'Model', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }
      ]
    ]),
    emitTerminal: async () => {},
    startTurn: async ({ sessionId, turnId }) => {
      const turn = childTurn(turnId);
      turns.set(sessionId, turn);
      return turn.handle;
    }
  });
  const spawn = async () => {
    const agent = await controller.run({
      description: 'Child',
      prompt: 'Inspect independently.',
      role: 'explore',
      background: true
    });
    await tick();
    return { id: agent.agentId, turn: turns.get(agent.agentId)! };
  };
  return { controller, spawn, turns };
}

describe('explicit multi-agent waiting', () => {
  it('exposes non-consuming public-message notifications without waking for tools or terminal-only changes', async () => {
    const { controller, spawn } = await fixture();
    const first = await spawn();
    let notifications = 0;
    const unsubscribe = controller.modelMessages.subscribe(() => notifications++);
    expect(controller.modelMessages.pending()).toBe(false);
    first.turn.emit({ type: 'tool.started', toolName: 'read', callId: 'read' } as AgentEvent);
    first.turn.finish();
    await tick();
    expect(notifications).toBe(0);
    expect(controller.modelMessages.pending()).toBe(false);
    const second = await spawn();
    second.turn.message('new public progress');
    await tick();
    expect(notifications).toBe(1);
    expect(controller.modelMessages.pending()).toBe(true);
    const updates = controller.collectModelUpdates();
    expect(
      updates.some((update) => update.snapshot.latestMessage?.text === 'new public progress')
    ).toBe(true);
    expect(controller.modelMessages.pending()).toBe(true);
    for (const update of updates) update.acknowledge();
    expect(controller.modelMessages.pending()).toBe(false);
    unsubscribe();
    second.turn.message('after unsubscribe');
    await tick();
    expect(notifications).toBe(1);
  });

  it('treats nullable optional fields as omitted for single, untargeted and default-any group waits', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn();
    const context = {
      subagents: controller,
      signal: new AbortController().signal
    } as ToolRuntimeContext;
    const defaults = { mode: null, waitFor: null, waitMs: 0 };
    for (const agentId of [a.id, null]) {
      const single = await executeAgentWait({ ...defaults, agentId, agentIds: null }, context);
      expect(single.data).toMatchObject({ agentId: a.id, waitOutcome: 'snapshot' });
    }
    const group = await executeAgentWait({ ...defaults, agentId: null, agentIds: [a.id] }, context);
    expect(group.data).toMatchObject({
      mode: 'any',
      waitFor: 'completion',
      waitOutcome: 'snapshot',
      agents: [expect.objectContaining({ agentId: a.id })]
    });
  });

  it('waits for any selected agent, excluding other live children, through the model tool', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn(),
      b = await spawn(),
      other = await spawn();
    let settled = false;
    const waiting = executeAgentWait(
      { agentIds: [b.id, a.id], mode: 'any', waitFor: 'completion', waitMs: 300000 },
      { subagents: controller, signal: new AbortController().signal } as ToolRuntimeContext
    ).then((value) => {
      settled = true;
      return value;
    });
    b.turn.message('unconsumed candidate progress');
    other.turn.finish();
    await tick();
    expect(settled).toBe(false);
    a.turn.finish();
    const result = (await waiting).data;
    expect(result).toMatchObject({
      mode: 'any',
      waitFor: 'completion',
      waitOutcome: 'completion',
      pendingAgentIds: [b.id],
      agents: [
        { agentId: b.id, status: 'running', waitOutcome: 'snapshot' },
        { agentId: a.id, status: 'completed', waitOutcome: 'completion' }
      ]
    });
    expect(controller.listSessionResources().find((item) => item.agentId === b.id)?.status).toBe(
      'running'
    );
    expect(await controller.output(b.id, { waitFor: 'message', waitMs: 10000 })).toHaveProperty(
      'latestMessage.text',
      'unconsumed candidate progress'
    );
  });

  it('waits for all terminal states and accepts already finished, failed and cancelled children', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn(),
      b = await spawn(),
      c = await spawn();
    a.turn.finish();
    await tick();
    let settled = false;
    const waiting = controller
      .outputMany([a.id, b.id, c.id], { mode: 'all', waitMs: 300000 })
      .then((value) => {
        settled = true;
        return value;
      });
    b.turn.finish('failed');
    await tick();
    expect(settled).toBe(false);
    await controller.cancel(c.id);
    expect(await waiting).toMatchObject({
      waitOutcome: 'completion',
      pendingAgentIds: [],
      agents: [{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }]
    });
  });

  it('collects one unread message or completion per child, coalesces progress and ignores tools', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn(),
      b = await spawn();
    let settled = false;
    const waiting = controller
      .outputMany([a.id, b.id], { mode: 'all', waitFor: 'message', waitMs: 300000 })
      .then((value) => {
        settled = true;
        return value;
      });
    a.turn.message('first');
    await tick();
    a.turn.message('latest');
    b.turn.emit({
      type: 'tool.completed',
      toolName: 'read',
      callId: 'read',
      timestamp: new Date().toISOString()
    } as AgentEvent);
    await tick();
    expect(settled).toBe(false);
    b.turn.finish();
    expect(await waiting).toMatchObject({
      waitOutcome: 'message',
      pendingAgentIds: [],
      agents: [
        { latestMessage: { text: 'latest' }, waitOutcome: 'message' },
        { waitOutcome: 'completion' }
      ]
    });
    const abort = new AbortController();
    const next = controller.output(a.id, {
      waitFor: 'message',
      waitMs: 300000,
      signal: abort.signal
    });
    await tick();
    abort.abort(new Error('stop observing'));
    await expect(next).rejects.toThrow('stop observing');
  });

  it('uses one deadline and returns partial completion with unread progress on timeout', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn(),
      b = await spawn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const waiting = controller.outputMany([a.id, b.id], { mode: 'all', waitMs: 20000 });
    await vi.advanceTimersByTimeAsync(10000);
    a.turn.finish();
    b.turn.message('still working');
    await vi.advanceTimersByTimeAsync(10000);
    expect(await waiting).toMatchObject({
      waitOutcome: 'timeout',
      pendingAgentIds: [b.id],
      agents: [
        { waitOutcome: 'completion' },
        { waitOutcome: 'timeout', latestMessage: { text: 'still working' } }
      ]
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(await controller.outputMany([a.id, b.id], { waitMs: 0 })).toMatchObject({
      waitOutcome: 'snapshot'
    });
  });

  it('cancels the entire waiter without consuming partial messages or stopping children', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn(),
      b = await spawn();
    const abort = new AbortController();
    const waiting = controller.outputMany([a.id, b.id], {
      mode: 'all',
      waitFor: 'message',
      waitMs: 300000,
      signal: abort.signal
    });
    const rejected = expect(waiting).rejects.toThrow('parent stopped');
    a.turn.message('retain this');
    await tick();
    abort.abort(new Error('parent stopped'));
    await rejected;
    expect(controller.listSessionResources().every((item) => item.status === 'running')).toBe(true);
    expect(
      await controller.outputMany([a.id, b.id], { waitFor: 'message', waitMs: 10000 })
    ).toMatchObject({
      waitOutcome: 'message',
      agents: [{ latestMessage: { text: 'retain this' } }, { waitOutcome: 'snapshot' }]
    });
  });

  it('returns partial message results on timeout and applies the positive model wait floor', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn(),
      b = await spawn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let settled = false;
    const waiting = controller
      .outputMany([a.id, b.id], { mode: 'all', waitFor: 'message', waitMs: 1 })
      .then((value) => {
        settled = true;
        return value;
      });
    a.turn.message('partial progress');
    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toMatchObject({
      waitOutcome: 'timeout',
      pendingAgentIds: [b.id],
      agents: [
        { waitOutcome: 'message', latestMessage: { text: 'partial progress' } },
        { waitOutcome: 'timeout' }
      ]
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves terminal evidence if an all-completion wait is cancelled after a partial finish', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn(),
      b = await spawn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const abort = new AbortController();
    const waiting = controller.outputMany([a.id, b.id], {
      mode: 'all',
      waitMs: 300000,
      signal: abort.signal
    });
    const rejected = expect(waiting).rejects.toThrow('parent stopped');
    a.turn.finish();
    await tick();
    abort.abort(new Error('parent stopped'));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(await controller.output(a.id, { waitMs: 10000 })).toHaveProperty(
      'summary',
      'finished ' + a.turn.handle.turnId
    );
    expect(await controller.output(a.id, { waitMs: 10000 })).not.toHaveProperty('summary');
  });

  it('returns zero-wait snapshots without consuming unread messages', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn();
    a.turn.message('unread');
    await tick();
    const snapshot = await controller.outputMany([a.id], {
      mode: 'all',
      waitFor: 'message',
      waitMs: 0
    });
    expect(snapshot.waitOutcome).toBe('snapshot');
    expect(snapshot.agents[0]).not.toHaveProperty('latestMessage');
    expect(
      await controller.outputMany([a.id], { mode: 'all', waitFor: 'message', waitMs: 10000 })
    ).toMatchObject({ waitOutcome: 'message', agents: [{ latestMessage: { text: 'unread' } }] });
  });

  it('pins the original turns even if an early finisher receives a new task', async () => {
    const { controller, spawn, turns } = await fixture();
    const a = await spawn(),
      b = await spawn();
    const oldTurnId = a.turn.handle.turnId;
    const waiting = controller.outputMany([a.id, b.id], { mode: 'all', waitMs: 300000 });
    await tick();
    a.turn.finish();
    await tick();
    await controller.message(a.id, 'Next independent task.');
    await tick();
    expect(turns.get(a.id)?.handle.turnId).not.toBe(oldTurnId);
    b.turn.finish();
    expect(await waiting).toMatchObject({
      waitOutcome: 'completion',
      agents: [{ agentId: a.id, status: 'completed', turnId: oldTurnId }, { status: 'completed' }]
    });
    expect(controller.listSessionResources().find((item) => item.agentId === a.id)?.status).toBe(
      'running'
    );
  });

  it('does not replay observed terminal evidence when a pinned child starts another turn', async () => {
    const { controller, spawn, turns } = await fixture();
    const a = await spawn(),
      b = await spawn();
    const waiting = controller.outputMany([a.id, b.id], { mode: 'all', waitMs: 300000 });
    await tick();
    a.turn.finish();
    await tick();
    expect(await controller.output(a.id, { waitMs: 10000 })).toHaveProperty('summary');
    await controller.message(a.id, 'Start the next task.');
    await tick();
    b.turn.finish();
    const result = await waiting;
    expect(result.agents[0]).toMatchObject({ status: 'completed', turnId: a.turn.handle.turnId });
    expect(result.agents[0]).not.toHaveProperty('summary');
    const nextTurn = turns.get(a.id)!;
    nextTurn.finish();
    expect(await controller.output(a.id, { waitMs: 10000 })).toMatchObject({
      status: 'completed',
      summary: 'finished ' + nextTurn.handle.turnId
    });
    expect(await controller.output(a.id, { waitMs: 10000 })).not.toHaveProperty('summary');
  });

  it('rejects ambiguous, duplicate, empty and unknown targets before consuming any result', async () => {
    const { controller, spawn } = await fixture();
    const a = await spawn();
    a.turn.message('preserved');
    await tick();
    const context = {
      subagents: controller,
      signal: new AbortController().signal
    } as ToolRuntimeContext;
    for (const input of [
      { agentIds: [] },
      { agentIds: 'not-an-array' },
      { agentIds: Array.from({ length: 9 }, (_, i) => 'child-' + i) },
      { agentIds: [a.id, a.id] },
      { agentIds: [' '] },
      { agentIds: [42] },
      { agentIds: [a.id], agentId: a.id },
      { agentIds: [a.id], mode: 'each' },
      { agentId: a.id, mode: 'all' },
      { mode: 'all' }
    ]) {
      await expect(executeAgentWait(input, context)).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
    }
    await expect(
      executeAgentWait({ agentIds: [a.id, 'outside-tree'], waitFor: 'message' }, context)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SUBAGENT_NOT_FOUND' });
    expect(await controller.output(a.id, { waitFor: 'message', waitMs: 10000 })).toHaveProperty(
      'latestMessage.text',
      'preserved'
    );
  });
});
