import { expect, test } from '@playwright/test';
import type { ExecuteValues } from 'mysql2';
import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { prepareMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { ResourceAccessService } from '../../ee/server/src/rbac/resource-access-service.js';
import { ConversationTemplateService } from '../../packages/server-core/src/conversation-template-service.js';
import type { TemplateStore } from '../../packages/server-core/src/hosted-contracts.js';
import type { ConversationTemplatePublishJob } from '../../packages/protocol/src/index.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

const queued: ConversationTemplatePublishJob = {
  id: 'request-1',
  templateId: 'template-1',
  draftRevision: 1,
  stage: 'VALIDATING',
  status: 'QUEUED',
  errorCode: null,
  createdAt: 2000,
  updatedAt: 2000
};
const running = { ...queued, stage: 'COPYING', status: 'RUNNING', updatedAt: 2050 } as const;
const failed = {
  ...running,
  status: 'FAILED',
  errorCode: 'PUBLISH_FAILED',
  errorSummary: 'Publishing failed.',
  updatedAt: 2100
} as const;
const version = {
  id: 'version-1',
  templateId: 'template-1',
  version: 1,
  status: 'AVAILABLE',
  contentHash: 'a'.repeat(64),
  manifestHash: 'b'.repeat(64),
  mcpConfigHash: 'c'.repeat(64),
  fileCount: 2,
  totalBytes: 1024,
  hostPolicyVersion: 1,
  publishedByUserId: 1,
  publishedAt: 2100
} as const;
const succeeded = {
  ...queued,
  stage: 'REGISTERED',
  status: 'SUCCEEDED',
  versionId: version.id,
  updatedAt: 2100
} as const;

type StatementHook = (connection: PoolConnection, sql: string, values: unknown[]) => Promise<void>;

// Gates surround real SQL on separate pool connections, not simulated lock behavior.
function observedStore(
  database: MysqlServerDatabase,
  hooks: {
    before?: StatementHook;
    after?: StatementHook;
    beforeCommit?: () => Promise<void>;
  }
): TemplateStore {
  return {
    raw: new Proxy(database.raw, {
      get(pool, key) {
        if (key === 'getConnection')
          return async () => {
            const connection = await pool.getConnection();
            await connection.query('SET SESSION innodb_lock_wait_timeout=8');
            return new Proxy(connection, {
              get(target, property) {
                if (property === 'execute')
                  return async (sql: string, values: ExecuteValues[] = []) => {
                    await hooks.before?.(connection, sql, values);
                    const result = await connection.execute(sql, values);
                    await hooks.after?.(connection, sql, values);
                    return result;
                  };
                if (property === 'commit')
                  return async () => {
                    await hooks.beforeCommit?.();
                    return connection.commit();
                  };
                const value: unknown = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              }
            });
          };
        const value: unknown = Reflect.get(pool, key);
        return typeof value === 'function' ? value.bind(pool) : value;
      }
    }),
    audit: database.audit.bind(database),
    auditWithConnection: database.auditWithConnection.bind(database)
  };
}

async function withDatabase(run: (database: MysqlServerDatabase) => Promise<void>) {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-publish-${randomUUID()}`);
  await createPlaywrightTestDatabase(target);
  const pool = mysql.createPool(target.databaseUrl);
  try {
    await prepareMysqlDatabase(pool);
    const database = new MysqlServerDatabase(pool);
    await database.initialize();
    const pendingAudits: Promise<void>[] = [];
    const dispatchAudit = database.dispatchAudit.bind(database);
    database.dispatchAudit = (task) => {
      const finished = Promise.withResolvers<void>();
      pendingAudits.push(finished.promise);
      dispatchAudit(async () => {
        try {
          await task();
        } finally {
          finished.resolve();
        }
      });
    };
    await pool.query(`INSERT INTO nodes
      (id,owner_type,owner_organization_id,registered_by_user_id,display_name,registered_address,metadata,created_at,updated_at)
      VALUES ('node-1','ORGANIZATION',1,1,'Template host','127.0.0.1',JSON_OBJECT(),1,1)`);
    await pool.query(`INSERT INTO workspaces
      (workspace_id,display_name,node_id,owner_type,owner_organization_id,registered_at)
      VALUES ('workspace-1','Source','node-1','ORGANIZATION',1,1)`);
    await pool.query(`INSERT INTO conversation_templates
      (id,source_node_id,source_workspace_id,name,normalized_name,description,draft_revision,draft_config,created_by_user_id,updated_by_user_id,created_at,updated_at)
      VALUES ('template-1','node-1','workspace-1','Research','research','Fixture',2,JSON_OBJECT(),1,1,1000,1900)`);
    await pool.query(`INSERT INTO conversation_template_publish_jobs
      (id,template_id,source_node_id,source_workspace_id,draft_revision,stage,status,requested_by_user_id,created_at,updated_at)
      VALUES ('request-1','template-1','node-1','workspace-1',1,'VALIDATING','QUEUED',1,2000,2000)`);
    await test
      .info()
      .attach('isolated-database', { body: target.databaseName, contentType: 'text/plain' });
    try {
      await run(database);
    } finally {
      await Promise.all(pendingAudits);
    }
  } finally {
    await pool.end();
    await dropPlaywrightTestDatabase(target);
  }
}

function service(store: TemplateStore) {
  return new ConversationTemplateService(store, {} as never, {} as never);
}

for (const operation of ['create', 'update', 'publish'] as const) {
  test(`Template ${operation} rejects admin revocation between preflight and transaction admission`, async () => {
    test.setTimeout(60_000);
    await withDatabase(async (database) => {
      const resources = new ResourceAccessService(database, new AuthorizationService(database));
      const models = {
        listTemplateOptionsForNode: async () => [{ modelId: 'coding', name: 'Coding' }]
      };
      const input = {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        name: 'Admission',
        description: 'Fixture',
        allowedModels: [{ modelId: 'coding', name: 'Coding' }],
        defaultModelId: 'coding',
        mcpIds: [],
        networkMode: 'NONE',
        quotas: { maxStorageBytes: 100_000_000, maxUploadBytes: 10_000_000 }
      };
      const inspect = async () => ({
        valid: true,
        code: null,
        message: 'Valid fixture.',
        checkedAt: 2000,
        mcpServers: []
      });
      const seed = new ConversationTemplateService(
        database,
        resources,
        models,
        () => 2000,
        () => 'admission-template'
      );
      await seed.create(1, input, inspect);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const store = observedStore(database, {
        before: async (_connection, sql) => {
          if (sql.startsWith('SELECT id FROM users')) {
            entered.resolve();
            await release.promise;
          }
        }
      });
      const templates = new ConversationTemplateService(
        store,
        resources,
        models,
        () => 2100,
        () => 'rejected-template'
      );
      let dispatched = false;
      const dispatch = async () => {
        dispatched = true;
        throw new Error('UNEXPECTED_DISPATCH');
      };
      const work =
        operation === 'create'
          ? templates.create(1, { ...input, name: 'Rejected' }, inspect)
          : operation === 'update'
            ? templates.update(
                1,
                'admission-template',
                { ...input, name: 'Rejected', draftRevision: 1 },
                inspect
              )
            : templates.publish(
                1,
                'admission-template',
                {
                  templateId: 'admission-template',
                  draftRevision: 1,
                  requestId: 'rejected-request'
                },
                dispatch
              );
      const settled = work.then(
        () => undefined,
        (error: unknown) => error
      );
      try {
        await Promise.race([
          entered.promise,
          settled.then(() => {
            throw new Error('ADMISSION_GATE_NOT_REACHED');
          })
        ]);
        await database.raw.execute('UPDATE users SET enabled=FALSE WHERE id=1');
      } finally {
        release.resolve();
      }
      expect(await settled).toMatchObject({ message: 'ADMIN_REQUIRED' });
      const [rows] = await database.raw.query<RowDataPacket[]>(
        "SELECT id,name,draft_revision FROM conversation_templates WHERE id IN ('admission-template','rejected-template')"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'admission-template',
        name: 'Admission',
        draft_revision: 1
      });
      const [jobs] = await database.raw.query<RowDataPacket[]>(
        "SELECT id FROM conversation_template_publish_jobs WHERE id='rejected-request'"
      );
      expect(jobs).toHaveLength(0);
      expect(dispatched).toBe(false);
    });
  });
}

async function state(database: MysqlServerDatabase) {
  const [jobs] = await database.raw.query<RowDataPacket[]>(
    'SELECT status,stage,version_id,error_code,draft_revision,created_at FROM conversation_template_publish_jobs WHERE id=?',
    [queued.id]
  );
  const [versions] = await database.raw.query<RowDataPacket[]>(
    'SELECT * FROM conversation_template_versions'
  );
  const [templates] = await database.raw.query<RowDataPacket[]>(
    'SELECT current_version_id FROM conversation_templates'
  );
  const [audits] = await database.raw.query<RowDataPacket[]>(
    "SELECT metadata FROM audit_events WHERE event_type='conversation_template.published'"
  );
  return { job: jobs[0], versions, template: templates[0], audits };
}

async function waitForParentLock(database: MysqlServerDatabase, blocker: number, waiter: number) {
  expect(waiter).not.toBe(blocker);
  // Own connections are observable without granting performance_schema/PROCESS access.
  await expect
    .poll(
      async () => {
        const [rows] = await database.raw.query<RowDataPacket[]>('SHOW FULL PROCESSLIST');
        return rows.some(
          (row) =>
            Number(row['Id']) === waiter &&
            String(row['Info']).includes('FROM conversation_templates template') &&
            String(row['Info']).includes('FOR UPDATE')
        );
      },
      { timeout: 5000 }
    )
    .toBe(true);
  const probe = await database.raw.getConnection();
  try {
    await probe.beginTransaction();
    await expect(
      probe.query("SELECT id FROM conversation_templates WHERE id='template-1' FOR UPDATE NOWAIT")
    ).rejects.toMatchObject({ code: 'ER_LOCK_NOWAIT' });
  } finally {
    await probe.rollback();
    probe.release();
  }
  await test.info().attach('mysql-lock-wait', {
    body: JSON.stringify({
      blocker,
      waiter,
      observedQuery: true,
      exclusiveLockProbe: 'ER_LOCK_NOWAIT'
    }),
    contentType: 'application/json'
  });
}

test('Template refresh keeps a committed failure when stale RUNNING waits on another MySQL connection', async () => {
  test.setTimeout(60_000);
  await withDatabase(async (database) => {
    const releaseRefresh = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    let refreshing = false;
    let blocker = 0;
    let waiter = 0;
    const store = observedStore(database, {
      before: async (connection, sql) => {
        if (
          blocker &&
          sql.includes('FROM conversation_templates template') &&
          sql.includes('FOR UPDATE')
        )
          waiter = connection.threadId;
      },
      after: async (connection, sql, values) => {
        if (sql.includes('UPDATE conversation_template_publish_jobs') && values[1] === 'FAILED') {
          blocker = connection.threadId;
          await releaseCommit.promise;
        }
      }
    });
    const templates = service(store);
    const late = templates.publishStatus(1, queued.templateId, queued.id, async () => {
      refreshing = true;
      await releaseRefresh.promise;
      return { job: running };
    });
    const pending: Promise<unknown>[] = [late];
    try {
      await expect.poll(() => refreshing).toBe(true);
      const failure = templates.publishStatus(1, queued.templateId, queued.id, async () => ({
        job: failed
      }));
      pending.push(failure);
      await expect.poll(() => blocker).toBeGreaterThan(0);
      releaseRefresh.resolve();
      await expect.poll(() => waiter).toBeGreaterThan(0);
      await waitForParentLock(database, blocker, waiter);
      releaseCommit.resolve();
      expect(await failure).toEqual(failed);
      expect(await late).toEqual(failed);
      expect(await state(database)).toMatchObject({
        job: { status: 'FAILED', error_code: 'PUBLISH_FAILED' },
        versions: [],
        template: { current_version_id: null },
        audits: []
      });
      await expect(
        templates.publishStatus(1, queued.templateId, queued.id, async () => {
          throw new Error('TERMINAL_REFRESH_MUST_NOT_RUN');
        })
      ).resolves.toEqual(failed);
    } finally {
      releaseRefresh.resolve();
      releaseCommit.resolve();
      await Promise.allSettled(pending);
    }
  });
});

test('Concurrent successful template refreshes serialize without lock upgrades and register one version and audit', async () => {
  test.setTimeout(60_000);
  await withDatabase(async (database) => {
    const plain = service(database);
    await expect(
      plain.publishStatus(1, queued.templateId, queued.id, async () => ({ job: queued }))
    ).resolves.toEqual(queued);
    await expect(
      plain.publishStatus(1, queued.templateId, queued.id, async () => ({ job: running }))
    ).resolves.toEqual(running);
    const release = Promise.withResolvers<void>();
    let blocker = 0;
    let waiter = 0;
    const templates = service(
      observedStore(database, {
        before: async (connection, sql) => {
          if (
            blocker &&
            sql.includes('FROM conversation_templates template') &&
            sql.includes('FOR UPDATE')
          )
            waiter = connection.threadId;
        },
        after: async (connection, sql) => {
          if (
            !blocker &&
            sql.includes('FROM conversation_templates template') &&
            sql.includes('FOR UPDATE')
          ) {
            blocker = connection.threadId;
            await release.promise;
          }
        }
      })
    );
    const first = templates.publishStatus(1, queued.templateId, queued.id, async () => ({
      job: succeeded,
      version
    }));
    const pending: Promise<unknown>[] = [first];
    try {
      await expect.poll(() => blocker).toBeGreaterThan(0);
      const second = templates.publishStatus(1, queued.templateId, queued.id, async () => ({
        job: succeeded,
        version
      }));
      pending.push(second);
      await expect.poll(() => waiter).toBeGreaterThan(0);
      await waitForParentLock(database, blocker, waiter);
      release.resolve();
      expect(await first).toEqual(succeeded);
      expect(await second).toEqual(succeeded);
      await expect.poll(async () => (await state(database)).audits.length).toBe(1);
      const stored = await state(database);
      expect(stored).toMatchObject({
        job: { status: 'SUCCEEDED', version_id: version.id, draft_revision: 1, created_at: 2000 },
        template: { current_version_id: version.id }
      });
      expect(stored.versions).toHaveLength(1);
      expect(stored.versions[0]).toMatchObject({
        draft_revision: 1,
        version_number: 1,
        published_by_user_id: 1
      });
      const metadata: unknown = stored.audits[0]?.['metadata'];
      expect(typeof metadata === 'string' ? JSON.parse(metadata) : metadata).toMatchObject({
        revision: 1,
        jobId: queued.id,
        versionId: version.id
      });
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });
});

test('A failed template publish commit rolls back the version, current pointer, job and deferred audit', async () => {
  test.setTimeout(60_000);
  await withDatabase(async (database) => {
    const templates = service(
      observedStore(database, {
        beforeCommit: async () => {
          // An independent connection must still see only committed state.
          expect(await state(database)).toMatchObject({
            job: { status: 'QUEUED' },
            versions: [],
            template: { current_version_id: null },
            audits: []
          });
          throw new Error('SIMULATED_COMMIT_FAILURE');
        }
      })
    );
    await expect(
      templates.publishStatus(1, queued.templateId, queued.id, async () => ({
        job: succeeded,
        version
      }))
    ).rejects.toThrow('SIMULATED_COMMIT_FAILURE');
    expect(await state(database)).toMatchObject({
      job: { status: 'QUEUED' },
      versions: [],
      template: { current_version_id: null },
      audits: []
    });
    await expect(
      service(database).publishStatus(1, queued.templateId, queued.id, async () => ({
        job: succeeded,
        version
      }))
    ).resolves.toEqual(succeeded);
    await expect.poll(async () => (await state(database)).audits.length).toBe(1);
    expect((await state(database)).versions).toHaveLength(1);
  });
});
