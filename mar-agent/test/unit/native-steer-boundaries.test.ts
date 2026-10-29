import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import {
  SecretValue,
  openAgentSessionCatalog,
  type AgentModelConfiguration
} from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import type { AgentExtension } from '../../src/extensions/contracts.js';
import type { AgentEvent } from '../../src/runtime/events.js';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type ModelScript = (
  request: ModelRequest,
  index: number,
  signal: AbortSignal,
  release: Promise<void>
) => AsyncIterable<ModelEvent>;

interface FixtureOptions {
  extensions?: readonly AgentExtension[];
  hostFactory?: (input: { homeDirectory: string; workspace: string }) => LocalAgentHost;
  script?: ModelScript;
}

async function waitForRelease(release: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Execution aborted.'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([release, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function* answerScript(
  _request: ModelRequest,
  index: number,
  signal: AbortSignal,
  release: Promise<void>
): AsyncIterable<ModelEvent> {
  if (index === 0) await waitForRelease(release, signal);
  yield {
    type: 'text.completed',
    itemId: 'answer-' + index,
    phase: 'final_answer',
    text: 'answer-' + index
  };
  yield { type: 'completed', reason: 'completed' };
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mar-steer-boundaries-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const homeDirectory = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(homeDirectory);
  await mkdir(workspace);
  const configuration: AgentModelConfiguration = {
    id: 'test',
    name: 'Test',
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: 'https://example.test',
    apiKey: new SecretValue('test'),
    modelId: 'test',
    contextWindowTokens: 10_000,
    maxOutputTokens: 1000,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    hostedWebSearch: false,
    enabled: true
  };
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  const host =
    options.hostFactory?.({ homeDirectory, workspace }) ??
    new LocalAgentHost({ homeDirectory, workspace });
  const script = options.script ?? answerScript;
  const create = () =>
    createAgentWithAdapter(
      {
        mode: 'normal',
        host,
        models: [configuration],
        ...(options.extensions ? { extensions: options.extensions } : {})
      },
      () =>
        ({
          configuration,
          async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
            const index = requests.length;
            requests.push({ ...request, messages: structuredClone(request.messages) });
            if (index === 0) started.resolve();
            yield* script(request, index, signal, release.promise);
          },
          async close() {}
        }) satisfies ModelAdapter
    );
  const agent = await create();
  cleanups.push(() => agent.dispose());
  const session = await agent.createSession({ workspace });
  const catalog = await openAgentSessionCatalog({ homeDirectory });
  cleanups.push(() => catalog.close());
  return {
    agent,
    catalog,
    create,
    homeDirectory,
    host,
    release: () => release.resolve(),
    requests,
    session,
    started: started.promise,
    workspace
  };
}

async function waitForGate(
  handle: { result(): Promise<unknown> },
  gate: Promise<void>,
  label: string
) {
  await Promise.race([
    gate,
    handle.result().then((result) => {
      throw new Error(
        label + ' was not reached before execution settled: ' + JSON.stringify(result)
      );
    })
  ]);
}

async function collectEvents(
  handle: AsyncIterable<AgentEvent>,
  onEvent?: (event: AgentEvent) => void
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of handle) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

function userContents(request: ModelRequest): unknown[] {
  return request.messages
    .filter((message) => message.role === 'user' && !message.contextKind)
    .map((message) => message.content);
}

async function userHistory(f: Awaited<ReturnType<typeof fixture>>) {
  const history = await f.catalog.history(f.session.id, { limit: 100 });
  return history.entries.filter((entry) => entry.kind === 'user');
}

async function deferredUserRecords(f: Awaited<ReturnType<typeof fixture>>) {
  const store = await JsonlSessionStore.open(f.homeDirectory);
  try {
    return (await store.read(f.session.id)).filter(
      (record) =>
        record.type === 'turn.user' && (record.payload as Record<string, unknown>).deferred === true
    );
  } finally {
    await store.close();
  }
}

describe('native steer acceptance boundaries', () => {
  it('waits for every tool in a response batch, including an approval-gated call, before applying steer', async () => {
    const approvalStarted = Promise.withResolvers<void>();
    const releaseApproval = Promise.withResolvers<void>();
    let approvalCount = 0;
    const firstToolCompleted = Promise.withResolvers<void>();
    const f = await fixture({
      hostFactory: ({ homeDirectory, workspace }) =>
        new LocalAgentHost({
          homeDirectory,
          workspace,
          approval: async (_request, signal) => {
            approvalCount++;
            approvalStarted.resolve();
            await waitForRelease(releaseApproval.promise, signal);
            return 'APPROVED';
          }
        }),
      script: async function* (_request, index) {
        if (index === 0) {
          yield {
            type: 'client_tool.call',
            callId: 'read-first',
            name: 'read',
            arguments: { reads: [{ path: 'first.txt' }] }
          };
          yield {
            type: 'client_tool.call',
            callId: 'read-gated',
            name: 'read',
            arguments: {
              reads: [{ path: 'second.txt' }],
              permission: { action: 'ask', reason: 'Test approval gate.' }
            }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        yield {
          type: 'text.completed',
          itemId: 'answer-' + index,
          phase: 'final_answer',
          text: 'done'
        };
        yield { type: 'completed', reason: 'completed' };
      }
    });
    await writeFile(join(f.workspace, 'first.txt'), 'first');
    await writeFile(join(f.workspace, 'second.txt'), 'second');
    const handle = f.session.run({ prompt: 'initial', permissionMode: 'auto' });
    const eventsPromise = collectEvents(handle, (event) => {
      if (event.type === 'tool.completed' && event.callId === 'read-first')
        firstToolCompleted.resolve();
    });
    await waitForGate(handle, f.started, 'initial model request');
    await waitForGate(handle, approvalStarted.promise, 'tool approval');
    await waitForGate(handle, firstToolCompleted.promise, 'first tool completion');
    const receipt = await f.session.steer({
      expectedExecutionId: handle.executionId,
      prompt: 'guidance after tools',
      modelText: 'model guidance after tools',
      clientMessageId: 'tool-batch-steer'
    });
    expect(receipt.status).toBe('accepted');
    expect(approvalCount).toBe(1);
    expect(f.requests).toHaveLength(1);
    releaseApproval.resolve();
    expect(await handle.result()).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    const events = await eventsPromise;
    expect(
      events.filter((event) => event.type === 'tool.completed').map((event) => event.callId)
    ).toEqual(['read-first', 'read-gated']);
    expect(f.requests).toHaveLength(2);
    expect(userContents(f.requests[1]!)).toContain('model guidance after tools');

    // The receipt can bisect a tool batch. Rollback keeps earlier completed work,
    // while recovery must not re-execute calls whose results were truncated.
    if (receipt.status !== 'accepted') throw new Error('Steer was not accepted.');
    await f.agent.dispose();
    await f.catalog.rollback(f.session.id, {
      beforeInput: { turnId: receipt.entry.turnId, clientMessageId: 'tool-batch-steer' }
    });
    const history = await f.catalog.history(f.session.id, { limit: 1000 });
    expect(
      history.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.text)
    ).toEqual(['initial']);
    expect(
      history.entries.some(
        (entry) =>
          entry.kind === 'event' &&
          entry.event.type === 'tool.completed' &&
          entry.event.callId === 'read-first'
      )
    ).toBe(true);
    expect(
      history.entries.some(
        (entry) =>
          entry.kind === 'event' &&
          entry.event.type === 'tool.completed' &&
          entry.event.callId === 'read-gated'
      )
    ).toBe(false);
    const reopened = await f.create();
    cleanups.push(() => reopened.dispose());
    const resumed = await reopened.openSession(f.session.id);
    const continued = resumed.run({ prompt: 'continue after rollback', permissionMode: 'auto' });
    const continuedEvents = collectEvents(continued);
    expect(await continued.result()).toMatchObject({ status: 'completed' });
    expect((await continuedEvents).filter((event) => event.type === 'tool.started')).toEqual([]);
    expect(userContents(f.requests.at(-1)!)).not.toContain('model guidance after tools');
  });

  it('runs prompt.submit once at admission and does not rerun it when cancellation recovery applies the input', async () => {
    const text = 'accepted once';
    let hookCalls = 0;
    const extension: AgentExtension = {
      id: 'native-steer-hook-count',
      apiVersion: '1.0',
      attachSession(context) {
        context.hooks.intercept('prompt.submit', (input, _call, next) => {
          if (input.text === text) hookCalls++;
          return next(input);
        });
      }
    };
    const f = await fixture({ extensions: [extension] });
    const handle = f.session.run({ prompt: 'initial', permissionMode: 'full-access' });
    await waitForGate(handle, f.started, 'initial model request');
    const input = {
      expectedExecutionId: handle.executionId,
      prompt: text,
      clientMessageId: 'hook-once'
    };
    expect((await f.session.steer(input)).status).toBe('accepted');
    expect(hookCalls).toBe(1);
    handle.cancel();
    expect(await handle.result()).toMatchObject({ status: 'cancelled' });
    expect(
      await f.session.run({ prompt: 'follow-up', permissionMode: 'full-access' }).result()
    ).toMatchObject({ status: 'completed' });
    expect(hookCalls).toBe(1);
    expect(userContents(f.requests[1]!)).toEqual(['initial', text, 'follow-up']);
  });

  it('restores pending input before an idle barrier created by the new Session ready Hook', async () => {
    let restoring = false;
    const queueSignal = new AbortController();
    const extension: AgentExtension = {
      id: 'native-steer-recovery-order',
      apiVersion: '1.0',
      attachSession(context) {
        context.hooks.observe('session.ready', async () => {
          if (restoring)
            await context.session!.submit({
              text: 'later idle input',
              delivery: 'idle',
              waitFor: 'admission',
              queueSignal: queueSignal.signal
            });
        });
      }
    };
    const f = await fixture({ extensions: [extension] });
    const handle = f.session.run({ prompt: 'initial' });
    await waitForGate(handle, f.started, 'initial model request');
    await f.session.steer({
      expectedExecutionId: handle.executionId,
      prompt: 'earlier pending input',
      clientMessageId: 'recovery-order'
    });
    handle.cancel();
    await handle.result();
    await f.agent.dispose();
    restoring = true;
    const reopened = await f.create();
    cleanups.push(() => reopened.dispose());
    try {
      const session = await reopened.openSession(f.session.id);
      expect(await session.run({ prompt: 'new request' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(userContents(f.requests[1]!)).toEqual([
        'initial',
        'earlier pending input',
        'new request'
      ]);
    } finally {
      queueSignal.abort();
    }
  });

  it('applies cancelled pending input before the next authorized SDK idle input', async () => {
    let context!: Parameters<NonNullable<AgentExtension['attachSession']>>[0];
    const extension: AgentExtension = {
      id: 'native-steer-idle-recovery',
      apiVersion: '1.0',
      attachSession(value) {
        context = value;
      }
    };
    const f = await fixture({ extensions: [extension] });
    const handle = f.session.run({ prompt: 'initial' });
    await waitForGate(handle, f.started, 'initial model request');
    await f.session.steer({
      expectedExecutionId: handle.executionId,
      prompt: 'earlier pending input',
      clientMessageId: 'idle-recovery'
    });
    expect(
      await f.agent.sessionInputReceipt(f.session.id, {
        clientMessageId: 'idle-recovery',
        executionId: handle.executionId
      })
    ).toMatchObject({
      status: 'accepted',
      clientMessageId: 'idle-recovery',
      executionId: handle.executionId
    });
    const queued = await context.session!.submit({
      text: 'authorized idle input',
      delivery: 'idle',
      waitFor: 'admission'
    });
    handle.cancel();
    await handle.result();
    await vi.waitFor(async () =>
      expect(
        (await context.session!.inspect()).operations.find(
          (entry) => entry.operationId === queued.operationId
        )?.status
      ).toBe('completed')
    );
    expect(userContents(f.requests[1]!)).toEqual([
      'initial',
      'earlier pending input',
      'authorized idle input'
    ]);
    const receipt = await f.agent.sessionInputReceipt(f.session.id, {
      clientMessageId: 'idle-recovery',
      executionId: handle.executionId
    });
    expect(receipt).toMatchObject({
      status: 'applied',
      clientMessageId: 'idle-recovery',
      executionId: handle.executionId,
      appliedExecutionId: expect.any(String),
      appliedTurnId: expect.any(String)
    });
    expect(receipt?.appliedExecutionId).not.toBe(receipt?.executionId);
    expect(receipt?.appliedTurnId).not.toBe(receipt?.turnId);
    expect(
      await f.agent.sessionInputReceipt(f.session.id, {
        clientMessageId: 'idle-recovery',
        executionId: 'wrong-execution'
      })
    ).toBeUndefined();
  });

  it('does not turn accepted guidance into a new idle execution after a model failure', async () => {
    let context!: Parameters<NonNullable<AgentExtension['attachSession']>>[0];
    const f = await fixture({
      extensions: [
        {
          id: 'native-steer-failed-target',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ],
      script: async function* (_request, index, signal, gate) {
        if (index === 0) {
          await waitForRelease(gate, signal);
          throw new Error('model failed');
        }
        yield {
          type: 'text.completed',
          itemId: 'retry-answer',
          phase: 'final_answer',
          text: 'done'
        };
        yield { type: 'completed', reason: 'completed' };
      }
    });
    const handle = f.session.run({ prompt: 'initial' });
    await waitForGate(handle, f.started, 'initial model request');
    expect(
      await f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: 'pending after failure',
        clientMessageId: 'failed-target'
      })
    ).toMatchObject({ status: 'accepted' });
    f.release();
    expect(await handle.result()).toMatchObject({ status: 'failed' });
    await vi.waitFor(async () =>
      expect(
        (await context.session!.inspect()).operations.some((entry) => entry.status === 'cancelled')
      ).toBe(true)
    );
    expect(f.requests).toHaveLength(1);
    expect(await f.session.run({ prompt: 'retry' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(userContents(f.requests[1]!)).toEqual(['initial', 'pending after failure', 'retry']);
    expect(
      (await userHistory(f)).filter(
        (entry) => entry.kind === 'user' && entry.text === 'pending after failure'
      )
    ).toHaveLength(1);
  });

  it('returns nonacceptance when the target fails before a blocked admission reaches the writer', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({
      extensions: [
        {
          id: 'native-steer-closed-admission',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.intercept('prompt.submit', async (input, _call, next) => {
              if (input.text === 'late input') {
                entered.resolve();
                await release.promise;
              }
              return next(input);
            });
          }
        }
      ],
      script: async function* (_request, _index, signal, gate) {
        yield { type: 'response.started', responseId: 'failed-admission-response' };
        await waitForRelease(gate, signal);
        throw new Error('model failed');
      }
    });
    const handle = f.session.run({ prompt: 'initial' });
    await waitForGate(handle, f.started, 'initial model request');
    const steer = f.session.steer({
      expectedExecutionId: handle.executionId,
      prompt: 'late input',
      clientMessageId: 'closed-admission'
    });
    try {
      await entered.promise;
      f.release();
      expect(await handle.result()).toMatchObject({ status: 'failed' });
      release.resolve();
      expect(await steer).toEqual({ status: 'notAccepted' });
      expect(
        (await userHistory(f)).filter(
          (entry) => entry.kind === 'user' && entry.text === 'late input'
        )
      ).toEqual([]);
    } finally {
      release.resolve();
    }
  });

  it('returns handled without history, a live received event, or a follow-up model request', async () => {
    const text = 'extension handles this';
    const extension: AgentExtension = {
      id: 'native-steer-handled',
      apiVersion: '1.0',
      attachSession(context) {
        context.hooks.intercept('prompt.submit', (input, _call, next) =>
          input.text === text ? { value: { drop: 'handled' } } : next(input)
        );
      }
    };
    const f = await fixture({ extensions: [extension] });
    const handle = f.session.run({ prompt: 'initial', permissionMode: 'full-access' });
    const eventsPromise = collectEvents(handle);
    await waitForGate(handle, f.started, 'initial model request');
    expect(
      await f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: text,
        clientMessageId: 'handled-input'
      })
    ).toEqual({ status: 'handled' });
    expect((await userHistory(f)).map((entry) => entry.kind === 'user' && entry.text)).toEqual([
      'initial'
    ]);
    expect(f.requests).toHaveLength(1);
    f.release();
    expect(await handle.result()).toMatchObject({ status: 'completed' });
    expect((await eventsPromise).some((event) => event.type === 'input.received')).toBe(false);
    expect(f.requests).toHaveLength(1);
  });

  it('rejects a prompt.submit failure before the writer commits and leaves no deferred record', async () => {
    const text = 'fails before writer';
    const extension: AgentExtension = {
      id: 'native-steer-pre-leaf-failure',
      apiVersion: '1.0',
      attachSession(context) {
        context.hooks.intercept('prompt.submit', (input, _call, next) => {
          if (input.text === text) throw new Error('pre-leaf failure');
          return next(input);
        });
      }
    };
    const f = await fixture({ extensions: [extension] });
    const handle = f.session.run({ prompt: 'initial', permissionMode: 'full-access' });
    await waitForGate(handle, f.started, 'initial model request');
    await expect(
      f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: text,
        clientMessageId: 'pre-leaf'
      })
    ).rejects.toThrow('pre-leaf failure');
    expect(await deferredUserRecords(f)).toHaveLength(0);
    f.release();
    expect(await handle.result()).toMatchObject({ status: 'completed' });
    expect(f.requests).toHaveLength(1);
    expect((await userHistory(f)).map((entry) => entry.kind === 'user' && entry.text)).toEqual([
      'initial'
    ]);
  });

  it('keeps concurrent next calls and a post-commit failure accepted with exactly one durable input', async () => {
    const text = 'committed before hook throws';
    let hookCalls = 0;
    const extension: AgentExtension = {
      id: 'native-steer-post-commit-failure',
      apiVersion: '1.0',
      attachSession(context) {
        context.hooks.intercept('prompt.submit', async (input, _call, next) => {
          if (input.text !== text) return next(input);
          hookCalls++;
          await Promise.all([next(input), next(input)]);
          throw new Error('post-commit failure');
        });
      }
    };
    const f = await fixture({ extensions: [extension] });
    const handle = f.session.run({ prompt: 'initial', permissionMode: 'full-access' });
    await waitForGate(handle, f.started, 'initial model request');
    const input = {
      expectedExecutionId: handle.executionId,
      prompt: text,
      clientMessageId: 'post-commit'
    };
    const receipt = await f.session.steer(input);
    expect(receipt.status).toBe('accepted');
    expect(await f.session.steer(input)).toEqual(receipt);
    expect(hookCalls).toBe(1);
    const records = await deferredUserRecords(f);
    expect(records).toHaveLength(1);
    expect(
      (await userHistory(f)).filter((entry) => entry.kind === 'user' && entry.text === text)
    ).toHaveLength(1);
    f.release();
    expect(await handle.result()).toMatchObject({ status: 'completed' });
    expect(userContents(f.requests[1]!).filter((content) => content === text)).toHaveLength(1);
  });

  it('keeps the committed receipt when the live observer fails and shares the durable history identity', async () => {
    let observerFailures = 0;
    class FailingObserverHost extends LocalAgentHost {
      override async emit(event: AgentEvent): Promise<void> {
        if (event.type === 'input.received') {
          observerFailures++;
          throw new Error('observer failed');
        }
        super.emit(event);
      }
    }
    const f = await fixture({
      hostFactory: (input) => new FailingObserverHost(input)
    });
    const handle = f.session.run({ prompt: 'initial', permissionMode: 'full-access' });
    const eventsPromise = collectEvents(handle);
    await waitForGate(handle, f.started, 'initial model request');
    const receipt = await f.session.steer({
      expectedExecutionId: handle.executionId,
      prompt: 'live and durable',
      clientMessageId: 'observer-fails'
    });
    expect(receipt.status).toBe('accepted');
    f.release();
    expect(await handle.result()).toMatchObject({ status: 'completed' });
    const events = await eventsPromise;
    const live = events.find((event) => event.type === 'input.received');
    const historyEntry = (await userHistory(f)).find(
      (entry) => entry.kind === 'user' && entry.text === 'live and durable'
    );
    const records = await deferredUserRecords(f);
    expect(observerFailures).toBe(1);
    expect(live?.type === 'input.received' && live.entry.recordId).toBe(
      receipt.status === 'accepted' ? receipt.entry.recordId : undefined
    );
    expect(historyEntry?.recordId).toBe(
      live?.type === 'input.received' ? live.entry.recordId : undefined
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.recordId).toBe(
      live?.type === 'input.received' ? live.entry.recordId : undefined
    );
  });

  it('rejects native steer while an SDK idle input forms the FIFO barrier', async () => {
    let sessionContext!: Parameters<NonNullable<AgentExtension['attachSession']>>[0];
    const extension: AgentExtension = {
      id: 'native-steer-idle-barrier',
      apiVersion: '1.0',
      attachSession(context) {
        sessionContext = context;
      }
    };
    const f = await fixture({ extensions: [extension] });
    const handle = f.session.run({ prompt: 'initial', permissionMode: 'full-access' });
    await waitForGate(handle, f.started, 'initial model request');
    const queueSignal = new AbortController();
    const queued = await sessionContext.session!.submit({
      text: 'idle barrier',
      delivery: 'idle',
      waitFor: 'admission',
      queueSignal: queueSignal.signal
    });
    expect(queued.kind).toBe('submit');
    expect(
      await f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: 'must not pass idle',
        clientMessageId: 'idle-barrier'
      })
    ).toEqual({ status: 'notAccepted' });
    queueSignal.abort();
    f.release();
    expect(await handle.result()).toMatchObject({ status: 'completed' });
    expect(f.requests).toHaveLength(1);
    expect((await userHistory(f)).map((entry) => entry.kind === 'user' && entry.text)).toEqual([
      'initial'
    ]);
  });

  it('returns notAccepted once finalization has closed steer, even before the result settles', async () => {
    const completionEntered = Promise.withResolvers<void>();
    const releaseCompletion = Promise.withResolvers<void>();
    class BlockingCompletionHost extends LocalAgentHost {
      override async emit(event: AgentEvent): Promise<void> {
        if (event.type === 'execution.completed') {
          completionEntered.resolve();
          await releaseCompletion.promise;
        }
        super.emit(event);
      }
    }
    const f = await fixture({ hostFactory: (input) => new BlockingCompletionHost(input) });
    const handle = f.session.run({ prompt: 'initial', permissionMode: 'full-access' });
    await waitForGate(handle, f.started, 'initial model request');
    f.release();
    await waitForGate(handle, completionEntered.promise, 'execution completion publication');
    expect(
      await f.session.steer({
        expectedExecutionId: handle.executionId,
        prompt: 'too late',
        clientMessageId: 'final-race'
      })
    ).toEqual({ status: 'notAccepted' });
    releaseCompletion.resolve();
    expect(await handle.result()).toMatchObject({ status: 'completed' });
    expect(f.requests).toHaveLength(1);
    expect((await userHistory(f)).map((entry) => entry.kind === 'user' && entry.text)).toEqual([
      'initial'
    ]);
  });
});
