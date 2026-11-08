import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate } from 'node:timers/promises';
import { queryObjects } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { ExtensionResourceScope } from '../../src/extensions/resources.js';
import { createSessionToolScheduler } from '../../src/tools/scheduler.js';

describe('async context growth guardrails', () => {
  it('does not retain completed resource contexts across repeated scope lifetimes', async () => {
    const cycle = async () => {
      const scope = new ExtensionResourceScope();
      for (let index = 0; index < 100; index++)
        scope.effect(() => async () => {
          await Promise.resolve();
        });
      await scope.ready();
      await scope.dispose();
    };
    await cycle();
    await setImmediate();
    const baseline = queryObjects(AsyncLocalStorage);
    for (let round = 0; round < 5; round++) {
      await cycle();
      await setImmediate();
      expect(queryObjects(AsyncLocalStorage)).toBe(baseline);
    }
  });

  it('does not retain idle scheduler contexts after their Session owners are released', async () => {
    const cycle = async () => {
      for (let index = 0; index < 20; index++) {
        const schedule = createSessionToolScheduler();
        await schedule(undefined, async () => 'done');
      }
    };
    await cycle();
    await setImmediate();
    const baseline = queryObjects(AsyncLocalStorage);
    for (let round = 0; round < 5; round++) {
      await cycle();
      await setImmediate();
      expect(queryObjects(AsyncLocalStorage)).toBe(baseline);
    }
  });
});
