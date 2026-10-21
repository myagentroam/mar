import { describe, expect, it, vi } from 'vitest';
import { ExtensionHooks } from '../../src/agent-core/extensions/hooks.js';
import { ExtensionResourceScope } from '../../src/agent-core/extensions/resources.js';
import { ExtensionOperations } from '../../src/agent-core/extensions/operation.js';

type Operations = { calculate: { input: number; output: number } };
type Facts = { calculated: Readonly<{ value: number }> };
const identity = () => ({
  sessionId: 's',
  sessionEpoch: 0,
  actor: 'extension' as const,
  entry: 'native-api' as const,
  signal: new AbortController().signal
});
const call = () => ({ ...identity(), operationId: 'op' });

describe('Extension domain hooks', () => {
  it('reports only active interceptors across staging, removal and retirement', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    expect(hooks.hasInterceptors('calculate')).toBe(false);
    const registration = hooks.intercept(scope, 'calculate', (input, _call, next) => next(input));
    expect(hooks.hasInterceptors('calculate')).toBe(false);
    scope.activate();
    expect(hooks.hasInterceptors('calculate')).toBe(true);
    await registration.dispose();
    expect(hooks.hasInterceptors('calculate')).toBe(false);
    hooks.intercept(scope, 'calculate', (input, _call, next) => next(input));
    expect(hooks.hasInterceptors('calculate')).toBe(true);
    scope.retire();
    expect(hooks.hasInterceptors('calculate')).toBe(false);
    await scope.dispose();
  });

  it('skips only the active ancestor observer registration, not other fact observers', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const self: number[] = [];
    const other: number[] = [];
    hooks.observe(scope, 'calculated', async (fact) => {
      self.push(fact.value);
      if (fact.value === 0) await hooks.emit('calculated', { value: 1 }, call());
    });
    hooks.observe(scope, 'calculated', (fact) => {
      other.push(fact.value);
    });
    scope.activate();
    try {
      await hooks.emit('calculated', { value: 0 }, call());
      expect(self).toEqual([0]);
      expect(other).toEqual([1, 0]);
      await hooks.emit('calculated', { value: 2 }, call());
      expect(self).toEqual([0, 2]);
    } finally {
      await scope.dispose();
    }
  });

  it('allows explicit observer reentry without inheriting suppression at physical ingress', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const allowed: number[] = [];
    const physical: number[] = [];
    hooks.observe(
      scope,
      'calculated',
      async (fact) => {
        allowed.push(fact.value);
        if (fact.value === 0) await hooks.emit('calculated', { value: 1 }, call());
      },
      { reentry: 'allow' }
    );
    hooks.observe(scope, 'calculated', async (fact) => {
      physical.push(fact.value);
      if (fact.value === 2)
        await hooks.independent(() => hooks.emit('calculated', { value: 3 }, call()));
    });
    scope.activate();
    try {
      await hooks.emit('calculated', { value: 0 }, call());
      expect(allowed).toEqual([0, 1]);
      expect(physical).toEqual([1, 0]);
      await hooks.emit('calculated', { value: 2 }, call());
      expect(physical).toEqual([1, 0, 2, 3]);
    } finally {
      await scope.dispose();
    }
  });

  it('does not suppress parallel observers or a finished inherited observation frame', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const { AsyncResource } = await import('node:async_hooks');
    const seen: number[] = [];
    let delayed!: () => Promise<void>;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.observe(scope, 'calculated', async (fact) => {
      seen.push(fact.value);
      if (fact.value === 0) {
        const resource = new AsyncResource('observer-test');
        delayed = () =>
          resource.runInAsyncScope(() => hooks.emit('calculated', { value: 2 }, call()));
        await gate;
      }
    });
    scope.activate();
    try {
      const pending = hooks.emit('calculated', { value: 0 }, call());
      await vi.waitFor(() => expect(seen).toEqual([0]));
      await hooks.emit('calculated', { value: 1 }, call());
      release();
      await pending;
      await delayed();
      expect(seen).toEqual([0, 1, 2]);
    } finally {
      release?.();
      await scope.dispose();
    }
  });

  it('does not inherit reentry suppression at an independent physical callback boundary', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const seen: number[] = [];
    hooks.intercept(scope, 'calculate', async (input, _call, next) => {
      seen.push(input);
      return input === 1
        ? hooks.independent(() => hooks.invoke('calculate', 2, call(), async (value) => value + 10))
        : next(input);
    });
    scope.activate();
    try {
      expect(await hooks.invoke('calculate', 1, call(), async (value) => value)).toBe(12);
      expect(seen).toEqual([1, 2]);
    } finally {
      await scope.dispose();
    }
  });

  it('joins accepted next calls before completing a short-circuit result', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = false;
    hooks.intercept(scope, 'calculate', (input, _call, next) => {
      void next(input);
      return 7;
    });
    scope.activate();
    const invocation = hooks.invoke('calculate', 1, call(), async (value) => {
      await gate;
      completed = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    finish();
    await expect(invocation).resolves.toBe(7);
    expect(completed).toBe(true);
    await scope.dispose();
  });

  it('does not skip a hook whose inherited async frame has already finished', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    let delayed!: () => Promise<number>;
    const handler = vi.fn(
      async (input: number, _call: unknown, next: (value: number) => Promise<number>) => {
        if (input === 1) {
          const { AsyncResource } = await import('node:async_hooks');
          const resource = new AsyncResource('extension-test');
          delayed = () =>
            resource.runInAsyncScope(() =>
              hooks.invoke('calculate', 2, call(), async (value) => value)
            );
        }
        return next(input);
      }
    );
    hooks.intercept(scope, 'calculate', handler);
    scope.activate();
    await hooks.invoke('calculate', 1, call(), async (value) => value);
    expect(await delayed()).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
    await scope.dispose();
  });

  it('captures registration order and permits explicit multiple next attempts', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const log: number[] = [];
    hooks.intercept(scope, 'calculate', async (input, _call, next) => {
      log.push(1);
      return (await next(input + 1)) + (await next(input + 2));
    });
    hooks.intercept(scope, 'calculate', async (input, _call, next) => {
      log.push(2);
      return next(input * 2);
    });
    scope.activate();
    const leaf = vi.fn(async (input: number) => input);
    expect(await hooks.invoke('calculate', 1, call(), leaf)).toBe(10);
    expect(log).toEqual([1, 2, 2]);
    expect(leaf).toHaveBeenCalledTimes(2);
    await scope.dispose();
  });

  it('does not recover handler failures or replay completed side effects', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const leaf = vi.fn(async () => 10);
    hooks.intercept(scope, 'calculate', async (input, _call, next) => {
      await next(input);
      throw new Error('post effect');
    });
    scope.activate();
    await expect(hooks.invoke('calculate', 1, call(), leaf)).rejects.toThrow('post effect');
    expect(leaf).toHaveBeenCalledTimes(1);
    await scope.dispose();
  });

  it('skips only the active ancestor registration and allows concurrent dispatch', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const handler = vi.fn(
      async (input: number, _call: unknown, next: (value: number) => Promise<number>) => {
        if (input === 1) return hooks.invoke('calculate', 2, call(), async (value) => value);
        return next(input);
      }
    );
    hooks.intercept(scope, 'calculate', handler);
    scope.activate();
    expect(
      await Promise.all([
        hooks.invoke('calculate', 1, call(), async (value) => value),
        hooks.invoke('calculate', 3, call(), async (value) => value)
      ])
    ).toEqual([2, 3]);
    expect(handler).toHaveBeenCalledTimes(2);
    await scope.dispose();
  });

  it('permits explicit reentry and preserves unrelated registrations', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const other = vi.fn(
      async (input: number, _call: unknown, next: (value: number) => Promise<number>) => next(input)
    );
    hooks.intercept(
      scope,
      'calculate',
      async (input, _call, next) =>
        input === 1 ? hooks.invoke('calculate', 2, call(), async (value) => value) : next(input),
      { reentry: 'allow' }
    );
    hooks.intercept(scope, 'calculate', other);
    scope.activate();
    expect(await hooks.invoke('calculate', 1, call(), async (value) => value)).toBe(2);
    expect(other).toHaveBeenCalledTimes(1);
    await scope.dispose();
  });

  it('retains the dispatch snapshot when a handler unregisters a downstream hook', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    let remove!: () => Promise<void>;
    hooks.intercept(scope, 'calculate', async (input, _call, next) => {
      await remove();
      return next(input);
    });
    const registration = hooks.intercept(scope, 'calculate', async (input, _call, next) =>
      next(input + 1)
    );
    remove = () => registration.dispose();
    scope.activate();
    expect(await hooks.invoke('calculate', 1, call(), async (value) => value)).toBe(2);
    expect(await hooks.invoke('calculate', 1, call(), async (value) => value)).toBe(1);
    await scope.dispose();
  });

  it('reports observation failures without changing the fact or skipping the next observer', async () => {
    const diagnose = vi.fn();
    const hooks = new ExtensionHooks<Operations, Facts>(diagnose);
    const scope = new ExtensionResourceScope();
    const observed = vi.fn();
    hooks.observe(scope, 'calculated', async () => {
      throw new Error('private');
    });
    hooks.observe(scope, 'calculated', observed);
    scope.activate();
    await hooks.emit('calculated', { value: 10 }, call());
    expect(observed).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith({
      code: 'MAR_AGENT_EXTENSION_OBSERVER_FAILED',
      operationId: 'op'
    });
    await scope.dispose();
  });

  it('hides staged hooks and preserves cancellation as cancellation', async () => {
    const hooks = new ExtensionHooks<Operations, Facts>();
    const scope = new ExtensionResourceScope();
    const handler = vi.fn(async (input: number) => input + 1);
    hooks.intercept(scope, 'calculate', handler);
    expect(await hooks.invoke('calculate', 1, call(), async (value) => value)).toBe(1);
    scope.activate();
    const context = call();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      hooks.invoke(
        'calculate',
        1,
        { ...context, signal: controller.signal },
        async (value) => value
      )
    ).rejects.toThrow('cancelled');
    expect(handler).not.toHaveBeenCalled();
    await scope.dispose();
  });
});

describe('Extension operation identity', () => {
  it('cancels and joins accepted descendants before propagating the original callback failure', async () => {
    const operations = new ExtensionOperations();
    const primary = new Error('callback failure');
    const controller = new AbortController();
    let joined = false;
    let nested: Promise<void> | undefined;
    try {
      await expect(
        operations.callback({ ...call(), signal: controller.signal }, () => {
          nested = operations.run(identity(), async (child) => {
            await new Promise<void>((resolve) =>
              child.signal.addEventListener('abort', () => resolve(), { once: true })
            );
            expect(child.signal.reason).toBe(primary);
            joined = true;
          });
          throw primary;
        })
      ).rejects.toBe(primary);
      expect(joined).toBe(true);
      expect(operations.current()).toBeUndefined();
    } finally {
      controller.abort();
      await nested;
    }
  });

  it.each(['direct', 'programmatic', 'native-api'] as const)(
    'binds the effective callback signal without rewriting %s provenance or physical ingress',
    async (entry) => {
      const operations = new ExtensionOperations();
      const owner = new AbortController();
      await operations.enter({ ...identity(), entry, actor: 'sdk' }, async (parent) => {
        await operations.callback({ ...parent, signal: owner.signal }, async (effective) => {
          expect(operations.current()).toBe(effective);
          await operations.run(identity(), async (child) => {
            expect(child.entry).toBe(entry);
            expect(child.parentOperationId).toBe(parent.operationId);
          });
          await operations.enter(identity(), async (independent) => {
            expect(independent.parentOperationId).toBeUndefined();
            expect(independent.entry).toBe('native-api');
            owner.abort();
            expect(independent.signal.aborted).toBe(false);
          });
          expect(operations.current()).toBe(effective);
          expect(effective.signal.aborted).toBe(true);
        });
        expect(operations.current()).toBe(parent);
        expect(parent.signal.aborted).toBe(false);
      });
      expect(operations.current()).toBeUndefined();
    }
  );

  it('permits settled observation of cancellation without renewing nested call authority', async () => {
    const operations = new ExtensionOperations();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    let observed = false;
    await operations.callback(
      { ...call(), signal: controller.signal },
      async (effective) => {
        observed = true;
        expect(effective.signal.aborted).toBe(true);
        expect(() => operations.run(identity(), () => 1)).toThrow(controller.signal.reason);
      },
      true
    );
    expect(observed).toBe(true);
  });

  it('inherits the transport and parent cancellation without changing the initiator', async () => {
    const operations = new ExtensionOperations();
    const controller = new AbortController();
    await operations.run(
      { ...identity(), actor: 'code-mode', entry: 'programmatic', signal: controller.signal },
      async (parent) => {
        await operations.run(identity(), async (child) => {
          expect(child.actor).toBe('extension');
          expect(child.entry).toBe('programmatic');
          expect(child.parentOperationId).toBe(parent.operationId);
          expect(child.operationId).not.toBe(parent.operationId);
          controller.abort();
          expect(child.signal.aborted).toBe(true);
        });
      }
    );
    expect(operations.current()).toBeUndefined();
  });
});
