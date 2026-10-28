import { expect, test } from '@playwright/test';
import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import { SkillSourceService } from '../../ee/server/src/skill/skill-source-service.js';
import { SkillFavoriteService } from '../../ee/server/src/skill/skill-favorite-service.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

type Scope = 'PERSONAL' | 'ORGANIZATION' | 'ENTERPRISE';
type Kind = 'source' | 'favorite';
type BeforeExecute = (sql: string, connection: PoolConnection) => Promise<void>;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function withFixture(kind: Kind, run: (fixture: Fixture) => Promise<void>) {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-skills-${randomUUID()}`);
  await createPlaywrightTestDatabase(target);
  const pool = mysql.createPool(target.databaseUrl);
  const clients: mysql.Pool[] = [];
  const cache = await mkdtemp(path.join(tmpdir(), 'mar-skill-capacity-'));
  try {
    await prepareMysqlDatabase(pool);
    await pool.query(`INSERT INTO organizations
      (id,name,parent_organization_id,created_at,updated_at)
      VALUES (2,'First',1,1,1),(3,'Second',1,1,1)`);
    await pool.query(`INSERT INTO users(id,username,role,organization_id,created_at,updated_at)
      VALUES (7,'first','ADMIN',1,1,1),(8,'second','ADMIN',1,1,1)`);
    await pool.query(`INSERT INTO skill_sources
      (id,kind,scope,name,locator,created_by_user_id,created_at,updated_at,owner_key)
      VALUES ('repo','REPOSITORY','ENTERPRISE','Repo','https://github.com/acme/skills',7,1,1,'ENTERPRISE::')`);
    const table = kind === 'source' ? 'skill_sources' : 'skill_favorites';
    const limit = kind === 'source' ? 20 : 500;
    const key = (scope: Scope, owner: number) =>
      scope === 'ENTERPRISE' ? 'ENTERPRISE::' : `${scope}:${owner === 0 ? '' : owner}:`;
    const create = (scope: Scope, owner: number, before?: BeforeExecute) => {
      // Separate single-connection pools ensure the two service transactions cannot share a session.
      const client = mysql.createPool({ uri: target.databaseUrl, connectionLimit: 1 });
      clients.push(client);
      const raw = new Proxy(client, {
        get(target, property) {
          if (property === 'getConnection')
            return async () => {
              const connection = await target.getConnection();
              return new Proxy(connection, {
                get(target, property) {
                  if (property === 'execute')
                    return async (
                      sql: string,
                      values?: Parameters<PoolConnection['execute']>[1]
                    ) => {
                      await before?.(sql, connection);
                      return target.execute(sql, values);
                    };
                  if (property === 'commit')
                    return async () => {
                      await before?.('COMMIT', connection);
                      return target.commit();
                    };
                  const value = Reflect.get(target, property);
                  return typeof value === 'function' ? value.bind(target) : value;
                }
              });
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const authorization = { authorize: async () => ({ allowed: true }) };
      const sourceService = new SkillSourceService({ raw }, authorization);
      const provider = {
        resolve: async (request: { skillPath?: string }) => ({
          repositoryIdentity: 'github.com/acme/skills',
          repositoryUrl: 'https://github.com/acme/skills',
          skillPath: request.skillPath!,
          name: 'example',
          description: 'Fixture',
          commitSha: 'a'.repeat(40),
          // Different candidates must not serialize on the independent cache-key coordinator.
          contentHash: createHash('sha256').update(request.skillPath!).digest('hex'),
          archiveHash: 'c'.repeat(64),
          archiveJson: JSON.stringify({
            schemaVersion: 1,
            files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }]
          }),
          contentBytes: 1,
          tlsVerified: true,
          files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }]
        })
      };
      const favoriteService = new SkillFavoriteService(
        { raw },
        authorization,
        sourceService,
        provider,
        cache
      );
      return (name: string, actor = scope === 'PERSONAL' ? owner : 7) => {
        const ownership = { scope, ...(scope === 'ORGANIZATION' ? { organizationId: owner } : {}) };
        return kind === 'source'
          ? sourceService.create(actor, {
              ...ownership,
              kind: 'REPOSITORY',
              name,
              locator: 'https://github.com/acme/skills'
            })
          : favoriteService.create(actor, {
              ...ownership,
              sourceId: 'repo',
              candidateId: `acme/skills/${name}`,
              skillPath: name
            });
      };
    };
    const seed = async (scope: Scope, owner: number, count: number) => {
      const rows = Array.from({ length: count }, (_, index) => {
        const id = randomUUID();
        const shared = [
          id,
          scope,
          scope === 'ORGANIZATION' ? owner : null,
          scope === 'PERSONAL' ? owner : null
        ];
        return [...shared, `seed-${index}`, key(scope, owner)];
      });
      if (!rows.length) return;
      if (kind === 'source')
        await pool.query(
          `INSERT INTO skill_sources
          (id,scope,owner_organization_id,owner_user_id,name,owner_key,kind,locator,
           created_by_user_id,created_at,updated_at) VALUES ${rows.map(() => "(?,?,?,?,?,?,'REPOSITORY','https://github.com/acme/skills',7,1,1)").join(',')}`,
          rows.flat()
        );
      else
        await pool.query(
          `INSERT INTO skill_favorites
          (id,scope,owner_organization_id,owner_user_id,skill_path,owner_key,source_id,
           repository_url,repository_identity,normalized_name,created_by_user_id,created_at,updated_at)
          VALUES ${rows.map(() => "(?,?,?,?,?,?,'repo','https://github.com/acme/skills','github.com/acme/skills','example',7,1,1)").join(',')}`,
          rows.flat()
        );
    };
    const count = async (scope: Scope, owner: number) => {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM ${table} WHERE owner_key=?`,
        [key(scope, owner)]
      );
      return Number(rows[0]!['total']);
    };
    await run({ pool, table, limit, create, seed, count });
  } finally {
    await Promise.all(clients.map((client) => client.end()));
    await pool.end();
    await dropPlaywrightTestDatabase(target);
    await rm(cache, { recursive: true, force: true });
  }
}

type Fixture = {
  pool: mysql.Pool;
  table: string;
  limit: number;
  create: (
    scope: Scope,
    owner: number,
    before?: BeforeExecute
  ) => (name: string, actor?: number) => Promise<unknown>;
  seed: (scope: Scope, owner: number, count: number) => Promise<void>;
  count: (scope: Scope, owner: number) => Promise<number>;
};

for (const kind of ['source', 'favorite'] as const) {
  const scopes: Scope[] =
    kind === 'source' ? ['PERSONAL', 'ORGANIZATION'] : ['PERSONAL', 'ORGANIZATION', 'ENTERPRISE'];
  for (const scope of scopes) {
    test(`${kind} ${scope}: two MySQL connections admit only one last-slot writer`, async () => {
      await withFixture(kind, async (fixture) => {
        const owner = scope === 'PERSONAL' ? 7 : scope === 'ENTERPRISE' ? 0 : 2;
        await fixture.seed(scope, owner, fixture.limit - 1);
        const inserting = gate();
        const resume = gate();
        const secondLock = gate();
        let secondConnection = 0;
        let secondCounts = 0;
        const first = fixture.create(scope, owner, async (sql) => {
          if (sql.includes(`INSERT INTO ${fixture.table}`)) {
            inserting.open();
            await resume.promise;
          }
        })('first');
        let second: Promise<unknown> | undefined;
        try {
          await Promise.race([
            inserting.promise,
            first.then(() => {
              throw new Error('FIRST_WRITER_DID_NOT_REACH_INSERT');
            })
          ]);
          second = fixture
            .create(scope, owner, async (sql, connection) => {
              if (sql.includes('COUNT(*)')) secondCounts++;
              if (sql.includes(scope === 'PERSONAL' ? 'FROM users' : 'FROM organizations')) {
                secondConnection = connection.threadId;
                secondLock.open();
              }
            })('second', scope === 'PERSONAL' ? 7 : 8)
            .catch((error: unknown) => error);
          await Promise.race([
            secondLock.promise,
            second.then(() => {
              throw new Error('SECOND_WRITER_DID_NOT_REACH_OWNER_LOCK');
            })
          ]);
          // Observe an actual InnoDB wait on the owner parent, not elapsed time or fake locks.
          await expect
            .poll(async () => {
              const [rows] = await fixture.pool.execute<RowDataPacket[]>(
                `SELECT requested.OBJECT_NAME FROM performance_schema.data_lock_waits waiting
               JOIN performance_schema.threads thread ON thread.THREAD_ID=waiting.REQUESTING_THREAD_ID
               JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID=waiting.REQUESTING_ENGINE_LOCK_ID
               WHERE thread.PROCESSLIST_ID=?`,
                [secondConnection]
              );
              return rows.map((row) => row['OBJECT_NAME']);
            })
            .toContain(scope === 'PERSONAL' ? 'users' : 'organizations');
          expect(secondCounts).toBe(0);
          resume.open();
          await first;
          expect(await second).toMatchObject({ message: 'SKILL_SOURCE_LIMIT_EXCEEDED' });
          expect(secondCounts).toBe(1);
          expect(await fixture.count(scope, owner)).toBe(fixture.limit);
          await expect(fixture.create(scope, owner)('already-full')).rejects.toThrow(
            'SKILL_SOURCE_LIMIT_EXCEEDED'
          );
        } finally {
          resume.open();
          await Promise.allSettled([first, ...(second ? [second] : [])]);
          test.info().annotations.push({
            type: 'owner-count',
            description: JSON.stringify({
              kind,
              scope,
              limit: fixture.limit,
              total: await fixture.count(scope, owner)
            })
          });
        }
      });
    });
  }

  for (const scope of ['PERSONAL', 'ORGANIZATION'] as const) {
    test(`${kind} ${scope}: different owners progress while another owner is held`, async () => {
      await withFixture(kind, async (fixture) => {
        const owner = scope === 'PERSONAL' ? 7 : 2;
        const otherOwner = scope === 'PERSONAL' ? 8 : 3;
        const inserting = gate();
        const resume = gate();
        const first = fixture.create(scope, owner, async (sql) => {
          if (sql.includes(`INSERT INTO ${fixture.table}`)) {
            inserting.open();
            await resume.promise;
          }
        })('first');
        let second: Promise<unknown> | undefined;
        try {
          await Promise.race([
            inserting.promise,
            first.then(() => {
              throw new Error('FIRST_WRITER_DID_NOT_REACH_INSERT');
            })
          ]);
          let completed = false;
          second = fixture
            .create(
              scope,
              otherOwner
            )('second')
            .then(() => {
              completed = true;
            });
          await expect.poll(() => completed).toBe(true);
          expect(await fixture.count(scope, otherOwner)).toBe(1);
          expect(await fixture.count(scope, owner)).toBe(0);
        } finally {
          resume.open();
          await Promise.all([first, ...(second ? [second] : [])]);
        }
        expect(await fixture.count(scope, owner)).toBe(1);
      });
    });
  }

  test(`${kind}: duplicate and transaction failure preserve capacity and release the connection`, async () => {
    await withFixture(kind, async (fixture) => {
      const create = fixture.create('PERSONAL', 7);
      await create('duplicate');
      await expect(create('duplicate')).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      expect(await fixture.count('PERSONAL', 7)).toBe(1);
      let fail = true;
      const failing = fixture.create('PERSONAL', 7, async (sql) => {
        // For favorites fail after both the favorite and its version have been inserted.
        if (
          fail &&
          sql.includes(
            kind === 'source' ? 'COMMIT' : 'UPDATE skill_favorites SET current_version_id'
          )
        ) {
          fail = false;
          throw new Error('INJECTED_TRANSACTION_FAILURE');
        }
      });
      await expect(failing('rolled-back')).rejects.toThrow('INJECTED_TRANSACTION_FAILURE');
      expect(await fixture.count('PERSONAL', 7)).toBe(1);
      if (kind === 'favorite') {
        const [versions] = await fixture.pool.query<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM skill_versions'
        );
        expect(Number(versions[0]!['total'])).toBe(1);
      }
      // The single-connection pool must be usable after rollback and return its owner lock.
      await expect(failing('after-failure')).resolves.toBeDefined();
      await expect(create('after-release')).resolves.toBeDefined();
      expect(await fixture.count('PERSONAL', 7)).toBe(3);
    });
  });

  test(`${kind}: same-owner writers below capacity both commit`, async () => {
    await withFixture(kind, async (fixture) => {
      await fixture.seed('PERSONAL', 7, fixture.limit - 2);
      await Promise.all([
        fixture.create('PERSONAL', 7)('first'),
        fixture.create('PERSONAL', 7)('second')
      ]);
      expect(await fixture.count('PERSONAL', 7)).toBe(fixture.limit);
    });
  });
}
