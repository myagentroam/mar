import mysql, { type Pool } from 'mysql2/promise';

export interface MysqlDatabaseOptions {
  readonly url?: string;
  readonly connectTimeoutMs?: number;
  readonly connectionLimit?: number;
}

export function createMysqlPool(options: MysqlDatabaseOptions = {}): Pool {
  const url = options.url ?? process.env['MAR_DATABASE_URL'];
  if (!url) throw new Error('MAR_DATABASE_URL_REQUIRED');
  const parsed = new URL(url);
  if (parsed.protocol !== 'mysql:') throw new Error('MAR_DATABASE_URL_INVALID');
  return mysql.createPool({
    uri: url,
    charset: 'utf8mb4',
    timezone: 'Z',
    connectionLimit: options.connectionLimit ?? 10,
    connectTimeout: options.connectTimeoutMs ?? 10_000,
    enableKeepAlive: true,
    decimalNumbers: true
  });
}

export async function assertMysqlVersion(pool: Pool): Promise<void> {
  const [rows] = await pool.query('SELECT VERSION() AS version');
  const version = String((rows as { version: string }[])[0]?.version ?? '');
  if (!/^8\.4(?:\.|-)/u.test(version)) throw new Error('SERVER_DATABASE_VERSION_UNSUPPORTED');
}
