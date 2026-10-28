import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import type { GithubSkillProvider } from '../../ee/server/src/skill/github-skill-provider.js';
import { SkillFavoriteService } from '../../ee/server/src/skill/skill-favorite-service.js';
import type { SkillSourceService } from '../../ee/server/src/skill/skill-source-service.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

describe('Server Skill favorite', () => {
  it('Accepts objects returned directly from MySQL JSON columns', async () => {
    const row = {
      id: 'favorite-1',
      source_id: 'source-1',
      scope: 'PERSONAL',
      owner_organization_id: null,
      owner_user_id: 7,
      normalized_name: 'review',
      featured: 1,
      tags: ['quality', 'review'],
      repository_identity: 'github.com/acme/skills',
      skill_path: 'skills/review',
      current_version_id: 'version-1',
      commit_sha: 'a'.repeat(40),
      content_hash: 'b'.repeat(64),
      tls_verified: 1,
      metadata: { description: 'Review code' },
      created_at: 1,
      updated_at: 2
    };
    const service = new SkillFavoriteService(
      { raw: { execute: vi.fn(async () => [[row], []]) } } as unknown as MysqlServerDatabase,
      { authorize: vi.fn(async () => ({ allowed: true })) } as unknown as AuthorizationService,
      {} as SkillSourceService,
      {} as GithubSkillProvider,
      '/unused'
    );

    await expect(service.list(7)).resolves.toEqual([
      expect.objectContaining({
        id: 'favorite-1',
        description: 'Review code',
        featured: true,
        tags: ['quality', 'review'],
        manageable: true
      })
    ]);
  });

  it('Favorites pin Commits, write immutable caches, and record TLS status', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'mar-skill-favorite-'));
    roots.push(cache);
    let transactionCount = 0;
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes('DATABASE()')) return [[{ database_name: 'favorite-test' }], []];
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        if (sql.includes('cached_versions')) return [[{ total: 0 }], []];
        if (sql.includes('COUNT(*)')) return [[{ total: transactionCount }], []];
        if (sql.includes('SELECT id FROM users')) return [[{ id: values?.[0] }], []];
        if (sql.includes('SELECT id,enabled FROM skill_sources'))
          return [[{ id: values?.[0], enabled: 1 }], []];
        void sql;
        void values;
        return [{ affectedRows: 1 }, []];
      }),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      on: vi.fn(),
      removeListener: vi.fn(),
      release: vi.fn()
    };
    const raw = {
      execute: vi.fn(async (sql: string) =>
        sql.includes('COUNT(*)') || sql.includes('cached_versions')
          ? [[{ total: 0 }], []]
          : [[], []]
      ),
      getConnection: vi.fn(async () => connection)
    };
    const bundle = {
      repositoryIdentity: 'github.com/acme/skills',
      repositoryUrl: 'https://github.com/acme/skills',
      skillPath: 'skills/review',
      name: 'review',
      description: 'Review code',
      commitSha: 'a'.repeat(40),
      contentHash: 'b'.repeat(64),
      archiveHash: 'c'.repeat(64),
      archiveJson: JSON.stringify({
        schemaVersion: 1,
        files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }]
      }),
      contentBytes: 10,
      tlsVerified: false,
      files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }]
    };
    const warnCacheUsage = vi.fn();
    const service = new SkillFavoriteService(
      { raw } as unknown as MysqlServerDatabase,
      { authorize: vi.fn(async () => ({ allowed: true })) } as unknown as AuthorizationService,
      {
        getVisible: vi.fn(async () => ({
          id: 'repo-1',
          kind: 'REPOSITORY',
          locator: 'https://github.com/acme/skills',
          enabled: true
        }))
      } as unknown as SkillSourceService,
      { resolve: vi.fn(async () => bundle) } as unknown as GithubSkillProvider,
      cache,
      () => 2_000,
      12,
      warnCacheUsage
    );

    await expect(
      service.create(7, {
        sourceId: 'repo-1',
        candidateId: 'acme/skills/review',
        skillPath: 'skills/review',
        scope: 'PERSONAL',
        featured: true,
        tags: ['quality', 'review']
      })
    ).resolves.toMatchObject({
      normalizedName: 'review',
      commitSha: 'a'.repeat(40),
      featured: true,
      tags: ['quality', 'review'],
      tlsVerified: false
    });
    await expect(readFile(path.join(cache, `${'b'.repeat(64)}.json`), 'utf8')).resolves.toContain(
      'SKILL.md'
    );
    await expect(readFile(path.join(cache, `${'b'.repeat(64)}.json`), 'utf8')).resolves.toBe(
      bundle.archiveJson
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(warnCacheUsage).toHaveBeenCalledWith(10, 12);
    expect(
      connection.execute.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO skill_versions')
      )?.[1]
    ).toEqual(expect.arrayContaining([false]));
    const statements = connection.execute.mock.calls.map(([sql]) => sql);
    expect(statements.slice(0, 2)).toEqual([
      expect.stringContaining('DATABASE()'),
      expect.stringContaining('GET_LOCK')
    ]);
    const ownerLockIndex = statements.findIndex((sql) => sql.includes('FROM users'));
    expect(ownerLockIndex).toBeGreaterThan(1);
    expect(statements.slice(ownerLockIndex, ownerLockIndex + 3)).toEqual([
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('FROM skill_sources'),
      expect.stringContaining('COUNT(*)')
    ]);
    expect(statements.findIndex((sql) => sql.includes('cached_versions'))).toBeGreaterThan(
      ownerLockIndex + 2
    );
    transactionCount = 500;
    await expect(
      service.create(7, {
        sourceId: 'repo-1',
        candidateId: 'acme/skills/other',
        skillPath: 'skills/other',
        scope: 'PERSONAL'
      })
    ).rejects.toThrow('SKILL_SOURCE_LIMIT_EXCEEDED');
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledTimes(2);
  });

  it('Update checks compare only upstream repository Commits without changing favorite versions', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('FROM skill_favorites'))
        return [
          [
            {
              id: 'favorite-1',
              scope: 'PERSONAL',
              owner_user_id: 7,
              owner_organization_id: null,
              repository_url: 'https://github.com/acme/skills',
              skill_path: 'skills/review',
              normalized_name: 'review',
              current_version_id: 'version-1'
            }
          ],
          []
        ];
      if (sql.includes('FROM skill_versions')) return [[{ commit_sha: 'a'.repeat(40) }], []];
      return [[], []];
    });
    const service = new SkillFavoriteService(
      { raw: { execute } } as unknown as MysqlServerDatabase,
      { authorize: vi.fn(async () => ({ allowed: true })) } as unknown as AuthorizationService,
      {} as SkillSourceService,
      {
        resolve: vi.fn(async () => ({
          repositoryIdentity: 'github.com/acme/skills',
          repositoryUrl: 'https://github.com/acme/skills',
          skillPath: 'skills/review',
          name: 'review',
          description: 'Review code',
          commitSha: 'b'.repeat(40),
          contentHash: 'c'.repeat(64),
          archiveHash: 'd'.repeat(64),
          contentBytes: 10,
          tlsVerified: true,
          files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }]
        }))
      } as unknown as GithubSkillProvider,
      '/unused'
    );

    await expect(service.checkUpdate(7, 'favorite-1')).resolves.toEqual({
      updateAvailable: true,
      latestCommitSha: 'b'.repeat(40)
    });
    expect(execute.mock.calls.every(([sql]) => !String(sql).includes('UPDATE'))).toBe(true);
  });

  it('Catalog star and tag edits preserve the pinned version', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM skill_favorites'))
        return [
          [
            {
              id: 'favorite-1',
              scope: 'PERSONAL',
              owner_user_id: 7,
              owner_organization_id: null
            }
          ],
          []
        ];
      return [{ affectedRows: 1 }, []];
    });
    const service = new SkillFavoriteService(
      { raw: { execute } } as unknown as MysqlServerDatabase,
      { authorize: vi.fn(async () => ({ allowed: true })) } as unknown as AuthorizationService,
      {} as SkillSourceService,
      {} as GithubSkillProvider,
      '/unused',
      () => 3_000
    );

    await service.updatePresentation(7, 'favorite-1', {
      featured: true,
      tags: ['quality', 'review']
    });

    expect(execute).toHaveBeenCalledWith(
      'UPDATE skill_favorites SET featured=?,tags=?,updated_at=? WHERE id=?',
      [true, JSON.stringify(['quality', 'review']), 3_000, 'favorite-1']
    );
  });
});
