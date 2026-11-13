import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { ExecuteValues } from 'mysql2';
import { SkillFavoriteService } from '../../../ee/server/src/skill/skill-favorite-service.js';
import type { MysqlServerDatabase } from '../../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../../ee/server/src/rbac/authorization-service.js';
import type { SkillSourceService } from '../../../ee/server/src/skill/skill-source-service.js';
import type { GithubSkillProvider } from '../../../ee/server/src/skill/github-skill-provider.js';
import type { ResolvedSkillBundle } from '../../../packages/server-core/src/skill-bundle.js';
import { prepareMysqlDatabase } from '../../../ee/server/src/mysql/connection.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './playwright-test-database.js';

export const input = {
  sourceId: 'repo-1',
  candidateId: 'acme/skills/review',
  skillPath: 'skills/review',
  scope: 'PERSONAL'
};

export function bundle(character = 'a'): ResolvedSkillBundle {
  const archive = JSON.stringify({
    schemaVersion: 1,
    files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }]
  });
  return {
    repositoryIdentity: 'github.com/acme/skills',
    repositoryUrl: 'https://github.com/acme/skills',
    skillPath: 'skills/review',
    name: 'review',
    description: 'Review code',
    commitSha: character.repeat(40),
    contentHash: character.repeat(64),
    archiveHash: 'f'.repeat(64),
    contentBytes: 10,
    tlsVerified: true,
    fileCount: 1,
    archive: () => Readable.from([archive]),
    dispose: async () => {}
  };
}

export function gate(timeoutMs = 15_000) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const bounded = (signal: Promise<void>, phase: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`SKILL_CACHE_GATE_${phase}_TIMEOUT`)),
        timeoutMs
      );
      void signal.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  return {
    get entered() {
      return bounded(entered, 'ENTRY');
    },
    release,
    wait: async () => {
      enter();
      await bounded(released, 'RELEASE');
    }
  };
}

export interface SqlHooks {
  before?: (sql: string, values: readonly unknown[], connection?: PoolConnection) => Promise<void>;
  after?: (sql: string, values: readonly unknown[], connection: PoolConnection) => Promise<void>;
}

/** Gates only scheduling; every SQL, transaction, lock and file operation remains real. */
export function gatedPool(pool: Pool, hooks: SqlHooks): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'getConnection')
        return async () => {
          await hooks.before?.('GET_CONNECTION', []);
          const connection = await target.getConnection();
          return new Proxy(connection, {
            get(session, member) {
              if (member === 'execute')
                return async (sql: string, values: readonly unknown[] = []) => {
                  await hooks.before?.(sql, values, session);
                  const result = await session.execute(sql, values as ExecuteValues);
                  await hooks.after?.(sql, values, session);
                  return result;
                };
              if (member === 'commit')
                return async () => {
                  await hooks.before?.('COMMIT', [], session);
                  await session.commit();
                  await hooks.after?.('COMMIT', [], session);
                };
              const value = Reflect.get(session, member);
              return typeof value === 'function' ? value.bind(session) : value;
            }
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export async function withSkillCacheFixture(
  run: (fixture: {
    pool: Pool;
    otherPool: Pool;
    inspector: Pool;
    cache: string;
    file: (character?: string) => string;
    audits: string[];
    service: (pool?: Pool, character?: string) => SkillFavoriteService;
    expire: (character?: string) => Promise<void>;
    advance: (milliseconds: number) => void;
    now: () => number;
  }) => Promise<void>
) {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-skill-${randomUUID()}`);
  await createPlaywrightTestDatabase(target);
  const pool = mysql.createPool({ uri: target.databaseUrl, connectionLimit: 1 });
  const otherPool = mysql.createPool({ uri: target.databaseUrl, connectionLimit: 1 });
  const inspector = mysql.createPool({ uri: target.databaseUrl, connectionLimit: 1 });
  const cache = await mkdtemp(path.join(tmpdir(), 'mar-skill-cache-mysql-'));
  try {
    await prepareMysqlDatabase(pool);
    await pool.query(
      "INSERT INTO users(id,username,role,created_at,updated_at) VALUES (7,'skill-user','ADMIN',1,1),(8,'other-user','ADMIN',1,1)"
    );
    await pool.query(`INSERT INTO skill_sources
      (id,kind,scope,owner_user_id,name,locator,enabled,built_in,status,created_by_user_id,created_at,updated_at,owner_key)
      VALUES ('repo-1','REPOSITORY','PERSONAL',7,'Repo','https://github.com/acme/skills',TRUE,FALSE,'READY',7,1,1,'PERSONAL::7')`);
    const audits: string[] = [];
    let currentTime = Date.now();
    const now = () => currentTime;
    const file = (character = 'a') => path.join(cache, `${character.repeat(64)}.json`);
    const service = (raw = pool, character = 'a') =>
      new SkillFavoriteService(
        {
          raw,
          audit: (event: { eventType: string }) => {
            audits.push(event.eventType);
          }
        } as unknown as MysqlServerDatabase,
        { authorize: async () => ({ allowed: true }) } as unknown as AuthorizationService,
        {
          getVisible: async () => ({
            kind: 'REPOSITORY',
            locator: 'https://github.com/acme/skills'
          })
        } as unknown as SkillSourceService,
        { resolve: async () => bundle(character) } as unknown as GithubSkillProvider,
        cache,
        now
      );
    await run({
      pool,
      otherPool,
      inspector,
      cache,
      file,
      audits,
      service,
      now,
      advance: (milliseconds) => {
        currentTime += milliseconds;
      },
      expire: async (character = 'a') => {
        const past = now() - 2 * 86_400_000;
        await pool.execute('UPDATE skill_versions SET unreferenced_at=? WHERE cache_key=?', [
          past,
          character.repeat(64)
        ]);
        await utimes(file(character), new Date(past), new Date(past));
      }
    });
  } finally {
    await Promise.all([pool.end(), otherPool.end(), inspector.end()]);
    await rm(cache, { recursive: true, force: true });
    await dropPlaywrightTestDatabase(target);
  }
}
