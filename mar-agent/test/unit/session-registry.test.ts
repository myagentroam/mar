import { describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../../src/sdk/session-registry.js';

describe('SessionRegistry', () => {
  it('shares initialization for the same session and epoch, then reuses its published identity', async () => {
    const registry = new SessionRegistry<object>();
    const ready = Promise.withResolvers<void>();
    const runtime = {};
    const initialize = vi.fn(async (publish: (value: object) => boolean) => {
      await ready.promise;
      expect(publish(runtime)).toBe(true);
      return runtime;
    });
    const first = registry.getOrCreate('one', 1, () => true, initialize);
    const second = registry.getOrCreate('one', 1, () => true, initialize);
    expect(registry.get('one')).toBeUndefined();
    ready.resolve();
    expect(await Promise.all([first, second])).toEqual([runtime, runtime]);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(await registry.getOrCreate('one', 1, () => true, initialize)).toBe(runtime);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('allows retry after initialization fails without publishing', async () => {
    const registry = new SessionRegistry<object>();
    const failure = new Error('initialization failed');
    await expect(
      registry.getOrCreate(
        'one',
        1,
        () => true,
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    const runtime = {};
    expect(
      await registry.getOrCreate(
        'one',
        1,
        () => true,
        async (publish) => {
          expect(publish(runtime)).toBe(true);
          return runtime;
        }
      )
    ).toBe(runtime);
  });

  it('waits for stale candidate cleanup without joining a new epoch into an earlier barrier', async () => {
    const registry = new SessionRegistry<object>();
    const initialized = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const newReady = Promise.withResolvers<void>();
    const oldRuntime = {};
    const newRuntime = {};
    const stale = new Error('stale');
    let epoch = 1;
    const old = registry.getOrCreate(
      'one',
      1,
      () => epoch === 1,
      async (publish) => {
        await initialized.promise;
        if (!publish(oldRuntime)) {
          cleanupStarted.resolve();
          await cleanup.promise;
          throw stale;
        }
        return oldRuntime;
      }
    );
    const oldResult = expect(old).rejects.toBe(stale);
    const idle = registry.whenIdle(['one']);
    let idleFinished = false;
    void idle.then(() => {
      idleFinished = true;
    });
    epoch = 2;
    const current = registry.getOrCreate(
      'one',
      2,
      () => epoch === 2,
      async (publish) => {
        await newReady.promise;
        expect(publish(newRuntime)).toBe(true);
        return newRuntime;
      }
    );
    initialized.resolve();
    await cleanupStarted.promise;
    expect(registry.get('one')).toBeUndefined();
    expect(idleFinished).toBe(false);
    cleanup.resolve();
    await oldResult;
    await idle;
    expect(idleFinished).toBe(true);
    newReady.resolve();
    expect(await current).toBe(newRuntime);
    expect(registry.get('one')).toBe(newRuntime);
  });

  it('does not let a late old candidate replace or unregister the current runtime', async () => {
    const registry = new SessionRegistry<object>();
    const oldReady = Promise.withResolvers<void>();
    const oldRuntime = {};
    const currentRuntime = {};
    let epoch = 1;
    const old = registry.getOrCreate(
      'one',
      1,
      () => epoch === 1,
      async (publish) => {
        await oldReady.promise;
        expect(publish(oldRuntime)).toBe(false);
        registry.unregister('one', oldRuntime);
        throw new Error('stale');
      }
    );
    const oldResult = expect(old).rejects.toThrow('stale');
    epoch = 2;
    await registry.getOrCreate(
      'one',
      2,
      () => epoch === 2,
      async (publish) => {
        expect(publish(currentRuntime)).toBe(true);
        return currentRuntime;
      }
    );
    oldReady.resolve();
    await oldResult;
    expect(registry.get('one')).toBe(currentRuntime);
    registry.unregister('one', currentRuntime);
    expect(registry.get('one')).toBeUndefined();
  });
});
