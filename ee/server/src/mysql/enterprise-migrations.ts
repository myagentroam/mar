import { createHash } from 'node:crypto';
import {
  CORE_MYSQL_SCHEMA,
  CORE_MYSQL_SCHEMA_V9,
  CORE_MYSQL_SCHEMA_V17,
  validateMysqlSessionShareReferences
} from '@myagentroam/server-core/mysql-schema';
import { projectCredentialDocument } from '@myagentroam/server-core/credential-document';
import {
  createMysqlBaselineMigration,
  validateMysqlSchema,
  mysqlSchemaWithoutForeignKeys,
  removeMysqlForeignKeys,
  validateMysqlReferences,
  assertMysqlNoForeignKeys,
  type MysqlSchema
} from '@myagentroam/server-core/mysql-schema-support';
import type { MysqlMigrationConnection } from '@myagentroam/server-core/mysql-migration-contracts';
import schema from './enterprise-schema-v1.json' with { type: 'json' };
import organizationReferences from './core-organization-references.json' with { type: 'json' };
import { initializeRootIdentity } from './community-root.js';

const managedNodeSchema: MysqlSchema = {
  server_managed_nodes: `CREATE TABLE \`server_managed_nodes\` (
  \`singleton_id\` tinyint unsigned NOT NULL,
  \`node_id\` varchar(64) NOT NULL,
  \`registration_token_hash\` varchar(128) DEFAULT NULL,
  \`state\` enum('PENDING','REGISTERED','REVOKED','DELETED') NOT NULL,
  \`created_at\` bigint NOT NULL,
  \`updated_at\` bigint NOT NULL,
  PRIMARY KEY (\`singleton_id\`),
  UNIQUE KEY \`server_managed_node_id\` (\`node_id\`),
  UNIQUE KEY \`server_managed_token\` (\`registration_token_hash\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
};

export const ENTERPRISE_MYSQL_SCHEMA_V4: MysqlSchema = Object.fromEntries(
  Object.entries(schema).filter(([name]) => !(name in CORE_MYSQL_SCHEMA))
);
const resourceGrantV6 = ENTERPRISE_MYSQL_SCHEMA_V4.resource_grants!.replace(
  "enum('USER','ORGANIZATION','ENTERPRISE')",
  "enum('USER','ORGANIZATION')"
)
  .replace("  `grant_authority` enum('ENTERPRISE','ORG_SUBTREE') NOT NULL,\n", '')
  .replace(
    '`grant_scope_organization_id` bigint unsigned DEFAULT NULL',
    '`grant_scope_organization_id` bigint unsigned NOT NULL'
  );

export const ENTERPRISE_MYSQL_SCHEMA_V6: MysqlSchema = {
  ...ENTERPRISE_MYSQL_SCHEMA_V4,
  resource_grants: resourceGrantV6
};
export const ENTERPRISE_MYSQL_SCHEMA: MysqlSchema = mysqlSchemaWithoutForeignKeys({
  ...ENTERPRISE_MYSQL_SCHEMA_V6
});
export const ENTERPRISE_MYSQL_BASELINE_VERSION = 4;
const dataMigrationName = 'root_organization_scope_data';
const schemaMigrationName = 'root_organization_scope_schema';

export const ENTERPRISE_MYSQL_MIGRATIONS = [
  {
    ...createMysqlBaselineMigration('enterprise_schema_v4', ENTERPRISE_MYSQL_SCHEMA_V4, 9),
    version: ENTERPRISE_MYSQL_BASELINE_VERSION
  },
  {
    version: 5,
    name: dataMigrationName,
    checksum: createHash('sha256').update(`${dataMigrationName}:v1`).digest('hex'),
    minimumCoreVersion: 14,
    up: migrateEnterpriseScopes
  },
  {
    version: 6,
    name: schemaMigrationName,
    checksum: createHash('sha256')
      .update(`${schemaMigrationName}:${resourceGrantV6}`)
      .digest('hex'),
    minimumCoreVersion: 14,
    up: migrateResourceGrantSchema
  },
  {
    version: 7,
    name: 'explicit_enterprise_references',
    checksum: createHash('sha256')
      .update(JSON.stringify(['explicit_enterprise_references:v1', ENTERPRISE_MYSQL_SCHEMA_V6]))
      .digest('hex'),
    minimumCoreVersion: 18,
    up: async (connection: MysqlMigrationConnection) => {
      await removeMysqlForeignKeys(connection, ENTERPRISE_MYSQL_SCHEMA_V6);
    }
  },
  {
    version: 8,
    name: 'community_root_and_server_managed_node',
    checksum: createHash('sha256')
      .update(JSON.stringify(['community_root_and_server_managed_node:v1', managedNodeSchema]))
      .digest('hex'),
    minimumCoreVersion: 19,
    up: async (connection: MysqlMigrationConnection) => {
      await createMysqlBaselineMigration('server_managed_node', managedNodeSchema, 19).up(
        connection
      );
      await connection.query('START TRANSACTION');
      try {
        await initializeRootIdentity(connection, Date.now());
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }
  },
  {
    version: 9,
    name: 'remove_server_managed_node',
    checksum: createHash('sha256').update('remove_server_managed_node:v1').digest('hex'),
    minimumCoreVersion: 19,
    up: removeServerManagedNode
  }
] as const;

async function removeServerManagedNode(connection: MysqlMigrationConnection): Promise<void> {
  const [rows] = (await connection.execute(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='server_managed_nodes'`
  )) as [readonly Record<string, unknown>[], unknown];
  if (rows.length === 0) return;
  await connection.query('START TRANSACTION');
  try {
    const timestamp = Date.now();
    await connection.execute(
      `UPDATE node_credentials c JOIN server_managed_nodes m ON m.node_id=c.node_id
       SET c.revoked_at=COALESCE(c.revoked_at,?)`,
      [timestamp]
    );
    await connection.execute(
      `UPDATE nodes n JOIN server_managed_nodes m ON m.node_id=n.id
       SET n.disabled=TRUE,n.updated_at=?`,
      [timestamp]
    );
    await connection.execute(
      `UPDATE node_registration_tokens t JOIN server_managed_nodes m
         ON m.registration_token_hash=t.token_hash
       SET t.used_at=COALESCE(t.used_at,?)`,
      [timestamp]
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
  await connection.query('DROP TABLE IF EXISTS server_managed_nodes');
}

async function migrateEnterpriseScopes(connection: MysqlMigrationConnection): Promise<void> {
  await connection.query('START TRANSACTION');
  try {
    const [stateRows] = (await connection.execute(
      'SELECT ever_activated FROM license_state WHERE singleton_id=1 FOR UPDATE'
    )) as [readonly Record<string, unknown>[], unknown];
    const activated = Boolean(stateRows[0]?.['ever_activated']);
    const [credentialRows] = (await connection.execute(
      "SELECT setting_value FROM system_settings WHERE setting_key='mar_agent_credentials' FOR UPDATE"
    )) as [readonly Record<string, unknown>[], unknown];
    const credentialRaw = credentialRows[0]?.['setting_value'];
    const [legacyRows] = (await connection.execute(
      `SELECT
         (SELECT COUNT(*) FROM skill_sources WHERE scope='ENTERPRISE' AND built_in=FALSE) +
         (SELECT COUNT(*) FROM skill_favorites WHERE scope='ENTERPRISE') +
         (SELECT COUNT(*) FROM mcp_sources WHERE scope='ENTERPRISE' AND built_in=FALSE) +
         (SELECT COUNT(*) FROM mcp_catalog_entries WHERE scope='ENTERPRISE'
            AND source_id<>'official-mcp-registry') +
         (SELECT COUNT(*) FROM resource_grants
            WHERE target_type='ENTERPRISE' OR grant_scope_organization_id IS NULL) AS legacy_count`
    )) as [readonly Record<string, unknown>[], unknown];
    const hasLegacyData = Number(legacyRows[0]?.['legacy_count'] ?? 0) > 0 || credentialRaw != null;
    let target:
      | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
      | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number }
      | undefined;
    if (activated) {
      const [rootRows] = (await connection.execute(
        'SELECT id FROM organizations WHERE id=1 FOR UPDATE'
      )) as [readonly unknown[], unknown];
      if (rootRows.length !== 1) throw new Error('ROOT_ORGANIZATION_REQUIRED');
      target = { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 };
    } else if (hasLegacyData) {
      const [adminRows] = (await connection.execute(
        "SELECT id FROM users WHERE username='admin' AND is_fixed_admin=TRUE AND enabled=TRUE FOR UPDATE"
      )) as [readonly Record<string, unknown>[], unknown];
      const adminUserId = Number(adminRows[0]?.['id']);
      if (!Number.isSafeInteger(adminUserId)) throw new Error('FIXED_ADMIN_REQUIRED');
      target = { ownerType: 'PERSONAL', ownerUserId: adminUserId };
    }
    if (credentialRaw != null) {
      const projected = projectCredentialDocument(credentialRaw, target, Date.now());
      if (projected.changed)
        await connection.execute(
          "UPDATE system_settings SET setting_value=CAST(? AS JSON),updated_at=? WHERE setting_key='mar_agent_credentials'",
          [JSON.stringify(projected.document), Date.now()]
        );
    }
    if (target !== undefined) await migrateCatalogScopes(connection, target);
    await migrateResourceGrantData(connection);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

async function migrateCatalogScopes(
  connection: MysqlMigrationConnection,
  target:
    | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
    | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number }
): Promise<void> {
  await assertCatalogScopeMigrationSafe(connection, target);
  const scope = target.ownerType;
  const organizationId = target.ownerType === 'ORGANIZATION' ? target.ownerOrganizationId : null;
  const userId = target.ownerType === 'PERSONAL' ? target.ownerUserId : null;
  const ownerKey =
    target.ownerType === 'ORGANIZATION'
      ? `ORGANIZATION:${target.ownerOrganizationId}:`
      : `PERSONAL:${target.ownerUserId}:`;
  for (const [table, predicate] of [
    ['skill_sources', "scope='ENTERPRISE' AND built_in=FALSE"],
    ['skill_favorites', "scope='ENTERPRISE'"],
    ['mcp_sources', "scope='ENTERPRISE' AND built_in=FALSE"]
  ] as const)
    await connection.execute(
      `UPDATE ${table} SET scope=?,owner_organization_id=?,owner_user_id=?,owner_key=? WHERE ${predicate}`,
      [scope, organizationId, userId, ownerKey]
    );
  await connection.execute(
    `UPDATE mcp_catalog_entries SET scope=?,owner_organization_id=?,owner_user_id=?
     WHERE scope='ENTERPRISE' AND source_id<>'official-mcp-registry'`,
    [scope, organizationId, userId]
  );
}

async function assertCatalogScopeMigrationSafe(
  connection: MysqlMigrationConnection,
  target:
    | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
    | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number }
): Promise<void> {
  const ownerPredicate =
    target.ownerType === 'ORGANIZATION'
      ? "target.scope='ORGANIZATION' AND target.owner_organization_id=?"
      : "target.scope='PERSONAL' AND target.owner_user_id=?";
  const ownerId =
    target.ownerType === 'ORGANIZATION' ? target.ownerOrganizationId : target.ownerUserId;
  const checks = [
    `SELECT legacy.id FROM skill_sources legacy
     JOIN skill_sources target ON target.name=legacy.name AND ${ownerPredicate}
     WHERE legacy.scope='ENTERPRISE' AND legacy.built_in=FALSE LIMIT 1`,
    `SELECT legacy.id FROM skill_favorites legacy
     JOIN skill_favorites target ON BINARY target.repository_identity=BINARY legacy.repository_identity
       AND BINARY target.skill_path=BINARY legacy.skill_path AND ${ownerPredicate}
     WHERE legacy.scope='ENTERPRISE' LIMIT 1`,
    `SELECT legacy.id FROM mcp_sources legacy
     JOIN mcp_sources target ON target.name=legacy.name AND ${ownerPredicate}
     WHERE legacy.scope='ENTERPRISE' AND legacy.built_in=FALSE LIMIT 1`,
    `SELECT legacy.id FROM mcp_catalog_entries legacy
     JOIN mcp_catalog_entries target ON BINARY target.server_name=BINARY legacy.server_name
       AND ${ownerPredicate}
     WHERE legacy.scope='ENTERPRISE' AND legacy.source_id<>'official-mcp-registry' LIMIT 1`
  ];
  for (const sql of checks) {
    const [rows] = (await connection.execute(sql, [ownerId])) as [readonly unknown[], unknown];
    if (rows.length > 0) throw new Error('CATALOG_SCOPE_MIGRATION_CONFLICT');
  }
}

async function migrateResourceGrantData(connection: MysqlMigrationConnection): Promise<void> {
  const [conflicts] = (await connection.execute(
    `SELECT enterprise_grant.id FROM resource_grants enterprise_grant
     JOIN resource_grants root_grant ON root_grant.resource_key=enterprise_grant.resource_key
       AND root_grant.target_key='ORGANIZATION:1'
     WHERE enterprise_grant.target_type='ENTERPRISE'
       AND COALESCE(root_grant.grant_scope_organization_id,1)<>1 LIMIT 1`
  )) as [readonly unknown[], unknown];
  if (conflicts.length > 0) throw new Error('RESOURCE_GRANT_SCOPE_MIGRATION_CONFLICT');
  await connection.execute(
    `DELETE enterprise_grant FROM resource_grants enterprise_grant
     JOIN resource_grants root_grant ON root_grant.resource_key=enterprise_grant.resource_key
       AND root_grant.target_key='ORGANIZATION:1'
     WHERE enterprise_grant.target_type='ENTERPRISE'
       AND COALESCE(root_grant.grant_scope_organization_id,1)=1`
  );
  await connection.execute(
    `UPDATE resource_grants SET target_type='ORGANIZATION',target_organization_id=1,
       target_key='ORGANIZATION:1' WHERE target_type='ENTERPRISE'`
  );
  await connection.execute(
    `UPDATE resource_grants SET grant_scope_organization_id=1
     WHERE grant_authority='ENTERPRISE' AND grant_scope_organization_id IS NULL`
  );
  const [invalidRows] = (await connection.execute(
    `SELECT id FROM resource_grants
     WHERE target_type='ENTERPRISE' OR grant_scope_organization_id IS NULL LIMIT 1`
  )) as [readonly unknown[], unknown];
  if (invalidRows.length > 0) throw new Error('RESOURCE_GRANT_SCOPE_MIGRATION_INVALID');
}

async function migrateResourceGrantSchema(connection: MysqlMigrationConnection): Promise<void> {
  const [columns] = (await connection.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='resource_grants'`
  )) as [readonly Record<string, unknown>[], unknown];
  if (columns.some((row) => String(row['COLUMN_NAME']) === 'grant_authority'))
    await connection.execute('ALTER TABLE resource_grants DROP COLUMN grant_authority');
  await connection.execute(
    "ALTER TABLE resource_grants MODIFY target_type enum('USER','ORGANIZATION') NOT NULL"
  );
  await connection.execute(
    'ALTER TABLE resource_grants MODIFY grant_scope_organization_id bigint unsigned NOT NULL'
  );
  await validateMysqlSchema(connection, { resource_grants: resourceGrantV6 });
}

export async function validateEnterpriseMysqlBaseline(
  connection: MysqlMigrationConnection
): Promise<void> {
  await validateMysqlSchema(connection, CORE_MYSQL_SCHEMA_V9);
  await validateMysqlSchema(connection, ENTERPRISE_MYSQL_SCHEMA_V4);
}

export async function validateEnterpriseMysqlDatabase(
  connection: Pick<MysqlMigrationConnection, 'query'>
): Promise<void> {
  await validateMysqlSchema(connection, CORE_MYSQL_SCHEMA);
  await validateMysqlSchema(connection, ENTERPRISE_MYSQL_SCHEMA);
  await validateMysqlReferences(connection, ENTERPRISE_MYSQL_SCHEMA_V6);
  await validateMysqlReferences(connection, CORE_MYSQL_SCHEMA_V17);
  await validateMysqlSessionShareReferences(connection);
  await assertMysqlNoForeignKeys(connection);
  for (const { table, column } of organizationReferences) {
    const [rows] = await connection.query(
      `SELECT 1 AS orphan FROM \`${table}\` resource
       LEFT JOIN organizations organization ON organization.id=resource.\`${column}\`
       WHERE resource.\`${column}\` IS NOT NULL AND organization.id IS NULL LIMIT 1`
    );
    if (!Array.isArray(rows) || rows.length !== 0)
      throw new Error('SERVER_DATABASE_ORGANIZATION_REFERENCE_INVALID');
  }
}
