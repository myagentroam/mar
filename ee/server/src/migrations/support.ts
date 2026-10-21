import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const MAX_ACTIVE_USER_SESSIONS = 5;
export type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

export function applyMigration(database: DatabaseSync, version: number, sql: string): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (sql.length > 0) database.exec(sql);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(version, Date.now());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function stringValue(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}

export function numberValue(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
