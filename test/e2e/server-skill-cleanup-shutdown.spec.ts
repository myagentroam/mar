import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { expect, test } from '@playwright/test';
import { createServerApp, type ServerApplication } from '../../ee/server/src/app.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { SkillFavoriteService } from '../../ee/server/src/skill/skill-favorite-service.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

test('Server close drains the running Skill cleanup before releasing its real MySQL pool', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const database = resolvePlaywrightTestDatabase(`${runId}-skill-cleanup-${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  let directory: string | undefined;
  let app: ServerApplication | undefined;
  let pool: Pool | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const events: string[] = [];
  try {
    // Keep the real initialization, SQL, cleanup algorithm, listener, and close hooks.
    const initialize = MysqlServerDatabase.prototype.initialize;
    mock.method(
      MysqlServerDatabase.prototype,
      'initialize',
      async function (this: MysqlServerDatabase) {
        pool = this.raw;
        await initialize.call(this);
      }
    );
    const intervals = mock.method(globalThis, 'setInterval');
    const cleanup = mock.method(SkillFavoriteService.prototype, 'cleanupCache');
    directory = await mkdtemp(join(tmpdir(), 'mar-skill-cleanup-shutdown-'));
    app = createServerApp({
      databaseUrl: database.databaseUrl,
      dataDirectory: directory,
      productUuid: null
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    expect(cleanup.mock.callCount()).toBe(1);
    const tick = intervals.mock.calls.at(-1)!.arguments[0] as () => void;
    const raw = pool!;
    const execute = raw.execute.bind(raw);
    mock.method(raw, 'execute', async (...args: Parameters<Pool['execute']>) => {
      const result = await execute(...args);
      const sql = typeof args[0] === 'string' ? args[0] : args[0].sql;
      if (sql.includes('SELECT cache_key,MIN(unreferenced_at)')) {
        events.push('cleanup-query');
        entered = true;
        // Pause after the real query, before filesystem work and the following SQL.
        await gate;
      }
      if (sql.includes("SET cache_state='TRASHED'")) events.push('later-sql');
      return result;
    });
    const end = raw.end.bind(raw);
    const poolEnd = mock.method(raw, 'end', async () => {
      events.push('pool-close');
      await end();
    });
    const cacheDirectory = join(directory, 'skills');
    await mkdir(cacheDirectory, { recursive: true });
    const cacheFile = join(cacheDirectory, `${'a'.repeat(64)}.json`);
    await writeFile(cacheFile, '{}');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(cacheFile, old, old);

    tick();
    await expect.poll(() => entered).toBe(true);
    expect(cleanup.mock.callCount()).toBe(2);
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    // The listener stops only after preClose has stopped admitting Skill work.
    await expect.poll(() => app!.server.listening).toBe(false);
    expect(closed).toBe(false);
    expect(poolEnd.mock.callCount()).toBe(0);
    tick();
    expect(cleanup.mock.callCount()).toBe(2);
    await expect(raw.execute('SELECT 1')).resolves.toBeDefined();
    release();
    await closing;
    expect(events).toEqual(['cleanup-query', 'later-sql', 'pool-close']);
    await expect(stat(cacheFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(raw.execute('SELECT 1')).rejects.toThrow('Pool is closed');
    const shutdown = app.shutdown();
    expect(app.shutdown()).toBe(shutdown);
    await shutdown;
    expect(poolEnd.mock.callCount()).toBe(1);
  } finally {
    release();
    try {
      await app?.close();
    } finally {
      mock.restoreAll();
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      await dropPlaywrightTestDatabase(database);
    }
  }
});
