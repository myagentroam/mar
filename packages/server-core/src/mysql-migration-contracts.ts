import type { DatabaseIdentityReader } from './database-identity.js';

export interface MysqlMigrationConnection extends DatabaseIdentityReader {
  execute(sql: string, values?: (string | number | null)[]): Promise<readonly unknown[]>;
  release(): void;
}

export interface MysqlMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly minimumCoreVersion?: number;
  readonly up: (
    connection: MysqlMigrationConnection,
    edition?: MysqlMigrationPlan['edition']
  ) => Promise<void>;
}

// The first migration in each namespace catalog is its immutable installation baseline.
export interface MysqlMigrationPlan {
  readonly edition: 'personal' | 'enterprise';
  readonly core: readonly MysqlMigration[];
  readonly enterprise?: readonly MysqlMigration[];
  readonly validate: (connection: MysqlMigrationConnection) => Promise<void>;
  readonly validateBaseline?: (connection: MysqlMigrationConnection) => Promise<void>;
}
