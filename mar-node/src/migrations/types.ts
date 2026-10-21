import type { DatabaseSync } from 'node:sqlite';

export interface NodeSchemaMigration {
  readonly version: number;
  readonly sql: string;
  readonly rebuildTables?: boolean;
  readonly preflight?: (database: DatabaseSync) => void;
  readonly assert: (database: DatabaseSync) => void;
}
