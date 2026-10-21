import { mkdtemp, rm } from 'node:fs/promises';
import { channel } from 'node:diagnostics_channel';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerApp, type ServerApplication } from '../../ee/server/src/app.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { SkillFavoriteService } from '../../ee/server/src/skill/skill-favorite-service.js';

const mysql = vi.hoisted(() => {
  const events: string[] = [];
  const pools: ReturnType<typeof pool>[] = [];
  function pool() {
    let closed = false;
    const connection = {
      execute: vi.fn(async (_sql: string) => {
        if (closed) throw new Error('POOL_CLOSED');
        return [[], []];
      }),
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn()
    };
    return {
      ...connection,
      getConnection: vi.fn(async () => connection),
      end: vi.fn(async () => {
        closed = true;
        events.push('pool-close');
      })
    };
  }
  return {
    events,
    pools,
    createMysqlPool: vi.fn(() => {
      const value = pool();
      pools.push(value);
      return value;
    }),
    prepareMysqlDatabase: vi.fn(async () => undefined)
  };
});

vi.mock('../../ee/server/src/mysql/connection.js', () => mysql);

const HOUR = 60 * 60 * 1000;
let app: ServerApplication | undefined;
let directory: string;
const releases: (() => void)[] = [];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  mysql.pools.length = 0;
  mysql.events.length = 0;
  mysql.createMysqlPool.mockClear();
  vi.spyOn(MysqlServerDatabase.prototype, 'initialize').mockResolvedValue(undefined);
  directory = await mkdtemp(join(tmpdir(), 'mar-skill-cleanup-lifecycle-'));
});

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

async function ready(configure?: (app: ServerApplication) => void) {
  // No databasePath: retain the actual MySQL Skill assembly and Fastify hooks.
  app = createServerApp({ dataDirectory: directory, productUuid: null });
  configure?.(app);
  const errors = vi.spyOn(app.log, 'error');
  const intervals = vi.spyOn(globalThis, 'setInterval');
  await app.ready();
  expect(mysql.createMysqlPool).toHaveBeenCalledTimes(2);
  const tick = intervals.mock.calls.at(-1)![0] as () => void;
  return { app, errors, tick };
}

describe('Server Skill cleanup lifecycle', () => {
  it('skips slow ticks, stops admission in preClose, and drains before both pools close', async () => {
    const pending = gate();
    const cleanup = vi.spyOn(SkillFavoriteService.prototype, 'cleanupCache');
    cleanup.mockResolvedValueOnce(0).mockImplementation(async () => {
      mysql.events.push('cleanup-start');
      await mysql.pools[0]!.execute('SELECT before_file_io');
      await pending.promise;
      await mysql.pools[0]!.execute('SELECT after_file_io');
      mysql.events.push('later-sql', 'cleanup-settle');
      return 1;
    });
    const { app, tick } = await ready();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR * 3);
    expect(cleanup).toHaveBeenCalledTimes(2);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await nextTurn();
    tick(); // A callback already queued before clearInterval must not be admitted.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(closed).toBe(false);
    expect(mysql.events).not.toContain('pool-close');
    pending.release();
    await closing;
    expect(mysql.events).toEqual([
      'cleanup-start',
      'later-sql',
      'cleanup-settle',
      'pool-close',
      'pool-close'
    ]);
    expect(vi.getTimerCount()).toBe(0);
    tick();
    expect(cleanup).toHaveBeenCalledTimes(2);
    await app.close();
    expect(mysql.pools.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1]);
  });

  it('stops queued ticks in preClose before HTTP draining reaches onClose', async () => {
    const draining = gate();
    const entered = gate();
    const cleanup = vi.spyOn(SkillFavoriteService.prototype, 'cleanupCache').mockResolvedValue(0);
    const { app, tick } = await ready((instance) => {
      instance.addHook('preClose', async () => {
        entered.release();
        await draining.promise;
      });
    });
    const closing = app.close();
    await entered.promise;
    tick();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mysql.events).not.toContain('pool-close');
    draining.release();
    await closing;
    tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('observes a periodic failure once and shares shutdown while still releasing the pools', async () => {
    const pending = gate();
    const cleanup = vi.spyOn(SkillFavoriteService.prototype, 'cleanupCache');
    cleanup.mockResolvedValueOnce(0).mockImplementation(async () => {
      await pending.promise;
      throw new Error('CLEANUP_FAILED');
    });
    const { app, tick, errors } = await ready();
    tick();
    tick();
    const closing = app.shutdown();
    expect(app.shutdown()).toBe(closing);
    await nextTurn();
    tick();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(mysql.events).not.toContain('pool-close');
    pending.release();
    await closing;
    expect(errors.mock.calls).toEqual([
      [{ errorCode: 'SKILL_CACHE_CLEANUP_FAILED' }, 'skill_cache_cleanup_failed']
    ]);
    expect(mysql.pools.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1]);
    await app.shutdown();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('propagates the first cleanup failure and still permits dependency release', async () => {
    const failure = new Error('FIRST_CLEANUP_FAILED');
    const cleanup = vi
      .spyOn(SkillFavoriteService.prototype, 'cleanupCache')
      .mockRejectedValue(failure);
    app = createServerApp({ dataDirectory: directory, productUuid: null });
    const errors = vi.spyOn(app.log, 'error');
    await expect(app.ready()).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await app.close();
    expect(errors).not.toHaveBeenCalled();
    expect(mysql.pools.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not install a timer when the first cleanup completes after preClose', async () => {
    const pending = gate();
    const started = gate();
    const cleanup = vi
      .spyOn(SkillFavoriteService.prototype, 'cleanupCache')
      .mockImplementation(async () => {
        started.release();
        await pending.promise;
        return 0;
      });
    let hooks: { mock: { calls: readonly (readonly unknown[])[] } } | undefined;
    const initialization = channel('fastify.initialization');
    const capture = (message: unknown) => {
      hooks = vi.spyOn((message as { fastify: ServerApplication }).fastify, 'addHook');
    };
    initialization.subscribe(capture);
    try {
      app = createServerApp({ dataDirectory: directory, productUuid: null });
    } finally {
      initialization.unsubscribe(capture);
    }
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const booting = app.ready();
    await started.promise;
    // Fastify serializes ready/close. Invoke the captured production hook to
    // exercise a late first completion without replacing or copying app logic.
    const preClose = hooks!.mock.calls.find(([name]) => name === 'preClose')![1] as (
      this: ServerApplication
    ) => Promise<void>;
    await preClose.call(app);
    const count = intervals.mock.calls.length;
    expect(mysql.events).not.toContain('pool-close');
    pending.release();
    await booting;
    expect(intervals).toHaveBeenCalledTimes(count);
    await app.close();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a later tick after a failed period and propagates database close failure', async () => {
    const cleanup = vi.spyOn(SkillFavoriteService.prototype, 'cleanupCache');
    cleanup
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('PERIOD_FAILED'))
      .mockResolvedValue(0);
    const { app, errors } = await ready();
    await vi.advanceTimersByTimeAsync(HOUR * 2);
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledTimes(1);
    const failure = new Error('POOL_CLOSE_FAILED');
    mysql.pools[0]!.end.mockRejectedValueOnce(failure);
    await expect(app.shutdown()).rejects.toBe(failure);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(mysql.pools.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1]);
  });
});
