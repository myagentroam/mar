import { describe, expect, it, vi } from 'vitest';
import {
  runServerMysqlMigrations,
  SERVER_MIGRATION_LEDGER_SQL
} from '../../src/mysql-migrations.js';
import type {
  MysqlMigration,
  MysqlMigrationConnection,
  MysqlMigrationPlan
} from '../../src/mysql-migration-contracts.js';

type HistoryInput = {
  namespace: unknown;
  version: unknown;
  name: unknown;
  checksum: unknown;
  status: unknown;
};

type Mutation =
  | { type: 'ledger-create' }
  | {
      type: 'started';
      namespace: string;
      version: number;
      name: string;
      checksum: string;
    }
  | { type: 'completed'; namespace: string; version: number }
  | { type: 'failed'; namespace: string; version: number; errorSummary: string };

interface DatabaseFixtureOptions {
  readonly tables: string[];
  readonly columns?: string[];
  readonly namespaces?: unknown[];
  readonly history?: readonly HistoryInput[];
  readonly lockAcquired?: number;
  readonly releaseLockError?: Error;
  readonly ledgerDefinition?: string;
}

interface DatabaseFixture {
  readonly connection: MysqlMigrationConnection;
  readonly pool: { getConnection(): Promise<MysqlMigrationConnection> };
  readonly events: string[];
  readonly mutations: Mutation[];
  readonly released: ReturnType<typeof vi.fn>;
}

function checksum(value: string): string {
  const encoded = [...value].map((character) => character.codePointAt(0)!.toString(16)).join('');
  return encoded.repeat(Math.ceil(64 / encoded.length)).slice(0, 64);
}

function migration(
  version: number,
  name: string,
  options: {
    readonly checksum?: string;
    readonly minimumCoreVersion?: number;
    readonly up?: (connection: MysqlMigrationConnection) => Promise<void>;
  } = {}
): MysqlMigration {
  return {
    version,
    name,
    checksum: options.checksum ?? checksum(`${version}${name}`),
    ...(options.minimumCoreVersion === undefined
      ? {}
      : { minimumCoreVersion: options.minimumCoreVersion }),
    up: options.up ?? (async () => undefined)
  };
}

function createDatabase(options: DatabaseFixtureOptions): DatabaseFixture {
  const events: string[] = [];
  const mutations: Mutation[] = [];
  const history = [...(options.history ?? [])];
  const namespaces = options.namespaces ?? [
    ...new Set(history.map((row) => row.namespace).filter((value) => typeof value === 'string'))
  ];
  const released = vi.fn(() => {
    events.push('connection:release');
  });

  const query = vi.fn(async (sql: string): Promise<readonly unknown[]> => {
    if (sql === 'START TRANSACTION') {
      events.push('transaction:begin');
      return [[], []];
    }
    if (sql === 'COMMIT') {
      events.push('transaction:commit');
      return [[], []];
    }
    if (sql === 'ROLLBACK') {
      events.push('transaction:rollback');
      return [[], []];
    }
    if (sql.includes('information_schema.tables')) {
      events.push('metadata:tables');
      return [options.tables.map((table_name) => ({ table_name })), []];
    }
    if (sql.includes('information_schema.columns')) {
      events.push('metadata:columns');
      return [
        (options.columns ?? ['version', 'namespace']).map((column_name) => ({ column_name })),
        []
      ];
    }
    if (sql.includes('SELECT DISTINCT namespace')) {
      events.push('metadata:namespaces');
      return [namespaces.map((namespace) => ({ namespace })), []];
    }
    if (sql.includes('SELECT namespace,version,name,checksum,status FROM schema_migrations')) {
      events.push('history:read');
      return [history, []];
    }
    if (sql.startsWith('SHOW CREATE TABLE'))
      return [[{ 'Create Table': options.ledgerDefinition ?? SERVER_MIGRATION_LEDGER_SQL }], []];
    if (sql.startsWith('CREATE TABLE')) {
      events.push('ledger:create');
      mutations.push({ type: 'ledger-create' });
      return [[], []];
    }
    if (sql === 'DELETE FROM schema_migrations') {
      events.push('ledger:clear');
      return [[], []];
    }
    throw new Error('UNEXPECTED_QUERY');
  });

  const execute = vi.fn(
    async (sql: string, values?: (string | number | null)[]): Promise<readonly unknown[]> => {
      if (sql.includes('GET_LOCK')) {
        events.push('lock:acquire');
        return [[{ acquired: options.lockAcquired ?? 1 }], []];
      }
      if (sql.includes('RELEASE_LOCK')) {
        events.push('lock:release');
        if (options.releaseLockError) throw options.releaseLockError;
        return [[{ released: 1 }], []];
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        const [namespace, version, name, migrationChecksum] = values ?? [];
        events.push(`ledger:started:${namespace}:${version}`);
        mutations.push({
          type: 'started',
          namespace: String(namespace),
          version: Number(version),
          name: String(name),
          checksum: String(migrationChecksum)
        });
        return [[], []];
      }
      if (sql.includes("status='COMPLETED'")) {
        const [, namespace, version] = values ?? [];
        events.push(`ledger:completed:${namespace}:${version}`);
        mutations.push({
          type: 'completed',
          namespace: String(namespace),
          version: Number(version)
        });
        return [[], []];
      }
      if (sql.includes("status='FAILED'")) {
        const [errorSummary, namespace, version] = values ?? [];
        events.push(`ledger:failed:${namespace}:${version}`);
        mutations.push({
          type: 'failed',
          namespace: String(namespace),
          version: Number(version),
          errorSummary: String(errorSummary)
        });
        return [[], []];
      }
      throw new Error('UNEXPECTED_EXECUTE');
    }
  );

  const connection: MysqlMigrationConnection = { query, execute, release: released };
  return {
    connection,
    pool: { getConnection: vi.fn(async () => connection) },
    events,
    mutations,
    released
  };
}

function createPlan(
  database: Pick<DatabaseFixture, 'events'>,
  options: {
    readonly edition?: 'personal' | 'enterprise';
    readonly core?: readonly MysqlMigration[];
    readonly enterprise?: readonly MysqlMigration[];
    readonly validate?: (connection: MysqlMigrationConnection) => Promise<void>;
  } = {}
): MysqlMigrationPlan {
  return {
    edition: options.edition ?? 'enterprise',
    core: options.core ?? [migration(1, 'core_init')],
    ...(options.enterprise === undefined ? {} : { enterprise: options.enterprise }),
    validate: async (connection) => {
      database.events.push('plan:validate');
      await options.validate?.(connection);
    }
  };
}

function historyRow(
  namespace: 'core' | 'enterprise',
  item: MysqlMigration,
  status: 'STARTED' | 'COMPLETED' | 'FAILED'
): HistoryInput {
  return {
    namespace,
    version: item.version,
    name: item.name,
    checksum: item.checksum,
    status
  };
}

const legacyBaselineHistory = [
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
] as const satisfies readonly (readonly [string, number, string, string])[];

function legacyHistory(): HistoryInput[] {
  return legacyBaselineHistory.map(([namespace, version, name, checksum]) => ({
    namespace,
    version,
    name,
    checksum,
    status: 'COMPLETED'
  }));
}

describe('server MySQL migration contract', () => {
  it('validates an invalid catalog before opening a connection', async () => {
    const database = createDatabase({ tables: [] });
    const plan = createPlan(database, { edition: 'personal', core: [] });

    await expect(runServerMysqlMigrations(database.pool, plan)).rejects.toThrow(
      'SERVER_DATABASE_MIGRATION_CATALOG_INVALID'
    );

    expect(database.pool.getConnection).not.toHaveBeenCalled();
    expect(database.events).toEqual([]);
  });

  it('runs all core migrations before enterprise migrations and honors declared Core dependencies', async () => {
    const database = createDatabase({ tables: [] });
    const coreOne = migration(1, 'core_initial', {
      up: async () => {
        database.events.push('up:core:1');
      }
    });
    const coreTwo = migration(2, 'core_second', {
      up: async () => {
        database.events.push('up:core:2');
      }
    });
    const enterpriseOne = migration(1, 'enterprise_initial', {
      minimumCoreVersion: 2,
      up: async () => {
        database.events.push('up:enterprise:1');
      }
    });

    await runServerMysqlMigrations(
      database.pool,
      createPlan(database, {
        core: [coreOne, coreTwo],
        enterprise: [enterpriseOne]
      })
    );

    expect(database.events.filter((event) => event.startsWith('up:'))).toEqual([
      'up:core:1',
      'up:core:2',
      'up:enterprise:1'
    ]);
    expect(database.events.indexOf('ledger:completed:core:2')).toBeLessThan(
      database.events.indexOf('up:enterprise:1')
    );
    expect(database.events).toContain('plan:validate');
  });

  it('runs explicit Core v9 and Enterprise v4 baselines before Core v10 and Enterprise v5', async () => {
    const database = createDatabase({ tables: [] });
    const coreV9 = migration(9, 'core_schema_v9');
    const coreV10 = migration(10, 'core_demo_future');
    const enterpriseV4 = migration(4, 'enterprise_schema_v4', {
      minimumCoreVersion: 9
    });
    const enterpriseV5 = migration(5, 'enterprise_demo_future', {
      minimumCoreVersion: 10
    });

    await runServerMysqlMigrations(
      database.pool,
      createPlan(database, {
        core: [coreV9, coreV10],
        enterprise: [enterpriseV4, enterpriseV5]
      })
    );

    expect(database.mutations.filter(({ type }) => type === 'started')).toEqual([
      {
        type: 'started',
        namespace: 'core',
        version: 9,
        name: coreV9.name,
        checksum: coreV9.checksum
      },
      {
        type: 'started',
        namespace: 'core',
        version: 10,
        name: coreV10.name,
        checksum: coreV10.checksum
      },
      {
        type: 'started',
        namespace: 'enterprise',
        version: 4,
        name: enterpriseV4.name,
        checksum: enterpriseV4.checksum
      },
      {
        type: 'started',
        namespace: 'enterprise',
        version: 5,
        name: enterpriseV5.name,
        checksum: enterpriseV5.checksum
      }
    ]);
  });

  it('validates and atomically compacts the recognized pre-baseline ledger without running DDL', async () => {
    const database = createDatabase({ tables: ['schema_migrations'], history: legacyHistory() });
    const coreV9 = migration(9, 'core_schema_v9');
    const enterpriseV4 = migration(4, 'enterprise_schema_v4', { minimumCoreVersion: 9 });

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, { core: [coreV9], enterprise: [enterpriseV4] })
      )
    ).resolves.toBeUndefined();

    expect(database.events).toContain('plan:validate');
    expect(database.events).toContain('ledger:clear');
    expect(database.events).toContain('transaction:begin');
    expect(database.events).toContain('transaction:commit');
    expect(database.events.filter((event) => event.startsWith('up:'))).toEqual([]);
  });

  it('validates the released baseline before compacting and the current schema only after upgrades', async () => {
    const database = createDatabase({ tables: ['schema_migrations'], history: legacyHistory() });
    const coreV9 = migration(9, 'core_schema_v9');
    const enterpriseV4 = migration(4, 'enterprise_schema_v4', { minimumCoreVersion: 9 });
    const plan = createPlan(database, { core: [coreV9], enterprise: [enterpriseV4] });
    const validateBaseline = vi.fn(async () => {
      database.events.push('baseline:validate');
    });
    await runServerMysqlMigrations(database.pool, { ...plan, validateBaseline });
    expect(validateBaseline).toHaveBeenCalledTimes(1);
    expect(database.events.indexOf('baseline:validate')).toBeLessThan(
      database.events.indexOf('ledger:clear')
    );
    expect(database.events.indexOf('plan:validate')).toBeGreaterThan(
      database.events.indexOf('transaction:commit')
    );
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['beyond Core catalog', 2]
  ] as const)(
    'rejects an enterprise migration with a %s minimum Core dependency',
    async (_, dependency) => {
      const database = createDatabase({ tables: [] });
      const enterprise = migration(1, 'enterprise_initial', {
        ...(dependency === undefined ? {} : { minimumCoreVersion: dependency })
      });

      await expect(
        runServerMysqlMigrations(
          database.pool,
          createPlan(database, {
            core: [migration(1, 'core_initial')],
            enterprise: [enterprise]
          })
        )
      ).rejects.toThrow('SERVER_DATABASE_MIGRATION_CATALOG_INVALID');

      expect(database.pool.getConnection).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'Core v8',
      [historyRow('core', migration(8, 'core_schema_v8'), 'COMPLETED')],
      [migration(9, 'core_schema_v9')],
      'SERVER_DATABASE_MIGRATION_BASELINE_UNSUPPORTED'
    ],
    [
      'Enterprise v3',
      [
        historyRow('core', migration(9, 'core_schema_v9'), 'COMPLETED'),
        historyRow(
          'enterprise',
          migration(3, 'enterprise_schema_v3', { minimumCoreVersion: 9 }),
          'COMPLETED'
        )
      ],
      [migration(9, 'core_schema_v9')],
      'SERVER_DATABASE_MIGRATION_BASELINE_UNSUPPORTED'
    ],
    [
      'Core history that skips v9',
      [historyRow('core', migration(10, 'core_future'), 'COMPLETED')],
      [migration(9, 'core_schema_v9'), migration(10, 'core_future')],
      'SERVER_DATABASE_MIGRATION_HISTORY_INVALID'
    ]
  ] as const)(
    'rejects %s history without making ledger or migration writes',
    async (_, history, core, errorCode) => {
      const database = createDatabase({ tables: ['schema_migrations'], history });
      const plan = createPlan(database, {
        core,
        enterprise: [migration(4, 'enterprise_schema_v4', { minimumCoreVersion: 9 })]
      });

      await expect(runServerMysqlMigrations(database.pool, plan)).rejects.toThrow(errorCode);

      expect(database.mutations).toEqual([]);
      expect(database.released).toHaveBeenCalledOnce();
    }
  );

  it('rejects legacy single-ledger databases before making writes', async () => {
    const database = createDatabase({
      tables: ['schema_migrations', 'users'],
      columns: ['version']
    });

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, {
          core: [migration(9, 'core_schema_v9')],
          enterprise: [migration(4, 'enterprise_schema_v4', { minimumCoreVersion: 9 })]
        })
      )
    ).rejects.toThrow('SERVER_DATABASE_LEDGER_UNSUPPORTED');

    expect(database.mutations).toEqual([]);
    expect(database.events).not.toContain('history:read');
    expect(database.events).not.toContain('ledger:create');
    expect(database.released).toHaveBeenCalledOnce();
  });

  it('validates Enterprise history dependencies against the completed Core version, not its count', async () => {
    const coreV9 = migration(9, 'core_schema_v9');
    const enterpriseV4 = migration(4, 'enterprise_schema_v4', {
      minimumCoreVersion: 9
    });
    const database = createDatabase({
      tables: ['schema_migrations'],
      history: [
        historyRow('core', coreV9, 'COMPLETED'),
        historyRow('enterprise', enterpriseV4, 'COMPLETED')
      ]
    });

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, { core: [coreV9], enterprise: [enterpriseV4] })
      )
    ).resolves.toBeUndefined();

    expect(database.mutations).toEqual([]);
    expect(database.events).toContain('plan:validate');
  });

  it.each([
    ['future Enterprise version', 'SERVER_DATABASE_MIGRATION_VERSION_UNSUPPORTED', 'future'],
    ['changed Enterprise checksum', 'SERVER_DATABASE_MIGRATION_CHECKSUM_MISMATCH', 'checksum']
  ] as const)(
    'validates all history before any write when it finds a %s',
    async (_, errorCode, variant) => {
      const coreOne = migration(1, 'core_initial');
      const coreTwo = migration(2, 'core_second', {
        up: async () => {
          database.events.push('up:core:2');
        }
      });
      const enterpriseOne = migration(1, 'enterprise_initial', { minimumCoreVersion: 1 });
      const history =
        variant === 'future'
          ? [
              historyRow('core', coreOne, 'COMPLETED'),
              historyRow('enterprise', enterpriseOne, 'COMPLETED'),
              {
                namespace: 'enterprise',
                version: 2,
                name: 'enterprise_future',
                checksum: checksum('future'),
                status: 'COMPLETED'
              }
            ]
          : [
              historyRow('core', coreOne, 'COMPLETED'),
              {
                ...historyRow('enterprise', enterpriseOne, 'COMPLETED'),
                checksum: checksum('changed')
              }
            ];
      const database = createDatabase({ tables: ['schema_migrations'], history });
      const plan = createPlan(database, {
        core: [coreOne, coreTwo],
        enterprise: [enterpriseOne]
      });

      await expect(runServerMysqlMigrations(database.pool, plan)).rejects.toThrow(errorCode);

      expect(database.events).toContain('history:read');
      expect(database.events).not.toContain('up:core:2');
      expect(database.mutations).toEqual([]);
      expect(database.events).toContain('lock:release');
      expect(database.released).toHaveBeenCalledOnce();
    }
  );

  it('skips completed history and only validates the resulting database', async () => {
    const core = migration(1, 'core_initial', {
      up: async () => {
        throw new Error('COMPLETED_CORE_RAN');
      }
    });
    const enterprise = migration(1, 'enterprise_initial', {
      minimumCoreVersion: 1,
      up: async () => {
        throw new Error('COMPLETED_ENTERPRISE_RAN');
      }
    });
    const database = createDatabase({
      tables: ['schema_migrations'],
      history: [
        historyRow('core', core, 'COMPLETED'),
        historyRow('enterprise', enterprise, 'COMPLETED')
      ]
    });

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, { core: [core], enterprise: [enterprise] })
      )
    ).resolves.toBeUndefined();

    expect(database.mutations).toEqual([]);
    expect(database.events).toContain('plan:validate');
  });

  it.each(['STARTED', 'FAILED'] as const)(
    'retries a %s final migration only when its original catalog checksum still matches',
    async (status) => {
      const core = migration(1, 'core_initial', {
        up: async () => undefined
      });
      const database = createDatabase({
        tables: ['schema_migrations'],
        history: [historyRow('core', core, status)]
      });
      await runServerMysqlMigrations(
        database.pool,
        createPlan(database, {
          edition: 'personal',
          core: [
            {
              ...core,
              up: async () => {
                database.events.push('up:core:1');
              }
            }
          ],
          enterprise: []
        })
      );

      expect(database.events).toContain('up:core:1');
      expect(database.mutations).toContainEqual({
        type: 'started',
        namespace: 'core',
        version: 1,
        name: core.name,
        checksum: core.checksum
      });
      expect(database.mutations).toContainEqual({
        type: 'completed',
        namespace: 'core',
        version: 1
      });
    }
  );

  it.each([
    [
      'a historical hole',
      [
        {
          namespace: 'core',
          version: 2,
          name: 'core_second',
          checksum: checksum('hole'),
          status: 'COMPLETED'
        }
      ],
      'SERVER_DATABASE_MIGRATION_HISTORY_INVALID'
    ],
    [
      'an unknown namespace',
      [
        {
          namespace: 'unknown',
          version: 1,
          name: 'unknown_initial',
          checksum: checksum('unknown'),
          status: 'COMPLETED'
        }
      ],
      'SERVER_DATABASE_IDENTITY_INVALID'
    ],
    [
      'an invalid history status',
      [
        {
          namespace: 'core',
          version: 1,
          name: 'core_initial',
          checksum: checksum('status'),
          status: 'UNKNOWN'
        }
      ],
      'SERVER_DATABASE_MIGRATION_HISTORY_INVALID'
    ]
  ] as const)(
    'rejects %s without making ledger or migration writes',
    async (_, history, errorCode) => {
      const database = createDatabase({ tables: ['schema_migrations'], history });
      const core = migration(1, 'core_initial', { checksum: checksum('status') });
      const coreTwo = migration(2, 'core_second', { checksum: checksum('hole') });

      await expect(
        runServerMysqlMigrations(
          database.pool,
          createPlan(database, { edition: 'personal', core: [core, coreTwo], enterprise: [] })
        )
      ).rejects.toThrow(errorCode);

      expect(database.mutations).toEqual([]);
      expect(database.released).toHaveBeenCalledOnce();
    }
  );

  it('rejects an Enterprise ledger under a personal plan before ledger or migration writes', async () => {
    const core = migration(1, 'core_initial');
    const enterprise = migration(1, 'enterprise_initial', { minimumCoreVersion: 1 });
    const database = createDatabase({
      tables: ['schema_migrations'],
      history: [
        historyRow('core', core, 'COMPLETED'),
        historyRow('enterprise', enterprise, 'COMPLETED')
      ]
    });

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, { edition: 'personal', core: [core], enterprise: [] })
      )
    ).rejects.toThrow('SERVER_DATABASE_EDITION_MISMATCH');

    expect(database.mutations).toEqual([]);
    expect(database.released).toHaveBeenCalledOnce();
  });

  it('recovers a database that contains only an empty namespaced ledger', async () => {
    const database = createDatabase({
      tables: ['schema_migrations'],
      namespaces: []
    });
    const core = migration(1, 'core_initial', {
      up: async () => {
        database.events.push('up:core:1');
      }
    });

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, { edition: 'personal', core: [core], enterprise: [] })
      )
    ).resolves.toBeUndefined();

    expect(database.events).toContain('up:core:1');
    expect(database.events).toContain('plan:validate');
  });

  it('rejects an empty ledger with an incompatible physical structure before writes', async () => {
    const database = createDatabase({
      tables: ['schema_migrations'],
      namespaces: [],
      ledgerDefinition: SERVER_MIGRATION_LEDGER_SQL.replace('PRIMARY KEY', 'KEY')
    });
    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, {
          edition: 'personal',
          enterprise: []
        })
      )
    ).rejects.toThrow('SERVER_DATABASE_SCHEMA_MISMATCH');
    expect(database.mutations).toEqual([]);
    expect(database.released).toHaveBeenCalledOnce();
  });

  it('records only the stable step failure summary and releases the lock and connection', async () => {
    const secret = 'mysql://admin:secret-value@example.invalid/server';
    const database = createDatabase({ tables: [] });
    const core = migration(1, 'core_initial', {
      up: async () => {
        throw new Error(`migration failed with ${secret}`);
      }
    });

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, { edition: 'personal', core: [core], enterprise: [] })
      )
    ).rejects.toThrow(secret);

    expect(database.mutations).toContainEqual({
      type: 'failed',
      namespace: 'core',
      version: 1,
      errorSummary: 'SERVER_DATABASE_MIGRATION_STEP_FAILED'
    });
    expect(JSON.stringify(database.mutations)).not.toContain(secret);
    expect(database.events).toContain('lock:release');
    expect(database.released).toHaveBeenCalledOnce();
  });

  it('propagates validation failures without swallowing them and still releases resources', async () => {
    const database = createDatabase({ tables: [] });
    const validationError = new Error('DATABASE_INTEGRITY_CHECK_FAILED');

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, {
          edition: 'personal',
          enterprise: [],
          validate: async () => {
            throw validationError;
          }
        })
      )
    ).rejects.toBe(validationError);

    expect(database.events).toContain('plan:validate');
    expect(database.events).toContain('lock:release');
    expect(database.released).toHaveBeenCalledOnce();
  });

  it('releases the connection even when releasing the migration lock fails', async () => {
    const releaseLockError = new Error('LOCK_RELEASE_FAILED');
    const database = createDatabase({ tables: [], releaseLockError });

    await expect(
      runServerMysqlMigrations(
        database.pool,
        createPlan(database, { edition: 'personal', enterprise: [] })
      )
    ).rejects.toBe(releaseLockError);

    expect(database.events).toContain('lock:release');
    expect(database.released).toHaveBeenCalledOnce();
  });
});
