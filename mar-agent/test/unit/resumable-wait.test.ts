import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeCells } from '../../src/tools/code-mode/cells.js';
import { structuredToolEventData } from '../../src/tools/output-projection.js';
import type { ToolExecutionContext } from '../../src/tools/contracts.js';
import { createToolWaitInterrupt, waitForToolCondition } from '../../src/tools/wait.js';

afterEach(() => vi.useRealTimers());

describe('resumable wait outcomes', () => {
  it.each(['initial', 'notification', 'deadline'] as const)(
    'rejects a failed condition check at %s and releases wait resources',
    async (stage) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const unsubscribe = vi.fn();
      const unsubscribeInterrupt = vi.fn();
      const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
      let notify = () => {};
      let fail = stage === 'initial';
      const failure = new Error('condition failed');
      const waiting = waitForToolCondition({
        ready: () => {
          if (fail) throw failure;
          return false;
        },
        subscribe: (listener) => {
          notify = listener;
          return unsubscribe;
        },
        interrupt: { pending: () => false, subscribe: () => unsubscribeInterrupt },
        waitMs: 10,
        signal: controller.signal
      });
      const result = waiting.catch((error: unknown) => error);
      fail = true;
      if (stage === 'notification') expect(() => notify()).not.toThrow();
      if (stage === 'deadline') await vi.advanceTimersByTimeAsync(10);
      expect(await result).toBe(failure);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(unsubscribeInterrupt).toHaveBeenCalledOnce();
      expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('projects only declared wait outcomes and a steer reason for interrupted waits', () => {
    const base = { cellId: 'cell', status: 'running' };
    expect(
      structuredToolEventData('code_exec', { ...base, waitOutcome: 'unexpected', reason: 'steer' })
    ).not.toHaveProperty('waitOutcome');
    expect(
      structuredToolEventData('code_exec', { ...base, waitOutcome: 'completion', reason: 'steer' })
    ).not.toHaveProperty('reason');
    expect(
      structuredToolEventData('code_exec', { ...base, waitOutcome: 'interrupted', reason: 'steer' })
    ).toMatchObject({ waitOutcome: 'interrupted', reason: 'steer' });
  });

  it('reports a voluntary cell yield without ending the cell', async () => {
    const cells = new CodeCells();
    const release = Promise.withResolvers<void>();
    const context: ToolExecutionContext = {
      sessionId: 'session',
      executionId: 'run',
      mode: 'run',
      signal: new AbortController().signal
    };
    try {
      const result = await cells.start('await task;', context, async (_source, _call, output) => {
        output.yield();
        await release.promise;
        return { content: '' };
      });
      expect(result.data).toMatchObject({ status: 'running', waitOutcome: 'yield' });
      release.resolve();
      const final = await cells.wait(
        { cellId: (result.data as { cellId: string }).cellId, yieldMs: 10000 },
        context
      );
      expect(final.data).toMatchObject({ status: 'completed', waitOutcome: 'completion' });
    } finally {
      release.resolve();
      await cells.dispose();
    }
  });

  it('returns timeout once the timer fires without requiring a mocked monotonic clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = waitForToolCondition({
      ready: () => false,
      subscribe: () => () => {},
      waitMs: 10
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe('timeout');
  });

  it.each(['ready', 'cancel'] as const)(
    'releases a synchronous source subscription on %s without registering later resources',
    async (outcome) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const addAbort = vi.spyOn(controller.signal, 'addEventListener');
      const unsubscribe = vi.fn();
      const subscribeInterrupt = vi.fn(() => vi.fn());
      const error = new Error('cancelled while subscribing');
      let ready = false;
      const waiting = waitForToolCondition({
        ready: () => ready,
        subscribe: (notify) => {
          if (outcome === 'ready') ready = true;
          else controller.abort(error);
          notify();
          return unsubscribe;
        },
        waitMs: 300000,
        signal: controller.signal,
        interrupt: { pending: () => false, subscribe: subscribeInterrupt }
      });
      if (outcome === 'ready') await expect(waiting).resolves.toBe('ready');
      else await expect(waiting).rejects.toBe(error);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(subscribeInterrupt).not.toHaveBeenCalled();
      expect(addAbort).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('releases both subscriptions if interrupt notifies synchronously', async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const unsubscribeInterrupt = vi.fn();
    const controller = new AbortController();
    const addAbort = vi.spyOn(controller.signal, 'addEventListener');
    await expect(
      waitForToolCondition({
        ready: () => false,
        subscribe: () => unsubscribe,
        waitMs: 300000,
        signal: controller.signal,
        interrupt: {
          pending: () => true,
          subscribe: (notify) => {
            notify();
            return unsubscribeInterrupt;
          }
        }
      })
    ).resolves.toBe('interrupted');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribeInterrupt).toHaveBeenCalledOnce();
    expect(addAbort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes a pending steer on entry and releases both subscriptions', async () => {
    let pending = true;
    const interrupt = createToolWaitInterrupt(() => pending);
    const unsubscribe = vi.fn();
    await expect(
      waitForToolCondition({
        ready: () => false,
        subscribe: () => unsubscribe,
        waitMs: 300000,
        interrupt
      })
    ).resolves.toBe('interrupted');
    expect(unsubscribe).toHaveBeenCalledOnce();
    pending = false;
    const next = waitForToolCondition({
      ready: () => false,
      subscribe: () => () => {},
      waitMs: 300000,
      interrupt
    });
    pending = true;
    interrupt.notify();
    await expect(next).resolves.toBe('interrupted');
  });

  it('prefers ready data to steer and propagates real cancellation', async () => {
    const interrupt = createToolWaitInterrupt(() => true);
    await expect(
      waitForToolCondition({
        ready: () => true,
        subscribe: () => () => {},
        waitMs: 300000,
        interrupt
      })
    ).resolves.toBe('ready');
    const controller = new AbortController();
    const error = new Error('execution cancelled');
    controller.abort(error);
    expect(() =>
      waitForToolCondition({
        ready: () => true,
        subscribe: () => () => {},
        waitMs: 300000,
        interrupt,
        signal: controller.signal
      })
    ).toThrow(error);
  });

  it('distinguishes cell timeout, snapshot, steer, completion, and cached replay', async () => {
    const cells = new CodeCells();
    const release = Promise.withResolvers<void>();
    const signal = new AbortController().signal;
    let pending = false;
    const waitInterrupt = createToolWaitInterrupt(() => pending);
    const context: ToolExecutionContext = {
      sessionId: 'session',
      executionId: 'run',
      mode: 'run',
      signal,
      waitInterrupt
    };
    try {
      vi.useFakeTimers();
      let cellSignal: AbortSignal | undefined;
      const starting = cells.start('await task;', context, async (_source, call) => {
        cellSignal = call.signal;
        expect(call.waitInterrupt).toBeUndefined();
        await release.promise;
        return { content: '' };
      });
      await vi.advanceTimersByTimeAsync(30000);
      const initial = (await starting).data as { cellId: string };
      expect(initial).toMatchObject({ status: 'running', waitOutcome: 'timeout' });
      expect(
        (await cells.wait({ cellId: initial.cellId, yieldMs: 0 }, context)).data
      ).toMatchObject({ status: 'running', waitOutcome: 'snapshot' });
      const waiting = cells.wait({ cellId: initial.cellId, yieldMs: 300000 }, context);
      pending = true;
      waitInterrupt.notify();
      expect((await waiting).data).toMatchObject({
        status: 'running',
        waitOutcome: 'interrupted',
        reason: 'steer'
      });
      expect(cellSignal?.aborted).toBe(false);
      pending = false;
      release.resolve();
      const final = await cells.wait({ cellId: initial.cellId, yieldMs: 300000 }, context);
      expect(final.data).toMatchObject({ status: 'completed', waitOutcome: 'completion' });
      expect(final.data).not.toHaveProperty('reason');
      const replay = await cells.wait({ cellId: initial.cellId, yieldMs: 0 }, context);
      expect(replay.data).toMatchObject({
        status: 'completed',
        waitOutcome: 'snapshot',
        cached: true
      });
      expect(replay.data).not.toHaveProperty('reason');
    } finally {
      release.resolve();
      await cells.dispose();
    }
  });
});
