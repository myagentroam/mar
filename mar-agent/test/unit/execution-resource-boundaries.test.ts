import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelEvent } from '../../src/model/contracts.js';
import { AgentError } from '../../src/error.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { CompactCoordinator } from '../../src/runtime/compaction/coordinator.js';
import { SessionExecution } from '../../src/sdk/session-execution.js';
import { fixture, answer, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCoreFixtures();
});

it.each([false, true])(
  'preserves the compact generation error over close failure (generationFails=%s)',
  async (generationFails) => {
    const f = await fixture([], answer);
    const generationError = new Error('generation failed');
    const closeError = new Error('compact turn close failed');
    const close = vi.fn(async () => {
      throw closeError;
    });
    Object.assign(f.adapter, {
      createTurnSession: () => ({ start: f.adapter.start.bind(f.adapter), close })
    });
    const execution = new SessionExecution(
      'session',
      'execution',
      'turn',
      'run',
      'user',
      {
        modelId: 'test',
        mode: 'run',
        models: new Map(),
        generation: 0,
        instruction: undefined
      },
      new Set()
    );
    await expect(
      execution.withCompactTurn(f.adapter, async () => {
        if (generationFails) throw generationError;
        return 'summary';
      })
    ).rejects.toBe(generationFails ? generationError : closeError);
    expect(close).toHaveBeenCalledOnce();
  }
);

it('joins main turn and releases the writer after compact close fails, preserving the first cleanup error', async () => {
  const f = await fixture([], answer);
  const compactError = new Error('compact close failed');
  const releaseError = new Error('writer release failed');
  const order: string[] = [];
  const compactClose = vi
    .spyOn(CompactCoordinator.prototype, 'close')
    .mockImplementationOnce(async () => {
      order.push('compact.close');
      throw compactError;
    });
  const close = vi.fn(async () => {
    order.push('turn.close');
  });
  Object.assign(f.adapter, {
    createTurnSession: () => ({ start: f.adapter.start.bind(f.adapter), close })
  });
  const acquire = JsonlSessionStore.prototype.acquireSessionLease;
  const lease = vi
    .spyOn(JsonlSessionStore.prototype, 'acquireSessionLease')
    .mockImplementation(async function (this: JsonlSessionStore, ...args) {
      const release = await acquire.apply(this, args);
      return async () => {
        order.push('lease.release');
        await release();
        throw releaseError;
      };
    });
  const handle = f.session.run({ prompt: 'cleanup failure' });
  const events = (async () => {
    const result = [];
    for await (const event of handle) result.push(event.type);
    return result;
  })();
  try {
    await expect(handle.result()).rejects.toBe(compactError);
    expect(await events).toContain('execution.completed');
    expect(order).toEqual(['compact.close', 'turn.close', 'lease.release']);
  } finally {
    compactClose.mockRestore();
    lease.mockRestore();
  }
  expect((await f.session.run({ prompt: 'next execution' }).result()).status).toBe('completed');
});

it('finishes an old writer release failure before activating a queued successor', async () => {
  let context!: import('../../src/index.js').SessionExtensionContext;
  const f = await fixture(
    [
      {
        id: 'queued-release',
        apiVersion: '1.0',
        attachSession(value) {
          context = value;
        }
      }
    ],
    () => answer()
  );
  const entered = Promise.withResolvers<void>();
  const finishRelease = Promise.withResolvers<void>();
  const releaseError = new Error('old writer release failed');
  const acquire = JsonlSessionStore.prototype.acquireSessionLease;
  let leases = 0;
  const lease = vi
    .spyOn(JsonlSessionStore.prototype, 'acquireSessionLease')
    .mockImplementation(async function (this: JsonlSessionStore, ...args) {
      const release = await acquire.apply(this, args);
      if (args[0] !== f.session.id || ++leases !== 1) return release;
      return async () => {
        entered.resolve();
        await finishRelease.promise;
        await release();
        throw releaseError;
      };
    });
  const first = f.session.run({ prompt: 'old execution' });
  const firstEvents = (async () => {
    const events = [];
    for await (const event of first) events.push(event.type);
    return events;
  })();
  const firstResult = first.result().then(
    () => undefined,
    (error: unknown) => error
  );
  try {
    await Promise.race([
      entered.promise,
      firstResult.then(() => {
        throw new Error('Writer release was not reached.');
      })
    ]);
    const successor = await context.session.submit({
      text: 'queued successor',
      delivery: 'idle',
      waitFor: 'admission'
    });
    expect(f.adapter.requests).toHaveLength(1);
    finishRelease.resolve();
    expect(await firstResult).toBe(releaseError);
    expect(await firstEvents).toContain('execution.completed');
    await vi.waitFor(async () =>
      expect(
        (await context.session.inspect()).operations.find(
          (item) => item.operationId === successor.operationId
        )?.status
      ).toBe('completed')
    );
    expect((await f.session.run({ prompt: 'after successor' }).result()).status).toBe('completed');
    expect(f.adapter.requests).toHaveLength(3);
  } finally {
    finishRelease.resolve();
    await firstResult;
    await firstEvents;
    lease.mockRestore();
  }
});

describe.each(['turn', 'adapter'] as const)('Execution-owned %s cleanup', (resource) => {
  it.each(
    [
      { outcome: 'completed', leaseFails: false },
      { outcome: 'failed', leaseFails: false },
      { outcome: 'cancelled', leaseFails: false },
      { outcome: 'completed', leaseFails: true },
      { outcome: 'failed', leaseFails: true },
      { outcome: 'cancelled', leaseFails: true }
    ].flatMap((test) => [false, true].map((synchronous) => ({ ...test, synchronous })))
  )(
    'keeps $outcome terminal semantics and warm resources when close fails (leaseFails=$leaseFails, synchronous=$synchronous)',
    async ({ outcome, leaseFails, synchronous }) => {
      const order: string[] = [];
      const warmDisposed = vi.fn();
      const f = await fixture(
        [
          {
            id: 'warm-session-resource',
            apiVersion: '1.0',
            attachSession(context) {
              context.resources.effect(() => warmDisposed);
            }
          }
        ],
        answer
      );
      const started = Promise.withResolvers<void>();
      let firstExecution = true;
      const start = vi
        .spyOn(f.adapter, 'start')
        .mockImplementation(async function* (_request, signal): AsyncGenerator<ModelEvent> {
          started.resolve();
          if (firstExecution && outcome === 'failed')
            throw new AgentError('ORIGINAL_MODEL_FAILURE', 'Original model failure.');
          if (firstExecution && outcome === 'cancelled') {
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true })
              );
            signal.throwIfAborted();
          }
          yield* answer();
        });
      const close = vi.fn(() => {
        order.push(resource + '.close');
        if (firstExecution) {
          const error = new Error('secondary model close failure');
          if (synchronous) throw error;
          return Promise.reject(error);
        }
        return Promise.resolve();
      });
      const borrowedAdapterClose = vi.fn(async () => undefined);
      if (resource === 'turn') {
        Object.assign(f.adapter, {
          createTurnSession: () => ({ start: f.adapter.start.bind(f.adapter), close }),
          close: borrowedAdapterClose
        });
      } else Object.assign(f.adapter, { close });

      const releaseError = new Error('secondary writer release failure');
      const acquire = JsonlSessionStore.prototype.acquireSessionLease;
      const lease = vi
        .spyOn(JsonlSessionStore.prototype, 'acquireSessionLease')
        .mockImplementation(async function (this: JsonlSessionStore, ...args) {
          const release = await acquire.apply(this, args);
          if (args[0] !== f.session.id) return release;
          return async () => {
            order.push('lease.release');
            await release();
            if (firstExecution && leaseFails) throw releaseError;
          };
        });
      const handle = f.session.run({ prompt: 'first execution' });
      const events: { type: string }[] = [];
      const stream = (async () => {
        for await (const event of handle) events.push(event);
      })();
      // Attach rejection handling before any terminal can settle.
      const result = handle.result().then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      try {
        if (outcome === 'cancelled') {
          await started.promise;
          await Promise.all([handle.cancel(), handle.cancel()]);
        }
        const settled = await result;
        await stream;
        if (outcome === 'completed' && leaseFails) expect(settled).toEqual({ error: releaseError });
        else {
          expect(settled).toMatchObject({ value: { status: outcome } });
          if (outcome === 'failed')
            expect(settled).toMatchObject({ value: { errorCode: 'ORIGINAL_MODEL_FAILURE' } });
        }
        expect(close).toHaveBeenCalledTimes(1);
        expect(borrowedAdapterClose).not.toHaveBeenCalled();
        expect(order).toEqual([resource + '.close', 'lease.release']);
        expect(
          events
            .filter((event) =>
              ['execution.completed', 'execution.failed', 'execution.cancelled'].includes(
                event.type
              )
            )
            .map((event) => event.type)
        ).toEqual(['execution.' + outcome]);
        const store = await JsonlSessionStore.open(f.home);
        try {
          expect(
            (await store.read(f.session.id))
              .filter(
                (record) =>
                  record.executionId === handle.executionId &&
                  ['execution.completed', 'execution.failed', 'execution.cancelled'].includes(
                    record.type
                  )
              )
              .map((record) => record.type)
          ).toEqual(['execution.' + outcome]);
        } finally {
          await store.close();
        }
        expect(warmDisposed).not.toHaveBeenCalled();
        firstExecution = false;
        expect((await f.session.run({ prompt: 'next execution' }).result()).status).toBe(
          'completed'
        );
        expect(close).toHaveBeenCalledTimes(2);
        expect(warmDisposed).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledTimes(2);
      } finally {
        firstExecution = false;
        lease.mockRestore();
        await result;
      }
      await f.agent.clearSession(f.session.id);
      expect(warmDisposed).toHaveBeenCalledTimes(1);
    }
  );
});
