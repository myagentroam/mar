import { AsyncLocalStorage } from 'node:async_hooks';
import { vi } from 'vitest';

/** Observe real context activation and release without relying on Node's private enabled flag. */
export function trackAsyncContexts() {
  const active = new Set<AsyncLocalStorage<unknown>>();
  const run = AsyncLocalStorage.prototype.run;
  const disable = AsyncLocalStorage.prototype.disable;
  const running = vi.spyOn(AsyncLocalStorage.prototype, 'run').mockImplementation(function (
    this: AsyncLocalStorage<unknown>,
    store,
    callback,
    ...args
  ) {
    active.add(this);
    return Reflect.apply(run, this, [store, callback, ...args]);
  });
  const disabling = vi.spyOn(AsyncLocalStorage.prototype, 'disable').mockImplementation(function (
    this: AsyncLocalStorage<unknown>
  ) {
    active.delete(this);
    return Reflect.apply(disable, this, []);
  });
  return {
    active,
    restore() {
      running.mockRestore();
      disabling.mockRestore();
      for (const context of active) context.disable();
      active.clear();
    }
  };
}
