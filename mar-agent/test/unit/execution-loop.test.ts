import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host/local-agent-host.js';
import { AgentError } from '../../src/error.js';
import { MAX_MODEL_ATTEMPTS } from '../../src/model/http.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import type { ModelMessage } from '../../src/model/contracts.js';
import type { ClientToolDefinition } from '../../src/tools/contracts.js';
import type { EventPayload } from '../../src/runtime/events.js';
import type { ToolRuntimeContext } from '../../src/tools/runtime-context.js';
import { ExecutionLoop, type ExecutionLoopInput } from '../../src/runtime/execution.js';
import { TodoStore } from '../../src/tools/agent/todo.js';
import { todoWriteToolDefinition } from '../../src/tools/agent/todo-write.js';
import { executeRoundTools, type RoundToolScope } from '../../src/tools/execution.js';
import { createSessionToolScheduler } from '../../src/tools/scheduler.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  events: ExecutionLoopInput['startModel'],
  tools: readonly ClientToolDefinition[] = []
) {
  const root = await mkdtemp(join(tmpdir(), 'mar-execution-loop-'));
  const host = new LocalAgentHost({ homeDirectory: root, workspace: root });
  cleanups.push(async () => {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const publish = vi.fn(async (_event: EventPayload) => {});
  const appendContext = vi.fn(async (_message: ModelMessage) => {});
  const observeUsage = vi.fn();
  const observeContextTokens = vi.fn();
  const closeMailbox = vi.fn();
  const context: ToolRuntimeContext = {
    host,
    todo: new TodoStore(),
    mode: 'run',
    sessionId: 'fixture-session',
    executionId: 'fixture-execution',
    signal: controller.signal,
    emit: publish,
    skills: new Map()
  };
  const input: ExecutionLoopInput<RoundToolScope> = {
    mode: 'run',
    sourceType: 'user',
    signal: controller.signal,
    model: { id: 'fixture', name: 'Fixture' },
    messages: [],
    toolImages: [],
    publish,
    appendContext,
    observeUsage,
    observeContextTokens,
    mailbox: { hasPending: () => false, append: async () => false, close: closeMailbox },
    compactContext: async () => false,
    recoverySignal: () => controller.signal,
    checkpoint: async () => {},
    startModel: events,
    runTools: executeRoundTools,
    prepareRound: async () => ({
      request: { system: 'Fixture.', messages: input.messages, tools },
      toolScope: {
        context,
        tools,
        expectations: new Map(),
        extensionToolNames: new Set(),
        schedule: createSessionToolScheduler(),
        assertLive: () => {},
        assertExecutionLive: () => {},
        emit: publish,
        searchMcpTools: async () => ({ summary: 'No tools.', content: 'No tools.' }),
        recentImages: async () => [],
        captureCodeContext: () => context,
        codeModeContext: async () => ({ tools: [], state: [], supportsImages: false })
      }
    })
  };
  return {
    input,
    controller,
    publish,
    appendContext,
    observeUsage,
    observeContextTokens,
    closeMailbox
  };
}

describe('Execution loop boundaries', () => {
  it('keeps compaction output transient and never invokes the completed-output writer', async () => {
    const f = await fixture(async function* () {
      yield { type: 'text.completed', itemId: 'summary', text: 'Transient summary' };
      yield { type: 'completed', reason: 'completed' };
    });
    const appendOutput = vi.fn<NonNullable<ExecutionLoopInput['appendOutput']>>();
    const loop = new ExecutionLoop({ ...f.input, mode: 'compact', appendOutput });
    expect(await loop.run()).toHaveProperty('finalAnswer', 'Transient summary');
    expect(appendOutput).not.toHaveBeenCalled();
    expect(f.appendContext).not.toHaveBeenCalled();
    expect(f.publish.mock.calls.some(([event]) => event.type === 'message.completed')).toBe(false);
  });

  it('settles response usage before continuing with pending mailbox input', async () => {
    let pending = true;
    const startModel = vi.fn(async function* () {
      yield { type: 'text.completed', itemId: 'answer', text: 'Done.' } as ModelEvent;
      yield { type: 'usage', usage: { rolloutBudgetUnits: 100 } } as ModelEvent;
      yield { type: 'completed', reason: 'completed' } as ModelEvent;
    });
    const state = await fixture(startModel);
    const checkpoint = vi.fn(async () => {});
    const loop = new ExecutionLoop({
      ...state.input,
      checkpoint,
      mailbox: {
        hasPending: () => pending,
        append: async () => {
          expect(checkpoint).toHaveBeenLastCalledWith(expect.anything(), {
            rolloutBudgetUnits: 100
          });
          pending = false;
          return true;
        },
        close: state.closeMailbox
      }
    });
    await expect(loop.run()).resolves.toMatchObject({ finalAnswer: 'Done.' });
    expect(startModel).toHaveBeenCalledTimes(2);
    expect(state.closeMailbox).toHaveBeenCalledOnce();
  });

  it('keeps cancellation ahead of a high-usage final answer', async () => {
    let abort = () => {};
    const state = await fixture(async function* () {
      yield { type: 'text.completed', itemId: 'answer', text: 'Partial answer.' };
      yield { type: 'usage', usage: { rolloutBudgetUnits: 1_250_000 } };
      abort();
      yield { type: 'completed', reason: 'completed' };
    });
    abort = () => state.controller.abort();
    await expect(new ExecutionLoop(state.input).run()).rejects.toMatchObject({
      code: 'MAR_AGENT_EXECUTION_CANCELLED'
    });
    expect(state.closeMailbox).not.toHaveBeenCalled();
  });

  it('keeps cancellation ahead of an empty completed response', async () => {
    let abort = () => {};
    const startModel = vi.fn(async function* () {
      abort();
      yield { type: 'completed', reason: 'completed' } as ModelEvent;
    });
    const state = await fixture(startModel);
    abort = () => state.controller.abort();
    await expect(new ExecutionLoop(state.input).run()).rejects.toMatchObject({
      code: 'MAR_AGENT_EXECUTION_CANCELLED'
    });
    expect(startModel).toHaveBeenCalledOnce();
    expect(state.closeMailbox).not.toHaveBeenCalled();
  });

  it('settles an empty response and accepts pending input before retry exhaustion', async () => {
    let pending = true;
    const usage = { contextInputTokens: 1200, outputTokens: 20 };
    const startModel = vi.fn(async function* (request: ModelRequest) {
      if (!request.retryState) throw new Error('Expected the shared model retry state.');
      if (pending) {
        request.retryState.attempts = MAX_MODEL_ATTEMPTS;
        yield { type: 'usage', usage } as ModelEvent;
      } else {
        expect(request.retryState.attempts).toBe(0);
        yield { type: 'text.completed', itemId: 'answer', text: 'Updated answer.' } as ModelEvent;
      }
      yield { type: 'completed', reason: 'completed' } as ModelEvent;
    });
    const state = await fixture(startModel);
    const checkpoint = vi.fn(async () => {});
    const afterModel = vi.fn(async () => {});
    const append = vi.fn(async () => {
      expect(state.observeUsage).toHaveBeenLastCalledWith(usage);
      expect(afterModel).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenLastCalledWith(expect.anything(), usage);
      pending = false;
      return true;
    });
    const loop = new ExecutionLoop({
      ...state.input,
      checkpoint,
      afterModel,
      mailbox: { hasPending: () => pending, append, close: state.closeMailbox }
    });
    await expect(loop.run()).resolves.toMatchObject({ finalAnswer: 'Updated answer.' });
    expect(startModel).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledOnce();
    expect(state.closeMailbox).toHaveBeenCalledOnce();
  });

  it('returns the answer without publishing an SDK lifecycle terminal', async () => {
    const state = await fixture(async function* () {
      yield { type: 'text.completed', itemId: 'answer', text: 'Done.' };
      yield { type: 'completed', reason: 'completed' };
    });
    const result = await new ExecutionLoop(state.input).run();
    expect(result.finalAnswer).toBe('Done.');
    expect(state.closeMailbox).toHaveBeenCalledOnce();
    const eventTypes = state.publish.mock.calls.map(([event]) => event.type);
    expect(eventTypes).toContain('message.completed');
    expect(eventTypes.every((type) => !type.startsWith('execution.'))).toBe(true);
  });

  it('observes authoritative context usage before a stream failure can lose the round', async () => {
    const failure = new AgentError('FIXTURE_STREAM_FAILURE', 'Fixture stream failed.');
    const state = await fixture(async function* () {
      yield { type: 'usage', usage: { contextInputTokens: 1200, outputTokens: 10 } };
      throw failure;
    });
    await expect(new ExecutionLoop(state.input).run()).rejects.toBe(failure);
    expect(state.observeContextTokens).toHaveBeenCalledExactlyOnceWith(1200);
    expect(state.observeUsage).not.toHaveBeenCalled();
    expect(state.closeMailbox).not.toHaveBeenCalled();
  });

  it('recovers completed empty final answers without replaying completed tools', async () => {
    const seenAttempts: number[] = [];
    let sharedRetryState: object | undefined;
    const state = await fixture(
      async function* (request) {
        const retryState = request.retryState;
        if (!retryState) throw new Error('Expected the shared model retry state.');
        if (sharedRetryState) expect(retryState).toBe(sharedRetryState);
        else sharedRetryState = retryState;
        seenAttempts.push(retryState.attempts);
        retryState.attempts += 1;
        if (seenAttempts.length === 1) {
          yield {
            type: 'client_tool.call',
            callId: 'todo',
            name: 'todo_write',
            arguments: {
              items: [{ id: 'done', step: 'Record the completed operation.', status: 'completed' }]
            }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        if (seenAttempts.length === 2) {
          retryState.retryDelayMs = 0;
          yield {
            type: 'text.completed',
            itemId: 'empty',
            text: '',
            phase: 'final_answer'
          };
        } else {
          yield { type: 'text.completed', itemId: 'answer', text: 'Recovered.' };
        }
        yield { type: 'completed', reason: 'completed' };
      },
      [todoWriteToolDefinition]
    );
    const outcome = new ExecutionLoop(state.input).run().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    expect(await outcome).toMatchObject({ result: { finalAnswer: 'Recovered.' } });
    expect(seenAttempts).toEqual([0, 0, 1]);
    expect(
      state.publish.mock.calls.filter(([event]) => event.type === 'todo.updated')
    ).toHaveLength(1);
    expect(state.closeMailbox).toHaveBeenCalledOnce();
  });

  it('retains the incomplete-output error after exhausting the shared retry budget', async () => {
    let attempts = 0;
    const state = await fixture(async function* (request) {
      if (!request.retryState) throw new Error('Expected the shared model retry state.');
      request.retryState.retryDelayMs = 0;
      request.retryState.attempts += 1;
      attempts += 1;
      yield {
        type: 'text.completed',
        itemId: `progress-${attempts}`,
        text: 'Checking.',
        phase: 'commentary'
      };
      yield {
        type: 'text.completed',
        itemId: `empty-${attempts}`,
        text: '',
        phase: 'final_answer'
      };
      yield { type: 'completed', reason: 'completed' };
    });
    const loop = new ExecutionLoop(state.input);
    const outcome = loop.run().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    expect(await outcome).toMatchObject({
      error: { code: 'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE', retryable: true }
    });
    expect(attempts).toBe(MAX_MODEL_ATTEMPTS);
    expect(loop.finalAnswer).toBe('');
    expect(state.publish.mock.calls.every(([event]) => !event.type.startsWith('execution.'))).toBe(
      true
    );
  });

  it('retains partial answer state while cancellation wins over a late completion', async () => {
    let abort = () => {};
    const state = await fixture(async function* () {
      yield { type: 'text.completed', itemId: 'answer', text: 'Partial answer.' };
      abort();
      yield { type: 'completed', reason: 'completed' };
    });
    abort = () => state.controller.abort();
    const loop = new ExecutionLoop(state.input);
    await expect(loop.run()).rejects.toMatchObject({ code: 'MAR_AGENT_EXECUTION_CANCELLED' });
    expect(loop.finalAnswer).toBe('Partial answer.');
    expect(state.closeMailbox).not.toHaveBeenCalled();
  });
});
