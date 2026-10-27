import { describe, expect, it, vi } from 'vitest';
import { createTestSubagents } from './support/subagent-controller.js';
import { TodoStore } from '../../src/tools/agent/todo.js';
import { restoreTodoStore } from '../../src/tools/agent/todo.js';
import { applyPatchToolDefinition } from '../../src/tools/local/apply-patch.js';
import { execToolDefinition, execWaitToolDefinition } from '../../src/tools/local/exec.js';
import { agentWaitToolDefinition } from '../../src/tools/agent/agent-wait.js';
import {
  agentStartToolDefinition,
  agentStartToolDefinitionWithModels,
  executeAgentStart
} from '../../src/tools/agent/agent-start.js';
import { executeAgentWait } from '../../src/tools/agent/agent-wait.js';
import {
  executeAgentCancel,
  agentCancelToolDefinition
} from '../../src/tools/agent/agent-cancel.js';
import {
  executeAgentMessage,
  agentMessageToolDefinition
} from '../../src/tools/agent/agent-message.js';
import { executeTodoWrite, todoWriteToolDefinition } from '../../src/tools/agent/todo-write.js';
import { executeQuestion, questionToolDefinition } from '../../src/tools/agent/question.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';
import { AGENT_TOOL_HANDLERS, BUILTIN_TOOL_DEFINITIONS } from '../../src/tools/registry.js';
import type { ToolRuntimeContext } from '../../src/tools/runtime-context.js';

describe('workflow tools', () => {
  it('exposes only agent lifecycle names and rejects taskId or processId inputs', async () => {
    const names = BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('agent_'))).toEqual([
      'agent_start',
      'agent_wait',
      'agent_message',
      'agent_cancel'
    ]);
    for (const name of ['task', 'task_output', 'task_cancel']) {
      expect(names).not.toContain(name);
      expect(AGENT_TOOL_HANDLERS.has(name)).toBe(false);
    }
    const context = {} as ToolRuntimeContext;
    for (const execute of [executeAgentWait, executeAgentCancel, executeAgentMessage]) {
      for (const input of [
        { taskId: 'old' },
        { processId: 'process' },
        { agentId: 'valid', taskId: 'old' }
      ]) {
        await expect(execute(input, context)).rejects.toMatchObject({
          code: 'MAR_AGENT_TOOL_INPUT_INVALID'
        });
      }
    }
    expect(agentWaitToolDefinition.description).toContain('Omit agentId');
    expect(agentWaitToolDefinition.description).toContain('exec processId');
    expect(agentCancelToolDefinition.description).toContain('use exec_wait with action:"cancel"');
    expect(agentCancelToolDefinition.description).not.toContain('use exec with action:');
    expect(agentWaitToolDefinition.description).toContain('300000 ms completion wait');
    expect(agentWaitToolDefinition.description).toContain('waitOutcome');
    expect(agentWaitToolDefinition.description).toContain('timeout with unread progress');
    expect(agentWaitToolDefinition.description).toContain('omit previously observed message text');
    expect(agentMessageToolDefinition.description).toContain(
      'without repeating the child’s previous latestMessage'
    );
    expect(agentStartToolDefinition.description).toContain(
      'agent_wait, agent_message, or agent_cancel'
    );
    expect(agentMessageToolDefinition.parallelSafety).toBe('serial');
    expect(agentMessageToolDefinition.description).toContain('running child turn');
  });

  it('places enabled subagent models in the agent_start tool description', () => {
    const definition = agentStartToolDefinitionWithModels([
      {
        id: 'current',
        name: 'Current',
        reasoningEfforts: ['low', 'high']
      },
      {
        id: 'review',
        name: 'Review\n# Injected',
        reasoningEfforts: ['medium']
      }
    ]);
    expect(definition.description).toContain('Omit modelId to use the current agent model.');
    expect(definition.description).toContain(
      '- "current" ("Current"; reasoning efforts: low, high)'
    );
    expect(definition.description).toContain(
      '- "review" ("Review\\n# Injected"; reasoning efforts: medium)'
    );
    expect(definition.description).not.toContain('Review\n# Injected');
    expect(definition.description).not.toContain(', default');
    expect(
      (definition.inputSchema.properties as Record<string, Record<string, unknown>>).modelId
    ).toEqual({ type: 'string' });
  });

  it('separates non-blocking child startup from waiting without a background parameter', () => {
    expect(agentStartToolDefinition.description).toContain('does not wait for task completion');
    expect(agentStartToolDefinition.description).toContain('Use agent_wait');
    expect(agentStartToolDefinition.description).not.toContain('background');
    expect(agentStartToolDefinition.inputSchema.properties).not.toHaveProperty('background');
    expect(agentWaitToolDefinition.description).toContain('next local step depends');
  });

  it('returns a child identity before completion and joins through agent_wait', async () => {
    let release!: () => void;
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => (started = resolve));
    const childWork = new Promise<void>((resolve) => (release = resolve));
    const scheduler = await createTestSubagents(async () => {
      started();
      await childWork;
      return { summary: 'child verified', changedFiles: [], verification: [], evidence: [] };
    });
    const context = {
      subagents: scheduler,
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;
    let returned = false;
    const operation = executeAgentStart(
      {
        description: 'Independent task',
        prompt: 'Verify the independent task.',
        role: 'explore'
      },
      context
    ).then((result) => {
      returned = true;
      return result;
    });
    try {
      await childStarted;
      await vi.waitFor(() => expect(returned).toBe(true));
      const receipt = await operation;
      expect(receipt.data).toMatchObject({ status: 'running' });
      expect(receipt.data.agentId).toBeTruthy();
      release();
      await expect(
        executeAgentWait({ agentId: receipt.data.agentId }, context)
      ).resolves.toMatchObject({ data: { status: 'completed', summary: 'child verified' } });
    } finally {
      release();
      await scheduler.dispose();
      await operation;
    }
  });

  it.each([true, false, null, undefined])(
    'rejects the removed background field (%s)',
    async (background) => {
      const run = vi.fn();
      await expect(
        executeAgentStart(
          { description: 'Task', prompt: 'Do work.', role: 'explore', background },
          { subagents: { run } } as never
        )
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
      expect(run).not.toHaveBeenCalled();
    }
  );

  it('waits for any live subagent without transcribing an agent id', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstCompletion = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondCompletion = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const scheduler = await createTestSubagents(async (task) => {
      await (task.description === 'first' ? firstCompletion : secondCompletion);
      return {
        summary: `${task.description} done`,
        changedFiles: [],
        verification: [],
        evidence: []
      };
    });
    const context = {
      subagents: scheduler,
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;
    const first = await scheduler.run({
      description: 'first',
      prompt: 'finish first',
      role: 'explore',
      background: true
    });
    const second = await scheduler.run({
      description: 'second',
      prompt: 'wait for release',
      role: 'explore',
      background: true
    });

    const untargetedPromise = executeAgentWait({ waitMs: 10_000 }, context);
    releaseFirst();
    const untargeted = await untargetedPromise;
    expect(untargeted.data).toMatchObject({
      agentId: first.agentId,
      status: 'completed',
      waitOutcome: 'completion',
      summary: 'first done'
    });
    expect(untargeted.data.agentId).not.toBe(second.agentId);

    releaseSecond();
    await scheduler.output(second.agentId, { waitMs: 10_000 });
    const latest = await executeAgentWait({ agentId: null, waitFor: null, waitMs: null }, context);
    expect(latest.data).toMatchObject({
      agentId: second.agentId,
      status: 'completed',
      waitOutcome: 'completion'
    });
    await scheduler.dispose();
  });

  it('observes a streamed child message through the Session controller', async () => {
    const scheduler = await createTestSubagents(async () => ({
      summary: 'done',
      changedFiles: [],
      verification: [],
      evidence: []
    }));
    const started = await scheduler.run({
      description: 'Compatibility task',
      prompt: 'Complete without streamed messages.',
      role: 'explore',
      background: true
    });
    await expect(
      scheduler.output(started.agentId, { waitFor: 'message', waitMs: 10_000 })
    ).resolves.toMatchObject({ waitOutcome: 'message', latestMessage: { text: 'done' } });
    await scheduler.dispose();
  });

  it('sends a non-empty message through the subagent controller without waiting for completion', async () => {
    const received: unknown[] = [];
    const snapshot = {
      agentId: 'child-session',
      description: 'Inspect state',
      status: 'running' as const,
      modelId: 'review',
      modelName: 'Review',
      reasoningEffort: 'high' as const
    };
    const context = {
      subagents: {
        message: async (agentId: string, message: string, options: unknown) => {
          received.push({ agentId, message, options });
          return snapshot;
        }
      }
    } as ToolRuntimeContext;

    await expect(
      executeAgentMessage(
        { agentId: ' child-session ', message: ' Continue with tests. ' },
        context
      )
    ).resolves.toEqual({ content: JSON.stringify(snapshot), data: snapshot });
    expect(received).toEqual([
      {
        agentId: 'child-session',
        message: ' Continue with tests. ',
        options: { delivery: 'append', signal: undefined }
      }
    ]);
    await executeAgentMessage(
      { agentId: 'child-session', message: 'Replace direction.', delivery: 'replace' },
      context
    );
    expect(received.at(-1)).toMatchObject({ options: { delivery: 'replace' } });
    await executeAgentMessage(
      { agentId: 'child-session', message: 'Use default delivery.', delivery: null },
      context
    );
    expect(received.at(-1)).toMatchObject({ options: { delivery: 'append' } });
    for (const input of [
      { agentId: 'child-session', message: '' },
      { agentId: 'child-session', message: '   ' },
      { agentId: 'child-session', message: 'x', taskId: 'legacy' },
      { agentId: 'child-session', message: 'x', delivery: 'invalid' }
    ])
      await expect(executeAgentMessage(input, context)).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
  });

  it('presents question as the preferred Plan path for unresolved user-owned decisions', () => {
    expect(questionToolDefinition.description).toContain('Prefer asking over guessing');
    expect(questionToolDefinition.description).toContain('one to three tightly related');
    expect(questionToolDefinition.description).toContain('another question round');
    expect(questionToolDefinition.description).toContain('configuration, branches, abstractions');
    expect(questionToolDefinition.description).toContain(
      'cannot be inferred from the request, conversation, or relevant safe discovery'
    );
    expect(questionToolDefinition.description).toContain('recommended option first');
    expect(JSON.stringify(questionToolDefinition.inputSchema)).toContain(
      'Put the recommended option first'
    );
    expect(questionToolDefinition.description).not.toContain('only when');
  });

  it('documents model-visible return shapes, lifecycle states, and recovery behavior', () => {
    expect(execToolDefinition.description).toContain('bounded stdout/stderr');
    expect(execToolDefinition.description).toContain('with processId, not exec');
    expect(execWaitToolDefinition.allowedCallers).toEqual(['direct', 'programmatic']);
    expect(execWaitToolDefinition.description).toContain('in Code Mode use tools.exec_wait');
    expect(execWaitToolDefinition.description).toContain('incremental stdout/stderr');
    expect(execWaitToolDefinition.description).toContain('cannot start a process');
    expect(execToolDefinition.description).toContain('truncated');
    expect(applyPatchToolDefinition.description).toContain(
      'Returns changed file paths and operations'
    );
    expect(applyPatchToolDefinition.description).toContain(
      'Do not batch all task files merely to reduce tool calls'
    );
    expect(applyPatchToolDefinition.description).toContain('successive bounded patches');
    expect(applyPatchToolDefinition.description).toContain('Oversized patches are rejected');
    expect(applyPatchToolDefinition.description).not.toContain('100 files');
    expect(applyPatchToolDefinition.description).not.toContain('4 MiB');
    expect(applyPatchToolDefinition.description).toContain('@@ <change context>');
    expect(applyPatchToolDefinition.description).toContain(
      'hunk match conflicts identify the affected path and hunk'
    );
    expect(applyPatchToolDefinition.description).toContain('MAR_AGENT_PATCH_PARTIAL');
    expect(agentStartToolDefinition.description).toContain(
      'queued/running/completed/failed/cancelled'
    );
    expect(agentStartToolDefinition.description).toContain('description');
    const taskProperties = agentStartToolDefinition.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(taskProperties.reasoningEffort).toMatchObject({
      type: 'string',
      maxLength: 64
    });
    expect(agentWaitToolDefinition.description).toContain('queued or running');
    expect(agentWaitToolDefinition.description).toContain('agentId and description');
    const agentWaitProperties = agentWaitToolDefinition.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(agentWaitToolDefinition.description).toContain('30 seconds by default');
    expect(agentWaitToolDefinition.description).toContain(
      'waitMs=0 returns the current snapshot immediately'
    );
    expect(agentWaitToolDefinition.description).toContain('raised to 10 seconds');
    expect(agentWaitProperties.waitMs?.default).toBe(TOOL_EXECUTION_LIMITS.agentWaitDefaultWaitMs);
    expect(agentWaitProperties.waitMs?.minimum).toBe(TOOL_EXECUTION_LIMITS.agentWaitMinWaitMs);
    expect(agentWaitProperties.waitMs?.maximum).toBe(TOOL_EXECUTION_LIMITS.agentWaitMaxWaitMs);
    expect(TOOL_EXECUTION_LIMITS.agentWaitMinWaitMs).toBe(0);
    expect(TOOL_EXECUTION_LIMITS.agentWaitWaitFloorMs).toBe(10_000);
    expect(TOOL_EXECUTION_LIMITS.agentWaitDefaultWaitMs).toBe(30_000);
    expect(TOOL_EXECUTION_LIMITS.agentWaitMaxWaitMs).toBe(300_000);
    expect(todoWriteToolDefinition.description).toContain(
      'Do not retain completed items from an earlier objective'
    );
  });

  it('replaces Todo without a revision precondition and enforces one in-progress item', () => {
    const store = new TodoStore();
    expect(
      store.write({
        items: [
          { id: 'a', step: 'First', status: 'in_progress' },
          { id: 'b', step: 'Second', status: 'pending' }
        ]
      }).revision
    ).toBe(1);
    expect(() =>
      store.write({
        items: [
          { id: 'a', step: 'First', status: 'in_progress' },
          { id: 'b', step: 'Second', status: 'in_progress' }
        ]
      })
    ).toThrow();
    expect(store.write({ items: [] })).toEqual({ revision: 2, items: [] });
  });

  it('writes restored Todo directly and publishes each replacement snapshot', async () => {
    expect(todoWriteToolDefinition.inputSchema.required).toEqual(['items']);
    expect(todoWriteToolDefinition.inputSchema.properties).not.toHaveProperty('expectedRevision');
    const emit = vi.fn(async () => undefined);
    const context = {
      todo: TodoStore.restore({
        revision: 7,
        items: [{ id: 'old', step: 'Old objective', status: 'completed' }]
      }),
      emit
    } as unknown as ToolRuntimeContext;
    const items = [{ id: 'new', step: 'New objective', status: 'in_progress' }];

    const written = await executeTodoWrite({ items }, context);
    expect(JSON.parse(written.content)).toEqual({ revision: 8, count: 1 });
    expect(written.data).toEqual({ revision: 8, items });
    const cleared = await executeTodoWrite({ items: [] }, context);
    expect(JSON.parse(cleared.content)).toEqual({ revision: 9, count: 0 });
    expect(cleared.data).toEqual({ revision: 9, items: [] });
    expect(emit.mock.calls).toEqual([
      [{ type: 'todo.updated', revision: 8, items }],
      [{ type: 'todo.updated', revision: 9, items: [] }]
    ]);
  });

  it('restores the latest valid Session Todo and rebuilds revision from snapshot order', () => {
    const restored = restoreTodoStore([
      {
        revision: 1,
        items: [{ id: 'inspect', step: 'Inspect', status: 'in_progress' }]
      },
      { revision: 2, items: [{ id: '', step: 'Invalid', status: 'pending' }] },
      {
        revision: 1,
        items: [
          { id: 'inspect', step: 'Inspect', status: 'completed' },
          { id: 'fix', step: 'Fix', status: 'in_progress' }
        ]
      }
    ]);

    expect(restored.read()).toEqual({
      revision: 2,
      items: [
        { id: 'inspect', step: 'Inspect', status: 'completed' },
        { id: 'fix', step: 'Fix', status: 'in_progress' }
      ]
    });
  });

  it('limits subagents, forbids recursion and cancels with the parent', async () => {
    let running = 0,
      maximum = 0;
    const scheduler = await createTestSubagents(
      async (task, signal) => {
        running++;
        maximum = Math.max(maximum, running);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true }
          );
        });
        running--;
        return { summary: task.prompt, changedFiles: [], verification: [], evidence: [] };
      },
      { maxTasks: 8, maxConcurrent: 2 }
    );
    const tasks = await Promise.all(
      ['a', 'b', 'c'].map((prompt) =>
        scheduler.run({ description: prompt, prompt, role: 'explore', background: true })
      )
    );
    expect(maximum).toBeLessThanOrEqual(2);
    expect(
      (
        await scheduler.output(tasks[0]!.agentId, {
          waitMs: TOOL_EXECUTION_LIMITS.agentWaitWaitFloorMs
        })
      ).status
    ).toBe('completed');
    await expect(
      scheduler.run({
        description: 'nested',
        prompt: 'x',
        role: 'explore',
        parentSubagentId: 'parent'
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SUBAGENT_RECURSION_DISABLED' });
    await scheduler.dispose();
  });

  it('passes an optional reasoning effort override to the subagent runner', async () => {
    let receivedTask: unknown;
    const scheduler = await createTestSubagents(async (task) => {
      receivedTask = task;
      return { summary: 'done', changedFiles: [], verification: [], evidence: [] };
    });
    const context = {
      subagents: scheduler,
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;

    const started = await executeAgentStart(
      {
        description: 'Review effort',
        prompt: 'Review with the selected effort.',
        role: 'general-purpose',
        modelId: 'review',
        reasoningEffort: ' high '
      },
      context
    );
    await expect(scheduler.output(started.data.agentId, { waitMs: 10_000 })).resolves.toMatchObject(
      { status: 'completed' }
    );
    expect(receivedTask).toMatchObject({
      modelId: 'review',
      reasoningEffort: 'high'
    });
    await scheduler.dispose();
  });

  it('waits for a running subagent to reach cancelled before returning from cancel', async () => {
    let abortObserved = false;
    const scheduler = await createTestSubagents(
      async (_task, signal) =>
        new Promise<never>((_resolve, reject) => {
          const abort = () => {
            abortObserved = true;
            reject(signal.reason ?? new Error('cancelled'));
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })
    );
    const started = await scheduler.run({
      description: 'Inspect cancellation',
      prompt: 'Wait for cancellation.',
      role: 'explore',
      background: true
    });

    await expect(scheduler.cancel(started.agentId)).resolves.toMatchObject({
      description: 'Inspect cancellation',
      status: 'cancelled'
    });
    expect(abortObserved).toBe(true);
    await scheduler.dispose();
  });

  it('interrupts agent_wait waiting with the Execution signal without cancelling the subagent', async () => {
    const scheduler = await createTestSubagents(
      async (_task, signal) =>
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error('cancelled'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })
    );
    const started = await scheduler.run({
      description: 'Inspect in background',
      prompt: 'Wait until explicitly cancelled.',
      role: 'explore',
      background: true
    });
    const controller = new AbortController();
    const context = {
      subagents: scheduler,
      signal: controller.signal,
      emit: async () => undefined
    } as never;
    const waiting = executeAgentWait(
      { agentId: started.agentId, waitMs: TOOL_EXECUTION_LIMITS.agentWaitMaxWaitMs },
      context
    );
    const interruption = new Error('replacement message');

    controller.abort(interruption);

    await expect(waiting).rejects.toBe(interruption);
    await expect(scheduler.output(started.agentId)).resolves.toMatchObject({ status: 'running' });
    await scheduler.cancel(started.agentId);
    await scheduler.dispose();
  });

  it('waits 30 seconds by default but returns as soon as the subagent reaches a terminal state', async () => {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = await createTestSubagents(async () => {
      await completion;
      return { summary: 'done', changedFiles: [], verification: [], evidence: [] };
    });
    const started = await scheduler.run({
      description: 'Complete during default wait',
      prompt: 'Wait for release.',
      role: 'explore',
      background: true
    });
    const context = {
      subagents: scheduler,
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;
    let settled = false;
    const waiting = executeAgentWait({ agentId: started.agentId }, context).then((result) => {
      settled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeCompletion = settled;
    release();
    await scheduler.output(started.agentId, {
      waitMs: TOOL_EXECUTION_LIMITS.agentWaitWaitFloorMs
    });
    const result = await waiting;

    expect(settledBeforeCompletion).toBe(false);
    expect(result.data).toMatchObject({ status: 'completed', summary: 'done' });
    expect(result.data.waitOutcome).toBe('completion');
    await scheduler.dispose();
  });

  it('returns the current snapshot immediately for zero waitMs', async () => {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = await createTestSubagents(async () => {
      await completion;
      return { summary: 'done', changedFiles: [], verification: [], evidence: [] };
    });
    const started = await scheduler.run({
      description: 'Clamp zero wait',
      prompt: 'Wait for release.',
      role: 'explore',
      background: true
    });
    const context = {
      subagents: scheduler,
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;
    let toolSettled = false;
    let schedulerSettled = false;
    const toolWaiting = executeAgentWait({ agentId: started.agentId, waitMs: 0 }, context).then(
      (result) => {
        toolSettled = true;
        return { result };
      },
      (error: unknown) => {
        toolSettled = true;
        return { error };
      }
    );
    const schedulerWaiting = scheduler.output(started.agentId, { waitMs: 0 }).then(
      (result) => {
        schedulerSettled = true;
        return { result };
      },
      (error: unknown) => {
        schedulerSettled = true;
        return { error };
      }
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeCompletion = { toolSettled, schedulerSettled };
    release();
    const [toolOutcome, schedulerOutcome] = await Promise.all([toolWaiting, schedulerWaiting]);

    expect(settledBeforeCompletion).toEqual({ toolSettled: true, schedulerSettled: true });
    expect(toolOutcome).toMatchObject({
      result: { data: { status: 'running', waitOutcome: 'snapshot' } }
    });
    expect(schedulerOutcome).toMatchObject({
      result: { status: 'running', waitOutcome: 'snapshot' }
    });
    await scheduler.dispose();
  });

  it('reports an explicit timeout outcome while leaving the child running', async () => {
    vi.useFakeTimers();
    const scheduler = await createTestSubagents(
      async (_task, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    try {
      const started = await scheduler.run({
        description: 'Timeout observation',
        prompt: 'Keep running.',
        role: 'explore',
        background: true
      });
      const waiting = scheduler.output(started.agentId, { waitMs: 10_000 });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(waiting).resolves.toMatchObject({
        status: 'running',
        waitOutcome: 'timeout'
      });
      await scheduler.cancel(started.agentId);
    } finally {
      await scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it('ends a foreground wait without cancelling the scheduled child', async () => {
    let release!: (value: {
      summary: string;
      changedFiles: string[];
      verification: string[];
      evidence: never[];
    }) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const result = new Promise<{
      summary: string;
      changedFiles: string[];
      verification: string[];
      evidence: never[];
    }>((resolve) => (release = resolve));
    const scheduler = await createTestSubagents(async () => {
      started();
      return result;
    });
    const parent = new AbortController();
    const foreground = scheduler.run(
      {
        description: 'Retain foreground work',
        prompt: 'Continue after the parent stops.',
        role: 'explore'
      },
      { signal: parent.signal }
    );
    await entered;

    parent.abort(new Error('parent replaced'));
    await expect(foreground).rejects.toThrow('parent replaced');
    await expect(scheduler.outputAny({ waitMs: 0 })).resolves.toMatchObject({
      status: 'running',
      waitOutcome: 'snapshot'
    });

    release({
      summary: 'done',
      changedFiles: [],
      verification: [],
      evidence: []
    });
    await expect(
      scheduler.outputAny({ waitFor: 'completion', waitMs: 10_000 })
    ).resolves.toMatchObject({
      status: 'completed',
      waitOutcome: 'completion'
    });
    await scheduler.dispose();
  });

  it('removes the unstarted child when publishing its created state fails', async () => {
    let agentId = '';
    const scheduler = await createTestSubagents(
      async (_task, signal) =>
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error('cancelled'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })
    );

    await expect(
      scheduler.run(
        {
          description: 'Publish lifecycle',
          prompt: 'Wait for lifecycle publication.',
          role: 'explore',
          background: true
        },
        {
          onCreated: (task) => {
            agentId = task.agentId;
            throw new Error('publish failed');
          }
        }
      )
    ).rejects.toThrow('publish failed');
    await expect(scheduler.output(agentId)).rejects.toMatchObject({
      code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
    });
    await scheduler.dispose();
  });

  it('strictly validates agent-owned workflow tool inputs at runtime', async () => {
    const scheduler = await createTestSubagents(async () => ({
      summary: 'done',
      changedFiles: [],
      verification: [],
      evidence: []
    }));
    const context = {
      todo: new TodoStore(),
      subagents: scheduler,
      host: { requestUserInput: async () => ({ choice: 'A' }) },
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;
    const receipt = await executeAgentStart(
      {
        description: 'Nullable defaults',
        prompt: 'Use inherited defaults.',
        role: 'explore',
        modelId: null,
        reasoningEffort: null
      },
      context
    );
    await expect(
      executeAgentWait({ agentId: receipt.data.agentId }, context)
    ).resolves.toMatchObject({ data: { status: 'completed' } });
    for (const operation of [
      () => executeTodoWrite(undefined, context),
      () => executeTodoWrite({}, context),
      () => executeTodoWrite({ items: 'invalid' }, context),
      () => executeTodoWrite({ items: [], unknown: true }, context),
      () => executeTodoWrite({ items: [], expectedRevision: 0 }, context),
      () => executeAgentStart({ description: 1 }, context),
      () =>
        executeAgentWait(
          { agentId: 'missing', waitMs: TOOL_EXECUTION_LIMITS.agentWaitMaxWaitMs + 1 },
          context
        ),
      () => executeAgentWait({ agentId: 'missing', waitMs: -1 }, context),
      () => executeAgentWait({ agentId: 'missing', waitFor: 'activity' }, context),
      () => executeAgentWait({ waitFor: false }, context),
      () => executeAgentWait({ waitMs: false }, context),
      () => executeAgentCancel({ agentId: '' }, context),
      () => executeAgentCancel({ agentId: '   ' }, context),
      () =>
        executeTodoWrite({ items: [{ id: '   ', step: 'Do work', status: 'pending' }] }, context),
      () =>
        executeAgentStart(
          {
            description: 'Task',
            prompt: 'Do work',
            role: 'explore',
            modelId: '   '
          },
          context
        ),
      () =>
        scheduler.run({
          description: 'Task',
          prompt: 'Do work',
          role: 'explore',
          reasoningEffort: null as never
        }),
      () =>
        executeAgentStart(
          {
            description: 'Task',
            prompt: 'Do work',
            role: 'explore',
            reasoningEffort: '   '
          },
          context
        ),
      () =>
        executeAgentStart(
          {
            description: 'Task',
            prompt: 'Do work',
            role: 'explore',
            reasoningEffort: 'x'.repeat(65)
          },
          context
        ),
      () => executeAgentWait({ agentId: '   ' }, context),
      () =>
        executeQuestion(
          { questions: [{ id: 'choice', header: 'Choice', question: 'Choose', options: ['A'] }] },
          context
        )
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await scheduler.dispose();
  });

  it('rejects blank nested question fields and non-string answers', async () => {
    const baseQuestion = {
      id: 'choice',
      header: 'Choice',
      question: 'Choose a mode.',
      options: [
        { label: 'A', description: 'Use A.' },
        { label: 'B', description: 'Use B.' }
      ]
    };
    const inputContext = {
      host: { requestUserInput: async () => ({ choice: undefined }) },
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;

    for (const question of [
      { ...baseQuestion, id: '   ' },
      { ...baseQuestion, header: '   ' },
      { ...baseQuestion, question: '\n\t' },
      {
        ...baseQuestion,
        options: [{ label: '   ', description: 'Use A.' }, baseQuestion.options[1]]
      },
      {
        ...baseQuestion,
        options: [{ label: 'A', description: '   ' }, baseQuestion.options[1]]
      }
    ])
      await expect(executeQuestion({ questions: [question] }, inputContext)).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });

    await expect(
      executeQuestion({ questions: [baseQuestion] }, inputContext)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_USER_INPUT_INVALID' });
  });

  it('rejects question answers that do not match every requested id', async () => {
    const context = {
      host: { requestUserInput: async () => ({ unknown: 'A' }) },
      signal: new AbortController().signal,
      emit: async () => undefined
    } as never;
    await expect(
      executeQuestion(
        {
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'Choose a mode.',
              options: [
                { label: 'A', description: 'Use A.' },
                { label: 'B', description: 'Use B.' }
              ]
            }
          ]
        },
        context
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_USER_INPUT_INVALID' });
  });
});
