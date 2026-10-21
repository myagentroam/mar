import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';

const identifierPattern = /^[a-z0-9_]+$/u;

export interface PlaywrightTestDatabase {
  adminUrl: string;
  databaseName: string;
  databaseUrl: string;
  markerPath: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function quotedIdentifier(value: string): string {
  if (!identifierPattern.test(value)) throw new Error('TEST_DATABASE_NAME_INVALID');
  return `\`${value}\``;
}

export function resolvePlaywrightTestDatabase(testRunId: string): PlaywrightTestDatabase {
  const adminUrl = requiredEnvironment('MAR_TEST_DATABASE_ADMIN_URL');
  const parsed = new URL(adminUrl);
  if (parsed.protocol !== 'mysql:') throw new Error('MAR_TEST_DATABASE_ADMIN_URL_INVALID');

  const prefix = (process.env['MAR_TEST_DATABASE_PREFIX'] ?? 'mar_test').trim().toLowerCase();
  if (!identifierPattern.test(prefix)) throw new Error('MAR_TEST_DATABASE_PREFIX_INVALID');
  const normalizedRunId = testRunId
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, '_')
    .slice(0, 32);
  const suffix = createHash('sha256').update(testRunId).digest('hex').slice(0, 10);
  const databaseName = `${prefix}_${normalizedRunId || 'run'}_${suffix}`.slice(0, 64);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const markerPath = resolve(process.cwd(), `test/runs/playwright-db-${testRunId}.json`);
  return { adminUrl, databaseName, databaseUrl: databaseUrl.toString(), markerPath };
}

export async function createPlaywrightTestDatabase(
  database: PlaywrightTestDatabase
): Promise<void> {
  const connection = await mysql.createConnection(database.adminUrl);
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database.databaseName]
    );
    if (rows.length > 0) throw new Error('TEST_DATABASE_ALREADY_EXISTS');
    await connection.query(
      `CREATE DATABASE ${quotedIdentifier(database.databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
    try {
      await mkdir(resolve(process.cwd(), 'test/runs'), { recursive: true });
      await writeFile(
        database.markerPath,
        JSON.stringify({ databaseName: database.databaseName }),
        { encoding: 'utf8', flag: 'wx' }
      );
    } catch (error) {
      await connection.query(`DROP DATABASE ${quotedIdentifier(database.databaseName)}`);
      throw error;
    }
  } finally {
    await connection.end();
  }
}

export async function dropPlaywrightTestDatabase(database: PlaywrightTestDatabase): Promise<void> {
  let marker: { databaseName?: string };
  try {
    marker = JSON.parse(await readFile(database.markerPath, 'utf8')) as { databaseName?: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (marker.databaseName !== database.databaseName) {
    throw new Error('TEST_DATABASE_MARKER_MISMATCH');
  }
  const connection = await mysql.createConnection(database.adminUrl);
  try {
    await connection.query(`DROP DATABASE ${quotedIdentifier(database.databaseName)}`);
    await unlink(database.markerPath);
  } finally {
    await connection.end();
  }
}
