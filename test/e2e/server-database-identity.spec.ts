import { expect, test } from '@playwright/test';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import {
  CORE_MYSQL_MIGRATIONS,
  CORE_MYSQL_SCHEMA,
  CORE_MYSQL_SCHEMA_V17,
  validateCoreMysqlDatabase
} from '../../packages/server-core/src/mysql-schema.js';
import { runServerMysqlMigrations } from '../../packages/server-core/src/mysql-migrations.js';
import {
  mysqlSchemaWithoutForeignKeys,
  validateMysqlSchema
} from '../../packages/server-core/src/mysql-schema-support.js';
import { prepareMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import {
  ENTERPRISE_MYSQL_MIGRATIONS,
  ENTERPRISE_MYSQL_SCHEMA_V6,
  validateEnterpriseMysqlDatabase
} from '../../ee/server/src/mysql/enterprise-migrations.js';
import { OrganizationService } from '../../ee/server/src/rbac/organization-service.js';
import { lockOrganizationReference } from '../../ee/server/src/rbac/organization-reference.js';
import type { AuthorizationProvider } from '../../ee/server/src/product/product-policy.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

async function withDatabase(
  suffix: string,
  run: (pool: mysql.Pool, databaseUrl: string) => Promise<void>
) {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-${suffix}-${randomUUID()}`);
  await createPlaywrightTestDatabase(target);
  const pool = mysql.createPool(target.databaseUrl);
  try {
    await run(pool, target.databaseUrl);
  } finally {
    await pool.end();
    await dropPlaywrightTestDatabase(target);
  }
}

const personalPlan = {
  edition: 'personal' as const,
  core: CORE_MYSQL_MIGRATIONS,
  validate: validateCoreMysqlDatabase
};

for (const reference of ['valid', 'owner', 'Node', 'Workspace', 'Workspace on another Node']) {
  test(`Enterprise startup validates Session share ${reference} references without changing share data`, async () => {
    await withDatabase(`share-${reference}`, async (pool) => {
      await prepareMysqlDatabase(pool);
      await pool.execute(
        "INSERT INTO users(id,username,created_at,updated_at) VALUES (42,'share-owner',1,1)"
      );
      await pool.execute(`INSERT INTO nodes
        (id,owner_type,owner_user_id,registered_address,metadata,created_at,updated_at)
        VALUES ('share-node','PERSONAL',42,'test','{}',1,1),
               ('other-node','PERSONAL',42,'test','{}',1,1)`);
      await pool.execute(`INSERT INTO workspaces
        (workspace_id,display_name,node_id,owner_type,owner_user_id,registered_at)
        VALUES ('share-workspace','Share','share-node','PERSONAL',42,1),
               ('other-workspace','Other','other-node','PERSONAL',42,1)`);
      await pool.execute(
        `INSERT INTO session_shares
        (id,user_id,node_id,workspace_id,session_id,password_hash,access_credential,created_at)
        VALUES (?,?,?,?,?,'fixture-hash','fixture-credential',1)`,
        [
          randomUUID(),
          reference === 'owner' ? 43 : 42,
          reference === 'Node' ? 'missing-node' : 'share-node',
          reference === 'Workspace'
            ? 'missing-workspace'
            : reference === 'Workspace on another Node'
              ? 'other-workspace'
              : 'share-workspace',
          'node-owned-session'
        ]
      );
      const [before] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM session_shares');
      expect(before).toHaveLength(1);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (reference === 'valid') {
          await expect(prepareMysqlDatabase(pool)).resolves.toBeUndefined();
        } else {
          await expect(prepareMysqlDatabase(pool)).rejects.toThrow(
            'SERVER_DATABASE_REFERENCE_INVALID'
          );
        }
        const [after] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM session_shares');
        expect(after).toEqual(before);
      }
    });
  });
}

test('Organization deletion waits for referencing transactions, rejects new-member deletion, and lets the enterprise transaction clean up cascades', async () => {
  await withDatabase('organization-integrity', async (pool) => {
    await prepareMysqlDatabase(pool);
    const database = new MysqlServerDatabase(pool);
    await database.initialize();
    await pool.query(
      "INSERT INTO organizations(id,name,parent_organization_id,created_at,updated_at) VALUES (2,'Child',1,1,1)"
    );
    const service = new OrganizationService(database, {
      authorize: async () => ({ allowed: true })
    } as unknown as AuthorizationProvider);
    const writer = await pool.getConnection();
    let deletion: Promise<{ error?: unknown }> | undefined;
    try {
      await writer.beginTransaction();
      await lockOrganizationReference(writer, 2);
      deletion = service.remove(1, 2).then(
        () => ({}),
        (error: unknown) => ({ error })
      );
      await writer.query(
        "INSERT INTO users(id,username,role,organization_id,created_at,updated_at) VALUES (2,'member','MEMBER',2,1,1)"
      );
      await writer.commit();
      expect((await deletion).error).toMatchObject({ message: 'ORGANIZATION_NOT_EMPTY' });
    } finally {
      await writer.rollback();
      writer.release();
      await deletion;
    }
    await pool.query('DELETE FROM users WHERE id=2');
    await pool.query(`INSERT INTO environment_secrets
      (id,name,secret_value,scope,owner_user_id,organization_id,visibility,node_id,owner_key,created_at,updated_at)
      VALUES ('org-secret','EXAMPLE','fixture-only','ORGANIZATION',NULL,2,'PRIVATE',NULL,'ORGANIZATION:2',1,1)`);
    await pool.query(`INSERT INTO skill_sources
      (id,kind,scope,owner_organization_id,owner_user_id,name,locator,enabled,built_in,status,last_error_code,created_by_user_id,created_at,updated_at,owner_key)
      VALUES ('org-source','REPOSITORY','ORGANIZATION',2,NULL,'Org source','https://example.invalid/repo',TRUE,FALSE,'READY',NULL,1,1,1,'ORGANIZATION:2:')`);
    await pool.query(`INSERT INTO skill_favorites
      (id,source_id,scope,owner_organization_id,owner_user_id,repository_url,repository_identity,skill_path,normalized_name,current_version_id,created_by_user_id,created_at,updated_at,owner_key)
      VALUES ('org-favorite','org-source','ORGANIZATION',2,NULL,'https://example.invalid/repo','example/repo','skill','skill',NULL,1,1,1,'ORGANIZATION:2:')`);
    await pool.query(`INSERT INTO mar_agent_models
      (id,name,normalized_name,protocol,base_url,credential,model_id,context_window_tokens,max_output_tokens,
       input_capabilities,output_capabilities,reasoning_efforts,default_reasoning_effort,owner_type,owner_user_id,owner_organization_id,created_by,created_at,updated_at)
      VALUES ('org-model','Org model','org model','OPENAI_RESPONSES','https://example.invalid',JSON_OBJECT('type','INLINE_API_KEY','value','fixture-key'),'test',1000,100,
       JSON_ARRAY('TEXT'),JSON_ARRAY('TEXT'),JSON_ARRAY('medium'),'medium','ORGANIZATION',NULL,2,1,1,1),
       ('unrelated-model','Other model','other model','OPENAI_RESPONSES','https://example.invalid',JSON_OBJECT('type','INLINE_API_KEY','value','fixture-key'),'test',1000,100,
       JSON_ARRAY('TEXT'),JSON_ARRAY('TEXT'),JSON_ARRAY('medium'),'medium','PERSONAL',1,NULL,1,1,1)`);
    await pool.query(`INSERT INTO system_settings(setting_key,setting_value,updated_at) VALUES
      ('mar_agent_model_config:org-model',JSON_OBJECT('version',1,'hostedWebSearch',FALSE,'responsesPreviousResponseId',FALSE),1),
      ('mar_agent_resource_input:model:org-model',JSON_OBJECT('useResourceUrl',TRUE),1),
      ('mar_agent_model_config:unrelated-model',JSON_OBJECT('version',1,'hostedWebSearch',FALSE,'responsesPreviousResponseId',FALSE),1)`);
    await service.remove(1, 2);
    const [settingsAfterOrganizationDeletion] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT setting_key FROM system_settings WHERE setting_key IN ('mar_agent_model_config:org-model','mar_agent_resource_input:model:org-model','mar_agent_model_config:unrelated-model') ORDER BY setting_key"
    );
    expect(settingsAfterOrganizationDeletion).toEqual([
      { setting_key: 'mar_agent_model_config:unrelated-model' }
    ]);
    await validateEnterpriseMysqlDatabase(pool);
    for (const table of ['environment_secrets', 'skill_favorites', 'skill_sources']) {
      const column = table === 'environment_secrets' ? 'organization_id' : 'owner_organization_id';
      const [rows] = await pool.query(`SELECT id FROM ${table} WHERE ${column}=2`);
      expect(rows).toEqual([]);
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await expect(lockOrganizationReference(connection, 2)).rejects.toThrow(
        'ORGANIZATION_NOT_FOUND'
      );
    } finally {
      await connection.rollback();
      connection.release();
    }
  });
});

test('Core v19 removes the dense column, resumes after an interrupted DDL, and preserves model data and Core startup invariants', async () => {
  await withDatabase('high-density-removal', async (pool) => {
    await runServerMysqlMigrations(pool, {
      edition: 'personal',
      core: CORE_MYSQL_MIGRATIONS.filter(({ version }) => version < 19),
      validate: (connection) =>
        validateMysqlSchema(connection, mysqlSchemaWithoutForeignKeys(CORE_MYSQL_SCHEMA_V17))
    });
    await pool.query(
      "INSERT INTO users(id,username,role,created_at,updated_at) VALUES (77,'model-owner','MEMBER',1,1)"
    );
    await pool.query(`INSERT INTO mar_agent_models
      (id,name,normalized_name,protocol,base_url,credential,model_id,context_window_tokens,max_output_tokens,
       input_capabilities,output_capabilities,reasoning_efforts,default_reasoning_effort,high_density_compaction,
       owner_type,owner_user_id,created_by,created_at,updated_at)
      VALUES ('preserved-model','Preserved model','preserved model','OPENAI_RESPONSES','https://example.invalid',JSON_OBJECT('type','INLINE_API_KEY','value','fixture-key'),
       'test',1000,100,JSON_ARRAY('TEXT'),JSON_ARRAY('TEXT'),JSON_ARRAY('medium'),'medium',1,'PERSONAL',77,77,1,1)`);
    const [before] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM mar_agent_models');
    const {
      high_density_compaction: removed,
      fast_mode: oldFastMode,
      service_tier: oldServiceTier,
      hosted_web_search: oldHostedWebSearch,
      responses_transport: oldTransport,
      responses_previous_response_id: oldPreviousResponseId,
      ...preserved
    } = before[0]!;
    const upgraded = { ...preserved, conversation_model: 1, subagent_model: 0 };
    expect(removed).toBe(1);
    expect([
      oldFastMode,
      oldServiceTier,
      oldHostedWebSearch,
      oldTransport,
      oldPreviousResponseId
    ]).toEqual([0, null, 0, null, 0]);
    const [history] = await pool.query(
      "SELECT * FROM schema_migrations WHERE namespace='core' ORDER BY version"
    );
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 19)!;
    await expect(
      runServerMysqlMigrations(pool, {
        ...personalPlan,
        core: CORE_MYSQL_MIGRATIONS.map((entry) =>
          entry.version === 19
            ? {
                ...entry,
                up: async (connection) => {
                  await migration.up(connection);
                  throw new Error('SIMULATED_AFTER_COLUMN_DROP');
                }
              }
            : entry
        )
      })
    ).rejects.toThrow('SIMULATED_AFTER_COLUMN_DROP');
    const [columns] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mar_agent_models' AND COLUMN_NAME='high_density_compaction'"
    );
    expect(columns).toHaveLength(0);
    const [failed] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT status,checksum FROM schema_migrations WHERE namespace='core' AND version=19"
    );
    expect(failed[0]).toMatchObject({ status: 'FAILED', checksum: migration.checksum });
    await runServerMysqlMigrations(pool, personalPlan);
    await runServerMysqlMigrations(pool, personalPlan);
    const [preservedHistory] = await pool.query(
      "SELECT * FROM schema_migrations WHERE namespace='core' AND version<19 ORDER BY version"
    );
    expect(preservedHistory).toEqual(history);
    const [completed] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT status,checksum FROM schema_migrations WHERE namespace='core' AND version=19"
    );
    expect(completed[0]).toMatchObject({ status: 'COMPLETED', checksum: migration.checksum });
    const [personalModels] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM mar_agent_models'
    );
    expect(personalModels.map((row) => ({ ...row }))).toEqual([upgraded]);
    const [settingsRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT setting_value FROM system_settings WHERE setting_key='mar_agent_model_config:preserved-model'"
    );
    expect(settingsRows).toHaveLength(1);
    const settingValue: unknown = settingsRows[0]!['setting_value'];
    expect(typeof settingValue === 'string' ? JSON.parse(settingValue) : settingValue).toEqual({
      version: 1,
      hostedWebSearch: false,
      responsesPreviousResponseId: false
    });
    await prepareMysqlDatabase(pool);
    await prepareMysqlDatabase(pool);
    const [enterpriseModels] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM mar_agent_models'
    );
    expect(enterpriseModels.map((row) => ({ ...row }))).toEqual([upgraded]);
    await validateMysqlSchema(pool, { mar_agent_models: CORE_MYSQL_SCHEMA.mar_agent_models! });
  });
});

test('Core-only schema expansion preserves shared data and the ledger while rejecting a downgrade to the legacy Core layout', async () => {
  await withDatabase('identity-upgrade', async (pool) => {
    await runServerMysqlMigrations(pool, personalPlan);
    const [tables] = await pool.query<mysql.RowDataPacket[]>('SHOW TABLES');
    expect(tables).toHaveLength(Object.keys(CORE_MYSQL_SCHEMA).length + 1);
    const [columns] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mar_agent_models' AND COLUMN_NAME='high_density_compaction'"
    );
    expect(columns).toHaveLength(0);
    await pool.query(
      "INSERT INTO system_settings VALUES ('identity-fixture',JSON_OBJECT('marker','preserved'),1)"
    );
    const [before] = await pool.query("SELECT * FROM schema_migrations WHERE namespace='core'");
    await prepareMysqlDatabase(pool);
    await prepareMysqlDatabase(pool);
    const [after] = await pool.query("SELECT * FROM schema_migrations WHERE namespace='core'");
    expect(after).toEqual(before);
    const [data] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT setting_value FROM system_settings WHERE setting_key='identity-fixture'"
    );
    expect(data[0]?.['setting_value']).toEqual({ marker: 'preserved' });
    await expect(runServerMysqlMigrations(pool, personalPlan)).rejects.toThrow(
      'SERVER_DATABASE_EDITION_MISMATCH'
    );
    const [ledgerBefore] = await pool.query(
      'SELECT * FROM schema_migrations ORDER BY namespace,version'
    );
    await pool.query(
      `UPDATE schema_migrations SET version=99 WHERE namespace='enterprise' AND version=${ENTERPRISE_MYSQL_MIGRATIONS.at(-1)!.version}`
    );
    await expect(prepareMysqlDatabase(pool)).rejects.toThrow(
      'SERVER_DATABASE_MIGRATION_VERSION_UNSUPPORTED'
    );
    await pool.query(
      `UPDATE schema_migrations SET version=${ENTERPRISE_MYSQL_MIGRATIONS.at(-1)!.version} WHERE namespace='enterprise' AND version=99`
    );
    const [ledgerAfter] = await pool.query(
      'SELECT * FROM schema_migrations ORDER BY namespace,version'
    );
    expect(ledgerAfter).toEqual(ledgerBefore);
  });
});

test('Legacy monolithic ledgers are rejected without rewriting the database', async () => {
  await withDatabase('identity-legacy-ledger', async (pool) => {
    await pool.query(`CREATE TABLE schema_migrations (
      version INT NOT NULL PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      checksum CHAR(64) NOT NULL,
      status ENUM('STARTED','COMPLETED','FAILED') NOT NULL,
      started_at BIGINT NOT NULL,
      completed_at BIGINT NULL,
      error_summary VARCHAR(512) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await pool.query('CREATE TABLE users (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await pool.query('INSERT INTO users(id) VALUES (7)');
    await pool.query(`INSERT INTO schema_migrations
      (version,name,checksum,status,started_at,completed_at,error_summary)
      VALUES (49,'legacy_final',REPEAT('a',64),'COMPLETED',1,1,NULL)`);

    const [tablesBefore] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME'
    );
    const [historyBefore] = await pool.query('SELECT * FROM schema_migrations');
    const [usersBefore] = await pool.query('SELECT * FROM users');

    await expect(prepareMysqlDatabase(pool)).rejects.toThrow('SERVER_DATABASE_LEDGER_UNSUPPORTED');

    const [tablesAfter] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME'
    );
    const [historyAfter] = await pool.query('SELECT * FROM schema_migrations');
    const [usersAfter] = await pool.query('SELECT * FROM users');
    expect(tablesAfter).toEqual(tablesBefore);
    expect(historyAfter).toEqual(historyBefore);
    expect(usersAfter).toEqual(usersBefore);
  });
});

test('A failed namespace migration resumes with the same checksum without writing the raw error to the ledger', async () => {
  await withDatabase('identity-retry', async (pool, databaseUrl) => {
    await prepareMysqlDatabase(pool);
    let fail = true;
    const migration = {
      version: CORE_MYSQL_MIGRATIONS.at(-1)!.version + 1,
      name: 'core_retry_fixture',
      checksum: 'f'.repeat(64),
      up: async (
        connection: Parameters<Parameters<typeof runServerMysqlMigrations>[1]['validate']>[0]
      ) => {
        await connection.query(
          "INSERT INTO system_settings VALUES ('retry-fixture',JSON_OBJECT('marker','preserved'),1) ON DUPLICATE KEY UPDATE setting_key=setting_key"
        );
        if (fail) throw new Error('PRIVATE_FIXTURE_VALUE');
      }
    };
    const plan = {
      edition: 'enterprise' as const,
      core: [...CORE_MYSQL_MIGRATIONS, migration],
      enterprise: ENTERPRISE_MYSQL_MIGRATIONS,
      validate: validateEnterpriseMysqlDatabase
    };
    await expect(runServerMysqlMigrations(pool, plan)).rejects.toThrow('PRIVATE_FIXTURE_VALUE');
    const [failed] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT status,error_summary FROM schema_migrations WHERE namespace='core' AND version=${migration.version}`
    );
    expect(failed[0]).toMatchObject({
      status: 'FAILED',
      error_summary: 'SERVER_DATABASE_MIGRATION_STEP_FAILED'
    });
    fail = false;
    await runServerMysqlMigrations(pool, plan);
    await expect(prepareMysqlDatabase(pool)).rejects.toThrow(
      'SERVER_DATABASE_MIGRATION_VERSION_UNSUPPORTED'
    );
    const lockProbe = await mysql.createConnection(databaseUrl);
    try {
      const [locks] = await lockProbe.query<mysql.RowDataPacket[]>(
        "SELECT GET_LOCK('myagentroam:server:migrations', 30) AS available"
      );
      expect(Number(locks[0]?.['available'])).toBe(1);
    } finally {
      await lockProbe.query("SELECT RELEASE_LOCK('myagentroam:server:migrations')");
      await lockProbe.end();
    }
  });
});

test('Removing MySQL foreign keys preserves data and history, and a partial DDL failure resumes from the original checksum', async () => {
  await withDatabase('explicit-references', async (pool) => {
    const oldPlan = {
      edition: 'enterprise' as const,
      core: CORE_MYSQL_MIGRATIONS.filter(({ version }) => version < 18),
      enterprise: ENTERPRISE_MYSQL_MIGRATIONS.filter(({ version }) => version < 7),
      validate: async (connection: Parameters<typeof validateMysqlSchema>[0]) => {
        await validateMysqlSchema(connection, CORE_MYSQL_SCHEMA_V17);
        await validateMysqlSchema(connection, ENTERPRISE_MYSQL_SCHEMA_V6);
      }
    };
    await runServerMysqlMigrations(pool, oldPlan);
    await pool.query(
      "INSERT INTO users(id,username,role,created_at,updated_at) VALUES (77,'retained','MEMBER',1,1),(78,'other-owner','MEMBER',1,1)"
    );
    await pool.query(`INSERT INTO mar_agent_models
      (id,name,normalized_name,protocol,base_url,credential,model_id,context_window_tokens,max_output_tokens,
       input_capabilities,output_capabilities,reasoning_efforts,default_reasoning_effort,owner_type,owner_user_id,created_by,created_at,updated_at)
      VALUES ('personal-model','Retained model','retained model','OPENAI_RESPONSES','https://example.invalid',JSON_OBJECT('type','INLINE_API_KEY','value','fixture-key'),'test',1000,100,
       JSON_ARRAY('TEXT'),JSON_ARRAY('TEXT'),JSON_ARRAY('medium'),'medium','PERSONAL',77,77,1,1)`);
    await pool.query(
      "INSERT INTO mar_agent_image_models(id,name,normalized_name,owner_type,owner_user_id,provider,config,created_by,created_at,updated_at) VALUES ('personal-image','Retained image','retained image','PERSONAL',77,'CODEX',JSON_OBJECT(),77,1,1)"
    );
    await pool.query(
      "INSERT INTO user_mar_agent_model_orders(user_id,model_id,sort_order,updated_at) VALUES (78,'personal-model',0,1)"
    );
    await pool.query(
      "INSERT INTO user_mar_agent_image_model_orders(user_id,image_model_id,sort_order,updated_at) VALUES (78,'personal-image',0,1)"
    );
    await pool.query(`INSERT INTO skill_sources
      (id,kind,scope,owner_user_id,name,locator,created_by_user_id,created_at,updated_at,owner_key)
      VALUES ('personal-source','REPOSITORY','PERSONAL',77,'Retained source','https://example.invalid/skills',77,1,1,'PERSONAL:77:')`);
    await pool.query(`INSERT INTO skill_favorites
      (id,source_id,scope,owner_user_id,repository_url,repository_identity,skill_path,normalized_name,created_by_user_id,created_at,updated_at,owner_key)
      VALUES ('personal-favorite','personal-source','PERSONAL',77,'https://example.invalid/skills','example/skills','skill','retained skill',77,1,1,'PERSONAL:77:')`);
    await pool.query(`INSERT INTO skill_versions
      (id,favorite_id,commit_sha,content_hash,archive_hash,cache_key,file_count,content_bytes,metadata,tls_verified,cache_state,created_at)
      VALUES ('personal-version','personal-favorite',REPEAT('a',40),REPEAT('b',64),REPEAT('c',64),'test-cache',1,1,JSON_OBJECT(),1,'READY',1)`);
    await pool.query(
      "INSERT INTO user_quick_prompts(id,user_id,phrase,prompt,created_at,updated_at) VALUES ('retained',77,'review','Preserve this data',1,1)"
    );
    const [before] = await pool.query(
      'SELECT namespace,version,name,checksum FROM schema_migrations ORDER BY namespace,version'
    );
    let drops = 0;
    const failingPool = {
      getConnection: async () => {
        const connection = await pool.getConnection();
        return {
          query: async (sql: string) => {
            if (sql.startsWith('ALTER TABLE') && sql.includes('DROP FOREIGN KEY') && ++drops === 2)
              throw new Error('DDL_FIXTURE_FAILED');
            return connection.query(sql);
          },
          execute: connection.execute.bind(connection),
          release: connection.release.bind(connection)
        };
      }
    };
    const plan = {
      edition: 'enterprise' as const,
      core: CORE_MYSQL_MIGRATIONS,
      enterprise: ENTERPRISE_MYSQL_MIGRATIONS,
      validate: validateEnterpriseMysqlDatabase
    };
    await expect(runServerMysqlMigrations(failingPool, plan)).rejects.toThrow('DDL_FIXTURE_FAILED');
    const [failed] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT status,checksum FROM schema_migrations WHERE namespace='core' AND version=18"
    );
    const migration18 = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 18)!;
    expect(failed[0]).toMatchObject({
      status: 'FAILED',
      checksum: migration18.checksum
    });
    await prepareMysqlDatabase(pool);
    await prepareMysqlDatabase(pool);
    const [keys] = await pool.query(
      "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='FOREIGN KEY'"
    );
    expect(keys).toEqual([]);
    const [after] = await pool.query(
      "SELECT namespace,version,name,checksum FROM schema_migrations WHERE (namespace='core' AND version<18) OR (namespace='enterprise' AND version<7) ORDER BY namespace,version"
    );
    expect(after).toEqual(before);
    const [prompts] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT user_id,prompt FROM user_quick_prompts WHERE id=?',
      ['retained']
    );
    expect(prompts).toEqual([{ user_id: 77, prompt: 'Preserve this data' }]);
    const database = new MysqlServerDatabase(pool);
    const token = await database.createNodeRegistrationToken(77, 60_000);
    const node = await database.registerNode(token.token, { metadata: '{}' });
    expect(node).toBeDefined();
    await pool.query(
      "INSERT INTO workspaces(workspace_id,display_name,node_id,owner_type,owner_user_id,registered_at) VALUES ('personal-workspace','Retained Workspace',?,'PERSONAL',77,1)",
      [node!.nodeId]
    );
    await pool.query(
      `INSERT INTO environment_secrets(id,name,secret_value,scope,node_id,workspace_id,created_at,updated_at,owner_key)
      VALUES ('workspace-secret','TEST_VALUE','fixture','WORKSPACE',?,'personal-workspace',1,1,'WORKSPACE:personal-workspace:')`,
      [node!.nodeId]
    );
    await pool.query(
      `INSERT INTO conversation_templates
      (id,source_node_id,source_workspace_id,name,normalized_name,description,draft_revision,draft_config,created_by_user_id,updated_by_user_id,created_at,updated_at)
      VALUES ('protected-template',?,'personal-workspace','Protected template','protected template','',1,JSON_OBJECT(),77,77,1,1)`,
      [node!.nodeId]
    );
    await expect(database.deleteNode(node!.nodeId)).rejects.toThrow('NODE_IN_USE');
    await expect(database.deleteUser(77)).rejects.toThrow('USER_IN_USE');
    await pool.query("DELETE FROM conversation_templates WHERE id='protected-template'");
    const [settingsBeforeDeletion] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT setting_key FROM system_settings WHERE setting_key='mar_agent_model_config:personal-model'"
    );
    expect(settingsBeforeDeletion).toHaveLength(1);
    await database.deleteUser(77);
    const [settingsAfterDeletion] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT setting_key FROM system_settings WHERE setting_key='mar_agent_model_config:personal-model'"
    );
    expect(settingsAfterDeletion).toEqual([]);
    for (const [table, column, id] of [
      ['mar_agent_models', 'id', 'personal-model'],
      ['mar_agent_image_models', 'id', 'personal-image'],
      ['user_mar_agent_model_orders', 'model_id', 'personal-model'],
      ['user_mar_agent_image_model_orders', 'image_model_id', 'personal-image'],
      ['skill_sources', 'id', 'personal-source'],
      ['skill_favorites', 'id', 'personal-favorite'],
      ['skill_versions', 'id', 'personal-version'],
      ['environment_secrets', 'id', 'workspace-secret'],
      ['workspaces', 'workspace_id', 'personal-workspace']
    ] as const) {
      const [rows] = await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=?`, [id]);
      expect(rows, table).toEqual([]);
    }
    await expect(database.createNodeRegistrationToken(77, 60_000)).rejects.toThrow(
      'USER_NOT_FOUND'
    );
    const [remaining] = await pool.query('SELECT id FROM user_quick_prompts WHERE user_id=77');
    expect(remaining).toEqual([]);
    const [nodes] = await pool.query('SELECT id FROM nodes WHERE owner_user_id=77');
    expect(nodes).toEqual([]);
    const connection = await pool.getConnection();
    try {
      await validateEnterpriseMysqlDatabase(connection);
    } finally {
      connection.release();
    }
  });
});
