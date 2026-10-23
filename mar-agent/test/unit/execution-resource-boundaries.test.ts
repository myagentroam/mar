import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelEvent } from '../../src/agent-core/model/contracts.js';
import { MarAgentError } from '../../src/agent-core/error.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { fixture, answer, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCoreFixtures();
});

it('finishes an old writer release failure before activating a queued successor', async () => {
  let context!: import('../../src/index.js').CoreSessionExtensionContext;
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
  it.each([
    { outcome: 'completed', leaseFails: false },
    { outcome: 'failed', leaseFails: false },
    { outcome: 'cancelled', leaseFails: false },
    { outcome: 'completed', leaseFails: true },
    { outcome: 'failed', leaseFails: true },
    { outcome: 'cancelled', leaseFails: true }
  ] as const)(
    'keeps $outcome terminal semantics and warm resources when close rejects (leaseFails=$leaseFails)',
    async ({ outcome, leaseFails }) => {
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
            throw new MarAgentError('ORIGINAL_MODEL_FAILURE', 'Original model failure.');
          if (firstExecution && outcome === 'cancelled') {
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true })
              );
            signal.throwIfAborted();
          }
          yield* answer();
        });
      const close = vi.fn(async () => {
        order.push(resource + '.close');
        if (firstExecution) throw new Error('secondary model close failure');
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
