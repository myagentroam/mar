import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { SkillFavoriteService } from '../../ee/server/src/skill/skill-favorite-service.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import type { SkillSourceService } from '../../ee/server/src/skill/skill-source-service.js';
import type { GithubSkillProvider } from '../../ee/server/src/skill/github-skill-provider.js';
import { deferMysqlAudit } from '../../packages/server-core/src/audit.js';
import { withSkillCacheTransaction } from '../../packages/server-core/src/skill-cache-transaction.js';
import { gate as mysqlGate } from '../e2e/support/skill-cache-fixture.js';
import { favoriteInput, gate, SkillCacheFake, skillBundle } from './support/skill-cache-fake.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(now: () => number = Date.now) {
  const cache = await mkdtemp(path.join(tmpdir(), 'mar-skill-cache-'));
  roots.push(cache);
  const fake = new SkillCacheFake();
  const audit = vi.fn();
  const resolve = vi.fn(async () => skillBundle());
  const service = () =>
    new SkillFavoriteService(
      { raw: fake.raw, audit } as unknown as MysqlServerDatabase,
      { authorize: async () => ({ allowed: true }) } as unknown as AuthorizationService,
      {
        getVisible: async () => ({ kind: 'REPOSITORY', locator: 'https://github.com/acme/skills' })
      } as unknown as SkillSourceService,
      { resolve } as unknown as GithubSkillProvider,
      cache,
      now
    );
  return { fake, audit, resolve, cache, service };
}

describe('Skill cache reference coordination with gated SQL fake', () => {
  for (const operation of ['create', 'upgrade'] as const) {
    for (const release of ['remove', 'upgrade'] as const) {
      it(`Restarts a continuous 24-hour grace after ${operation} reuses an expired orphan key and ${release} releases it`, async () => {
        const day = 86_400_000;
        let now = Date.now();
        const { fake, cache, service, resolve } = await fixture(() => now);
        const original = await service().create(7, favoriteInput);
        resolve.mockResolvedValue(skillBundle('b'));
        await service().upgrade(7, original.id);
        fake.versions.get(original.currentVersionId)!['unreferenced_at'] = now - 2 * day;
        const file = path.join(cache, `${'a'.repeat(64)}.json`);
        await utimes(file, new Date(now - 2 * day), new Date(now - 2 * day));
        let borrowed;
        if (operation === 'create') {
          resolve.mockResolvedValue(skillBundle());
          borrowed = await service().create(8, favoriteInput);
        } else {
          borrowed = await service().create(8, favoriteInput);
          resolve.mockResolvedValue(skillBundle());
          borrowed = await service().upgrade(8, borrowed.id);
        }
        expect(fake.versions.get(original.currentVersionId)?.['unreferenced_at']).toBeNull();
        await expect(service().cleanupCache()).resolves.toBe(0);
        now += 2 * day;
        await expect(service().cleanupCache()).resolves.toBe(0);
        expect(fake.versions.get(original.currentVersionId)?.['unreferenced_at']).toBeNull();
        if (release === 'remove') await service().remove(8, borrowed.id);
        else {
          resolve.mockResolvedValue(skillBundle('b'));
          await service().upgrade(8, borrowed.id);
        }
        expect(fake.versions.get(original.currentVersionId)?.['unreferenced_at']).toBe(now);
        await expect(service().cleanupCache()).resolves.toBe(0);
        await expect(readFile(file, 'utf8')).resolves.toContain('SKILL.md');
        now += day - 1;
        await expect(service().cleanupCache()).resolves.toBe(0);
        now += 2;
        await expect(service().cleanupCache()).resolves.toBe(1);
        await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fake.versions.get(original.currentVersionId)?.['cache_state']).toBe('TRASHED');
      });
    }

    it(`Rolls back ${operation} grace resets when reference commit fails`, async () => {
      const now = Date.now();
      const { fake, cache, service, resolve, audit } = await fixture(() => now);
      const original = await service().create(7, favoriteInput);
      resolve.mockResolvedValue(skillBundle('b'));
      await service().upgrade(7, original.id);
      const previous =
        operation === 'upgrade' ? await service().create(8, favoriteInput) : undefined;
      const past = now - 2 * 86_400_000;
      fake.versions.get(original.currentVersionId)!['unreferenced_at'] = past;
      const file = path.join(cache, `${'a'.repeat(64)}.json`);
      await utimes(file, new Date(past), new Date(past));
      resolve.mockResolvedValue(skillBundle());
      audit.mockClear();
      fake.beforeCommit = async () => {
        throw new Error('COMMIT_FAILED');
      };
      const attempt = () =>
        previous ? service().upgrade(8, previous.id) : service().create(8, favoriteInput);
      await expect(attempt()).rejects.toThrow('COMMIT_FAILED');
      fake.beforeCommit = async () => {};
      expect(fake.versions.get(original.currentVersionId)?.['unreferenced_at']).toBe(past);
      expect(fake.favorites.size).toBe(previous ? 2 : 1);
      if (previous)
        expect(fake.favorites.get(previous.id)?.['current_version_id']).toBe(
          previous.currentVersionId
        );
      expect(audit).not.toHaveBeenCalled();
      await expect(readFile(file, 'utf8')).resolves.toContain('SKILL.md');
      await expect(service().cleanupCache()).resolves.toBe(1);
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(attempt()).resolves.toMatchObject({ contentHash: 'a'.repeat(64) });
      expect(fake.versions.get(original.currentVersionId)?.['unreferenced_at']).toBe(past);
      await expect(readFile(file, 'utf8')).resolves.toContain('SKILL.md');
    });

    it(`Rechecks selected cache after ${operation} commits a same-hash reference`, async () => {
      const { fake, cache, service, resolve } = await fixture();
      let favoriteId = '';
      if (operation === 'upgrade') {
        resolve.mockResolvedValueOnce(skillBundle('b'));
        favoriteId = (await service().create(7, favoriteInput)).id;
      }
      await writeFile(path.join(cache, `${'a'.repeat(64)}.json`), '{"old":true}');
      await utimes(path.join(cache, `${'a'.repeat(64)}.json`), new Date(0), new Date(0));
      const selected = gate();
      let first = true;
      fake.beforeConnection = async () => {
        if (first) {
          first = false;
          await selected.wait();
        }
      };
      const cleanup = service().cleanupCache();
      // Attach a handler while the other operation is gated; the assertions still await failures.
      void cleanup.catch(() => {});
      const committed = gate();
      let writer: ReturnType<SkillFavoriteService['create']> | undefined;
      try {
        await selected.entered;
        fake.beforeCommit = async () => {
          fake.beforeCommit = async () => {};
          await committed.wait();
        };
        writer =
          operation === 'create'
            ? service().create(7, favoriteInput)
            : service().upgrade(7, favoriteId);
        void writer.catch(() => {});
        await committed.entered;
        expect(fake.favorites.size).toBe(operation === 'create' ? 0 : 1);
        committed.release();
        const summary = await writer;
        selected.release();
        await expect(cleanup).resolves.toBe(0);
        await expect(
          readFile(path.join(cache, `${summary.contentHash}.json`), 'utf8')
        ).resolves.toBe('{"old":true}');
        expect(fake.versions.get(summary.currentVersionId)).toMatchObject({
          cache_state: 'READY',
          unreferenced_at: null
        });
      } finally {
        selected.release();
        committed.release();
        await Promise.allSettled([cleanup, writer]);
      }
      expect(fake.destroyed).toBe(0);
    });

    it(`Rebuilds a same-hash cache when cleanup wins before ${operation}`, async () => {
      const { fake, cache, service, resolve } = await fixture();
      let favoriteId = '';
      if (operation === 'upgrade') {
        resolve.mockResolvedValueOnce(skillBundle('b'));
        favoriteId = (await service().create(7, favoriteInput)).id;
      }
      await writeFile(path.join(cache, `${'a'.repeat(64)}.json`), '{"old":true}');
      await utimes(path.join(cache, `${'a'.repeat(64)}.json`), new Date(0), new Date(0));
      const deleted = gate();
      const waiting = gate();
      fake.beforeSql = async (sql) => {
        if (sql.includes("SET cache_state='TRASHED'")) await deleted.wait();
        if (sql.includes('GET_LOCK') && reachedDelete) {
          waiting.release();
          await waiting.wait();
        }
      };
      let reachedDelete = false;
      const cleanup = service().cleanupCache();
      void cleanup.catch(() => {});
      let writer: ReturnType<SkillFavoriteService['create']> | undefined;
      try {
        await deleted.entered;
        reachedDelete = true;
        writer =
          operation === 'create'
            ? service().create(7, favoriteInput)
            : service().upgrade(7, favoriteId);
        void writer.catch(() => {});
        await waiting.entered;
        await expect(readFile(path.join(cache, `${'a'.repeat(64)}.json`))).rejects.toMatchObject({
          code: 'ENOENT'
        });
        deleted.release();
        await expect(cleanup).resolves.toBe(1);
        const summary = await writer;
        await expect(
          readFile(path.join(cache, `${summary.contentHash}.json`), 'utf8')
        ).resolves.toContain('SKILL.md');
        expect(fake.versions.get(summary.currentVersionId)).toMatchObject({
          cache_state: 'READY',
          unreferenced_at: null
        });
      } finally {
        deleted.release();
        waiting.release();
        await Promise.allSettled([cleanup, writer]);
      }
    });
  }

  it('Starts an unobserved orphan grace period only after the protected reference check', async () => {
    let now = Date.now();
    const { fake, cache, service, resolve } = await fixture(() => now);
    const original = await service().create(7, favoriteInput);
    resolve.mockResolvedValue(skillBundle('b'));
    await service().upgrade(7, original.id);
    fake.versions.get(original.currentVersionId)!['unreferenced_at'] = null;
    const file = path.join(cache, `${'a'.repeat(64)}.json`);
    const past = new Date(now - 2 * 86_400_000);
    await utimes(file, past, past);
    await expect(service().cleanupCache()).resolves.toBe(0);
    expect(fake.versions.get(original.currentVersionId)?.['unreferenced_at']).toBe(now);
    await expect(readFile(file, 'utf8')).resolves.toContain('SKILL.md');
    now += 86_400_001;
    await expect(service().cleanupCache()).resolves.toBe(1);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Rolls back failed upgrades without publishing audit or dropping the old current version', async () => {
    const { fake, service, resolve, audit, cache } = await fixture();
    const old = await service().create(7, favoriteInput);
    audit.mockClear();
    resolve.mockResolvedValue(skillBundle('b'));
    fake.beforeCommit = async () => {
      throw new Error('COMMIT_FAILED');
    };
    await expect(service().upgrade(7, old.id)).rejects.toThrow('COMMIT_FAILED');
    expect(fake.favorites.get(old.id)?.['current_version_id']).toBe(old.currentVersionId);
    expect(audit).not.toHaveBeenCalled();
    await expect(readFile(path.join(cache, `${old.contentHash}.json`), 'utf8')).resolves.toContain(
      'SKILL.md'
    );
  });
});

describe('Skill cache scheduling gates', () => {
  for (const [name, createGate] of [
    ['SQL fake', gate],
    ['MySQL fixture', mysqlGate]
  ] as const) {
    it(`Bounds missing entry for the ${name} gate`, async () => {
      await expect(createGate(10).entered).rejects.toThrow('SKILL_CACHE_GATE_ENTRY_TIMEOUT');
    });

    it(`Bounds a missing release for the ${name} gate`, async () => {
      const pending = createGate(10);
      await expect(pending.wait()).rejects.toThrow('SKILL_CACHE_GATE_RELEASE_TIMEOUT');
    });

    it(`Completes and clears deadlines for a released ${name} gate`, async () => {
      vi.useFakeTimers();
      try {
        const pending = createGate(10);
        const held = pending.wait();
        await pending.entered;
        pending.release();
        await held;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe('Skill cache connection and audit lifecycle', () => {
  for (const failure of [
    'timeout',
    'missing',
    'acquisition',
    'commit',
    'unlock',
    'rollback',
    'fatal'
  ] as const) {
    it(`Releases or destroys the connection after ${failure} without leaking deferred audit`, async () => {
      const audit = vi.fn();
      const action = vi.fn(async (connection: object) => {
        deferMysqlAudit(connection, audit);
        if (failure === 'rollback') throw new Error('SQL_FAILED');
        if (failure === 'fatal') throw Object.assign(new Error('CONNECTION_LOST'), { fatal: true });
        return true;
      });
      const connection = {
        execute: vi.fn(async (sql: string) => {
          if (sql.includes('DATABASE()')) return [[{ database_name: 'test' }], []];
          if (sql.includes('GET_LOCK')) {
            if (failure === 'acquisition') throw new Error('ACQUIRE_FAILED');
            return [
              [{ acquired: failure === 'missing' ? null : failure === 'timeout' ? 0 : 1 }],
              []
            ];
          }
          if (failure === 'unlock') throw new Error('UNLOCK_FAILED');
          return [[{ released: 1 }], []];
        }),
        beginTransaction: vi.fn(async () => {}),
        commit: vi.fn(async () => {
          if (failure === 'commit') throw new Error('COMMIT_FAILED');
        }),
        rollback: vi.fn(async () => {
          if (failure === 'rollback') throw new Error('ROLLBACK_FAILED');
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
        release: vi.fn(),
        destroy: vi.fn()
      };
      const pool = { getConnection: async () => connection } as unknown as Pool;
      await expect(withSkillCacheTransaction(pool, 'a'.repeat(64), action)).rejects.toThrow();
      const reusable = failure === 'timeout' || failure === 'commit';
      expect(connection.release).toHaveBeenCalledTimes(reusable ? 1 : 0);
      expect(connection.destroy).toHaveBeenCalledTimes(reusable ? 0 : 1);
      expect(audit).toHaveBeenCalledTimes(failure === 'unlock' ? 1 : 0);
      if (failure === 'timeout' || failure === 'missing' || failure === 'acquisition') {
        expect(action).not.toHaveBeenCalled();
        expect(connection.beginTransaction).not.toHaveBeenCalled();
      }
      if (failure === 'commit') expect(connection.rollback).toHaveBeenCalledOnce();
      // Reusing the object cannot publish rolled-back intents later.
      const { commitMysqlAudits } = await import('../../packages/server-core/src/audit.js');
      commitMysqlAudits(connection);
      expect(audit).toHaveBeenCalledTimes(failure === 'unlock' ? 1 : 0);
    });
  }
});
