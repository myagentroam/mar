import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { createSubagentBackend } from '../../src/sdk/subagent-backend.js';
import {
  SubagentSessionController,
  type SubagentParentOperation,
  type SubagentMessageDelivery,
  type SubagentTurnHandle
} from '../../src/subagent/session-controller.js';
import type { AgentEvent } from '../../src/runtime/events.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';

const roots: string[] = [];
const controllers: SubagentSessionController[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(maxConcurrent = 4) {
  const home = await mkdtemp(join(tmpdir(), 'mar-native-agents-'));
  roots.push(home);
  const store = await JsonlSessionStore.open(home);
  const parent = await store.createSession({ workspace: home });
  const backend = createSubagentBackend(store, home);
  const open = async () => {
    const controller = await SubagentSessionController.open({
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      backend,
      limits: { maxTasks: 8, maxConcurrent }
    });
    controllers.push(controller);
    return controller;
  };
  return { store, parent, controller: await open(), open };
}

function operation(overrides: Partial<SubagentParentOperation> = {}): SubagentParentOperation {
  return {
    operationId: 'operation-native',
    ownerInstanceId: 'owner-native',
    extensionId: 'native',
    modelId: 'test',
    reasoningEffort: 'low',
    signal: new AbortController().signal,
    models: new Map([
      [
        'test',
        { id: 'test', name: 'Test', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }
      ]
    ]),
    emitTerminal: async () => {},
    startTurn: async (input) => finished(input.turnId),
    ...overrides
  };
}

function finished(
  turnId: string,
  text = 'done',
  events: readonly AgentEvent[] = []
): SubagentTurnHandle {
  return {
    executionId: 'actual-child-execution',
    turnId,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: async () => ({
      executionId: 'actual-child-execution',
      status: 'completed',
      finalAnswer: text
    }),
    cancel: () => {},
    enqueueMessage: () => false
  };
}

const task = {
  description: 'native task',
  prompt: 'self-contained',
  role: 'general-purpose' as const
};

describe('native subagent controller operations', () => {
  it.each(['ends', 'rejects'] as const)(
    'joins the child event stream after result failure when the stream %s',
    async (streamOutcome) => {
      const { controller } = await fixture();
      const release = Promise.withResolvers<void>();
      const resultFailed = Promise.withResolvers<void>();
      const terminals: unknown[] = [];
      let streamEnded = false;
      const native = operation({
        emitTerminal: async (event) => {
          terminals.push(event);
        },
        startTurn: async (input) => ({
          ...finished(input.turnId),
          async *[Symbol.asyncIterator]() {
            try {
              await release.promise;
              yield {
                type: 'message.completed' as const,
                eventId: 'late-message',
                sessionId: input.sessionId,
                executionId: 'actual-child-execution',
                turnId: input.turnId,
                sequence: 1,
                timestamp: new Date().toISOString(),
                itemId: 'late',
                phase: 'final_answer' as const,
                text: 'last child message'
              };
              if (streamOutcome === 'rejects') throw new Error('stream failure');
            } finally {
              streamEnded = true;
            }
          },
          result: async () => {
            resultFailed.resolve();
            throw new Error('result failure');
          },
          cancel: () => release.resolve()
        })
      });
      const child = await controller.withOperation(native, () =>
        controller.run({ ...task, background: true }, { waitFor: 'start' })
      );
      try {
        await resultFailed.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect((await controller.inspect(child.agentId)).status).toBe('running');
        expect(streamEnded).toBe(false);
        expect(terminals).toHaveLength(0);
        release.resolve();
        await vi.waitFor(async () =>
          expect((await controller.inspect(child.agentId)).status).toBe('failed')
        );
        const snapshot = await controller.inspect(child.agentId);
        expect(streamEnded).toBe(true);
        expect(snapshot.latestMessage?.text).toBe('last child message');
        expect(snapshot.errorMessage).toContain('result failure');
      } finally {
        release.resolve();
      }
    }
  );
  it.each(['signal', 'owner'] as const)(
    'cancels only the sender when a running Turn rejects append (%s)',
    async (kind) => {
      const { controller } = await fixture();
      const release = Promise.withResolvers<void>();
      const attempted = Promise.withResolvers<void>();
      const childCancel = vi.fn();
      const childOwner = operation({
        ownerInstanceId: 'child-owner',
        startTurn: async (input) => ({
          ...finished(input.turnId),
          result: async () => {
            await release.promise;
            return {
              executionId: 'actual-child-execution',
              status: 'completed',
              finalAnswer: 'done'
            };
          },
          cancel: childCancel,
          enqueueMessage: () => {
            attempted.resolve();
            return false;
          }
        })
      });
      const sender = operation({ ownerInstanceId: 'sender-owner' });
      const cancel = new AbortController();
      const child = await controller.withOperation(childOwner, () =>
        controller.run({ ...task, background: true }, { waitFor: 'start' })
      );
      let outcome: unknown = 'pending';
      const sent = controller
        .withOperation(sender, () =>
          controller.message(child.agentId, 'follow-up', { signal: cancel.signal })
        )
        .then(
          () => {
            outcome = 'fulfilled';
          },
          (error: unknown) => {
            outcome = error;
          }
        );
      try {
        await attempted.promise;
        if (kind === 'signal') cancel.abort(new Error('sender cancelled'));
        else await controller.cancelOwned('sender-owner');
        for (let index = 0; index < 12 && outcome === 'pending'; index++) await Promise.resolve();
        expect(outcome).not.toBe('pending');
        expect(outcome).not.toBe('fulfilled');
        expect(childCancel).not.toHaveBeenCalled();
        expect((await controller.inspect(child.agentId)).status).toBe('running');
      } finally {
        release.resolve();
        await sent;
      }
    }
  );
  it('separates a start receipt from foreground completion and cancels only an unbounded waiter', async () => {
    const { controller } = await fixture();
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const native = operation({
      startTurn: async (input) => ({
        ...finished(input.turnId),
        result: async () => {
          await completion;
          return {
            executionId: 'actual-child-execution',
            status: 'completed',
            finalAnswer: 'done'
          };
        },
        cancel: finish
      })
    });
    const result = await controller.withOperation(native, () =>
      controller.run({ ...task, background: false }, { waitFor: 'start' })
    );
    expect(['queued', 'running']).toContain(result.status);
    await expect(
      controller.withOperation(native, () =>
        controller.output(result.agentId, { untilSettled: true, waitFor: 'message' })
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    const cancel = new AbortController();
    const wait = controller.withOperation(native, () =>
      controller.output(result.agentId, {
        untilSettled: true,
        signal: cancel.signal
      })
    );
    const rejected = expect(wait).rejects.toThrow('wait cancelled');
    cancel.abort(new Error('wait cancelled'));
    await rejected;
    expect((await controller.inspect(result.agentId)).status).not.toBe('cancelled');
    finish();
    expect(
      await controller.withOperation(native, () =>
        controller.output(result.agentId, { untilSettled: true })
      )
    ).toMatchObject({ status: 'completed', waitOutcome: 'completion' });
  });

  it('persists an idle operation without fabricating a parent Execution and restores its state', async () => {
    const { store, controller, open } = await fixture();
    const result = await controller.withOperation(operation(), () => controller.run(task));
    const child = await store.getSession(result.agentId);
    expect(child.source).toMatchObject({
      parentOperationId: 'operation-native',
      ownerInstanceId: 'owner-native',
      extensionId: 'native'
    });
    expect(child.source).not.toHaveProperty('parentExecutionId');
    expect(result).toMatchObject({ status: 'completed', summary: 'done', modelId: 'test' });
    // The fake child has no durable Execution events; restart must not invent completion.
    expect(await (await open()).inspect(result.agentId)).toMatchObject({ status: 'interrupted' });
  });

  it('does not borrow or spend an active model tool creation budget', async () => {
    const { controller, store } = await fixture();
    const native = operation();
    await controller.beginParentExecution({ ...native, executionId: 'parent-real' });
    const retained = controller.captureExecution();
    for (let index = 0; index < 9; index++)
      await controller.withOperation(native, () => controller.run(task));
    for (let index = 0; index < 8; index++) await retained.run(task);
    await expect(retained.run(task)).rejects.toMatchObject({ code: 'MAR_AGENT_SUBAGENT_LIMIT' });
    const results = controller.inspectAll();
    expect(results).toHaveLength(17);
    const legacy = await store.getSession(results.at(-1)!.agentId);
    expect(legacy.source).toHaveProperty('parentExecutionId', 'parent-real');
    expect(legacy.source).not.toHaveProperty('parentOperationId');
  });

  it('preserves the original budget when recapturing a retained parent after another Execution starts', async () => {
    const { controller, store } = await fixture();
    const first = { ...operation(), executionId: 'first-parent' };
    await controller.beginParentExecution(first);
    const enterFirst = controller.captureParentFrame('first-parent');
    const retained = controller.captureExecution('first-parent');
    for (let index = 0; index < 8; index++) await retained.run(task);
    controller.endParentExecution('first-parent');
    await controller.beginParentExecution({ ...operation(), executionId: 'second-parent' });
    const second = controller.captureExecution('second-parent');
    const nested = enterFirst(() => {
      expect(controller.parentExecution('first-parent')?.executionId).toBe('first-parent');
      return controller.captureExecution();
    });
    await expect(nested.run(task)).rejects.toMatchObject({ code: 'MAR_AGENT_SUBAGENT_LIMIT' });
    const created = await second.run(task);
    if (!('agentId' in created)) throw new Error('Expected an actual child task.');
    expect((await store.getSession(created.agentId)).source).toHaveProperty(
      'parentExecutionId',
      'second-parent'
    );
    expect(controller.inspectAll()).toHaveLength(9);
  });

  it('preserves native operation provenance in a nested captured frame', async () => {
    const { controller, store } = await fixture();
    const native = operation({ operationId: 'original-native-operation' });
    const captured = controller.withOperation(native, () => controller.captureExecution());
    await controller.beginParentExecution({ ...operation(), executionId: 'different-parent' });
    const created = await captured.run({ ...task, description: 'd'.repeat(81) });
    if (!('agentId' in created)) throw new Error('Expected an actual child task.');
    expect(created.status).toBe('completed');
    expect((await store.getSession(created.agentId)).source).toMatchObject({
      parentOperationId: 'original-native-operation',
      ownerInstanceId: 'owner-native'
    });
    expect((await store.getSession(created.agentId)).source).not.toHaveProperty(
      'parentExecutionId'
    );
  });

  it('accepts native long inputs without changing legacy model tool limits', async () => {
    const { controller } = await fixture();
    const longTask = {
      ...task,
      description: 'd'.repeat(81),
      prompt: 'p'.repeat(TOOL_EXECUTION_LIMITS.subagentPromptMaxBytes + 1)
    };
    const native = operation();
    expect(await controller.withOperation(native, () => controller.run(longTask))).toHaveProperty(
      'status',
      'completed'
    );
    await controller.beginParentExecution({ ...native, executionId: 'parent-real' });
    await expect(controller.run(longTask)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
  });

  it('keeps full public results and only clips the model tool projection', async () => {
    const { controller } = await fixture();
    const text = 'x'.repeat(Math.max(20_000, TOOL_EXECUTION_LIMITS.subagentSummaryMaxBytes + 100));
    const native = operation({
      startTurn: async (input) =>
        finished(input.turnId, text, [
          {
            type: 'message.completed',
            eventId: 'child-final',
            modelId: 'test',
            modelName: 'Test',
            sessionId: input.sessionId,
            executionId: 'actual-child-execution',
            sequence: 1,
            timestamp: new Date().toISOString(),
            itemId: 'final',
            turnId: input.turnId,
            phase: 'final_answer',
            text
          }
        ])
    });
    const result = await controller.withOperation(native, () =>
      controller.run({ ...task, background: true })
    );
    await vi.waitFor(async () =>
      expect(await controller.inspect(result.agentId)).toHaveProperty('status', 'completed')
    );
    const raw = await controller.inspect(result.agentId);
    expect(raw.summary).toBe(text);
    expect(raw.latestMessage).toMatchObject({ text, truncated: false });
    raw.latestMessage!.text = 'mutated';
    expect((await controller.inspect(result.agentId)).latestMessage!.text).toBe(text);
    expect(await controller.cancel(result.agentId)).toHaveProperty(
      'latestMessage.text',
      text.slice(0, 10_000)
    );
  });

  it('cancels only tasks created by the retiring instance', async () => {
    const { controller } = await fixture();
    const cancellations: string[] = [];
    const native = operation({
      startTurn: async (input) => {
        let resolve!: (value: Awaited<ReturnType<SubagentTurnHandle['result']>>) => void;
        const result = new Promise<Awaited<ReturnType<SubagentTurnHandle['result']>>>((done) => {
          resolve = done;
        });
        return {
          ...finished(input.turnId),
          result: () => result,
          cancel: () => {
            cancellations.push(input.sessionId);
            resolve({
              executionId: 'actual-child-execution',
              status: 'cancelled',
              finalAnswer: ''
            });
          }
        };
      }
    });
    const owned = await controller.withOperation(native, () =>
      controller.run({ ...task, background: true })
    );
    const other = await controller.withOperation(
      { ...native, ownerInstanceId: 'other-owner' },
      () => controller.run({ ...task, background: true })
    );
    await controller.cancelOwned('owner-native');
    expect(cancellations).toEqual([owned.agentId]);
    expect(await controller.inspect(other.agentId)).toHaveProperty('status', 'running');
    await controller.cancel(other.agentId);
  });

  it('retires the owner of a resumed Turn without changing durable creation provenance', async () => {
    const { controller, store } = await fixture();
    const first = await controller.withOperation(operation({ ownerInstanceId: 'creator' }), () =>
      controller.run(task)
    );
    const cancellations: string[] = [];
    const resumed = operation({
      ownerInstanceId: 'resumer',
      operationId: 'resume-operation',
      startTurn: async (input) => {
        let resolve!: (value: Awaited<ReturnType<SubagentTurnHandle['result']>>) => void;
        const result = new Promise<Awaited<ReturnType<SubagentTurnHandle['result']>>>(
          (done) => (resolve = done)
        );
        return {
          ...finished(input.turnId),
          result: () => result,
          cancel: () => {
            cancellations.push(input.sessionId);
            resolve({ executionId: 'resumed-execution', status: 'cancelled', finalAnswer: '' });
          }
        };
      }
    });
    await controller.withOperation(resumed, () => controller.message(first.agentId, 'continue'));
    await controller.cancelOwned('creator');
    expect(cancellations).toEqual([]);
    expect(await controller.inspect(first.agentId)).toHaveProperty('status', 'running');
    await controller.cancelOwned('resumer');
    expect(cancellations).toEqual([first.agentId]);
    expect(await controller.inspect(first.agentId)).toHaveProperty('status', 'cancelled');
    expect((await store.getSession(first.agentId)).source).toMatchObject({
      ownerInstanceId: 'creator',
      parentOperationId: 'operation-native'
    });
  });

  it.each(['running', 'queued'] as const)(
    'retires only a sender mailbox when the receiving Turn is %s',
    async (status) => {
      const { controller } = await fixture(1);
      const delivered: SubagentMessageDelivery[] = [];
      const cancellations: string[] = [];
      const receiver = operation({
        ownerInstanceId: 'receiver',
        startTurn: async (input) => {
          delivered.push(
            ...input.initialMailbox.flatMap((message) =>
              message.delivery ? [message.delivery] : []
            )
          );
          let resolve!: (value: Awaited<ReturnType<SubagentTurnHandle['result']>>) => void;
          const result = new Promise<Awaited<ReturnType<SubagentTurnHandle['result']>>>(
            (done) => (resolve = done)
          );
          return {
            ...finished(input.turnId),
            result: () => result,
            enqueueMessage: (_message, delivery) => {
              if (delivery) delivered.push(delivery);
              return true;
            },
            cancel: () => {
              cancellations.push(input.sessionId);
              resolve({ executionId: 'receiver-execution', status: 'cancelled', finalAnswer: '' });
            }
          };
        }
      });
      const first = await controller.withOperation(receiver, () =>
        controller.run({ ...task, background: true })
      );
      const target =
        status === 'running'
          ? first
          : await controller.withOperation(receiver, () =>
              controller.run({ ...task, background: true })
            );
      await controller.withOperation(operation({ ownerInstanceId: 'sender' }), () =>
        controller.message(target.agentId, 'pending sender input')
      );
      await controller.cancelOwned('sender');
      expect(cancellations).toEqual([]);
      expect(await controller.inspect(target.agentId)).toMatchObject({
        status,
        deliveryStatus: 'cancelled'
      });
      if (status === 'queued') await controller.cancel(first.agentId);
      expect(delivered.at(-1)?.signal?.aborted).toBe(true);
      await controller.cancel(target.agentId);
    }
  );

  it('does not join an unrelated receiver mailbox control while retiring an instance', async () => {
    const { controller } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const target = await controller.withOperation(
      operation({
        ownerInstanceId: 'receiver',
        startTurn: async (input) => {
          await gate;
          return finished(input.turnId);
        }
      }),
      () => controller.run({ ...task, background: true })
    );
    const message = controller.withOperation(operation({ ownerInstanceId: 'sender' }), () =>
      controller.message(target.agentId, 'waiting for receiver startup')
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    let retired = false;
    const retirement = controller.cancelOwned('unrelated').then(() => {
      retired = true;
    });
    try {
      await vi.waitFor(() => expect(retired).toBe(true), { timeout: 150 });
    } finally {
      release();
      await message;
      await retirement;
    }
  });

  it('propagates native Turn cancellation but does not cancel a legacy retained task', async () => {
    const { controller } = await fixture();
    const source = new AbortController();
    const cancelled = vi.fn();
    const parent = operation({
      signal: source.signal,
      startTurn: async (input) => {
        let resolve!: (value: Awaited<ReturnType<SubagentTurnHandle['result']>>) => void;
        const result = new Promise<Awaited<ReturnType<SubagentTurnHandle['result']>>>(
          (done) => (resolve = done)
        );
        return {
          ...finished(input.turnId),
          result: () => result,
          cancel: () => {
            cancelled(input.sessionId);
            resolve({ executionId: 'child', status: 'cancelled', finalAnswer: '' });
          }
        };
      }
    });
    await controller.beginParentExecution({ ...parent, executionId: 'legacy-parent' });
    const legacy = await controller.captureExecution().run({ ...task, background: true });
    if (!('agentId' in legacy)) throw new Error('Expected an actual child task.');
    const native = await controller.withOperation(parent, () =>
      controller.run({ ...task, background: true })
    );
    source.abort();
    await vi.waitFor(async () =>
      expect(await controller.inspect(native.agentId)).toHaveProperty('status', 'cancelled')
    );
    expect(cancelled.mock.calls).toEqual([[native.agentId]]);
    expect(await controller.inspect(legacy.agentId)).toHaveProperty('status', 'running');
    await controller.cancel(legacy.agentId);
  });

  it('resumes a completed task with a fresh idle operation and returns a real delivery receipt', async () => {
    const { controller } = await fixture();
    const starts = vi.fn(operation().startTurn);
    const first = await controller.withOperation(operation({ startTurn: starts }), () =>
      controller.run(task)
    );
    const resumed = await controller.withOperation(
      operation({ operationId: 'next-operation', startTurn: starts }),
      () => controller.message(first.agentId, 'follow-up')
    );
    expect(resumed).toMatchObject({ agentId: first.agentId, deliveryStatus: 'accepted' });
    expect(starts.mock.calls.at(-1)?.[0]).toMatchObject({ prompt: 'follow-up' });
    await controller.withOperation(operation(), () =>
      controller.output(first.agentId, { waitMs: 10 })
    );
    expect(await controller.inspect(first.agentId)).toHaveProperty('status', 'completed');
  });

  it('rejects cancelled operation admission without creating a child Session', async () => {
    const { controller, store, parent } = await fixture();
    const signal = AbortSignal.abort(new Error('cancel-native'));
    expect(() =>
      controller.withOperation(operation({ signal }), () => controller.run(task))
    ).toThrow('cancel-native');
    expect(await store.listSubagentChildren(parent.id)).toHaveLength(0);
  });

  it('preserves both real identities when a native operation originates in an Execution', async () => {
    const { controller, store } = await fixture();
    const result = await controller.withOperation(operation({ executionId: 'real-parent' }), () =>
      controller.run(task)
    );
    expect((await store.getSession(result.agentId)).source).toMatchObject({
      parentExecutionId: 'real-parent',
      parentOperationId: 'operation-native'
    });
  });

  it('does not apply the model wait floor or ceiling and segments native long deadlines', async () => {
    const { controller } = await fixture();
    let resolve!: (value: Awaited<ReturnType<SubagentTurnHandle['result']>>) => void;
    const result = new Promise<Awaited<ReturnType<SubagentTurnHandle['result']>>>((done) => {
      resolve = done;
    });
    const context = operation({
      startTurn: async (input) => ({
        ...finished(input.turnId),
        result: () => result,
        cancel: () =>
          resolve({ executionId: 'actual-child-execution', status: 'cancelled', finalAnswer: '' })
      })
    });
    const child = await controller.withOperation(context, () =>
      controller.run({ ...task, background: true })
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const short = controller.withOperation(context, () =>
      controller.output(child.agentId, { waitMs: 1 })
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(await short).toHaveProperty('waitOutcome', 'timeout');
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const duration = 2_147_483_647 + 500;
    const long = controller.withOperation(context, () =>
      controller.output(child.agentId, { waitMs: duration })
    );
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(timer.mock.calls.every((args) => Number(args[1]) <= 2_147_483_647)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(await long).toHaveProperty('waitOutcome', 'timeout');
    timer.mockRestore();
    vi.useRealTimers();
    await controller.cancel(child.agentId);
  });

  it('validates real operation provenance without accepting malformed source identities', async () => {
    const { store, parent } = await fixture();
    const source = {
      type: 'subagent',
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      parentOperationId: 'op',
      role: 'general-purpose',
      description: 'child'
    } as const;
    for (const invalid of [
      { ...source, parentOperationId: undefined },
      { ...source, parentOperationId: '' },
      { ...source, rootSessionId: 1 },
      { ...source, description: null },
      {
        ...source,
        parentOperationId: undefined,
        parentExecutionId: 'real',
        extensionId: 'forged-without-operation'
      }
    ])
      await expect(
        store.createSession({ workspace: parent.workspace, source: invalid as never })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    expect(await store.listSubagentChildren(parent.id)).toHaveLength(0);
  });

  it('collects native terminal updates without consuming until acknowledgment', async () => {
    const { controller } = await fixture();
    const child = await controller.withOperation(operation(), () => controller.run(task));
    const [update] = controller.collectModelUpdates();
    expect(update?.snapshot).toMatchObject({
      agentId: child.agentId,
      status: 'completed',
      summary: 'done'
    });
    expect(controller.collectModelUpdates()).toHaveLength(1);
    update!.acknowledge();
    update!.acknowledge();
    expect(controller.collectModelUpdates()).toEqual([]);
    expect(await controller.output(child.agentId, { waitMs: 1000 })).not.toHaveProperty('summary');
    const other = operation({ ownerInstanceId: 'another-instance' });
    expect(
      await controller.withOperation(other, () =>
        controller.output(child.agentId, { waitMs: 1000 })
      )
    ).toHaveProperty('summary', 'done');
  });

  it('acknowledges only the captured message and later delivers completion independently', async () => {
    const { controller } = await fixture();
    let releaseSecond!: () => void;
    let releaseDone!: () => void;
    const second = new Promise<void>((resolve) => (releaseSecond = resolve));
    const done = new Promise<void>((resolve) => (releaseDone = resolve));
    const op = operation({
      startTurn: async ({ turnId }) => ({
        ...finished(turnId),
        async *[Symbol.asyncIterator]() {
          for (const text of ['first', 'second']) {
            yield {
              type: 'message.completed',
              itemId: text,
              turnId,
              phase: 'final_answer',
              text,
              timestamp: new Date().toISOString()
            } as AgentEvent;
            if (text === 'first') await second;
          }
          await done;
        },
        result: async () => {
          await done;
          return { executionId: 'child', status: 'completed', finalAnswer: 'done' };
        },
        cancel: () => {
          releaseSecond();
          releaseDone();
        }
      })
    });
    const child = await controller.withOperation(op, () =>
      controller.run({ ...task, background: true })
    );
    const readMessage = () =>
      controller.withOperation(op, () =>
        controller.output(child.agentId, { waitFor: 'message', waitMs: 1000 })
      );
    expect(await readMessage()).toHaveProperty('latestMessage.text', 'first');
    const [older] = controller.collectModelUpdates();
    expect(older?.snapshot).toMatchObject({
      status: 'running',
      latestMessage: { text: 'first', phase: 'final_answer' }
    });
    releaseSecond();
    expect(await readMessage()).toHaveProperty('latestMessage.text', 'second');
    older!.acknowledge();
    const [newer] = controller.collectModelUpdates();
    expect(newer?.snapshot).toHaveProperty('latestMessage.text', 'second');
    newer!.acknowledge();
    expect(controller.collectModelUpdates()).toEqual([]);
    releaseDone();
    await controller.withOperation(op, () => controller.output(child.agentId, { waitMs: 1000 }));
    const [terminal] = controller.collectModelUpdates();
    expect(terminal?.snapshot).toMatchObject({ status: 'completed', summary: 'done' });
    expect(terminal?.snapshot).not.toHaveProperty('latestMessage');
    terminal!.acknowledge();
    expect(controller.collectModelUpdates()).toEqual([]);
  });

  it('collects failed and cancelled Turns without public message bodies', async () => {
    const { controller } = await fixture();
    const failed = await controller.withOperation(
      operation({
        startTurn: async () => {
          throw new Error('fixture failure');
        }
      }),
      () => controller.run(task)
    );
    const cancelled = await controller.withOperation(
      operation({
        startTurn: async ({ turnId }) => ({
          ...finished(turnId),
          result: async () => ({ executionId: 'child', status: 'cancelled', finalAnswer: '' })
        })
      }),
      () => controller.run(task)
    );
    const updates = controller.collectModelUpdates();
    expect(updates.map((update) => update.snapshot)).toMatchObject([
      { agentId: failed.agentId, status: 'failed', errorCode: 'MAR_AGENT_SUBAGENT_FAILED' },
      { agentId: cancelled.agentId, status: 'cancelled' }
    ]);
    for (const update of updates) expect(update.snapshot).not.toHaveProperty('latestMessage');
  });

  it('marks model projection clipping without changing the native full result', async () => {
    const { controller } = await fixture();
    const full = 'a'.repeat(20_000);
    const native = await controller.withOperation(
      operation({ startTurn: async ({ turnId }) => finished(turnId, full) }),
      () => controller.run(task)
    );
    expect(native.summary).toBe(full);
    const [update] = controller.collectModelUpdates();
    expect(update?.truncated).toBe(true);
    expect(Buffer.byteLength(update!.snapshot.summary!)).toBeLessThanOrEqual(
      TOOL_EXECUTION_LIMITS.subagentSummaryMaxBytes
    );
  });

  it('does not consume a newer Turn by acknowledging an older captured terminal', async () => {
    const { controller } = await fixture();
    const op = operation();
    const child = await controller.withOperation(op, () => controller.run(task));
    const [older] = controller.collectModelUpdates();
    await controller.withOperation(op, async () => {
      await controller.message(child.agentId, 'next Turn');
      await controller.output(child.agentId, { waitMs: 1000 });
    });
    older!.acknowledge();
    const [newer] = controller.collectModelUpdates();
    expect(newer?.snapshot).toMatchObject({
      agentId: child.agentId,
      status: 'completed',
      summary: 'done'
    });
    newer!.acknowledge();
    expect(controller.collectModelUpdates()).toEqual([]);
  });

  it('keeps excess native children pending and does not replay restored terminals', async () => {
    const { controller, open } = await fixture();
    const children = await controller.withOperation(operation(), async () => {
      const result = [];
      for (let index = 0; index < 10; index++) result.push(await controller.run(task));
      return result;
    });
    const first = controller.collectModelUpdates();
    expect(first.map((update) => update.snapshot.agentId)).toEqual(
      children.slice(0, 8).map((child) => child.agentId)
    );
    for (const update of first) update.acknowledge();
    expect(controller.collectModelUpdates().map((update) => update.snapshot.agentId)).toEqual(
      children.slice(8).map((child) => child.agentId)
    );
    const restored = await open();
    expect(restored.collectModelUpdates()).toEqual([]);
    expect(await restored.output(children[0]!.agentId, { waitMs: 1000 })).toMatchObject({
      status: 'interrupted'
    });
  });

  it('does not automatically replay evidence consumed by model waits', async () => {
    const { controller } = await fixture();
    const child = await controller.withOperation(operation(), () => controller.run(task));
    expect(await controller.output(child.agentId, { waitMs: 1000 })).toHaveProperty(
      'summary',
      'done'
    );
    expect(controller.collectModelUpdates()).toEqual([]);
  });

  it('keeps native wait consumption separate from model tools and other Extension instances', async () => {
    const { controller } = await fixture();
    const a = operation({ ownerInstanceId: 'instance-a' });
    const b = operation({ ownerInstanceId: 'instance-b' });
    const task = await controller.withOperation(a, () =>
      controller.run({
        description: 'child',
        prompt: 'work',
        role: 'general-purpose',
        background: true
      })
    );
    expect(
      await controller.withOperation(a, () => controller.output(task.agentId, { waitMs: 1000 }))
    ).toHaveProperty('summary', 'done');
    expect(
      await controller.withOperation(a, () => controller.output(task.agentId, { waitMs: 1000 }))
    ).not.toHaveProperty('summary');
    expect(
      await controller.withOperation(b, () => controller.output(task.agentId, { waitMs: 1000 }))
    ).toHaveProperty('summary', 'done');
    expect(await controller.output(task.agentId, { waitMs: 1000 })).toHaveProperty(
      'summary',
      'done'
    );
    expect(await controller.output(task.agentId, { waitMs: 1000 })).not.toHaveProperty('summary');
    expect(await controller.inspect(task.agentId)).toHaveProperty('summary', 'done');
  });
});
