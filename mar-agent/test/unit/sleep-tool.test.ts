import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeSleep as runSleep, sleepToolDefinition } from '../../src/tools/agent/sleep.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';
import type { ToolRuntimeContext } from '../../src/tools/runtime-context.js';
import { createToolWaitInterrupt } from '../../src/tools/wait.js';
import { structuredToolEventData } from '../../src/tools/output-projection.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function context(values: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext {
  return {
    signal: new AbortController().signal,
    emit: vi.fn(async () => {}),
    ...values
  } as ToolRuntimeContext;
}
function executeSleep(input: unknown, ctx: ToolRuntimeContext) {
  return runSleep(input, ctx, 'sleep-call');
}

describe('sleep tool', () => {
  it('publishes the actual wait start and keeps the deadline when event delivery is slow', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date('2026-10-20T15:50:00.000Z'));
    const delivered = Promise.withResolvers<void>();
    const ctx = context({ emit: vi.fn(() => delivered.promise) });
    const settled = vi.fn();
    const waiting = executeSleep({ durationMs: 100 }, ctx).then((result) => {
      settled();
      return result;
    });
    expect(ctx.emit).toHaveBeenCalledWith({
      type: 'sleep.started',
      callId: 'sleep-call',
      durationMs: 100,
      startedAt: '2026-10-20T15:50:00.000Z'
    });
    await vi.advanceTimersByTimeAsync(40);
    delivered.resolve();
    await vi.advanceTimersByTimeAsync(59);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await waiting).data.elapsedMs).toBe(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not publish a wait start for rejected input or an already cancelled execution', async () => {
    const ctx = context({ signal: AbortSignal.abort() });
    await expect(executeSleep({ durationMs: 0 }, ctx)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await expect(executeSleep({ durationMs: 100 }, ctx)).rejects.toBeDefined();
    expect(ctx.emit).not.toHaveBeenCalled();
  });
  it.each([100, 1_800_000])(
    'waits until the requested %s ms deadline and reports elapsed time',
    async (durationMs) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const settled = vi.fn();
      const waiting = executeSleep({ durationMs }, context()).then((value) => {
        settled();
        return value;
      });
      await vi.advanceTimersByTimeAsync(durationMs - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await waiting;
      expect(result.data).toEqual({ durationMs, elapsedMs: durationMs, wakeReason: 'elapsed' });
      expect(JSON.parse(result.content)).toEqual(result.data);
      expect(structuredToolEventData('sleep', result.data)).toEqual(result.data);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([
    [0.49, 0],
    [0.5, 1],
    [1.49, 1],
    [1.5, 2]
  ])(
    'rounds %s elapsed milliseconds to %s without capping at the requested duration',
    async (elapsed, expected) => {
      vi.spyOn(performance, 'now')
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1000 + elapsed);
      const result = await executeSleep(
        { durationMs: 1 },
        context({ waitInterrupt: createToolWaitInterrupt(() => true) })
      );
      expect(result.data.elapsedMs).toBe(expected);
      expect(JSON.parse(result.content).elapsedMs).toBe(expected);
    }
  );

  it('rejects invalid or coerced wake reasons in structured events', () => {
    for (const wakeReason of [undefined, 'timeout', { toString: () => 'steer' }])
      expect(
        structuredToolEventData('sleep', { durationMs: 1, elapsedMs: 0, wakeReason })
      ).toBeUndefined();
    for (const wakeReason of ['elapsed', 'steer', 'subagent_message']) {
      const data = { durationMs: 1, elapsedMs: 0, wakeReason };
      expect(structuredToolEventData('sleep', data)).toEqual(data);
    }
  });

  it.each(['steer', 'subagent_message'] as const)(
    'wakes for %s already pending or received during the wait without consuming it',
    async (wakeReason) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      let pending = false;
      const source = createToolWaitInterrupt(() => pending);
      const unsubscribe = vi.fn();
      const subscribe = source.subscribe.bind(source);
      source.subscribe = (listener) => {
        const release = subscribe(listener);
        return () => {
          unsubscribe();
          release();
        };
      };
      const input = context(
        wakeReason === 'steer' ? { waitInterrupt: source } : { contextUpdates: source }
      );
      const waiting = executeSleep({ durationMs: 300000 }, input);
      await vi.advanceTimersByTimeAsync(20);
      pending = true;
      source.notify();
      expect((await waiting).data).toEqual({ durationMs: 300000, elapsedMs: 20, wakeReason });
      expect(pending).toBe(true);
      expect((await executeSleep({ durationMs: 300000 }, input)).data.wakeReason).toBe(wakeReason);
      expect(unsubscribe).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('ignores notifications without unread messages and cleans up on expiry', async () => {
    vi.useFakeTimers();
    const source = createToolWaitInterrupt(() => false);
    const waiting = executeSleep({ durationMs: 50 }, context({ contextUpdates: source }));
    source.notify();
    await vi.advanceTimersByTimeAsync(50);
    expect((await waiting).data.wakeReason).toBe('elapsed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prefers an unread child message when a steer is also pending', async () => {
    const source = createToolWaitInterrupt(() => true);
    const result = await executeSleep(
      { durationMs: 300000 },
      context({
        waitInterrupt: source,
        contextUpdates: source
      })
    );
    expect(result.data.wakeReason).toBe('subagent_message');
  });

  it.each([false, true])(
    'propagates cancellation (already aborted: %s) and releases listeners',
    async (aborted) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const reason = new Error('Execution cancelled');
      const release = vi.fn();
      const subscribe = vi.fn(() => release);
      if (aborted) controller.abort(reason);
      const waiting = executeSleep(
        { durationMs: 300000 },
        context({
          signal: controller.signal,
          contextUpdates: { pending: () => false, subscribe }
        })
      );
      const assertion = expect(waiting).rejects.toBe(reason);
      // Let the persisted start event finish before cancelling the active wait.
      await Promise.resolve();
      controller.abort(reason);
      await assertion;
      expect(subscribe).toHaveBeenCalledTimes(aborted ? 0 : 1);
      expect(release).toHaveBeenCalledTimes(aborted ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('preserves cancellation when input becomes ready immediately before abort', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled before returning to the caller');
    const waiting = executeSleep(
      { durationMs: 300000 },
      context({
        signal: controller.signal,
        waitInterrupt: createToolWaitInterrupt(() => true)
      })
    );
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it('shares schema and runtime duration boundaries without a default', async () => {
    const schema = sleepToolDefinition.inputSchema as {
      properties: { durationMs: Record<string, unknown> };
      required: string[];
    };
    expect(schema.required).toEqual(['durationMs']);
    expect(schema.properties.durationMs).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 1_800_000
    });
    expect(schema.properties.durationMs).not.toHaveProperty('default');
    for (const input of [
      undefined,
      null,
      [],
      {},
      { durationMs: null },
      { durationMs: 0 },
      { durationMs: -1 },
      { durationMs: 1.5 },
      { durationMs: '10' },
      { durationMs: Infinity },
      { durationMs: NaN },
      { durationMs: TOOL_EXECUTION_LIMITS.sleepMaxDurationMs + 1 }
    ])
      await expect(executeSleep(input, context())).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
    const source = createToolWaitInterrupt(() => true);
    for (const durationMs of [1, 300_001, 1_800_000])
      expect(
        (await executeSleep({ durationMs }, context({ waitInterrupt: source }))).data.wakeReason
      ).toBe('steer');
  });
});
