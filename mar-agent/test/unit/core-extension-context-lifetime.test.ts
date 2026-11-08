import { describe, expect, it, vi } from 'vitest';
import { ExtensionResourceScope } from '../../src/extensions/resources.js';
import { trackAsyncContexts } from './support/async-contexts.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Extension async context lifetime', () => {
  it('does not accumulate enabled contexts across repeated acquisition and release', async () => {
    const contexts = trackAsyncContexts();
    try {
      for (let round = 0; round < 5; round++) {
        const scope = new ExtensionResourceScope();
        const registrations = Array.from({ length: 20 }, () =>
          scope.effect(() => async () => {
            await Promise.resolve();
          })
        );
        await scope.ready();
        await Promise.all(registrations.map((registration) => registration.dispose()));
        await scope.dispose();
        expect(contexts.active.size).toBe(0);
      }
    } finally {
      contexts.restore();
    }
  });

  it('releases failed disposer contexts without changing the shared failure or skipping cleanup', async () => {
    const contexts = trackAsyncContexts();
    const failure = new Error('disposer failure');
    const released = vi.fn();
    const scope = new ExtensionResourceScope();
    scope.effect(() => released);
    const resource = scope.effect(() => async () => {
      throw failure;
    });
    try {
      await scope.ready();
      const disposing = resource.dispose();
      expect(resource.dispose()).toBe(disposing);
      await expect(disposing).rejects.toBe(failure);
      await expect(scope.dispose()).rejects.toMatchObject({
        code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED'
      });
      expect(released).toHaveBeenCalledOnce();
      expect(contexts.active.size).toBe(0);
    } finally {
      contexts.restore();
    }
  });

  it('does not disable a parallel disposer before its asynchronous self-release', async () => {
    const contexts = trackAsyncContexts();
    const entered = deferred();
    const finish = deferred();
    const scope = new ExtensionResourceScope();
    const pending = scope.effect(() => async () => {
      entered.resolve();
      await finish.promise;
      await pending.dispose();
    });
    const other = scope.effect(() => () => {});
    try {
      await scope.ready();
      const disposing = pending.dispose();
      await entered.promise;
      await other.dispose();
      expect(contexts.active.size).toBe(1);
      finish.resolve();
      await disposing;
      await scope.dispose();
      expect(contexts.active.size).toBe(0);
    } finally {
      finish.resolve();
      await scope.dispose().catch(() => {});
      contexts.restore();
    }
  });

  it.each(['after', 'every'] as const)(
    'releases %s callback contexts after self-disposal finishes',
    async (kind) => {
      const contexts = trackAsyncContexts();
      const scope = new ExtensionResourceScope();
      const entered = deferred();
      const finish = deferred();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const timer = scope[kind](1, async () => {
        await timer.dispose();
        entered.resolve();
        await finish.promise;
        await timer.dispose();
      });
      try {
        await scope.ready();
        scope.activate();
        await vi.advanceTimersByTimeAsync(10);
        await entered.promise;
        expect(contexts.active.size).toBe(1);
        finish.resolve();
        await scope.dispose();
        expect(contexts.active.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        finish.resolve();
        await scope.dispose().catch(() => {});
        vi.useRealTimers();
        contexts.restore();
      }
    }
  );

  it('releases a completed one-shot callback context before its registration is disposed', async () => {
    const contexts = trackAsyncContexts();
    const scope = new ExtensionResourceScope();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const called = vi.fn(async () => {
      await Promise.resolve();
    });
    scope.after(1, called);
    try {
      await scope.ready();
      scope.activate();
      await vi.advanceTimersByTimeAsync(10);
      expect(called).toHaveBeenCalledOnce();
      expect(contexts.active.size).toBe(0);
      await scope.dispose();
      expect(contexts.active.size).toBe(0);
    } finally {
      await scope.dispose().catch(() => {});
      vi.useRealTimers();
      contexts.restore();
    }
  });

  it('joins a cancelled repeating callback before releasing its context', async () => {
    const contexts = trackAsyncContexts();
    const scope = new ExtensionResourceScope();
    const finish = deferred();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const timer = scope.every(1, async () => {
      await finish.promise;
    });
    try {
      await scope.ready();
      scope.activate();
      await vi.advanceTimersByTimeAsync(10);
      let disposed = false;
      const disposing = timer.dispose().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(disposed).toBe(false);
      expect(contexts.active.size).toBe(2);
      finish.resolve();
      await disposing;
      await scope.dispose();
      expect(contexts.active.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish.resolve();
      await scope.dispose().catch(() => {});
      vi.useRealTimers();
      contexts.restore();
    }
  });
});
