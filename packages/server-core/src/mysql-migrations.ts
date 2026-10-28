import { validateMysqlSchema } from './mysql-schema-support.js';
import { assertDatabaseIdentity } from './database-identity.js';
import type { MysqlMigrationConnection, MysqlMigrationPlan } from './mysql-migration-contracts.js';

interface HistoryRow {
  namespace: 'core' | 'enterprise';
  version: number;
  checksum: string;
  name: string;
  status: 'STARTED' | 'COMPLETED' | 'FAILED';
}

const LEGACY_BASELINE_HISTORY = [
  ['core', 1, 'core_schema_v1', 'b3f50db152bd1d24ea4a48a91a1667ab7061a12da7b10fc3d947134a1bd34dfd'],
  [
    'core',
    2,
    'core_hosted_notifications_v2',
    'b93fcebbfb6ffd454cfcaad85fc0e92f24f7c6511084299aad0edfa97dc9a261'
  ],
  [
    'core',
    3,
    'core_personal_git_v3',
    'b58d8dca38e4971c95a9f97c626b91ff6bb74d7d18200c4d9c10efc40dd41c3a'
  ],
  [
    'core',
    4,
    'workspace_groups',
    '61dc0da6e14ed5000609abf848574ff37b78d406b40f60e87d12934e45d8e002'
  ],
  [
    'core',
    5,
    'mar_agent_high_density_compaction',
    '2574bd9669864f063a403d9846e296be605acc4d1dc12d0756f5901fb982ede3'
  ],
  [
    'core',
    6,
    'core_mar_agent_model_order_v6',
    '94ce00c5d579a8001fb57ac58134220b3cecf1bc16caa61d284ea0e4799021c5'
  ],
  [
    'core',
    7,
    'mar_agent_fast_mode',
    'd0b8d93511a7c9496722ef3bf8c155d7ec065c7b19ceb44b388216dec896de9c'
  ],
  [
    'core',
    8,
    'mar_agent_model_resources',
    '5e906aa868ecdb52e91b0e6ee5bb87ed1f59f26e3766505f9ca1644238cb4bbf'
  ],
  [
    'enterprise',
    1,
    'enterprise_schema_v1',
    '42b22a256743a9990969abc2919e086f925335862a5edbb6c967422133f405ff'
  ],
  [
    'enterprise',
    2,
    'enterprise_shared_hosted_v2',
    'cc32e1003ad1efd9a784baffc2a09703de4b080ae2f8445718d51be3c1d82c71'
  ],
  [
    'enterprise',
    3,
    'enterprise_model_resource_ownership',
    'd9db3e7df4596bd65789f402d3c1d4ce43f67e6d0ee71060a55f7e5a2a9477ea'
  ]
] as const;

export const SERVER_MIGRATION_LEDGER_SQL = `CREATE TABLE \`schema_migrations\` (
  \`namespace\` varchar(32) NOT NULL,
  \`version\` int NOT NULL,
  \`name\` varchar(128) NOT NULL,
  \`checksum\` char(64) NOT NULL,
  \`status\` enum('STARTED','COMPLETED','FAILED') NOT NULL,
  \`started_at\` bigint NOT NULL,
  \`completed_at\` bigint DEFAULT NULL,
  \`error_summary\` varchar(512) DEFAULT NULL,
  PRIMARY KEY (\`namespace\`,\`version\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export async function runServerMysqlMigrations(
  pool: { getConnection(): Promise<MysqlMigrationConnection> },
  plan: MysqlMigrationPlan
): Promise<void> {
  validateCatalog(plan);
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.execute(
      "SELECT GET_LOCK('myagentroam:server:migrations', 30) AS acquired"
    );
    locked = Number((lockRows as { acquired: number }[])[0]?.acquired) === 1;
    if (!locked) throw new Error('DATABASE_MIGRATION_LOCK_UNAVAILABLE');
    const identity = await assertDatabaseIdentity(connection, {
      edition: plan.edition,
      ledger: 'namespaced',
      recoverEmptyLedger: true
    });
    let history: HistoryRow[] = [];
    if (identity !== 'empty') {
      await validateMysqlSchema(connection, { schema_migrations: SERVER_MIGRATION_LEDGER_SQL });
      const [rows] = await connection.query(
        'SELECT namespace,version,name,checksum,status FROM schema_migrations ORDER BY namespace,version'
      );
      const compacted = compactLegacyHistory(rows, plan);
      if (compacted === undefined) history = validateHistory(rows, plan);
      else {
        // The legacy sequence already represents the v9/v4 schema. Validate that schema before
        // changing only the ledger, then retain one immutable baseline entry per namespace.
        await (plan.validateBaseline ?? plan.validate)(connection);
        await connection.query('START TRANSACTION');
        try {
          await connection.query('DELETE FROM schema_migrations');
          for (const row of compacted)
            await connection.execute(
              `INSERT INTO schema_migrations
               (namespace,version,name,checksum,status,started_at,completed_at,error_summary)
               VALUES (?,?,?,?,'COMPLETED',?,?,NULL)`,
              [row.namespace, row.version, row.name, row.checksum, Date.now(), Date.now()]
            );
          await connection.query('COMMIT');
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        }
        history = compacted;
      }
    }
    if (identity === 'empty') await connection.query(SERVER_MIGRATION_LEDGER_SQL);
    for (const namespace of ['core', 'enterprise'] as const) {
      for (const migration of plan[namespace] ?? []) {
        if (
          history.some(
            (row) =>
              row.namespace === namespace &&
              row.version === migration.version &&
              row.status === 'COMPLETED'
          )
        )
          continue;
        await connection.execute(
          `INSERT INTO schema_migrations
           (namespace,version,name,checksum,status,started_at,completed_at,error_summary)
           VALUES (?,?,?,?,'STARTED',?,NULL,NULL)
           ON DUPLICATE KEY UPDATE status='STARTED',started_at=VALUES(started_at),completed_at=NULL,error_summary=NULL`,
          [namespace, migration.version, migration.name, migration.checksum, Date.now()]
        );
        try {
          await migration.up(connection, plan.edition);
          await connection.execute(
            "UPDATE schema_migrations SET status='COMPLETED',completed_at=?,error_summary=NULL WHERE namespace=? AND version=?",
            [Date.now(), namespace, migration.version]
          );
        } catch (error) {
          await connection.execute(
            "UPDATE schema_migrations SET status='FAILED',error_summary=? WHERE namespace=? AND version=?",
            ['SERVER_DATABASE_MIGRATION_STEP_FAILED', namespace, migration.version]
          );
          throw error;
        }
      }
    }
    await plan.validate(connection);
  } finally {
    try {
      if (locked)
        await connection.execute(
          "SELECT RELEASE_LOCK('myagentroam:server:migrations') AS released"
        );
    } finally {
      connection.release();
    }
  }
}

function compactLegacyHistory(rows: unknown, plan: MysqlMigrationPlan): HistoryRow[] | undefined {
  if (!plan.enterprise || !Array.isArray(rows) || rows.length !== LEGACY_BASELINE_HISTORY.length)
    return undefined;
  if (
    !rows.every((raw, index) => {
      const expected = LEGACY_BASELINE_HISTORY[index]!;
      const row = raw as Partial<HistoryRow> | null;
      return (
        row?.namespace === expected[0] &&
        row.version === expected[1] &&
        row.name === expected[2] &&
        row.checksum === expected[3] &&
        row.status === 'COMPLETED'
      );
    })
  )
    return undefined;
  return [
    { ...plan.core[0]!, namespace: 'core', status: 'COMPLETED' },
    { ...plan.enterprise[0]!, namespace: 'enterprise', status: 'COMPLETED' }
  ];
}

function validateCatalog(plan: MysqlMigrationPlan): void {
  if (
    plan.core.length === 0 ||
    (plan.edition === 'personal' && (plan.enterprise?.length ?? 0) !== 0) ||
    (plan.edition === 'enterprise' && (plan.enterprise?.length ?? 0) === 0)
  )
    throw new Error('SERVER_DATABASE_MIGRATION_CATALOG_INVALID');
  const latestCoreVersion = plan.core.at(-1)!.version;
  for (const namespace of ['core', 'enterprise'] as const) {
    const catalog = plan[namespace] ?? [];
    const baselineVersion = catalog[0]?.version;
    if (catalog.length > 0 && !Number.isSafeInteger(baselineVersion))
      throw new Error('SERVER_DATABASE_MIGRATION_CATALOG_INVALID');
    for (const [index, migration] of catalog.entries()) {
      if (
        migration.version !== baselineVersion! + index ||
        !/^[a-z][a-z0-9_]{0,127}$/u.test(migration.name) ||
        !/^[a-f0-9]{64}$/u.test(migration.checksum) ||
        (namespace === 'core' && migration.minimumCoreVersion !== undefined) ||
        (namespace === 'enterprise' &&
          (!Number.isSafeInteger(migration.minimumCoreVersion) ||
            migration.minimumCoreVersion! < 1 ||
            migration.minimumCoreVersion! > latestCoreVersion))
      )
        throw new Error('SERVER_DATABASE_MIGRATION_CATALOG_INVALID');
    }
  }
}

function validateHistory(rows: unknown, plan: MysqlMigrationPlan): HistoryRow[] {
  if (!Array.isArray(rows)) throw new Error('SERVER_DATABASE_MIGRATION_HISTORY_INVALID');
  const history: HistoryRow[] = [];
  const counts = { core: 0, enterprise: 0 };
  const incomplete = { core: false, enterprise: false };
  const catalogs = {
    core: new Map(plan.core.map((migration) => [migration.version, migration])),
    enterprise: new Map((plan.enterprise ?? []).map((migration) => [migration.version, migration]))
  };
  for (const raw of rows) {
    const row = raw as Partial<HistoryRow> | null;
    if (
      !row ||
      (row.namespace !== 'core' && row.namespace !== 'enterprise') ||
      !Number.isSafeInteger(row.version) ||
      (row.status !== 'STARTED' && row.status !== 'COMPLETED' && row.status !== 'FAILED')
    )
      throw new Error('SERVER_DATABASE_MIGRATION_HISTORY_INVALID');
    const namespace = row.namespace;
    const catalog = plan[namespace] ?? [];
    const baselineVersion = catalog[0]?.version;
    const latestVersion = catalog.at(-1)?.version;
    if (baselineVersion === undefined || latestVersion === undefined)
      throw new Error('SERVER_DATABASE_MIGRATION_VERSION_UNSUPPORTED');
    if (row.version! < baselineVersion)
      throw new Error('SERVER_DATABASE_MIGRATION_BASELINE_UNSUPPORTED');
    if (row.version! > latestVersion)
      throw new Error('SERVER_DATABASE_MIGRATION_VERSION_UNSUPPORTED');
    if (row.version !== baselineVersion + counts[namespace] || incomplete[namespace])
      throw new Error('SERVER_DATABASE_MIGRATION_HISTORY_INVALID');
    const migration = catalogs[namespace].get(row.version!);
    if (!migration) throw new Error('SERVER_DATABASE_MIGRATION_VERSION_UNSUPPORTED');
    if (row.checksum !== migration.checksum || row.name !== migration.name)
      throw new Error('SERVER_DATABASE_MIGRATION_CHECKSUM_MISMATCH');
    counts[namespace]++;
    incomplete[namespace] = row.status !== 'COMPLETED';
    history.push(row as HistoryRow);
  }
  const completedCoreVersion = Math.max(
    0,
    ...history
      .filter((row) => row.namespace === 'core' && row.status === 'COMPLETED')
      .map((row) => row.version)
  );
  for (const row of history) {
    const migration = catalogs.enterprise.get(row.version);
    if (
      row.namespace === 'enterprise' &&
      migration !== undefined &&
      migration.minimumCoreVersion! > completedCoreVersion
    )
      throw new Error('SERVER_DATABASE_MIGRATION_HISTORY_INVALID');
  }
  return history;
}
