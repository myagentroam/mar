import { expect, test } from '@playwright/test';
import { chmod, readFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { deferMysqlAudit } from '../../packages/server-core/src/audit.js';
import { withSkillCacheTransaction } from '../../packages/server-core/src/skill-cache-transaction.js';
import { gate, gatedPool, input, withSkillCacheFixture } from './support/skill-cache-fixture.js';

for (const operation of ['create', 'upgrade'] as const) {
  test(`Skill cache rechecks a selected key after same-hash ${operation} commits`, async () => {
    await withSkillCacheFixture(async ({ pool, otherPool, service, file, expire }) => {
      const original = await service().create(7, input);
      if (operation === 'create') await service().remove(7, original.id);
      else await service(pool, 'b').upgrade(7, original.id);
      await expire();
      const selected = gate();
      const commit = gate();
      let first = true;
      const collector = service(
        gatedPool(otherPool, {
          before: async (sql) => {
            if (sql === 'GET_CONNECTION' && first) {
              first = false;
              await selected.wait();
            }
          }
        })
      );
      const writer = service(
        gatedPool(pool, {
          before: async (sql) => {
            if (sql === 'COMMIT') await commit.wait();
          }
        })
      );
      const cleanup = collector.cleanupCache();
      let writing: ReturnType<typeof writer.create> | undefined;
      try {
        await selected.entered;
        writing = operation === 'create' ? writer.create(7, input) : writer.upgrade(7, original.id);
        await commit.entered;
        commit.release();
        const current = await writing;
        selected.release();
        await expect(cleanup).resolves.toBe(0);
        await expect(readFile(file(), 'utf8')).resolves.toContain('SKILL.md');
        const [rows] = await pool.execute<RowDataPacket[]>(
          'SELECT cache_state,unreferenced_at FROM skill_versions WHERE id=?',
          [current.currentVersionId]
        );
        expect(rows).toMatchObject([{ cache_state: 'READY', unreferenced_at: null }]);
        if (operation === 'upgrade')
          expect(current.currentVersionId).toBe(original.currentVersionId);
      } finally {
        selected.release();
        commit.release();
        await cleanup;
        await writing;
      }
    });
  });

  test(`Skill cache rebuilds content when collection precedes same-hash ${operation}`, async () => {
    await withSkillCacheFixture(async ({ pool, otherPool, inspector, service, file, expire }) => {
      const original = await service().create(7, input);
      if (operation === 'create') await service().remove(7, original.id);
      else await service(pool, 'b').upgrade(7, original.id);
      await expire();
      const deleted = gate();
      const attempting = gate();
      let lockName = '';
      let writerAcquired = false;
      const collector = service(
        gatedPool(otherPool, {
          before: async (sql) => {
            if (sql.includes("SET cache_state='TRASHED'")) await deleted.wait();
          }
        })
      );
      const writer = service(
        gatedPool(pool, {
          before: async (sql, values) => {
            if (sql.includes('GET_LOCK')) {
              lockName = String(values[0]);
              attempting.release();
              await attempting.wait();
            }
          },
          after: async (sql) => {
            if (sql.includes('GET_LOCK')) writerAcquired = true;
          }
        })
      );
      const cleanup = collector.cleanupCache();
      let writing: ReturnType<typeof writer.create> | undefined;
      try {
        await deleted.entered;
        writing = operation === 'create' ? writer.create(7, input) : writer.upgrade(7, original.id);
        await attempting.entered;
        // Observe an actual waiting MySQL session while the collector still owns the key.
        await expect
          .poll(
            async () => {
              const [rows] = await inspector.query<RowDataPacket[]>('SHOW PROCESSLIST');
              return rows.filter(
                (row) =>
                  String(row['Info']).includes(lockName) &&
                  String(row['State']).toLowerCase().includes('lock')
              ).length;
            },
            { timeout: 2_000 }
          )
          .toBe(1);
        expect(writerAcquired).toBe(false);
        expect(lockName).toHaveLength(64);
        await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
        deleted.release();
        await expect(cleanup).resolves.toBe(1);
        const current = await writing;
        expect(writerAcquired).toBe(true);
        await expect(readFile(file(), 'utf8')).resolves.toContain('SKILL.md');
        const [rows] = await pool.execute<RowDataPacket[]>(
          `SELECT version.cache_state,version.unreferenced_at,favorite.current_version_id
          FROM skill_versions version JOIN skill_favorites favorite ON favorite.id=version.favorite_id WHERE version.id=?`,
          [current.currentVersionId]
        );
        expect(rows).toMatchObject([
          {
            cache_state: 'READY',
            unreferenced_at: null,
            current_version_id: current.currentVersionId
          }
        ]);
        if (operation === 'upgrade')
          expect(current.currentVersionId).toBe(original.currentVersionId);
      } finally {
        deleted.release();
        attempting.release();
        await cleanup;
        await writing;
      }
    });
  });
}

test('Skill cache uses independent keys, bounded MySQL waits, and reusable single-connection pools', async () => {
  await withSkillCacheFixture(async ({ pool, otherPool, service, file }) => {
    const held = gate();
    let lockName = '';
    const holderPool = gatedPool(pool, {
      before: async (sql, values) => {
        if (sql.includes('GET_LOCK')) lockName = String(values[0]);
      }
    });
    const holder = withSkillCacheTransaction(holderPool, 'a'.repeat(64), async () => held.wait());
    try {
      await held.entered;
      await expect(service(otherPool, 'b').create(7, input)).resolves.toMatchObject({
        contentHash: 'b'.repeat(64)
      });
      const [owned] = await otherPool.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?) AS owner', [
        lockName
      ]);
      expect(owned[0]?.['owner']).toBeGreaterThan(0);
      const start = Date.now();
      await expect(service(otherPool).create(8, input)).rejects.toThrow('SKILL_CACHE_LOCK_TIMEOUT');
      expect(Date.now() - start).toBeGreaterThanOrEqual(4_500);
      expect(Date.now() - start).toBeLessThan(8_000);
      await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
      held.release();
      await holder;
      await expect(service(otherPool).create(8, input)).resolves.toMatchObject({
        contentHash: 'a'.repeat(64)
      });
      const [free] = await pool.query<RowDataPacket[]>('SELECT IS_FREE_LOCK(?) AS free', [
        lockName
      ]);
      expect(free[0]?.['free']).toBe(1);
    } finally {
      held.release();
      await holder;
    }
  });
});

test('Skill cache SQL rollback preserves the old current version and discards success audit', async () => {
  await withSkillCacheFixture(async ({ pool, service, audits, file }) => {
    const original = await service().create(7, input);
    audits.length = 0;
    await pool.query(`ALTER TABLE skill_favorites ADD CONSTRAINT fixture_keep_version
      CHECK (current_version_id IS NULL OR current_version_id='${original.currentVersionId}')`);
    await expect(service(pool, 'b').upgrade(7, original.id)).rejects.toMatchObject({
      code: 'ER_CHECK_CONSTRAINT_VIOLATED'
    });
    expect(audits).toEqual([]);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT current_version_id FROM skill_favorites WHERE id=?',
      [original.id]
    );
    expect(rows[0]?.['current_version_id']).toBe(original.currentVersionId);
    const [versions] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM skill_versions WHERE favorite_id=?',
      [original.id]
    );
    expect(versions).toHaveLength(1);
    await expect(readFile(file(), 'utf8')).resolves.toContain('SKILL.md');
    // A completed file write is intentionally left for grace-based collection on rollback.
    await expect(readFile(file('b'), 'utf8')).resolves.toContain('SKILL.md');
    await pool.query('ALTER TABLE skill_favorites DROP CHECK fixture_keep_version');
    let published = 0;
    await expect(
      withSkillCacheTransaction(pool, 'b'.repeat(64), async (connection) => {
        deferMysqlAudit(connection, () => {
          published++;
        });
        await connection.query('INSERT INTO missing_skill_fixture_table VALUES (1)');
      })
    ).rejects.toThrow();
    expect(published).toBe(0);
    await withSkillCacheTransaction(pool, 'b'.repeat(64), async (connection) => {
      deferMysqlAudit(connection, () => {
        published++;
      });
    });
    expect(published).toBe(1);
    await expect(service(pool, 'b').upgrade(7, original.id)).resolves.toMatchObject({
      contentHash: 'b'.repeat(64)
    });
    expect(audits).toEqual(['skill.catalog.upgraded']);
  });
});

test('Skill cache reports real file failures, releases protection, and collects unreferenced content normally', async () => {
  await withSkillCacheFixture(async ({ pool, cache, service, audits, file, expire }) => {
    const original = await service().create(7, input);
    await service().remove(7, original.id);
    await expire();
    audits.length = 0;
    await chmod(cache, 0o500);
    try {
      await expect(service(pool, 'b').create(7, input)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(service().cleanupCache()).rejects.toMatchObject({ code: 'EACCES' });
      await expect(readFile(file(), 'utf8')).resolves.toContain('SKILL.md');
      expect(audits).toEqual([]);
    } finally {
      await chmod(cache, 0o700);
    }
    await expect(service().cleanupCache()).resolves.toBe(1);
    await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service().create(7, input)).resolves.toMatchObject({
      contentHash: 'a'.repeat(64)
    });
  });
});

test('Skill cache exposes post-unlink SQL failure and rebuilds a previously trashed version safely', async () => {
  await withSkillCacheFixture(async ({ pool, service, file, expire }) => {
    const original = await service().create(7, input);
    const current = await service(pool, 'b').upgrade(7, original.id);
    await expire();
    await pool.query(
      "ALTER TABLE skill_versions ADD CONSTRAINT fixture_keep_cache CHECK (cache_state <> 'TRASHED')"
    );
    await expect(service().cleanupCache()).rejects.toMatchObject({
      code: 'ER_CHECK_CONSTRAINT_VIOLATED'
    });
    await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT cache_state FROM skill_versions WHERE id=?',
      [original.currentVersionId]
    );
    expect(rows[0]?.['cache_state']).toBe('READY');
    const [favorites] = await pool.query<RowDataPacket[]>(
      'SELECT current_version_id FROM skill_favorites WHERE id=?',
      [original.id]
    );
    expect(favorites[0]?.['current_version_id']).toBe(current.currentVersionId);
    await pool.query('ALTER TABLE skill_versions DROP CHECK fixture_keep_cache');
    await expect(service().upgrade(7, original.id)).resolves.toMatchObject({
      currentVersionId: original.currentVersionId
    });
    await expect(readFile(file(), 'utf8')).resolves.toContain('SKILL.md');
    await service(pool, 'b').upgrade(7, original.id);
    await expire();
    await expect(service().cleanupCache()).resolves.toBe(1);
    await expect(service().upgrade(7, original.id)).resolves.toMatchObject({
      currentVersionId: original.currentVersionId
    });
    const [restored] = await pool.query<RowDataPacket[]>(
      'SELECT cache_state,unreferenced_at FROM skill_versions WHERE id=?',
      [original.currentVersionId]
    );
    expect(restored).toMatchObject([{ cache_state: 'READY', unreferenced_at: null }]);
  });
});

test('Skill cache destroys an uncertain unlock session instead of returning its named lock to the pool', async () => {
  await withSkillCacheFixture(async ({ pool, otherPool, service }) => {
    let lockName = '';
    const faulty = gatedPool(pool, {
      before: async (sql, values) => {
        if (sql.includes('GET_LOCK')) lockName = String(values[0]);
        if (sql.includes('RELEASE_LOCK')) throw new Error('FIXTURE_UNLOCK_FAILED');
      }
    });
    await expect(service(faulty).create(7, input)).rejects.toThrow('FIXTURE_UNLOCK_FAILED');
    await expect
      .poll(async () => {
        const [rows] = await otherPool.query<RowDataPacket[]>('SELECT IS_FREE_LOCK(?) AS free', [
          lockName
        ]);
        return rows[0]?.['free'];
      })
      .toBe(1);
    await expect(service(pool, 'b').create(8, input)).resolves.toMatchObject({
      contentHash: 'b'.repeat(64)
    });
  });
});

test('Skill cache stops deletion after a known MySQL session loss and frees the key for another connection', async () => {
  await withSkillCacheFixture(async ({ pool, otherPool, inspector, service, file, expire }) => {
    const original = await service().create(7, input);
    await service().remove(7, original.id);
    await expire();
    const cached = await readFile(file(), 'utf8');
    const collector = service(
      gatedPool(pool, {
        after: async (sql, _values, connection) => {
          if (!sql.includes('MIN(unreferenced_at)')) return;
          const closed = new Promise<void>((resolve) => connection.once('error', () => resolve()));
          await inspector.query(`KILL CONNECTION ${Number(connection.threadId)}`);
          await closed;
        }
      })
    );
    await expect(collector.cleanupCache()).rejects.toThrow();
    expect(await readFile(file(), 'utf8')).toBe(cached);
    await service(otherPool).create(7, input);
    expect(
      (await pool.query<RowDataPacket[]>('SELECT cache_state FROM skill_versions'))[0][0]?.[
        'cache_state'
      ]
    ).toBe('READY');
  });
});
