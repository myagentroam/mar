import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gate, ready, setup, teardown } from './support/server-notification-close-fixture.js';
import { mysql } from './support/server-notification-pools.js';

vi.mock('../../src/mysql/connection.js', async () => {
  const { mysql } = await import('./support/server-notification-pools.js');
  return mysql;
});

beforeEach(setup);
afterEach(teardown);

describe('Server notification dependency close order', () => {
  it.each(['close', 'shutdown'] as const)(
    '%s stops tasks and drains an in-flight Push before closing either pool',
    async (entry) => {
      const { app, pending, transport, warnings, dispatcher } = await ready();
      let closed = false;
      const operation = app[entry]();
      const closing = operation.then(() => {
        closed = true;
      });
      if (entry === 'shutdown') expect(app.shutdown()).toBe(operation);
      await nextTurn();
      expect(closed).toBe(false);
      expect(mysql.events).toEqual(['transport-start', 'transport-abort']);
      expect(vi.getTimerCount()).toBe(0);
      expect(dispatcher.enqueue(1, 'late-notice', async () => true)).toBe('closed');
      pending.release();
      await closing;
      expect(mysql.events).toEqual([
        'transport-start',
        'transport-abort',
        'transport-settle',
        'expire-sql',
        'pool-close',
        'pool-close'
      ]);
      expect(warnings).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledOnce();
      await app[entry]();
      expect(mysql.pools.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1]);
    }
  );

  it('stops Push admission and aborts active transport before HTTP draining completes', async () => {
    const draining = gate();
    const entered = gate();
    const { app, pending, transport, dispatcher } = await ready((instance) => {
      instance.addHook('preClose', async () => {
        entered.release();
        await draining.promise;
      });
    });
    const closing = app.close();
    await entered.promise;
    expect(mysql.events).toEqual(['transport-start', 'transport-abort']);
    expect(dispatcher.enqueue(1, 'late-notice', async () => true)).toBe('closed');
    pending.release();
    draining.release();
    await closing;
    expect(transport).toHaveBeenCalledOnce();
  });
});
