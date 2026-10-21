export interface DatabaseIdentityReader {
  query(sql: string): Promise<readonly unknown[]>;
}

export interface DatabaseIdentityTarget {
  readonly edition: 'personal' | 'enterprise';
  readonly ledger: 'legacy' | 'namespaced';
  readonly recoverEmptyLedger?: boolean;
}

export type DatabaseIdentity = 'empty' | 'legacy' | 'personal' | 'enterprise';

/** Call under the migration lock, before any schema or data writes. */
export async function assertDatabaseIdentity(
  connection: DatabaseIdentityReader,
  target: DatabaseIdentityTarget
): Promise<DatabaseIdentity> {
  const tables = await readStrings(
    connection,
    'SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()',
    'table_name'
  );
  if (tables.length === 0) return 'empty';
  if (!tables.includes('schema_migrations')) invalidIdentity();
  const columns = await readStrings(
    connection,
    "SELECT COLUMN_NAME AS column_name FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'",
    'column_name'
  );
  if (!columns.includes('version')) invalidIdentity();
  if (!columns.includes('namespace')) {
    if (target.edition === 'personal') throw new Error('SERVER_DATABASE_EDITION_MISMATCH');
    if (target.ledger !== 'legacy') throw new Error('SERVER_DATABASE_LEDGER_UNSUPPORTED');
    return 'legacy';
  }
  const namespaces = await readStrings(
    connection,
    'SELECT DISTINCT namespace FROM schema_migrations',
    'namespace'
  );
  if (
    namespaces.length === 0 &&
    tables.length === 1 &&
    target.ledger === 'namespaced' &&
    target.recoverEmptyLedger === true
  )
    return 'personal';
  if (
    !namespaces.includes('core') ||
    namespaces.some((namespace) => namespace !== 'core' && namespace !== 'enterprise')
  )
    invalidIdentity();
  const identity = namespaces.includes('enterprise') ? 'enterprise' : 'personal';
  if (identity === 'enterprise' && target.edition === 'personal')
    throw new Error('SERVER_DATABASE_EDITION_MISMATCH');
  if (target.ledger !== 'namespaced') throw new Error('SERVER_DATABASE_LEDGER_UNSUPPORTED');
  return identity;
}

async function readStrings(
  connection: DatabaseIdentityReader,
  sql: string,
  column: string
): Promise<string[]> {
  const [rows] = await connection.query(sql);
  if (!Array.isArray(rows)) return invalidIdentity();
  return rows.map((row: unknown) => {
    if (typeof row !== 'object' || row === null) return invalidIdentity();
    const value = (row as Record<string, unknown>)[column];
    if (typeof value !== 'string' || value.length === 0) return invalidIdentity();
    return value;
  });
}

function invalidIdentity(): never {
  throw new Error('SERVER_DATABASE_IDENTITY_INVALID');
}
