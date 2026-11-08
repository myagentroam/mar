import { describe, expect, it, vi } from 'vitest';
import { ExtensionResourceScope } from '../../src/extensions/resources.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Extension resource scope', () => {
  it.each(['revoked proxy', 'throwing stack getter'] as const)(
    'preserves an uninspectable cleanup failure and counts it (%s)',
    async (kind) => {
      const scope = new ExtensionResourceScope();
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      const error = new Error('release failed');
      Object.defineProperty(error, 'stack', {
        get() {
          throw new Error('stack unavailable');
        }
      });
      const failure = kind === 'revoked proxy' ? revoked.proxy : error;
      const resource = scope.effect(() => () => {
        throw failure;
      });
      try {
        await resource.ready;
        for (let index = 0; index < 2; index++) {
          const sameFailure = await resource.dispose().then(
            () => false,
            (reason) => reason === failure
          );
          expect(sameFailure).toBe(true);
        }
        await expect(scope.dispose()).rejects.toMatchObject({
          code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
          details: { failures: 1 }
        });
      } finally {
        await scope.dispose().catch(() => undefined);
      }
    }
  );

  it('completes explicit sleep during initialization and clears its timer', async () => {
    const scope = new ExtensionResourceScope();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const waiting = ExtensionResourceScope.initialize(() => scope.sleep(10));
      await vi.advanceTimersByTimeAsync(10);
      await waiting;
      expect(vi.getTimerCount()).toBe(0);
      scope.activate();
      await scope.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels only a requested sleep and waits for sleep cleanup on scope retirement', async () => {
    const scope = new ExtensionResourceScope();
    scope.activate();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const controller = new AbortController();
      const reason = new Error('sleep cancelled');
      const waiting = scope.sleep(10_000, controller.signal);
      const rejected = waiting.catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);
      expect(await rejected).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
      expect(scope.signal.aborted).toBe(false);
      const retained = scope.sleep(10_000).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      await scope.dispose();
      expect(await retained).toBeInstanceOf(Error);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('segments very long sleep deadlines rather than firing an overflowed timer', async () => {
    const scope = new ExtensionResourceScope();
    scope.activate();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const completed = vi.fn();
      const waiting = scope.sleep(2 ** 31 + 100).then(completed);
      await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
      expect(completed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(101);
      await waiting;
      expect(completed).toHaveBeenCalledOnce();
      await scope.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('permits a disposer and its timer callback to release their own registration', async () => {
    const scope = new ExtensionResourceScope();
    const registration = scope.effect(() => async () => {
      await registration.dispose();
    });
    await registration.ready;
    await registration.dispose();
    const done = deferred<void>();
    const timer = scope.after(0, async () => {
      await timer.dispose();
      done.resolve();
    });
    scope.activate();
    await done.promise;
    await scope.dispose();
  }, 1000);

  it('releases in reverse order and shares manual and automatic disposal', async () => {
    const scope = new ExtensionResourceScope();
    const order: number[] = [];
    const a = scope.effect(() => () => {
      order.push(1);
    });
    scope.effect(() => async () => {
      order.push(2);
    });
    await a.ready;
    scope.activate();
    const first = scope.dispose();
    expect(scope.dispose()).toBe(first);
    await first;
    await a.dispose();
    expect(order).toEqual([2, 1]);
    expect(scope.state).toBe('DISPOSED');
  });

  it('awaits a late acquisition and immediately releases it on retirement', async () => {
    const scope = new ExtensionResourceScope();
    const acquired = deferred<() => Promise<void>>();
    const released = deferred<void>();
    const cleanup = vi.fn(() => released.promise);
    const resource = scope.effect(() => acquired.promise);
    let finished = false;
    const disposing = scope.dispose().then(() => {
      finished = true;
    });
    acquired.resolve(cleanup);
    await resource.ready;
    await Promise.resolve();
    expect(finished).toBe(false);
    released.resolve();
    await disposing;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('aborts and joins running operations before releasing their resources', async () => {
    const scope = new ExtensionResourceScope();
    const order: string[] = [];
    const started = deferred<void>();
    scope.effect(() => () => {
      order.push('resource');
    });
    scope.activate();
    const running = scope.run(async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      order.push('operation');
      signal.throwIfAborted();
    });
    const outcome = running.catch(() => undefined);
    await started.promise;
    await scope.dispose();
    await outcome;
    expect(order).toEqual(['operation', 'resource']);
    expect(() => scope.effect(() => () => {})).toThrow(/RETIRED/);
    await expect(scope.run(async () => undefined)).rejects.toThrow(/RETIRED/);
  });

  it('aggregates failures without skipping other resources or exposing raw errors', async () => {
    const scope = new ExtensionResourceScope();
    const cleanup = vi.fn();
    scope.effect(() => cleanup);
    scope.effect(() => () => {
      throw new Error('private credential');
    });
    scope.activate();
    await expect(scope.dispose()).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED'
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scope.state).toBe('RETIRING');
    await expect(scope.dispose()).rejects.not.toThrow('private credential');
  });

  it('does not start automatic callbacks until activated and cancels staged timers', async () => {
    vi.useFakeTimers();
    try {
      const scope = new ExtensionResourceScope();
      const callback = vi.fn();
      scope.after(10, callback);
      await vi.advanceTimersByTimeAsync(100);
      expect(callback).not.toHaveBeenCalled();
      scope.activate();
      await vi.advanceTimersByTimeAsync(10);
      expect(callback).toHaveBeenCalledTimes(1);
      await scope.dispose();
      const failed = new ExtensionResourceScope();
      failed.after(1, callback);
      await failed.dispose();
      await vi.advanceTimersByTimeAsync(20);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates non-overlapping periodic work and waits for cancellation cleanup', async () => {
    vi.useFakeTimers();
    try {
      const scope = new ExtensionResourceScope();
      const callback = vi.fn(async (signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
      });
      scope.every(10, callback);
      scope.activate();
      await vi.advanceTimersByTimeAsync(100);
      expect(callback).toHaveBeenCalledTimes(1);
      await scope.dispose();
      await vi.advanceTimersByTimeAsync(100);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates an external abort without retiring unrelated operations', async () => {
    const scope = new ExtensionResourceScope();
    scope.activate();
    const external = new AbortController();
    external.abort(new Error('cancelled'));
    await expect(scope.run(async () => 1, external.signal)).rejects.toThrow('cancelled');
    expect(await scope.run(async () => 2)).toBe(2);
    await scope.dispose();
  });

  it('joins pending acquisitions after another registration has been disposed during readiness', async () => {
    const scope = new ExtensionResourceScope();
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    const a = scope.effect(() => first.promise);
    const b = scope.effect(() => second.promise);
    let ready = false;
    const waiting = scope.ready().then(() => {
      ready = true;
    });
    try {
      first.resolve(() => {});
      await a.ready;
      await a.dispose();
      expect(ready).toBe(false);
      second.resolve(() => {});
      await waiting;
      await b.ready;
      expect(ready).toBe(true);
    } finally {
      first.resolve(() => {});
      second.resolve(() => {});
      await waiting;
      await scope.dispose();
    }
  });

  it('keeps acquisition failures observable after the failed registration is disposed', async () => {
    const scope = new ExtensionResourceScope();
    const failure = new Error('acquire failed');
    const resource = scope.effect(() => {
      throw failure;
    });
    await expect(resource.ready).rejects.toBe(failure);
    await resource.dispose();
    await expect(scope.ready()).rejects.toBe(failure);
    await scope.dispose();
  });

  it('counts manually observed disposal failures once and still releases remaining resources', async () => {
    const scope = new ExtensionResourceScope();
    const cleanup = vi.fn();
    const first = scope.effect(() => () => {
      throw new Error('first failure');
    });
    scope.effect(() => cleanup);
    scope.effect(() => () => {
      throw new Error('second failure');
    });
    await scope.ready();
    const failure = first.dispose();
    expect(first.dispose()).toBe(failure);
    await expect(failure).rejects.toThrow('first failure');
    await expect(first.dispose()).rejects.toThrow('first failure');
    await expect(scope.dispose()).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
      details: { failures: 2 }
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
