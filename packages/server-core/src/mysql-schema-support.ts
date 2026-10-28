import { createHash } from 'node:crypto';
import type { DatabaseIdentityReader } from './database-identity.js';
import type { MysqlMigration } from './mysql-migration-contracts.js';

export type MysqlSchema = Readonly<Record<string, string>>;

/** Preserve released DDL while projecting the current physical-key-free schema. */
export function mysqlSchemaWithoutForeignKeys(schema: MysqlSchema): MysqlSchema {
  return Object.fromEntries(
    Object.entries(schema).map(([table, sql]) => [
      table,
      sql
        .split('\n')
        .filter((line) => !/^\s*CONSTRAINT `[^`]+` FOREIGN KEY\b/u.test(line))
        .join('\n')
        .replace(/,\n\) ENGINE/u, '\n) ENGINE')
    ])
  );
}

/** Validate logical associations declared by the immutable pre-removal schema. */
export async function validateMysqlReferences(
  connection: DatabaseIdentityReader,
  schema: MysqlSchema
): Promise<void> {
  const pattern =
    /FOREIGN KEY \(`([a-z][a-z0-9_]*)`\) REFERENCES `([a-z][a-z0-9_]*)` \(`([a-z][a-z0-9_]*)`\)/gu;
  for (const [table, sql] of Object.entries(schema)) {
    if (!/^[a-z][a-z0-9_]+$/u.test(table))
      throw new Error('SERVER_DATABASE_SCHEMA_CATALOG_INVALID');
    for (const match of sql.matchAll(pattern)) {
      const [, column, parent, key] = match;
      const [rows] = await connection.query(`SELECT 1 AS orphan FROM \`${table}\` child
        LEFT JOIN \`${parent}\` parent ON parent.\`${key}\`=child.\`${column}\`
        WHERE child.\`${column}\` IS NOT NULL AND parent.\`${key}\` IS NULL LIMIT 1`);
      if (!Array.isArray(rows) || rows.length !== 0)
        throw Object.assign(new Error('SERVER_DATABASE_REFERENCE_INVALID'), {
          publicDetails: `The logical reference ${table}.${column} points to a missing ${parent}.${key} record.`
        });
    }
  }
}

/** DDL may partially commit; retry only the constraints still present on owned tables. */
export async function removeMysqlForeignKeys(
  connection: DatabaseIdentityReader,
  releasedSchema: MysqlSchema
): Promise<void> {
  const target = mysqlSchemaWithoutForeignKeys(releasedSchema);
  // Validate all owned structures and data before issuing the first non-rollbackable DDL.
  for (const [table, expected] of Object.entries(target)) {
    const [rows] = await connection.query(`SHOW CREATE TABLE \`${table}\``);
    const actual = (rows as { 'Create Table': unknown }[])[0]?.['Create Table'];
    if (
      typeof actual !== 'string' ||
      normalizeMysqlTableDefinition(mysqlSchemaWithoutForeignKeys({ [table]: actual })[table]!) !==
        normalizeMysqlTableDefinition(expected)
    )
      throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
    const declaredKeys = new Set(
      releasedSchema[table]!.split('\n')
        .filter((line) => /\bFOREIGN KEY\b/u.test(line))
        .map((line) => normalizeMysqlTableDefinition(line))
    );
    if (
      actual
        .split('\n')
        .filter((line) => /\bFOREIGN KEY\b/u.test(line))
        .some((line) => !declaredKeys.has(normalizeMysqlTableDefinition(line)))
    )
      throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
  }
  await validateMysqlReferences(connection, releasedSchema);
  const [rows] =
    await connection.query(`SELECT TABLE_NAME,CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='FOREIGN KEY' ORDER BY TABLE_NAME,CONSTRAINT_NAME`);
  if (!Array.isArray(rows)) throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
  const owned = new Map<string, string[]>();
  for (const row of rows as { TABLE_NAME: string; CONSTRAINT_NAME: string }[]) {
    if (typeof row?.TABLE_NAME !== 'string' || typeof row?.CONSTRAINT_NAME !== 'string')
      throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
    if (!Object.hasOwn(releasedSchema, row.TABLE_NAME)) continue;
    if (!/^[a-z][a-z0-9_]+$/iu.test(row.CONSTRAINT_NAME))
      throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
    const names = owned.get(row.TABLE_NAME) ?? [];
    names.push(row.CONSTRAINT_NAME);
    owned.set(row.TABLE_NAME, names);
  }
  for (const [table, names] of owned)
    await connection.query(
      `ALTER TABLE \`${table}\` ${names.map((name) => `DROP FOREIGN KEY \`${name}\``).join(', ')}`
    );
  await validateMysqlSchema(connection, target);
}

export async function assertMysqlNoForeignKeys(connection: DatabaseIdentityReader): Promise<void> {
  const [rows] =
    await connection.query(`SELECT 1 AS physical_key FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='FOREIGN KEY' LIMIT 1`);
  if (!Array.isArray(rows) || rows.length !== 0)
    throw new Error('SERVER_DATABASE_FOREIGN_KEYS_UNSUPPORTED');
}

export function normalizeMysqlTableDefinition(sql: string): string {
  return sql
    .replace(/ AUTO_INCREMENT=\d+/gu, '')
    .split('\n')
    .map((line) => normalizeMysqlDefinitionLine(line.trim().replace(/,$/u, '')))
    .sort()
    .join('\n');
}

function normalizeMysqlDefinitionLine(line: string): string {
  const checkIndex = line.indexOf(' CHECK ');
  if (checkIndex === -1) return line;
  const expressionIndex = line.indexOf('(', checkIndex + ' CHECK '.length);
  if (expressionIndex === -1) return line;
  let expression = line.slice(expressionIndex);
  while (hasRedundantOuterParentheses(expression)) expression = expression.slice(1, -1);
  return `${line.slice(0, expressionIndex)}(${expression})`;
}

function hasRedundantOuterParentheses(value: string): boolean {
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let depth = 0;
  let quote: "'" | '"' | '`' | undefined;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) {
        if (value[index + 1] === quote) index++;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth++;
    else if (character === ')') {
      depth--;
      if (depth === 0 && index !== value.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && quote === undefined;
}

export async function validateMysqlSchema(
  connection: DatabaseIdentityReader,
  schema: MysqlSchema
): Promise<void> {
  for (const [name, expected] of Object.entries(schema)) {
    if (!/^[a-z][a-z0-9_]+$/u.test(name)) throw new Error('SERVER_DATABASE_SCHEMA_CATALOG_INVALID');
    const [rows] = await connection.query(`SHOW CREATE TABLE \`${name}\``);
    const actual = (rows as { 'Create Table': unknown }[])[0]?.['Create Table'];
    if (
      typeof actual !== 'string' ||
      normalizeMysqlTableDefinition(actual) !== normalizeMysqlTableDefinition(expected)
    )
      throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
  }
}

export function createMysqlBaselineMigration(
  name: string,
  schema: MysqlSchema,
  minimumCoreVersion?: number,
  version = 1
): MysqlMigration {
  return {
    version,
    name,
    checksum: createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
    ...(minimumCoreVersion === undefined ? {} : { minimumCoreVersion }),
    up: async (connection) => {
      for (const [table, statement] of Object.entries(schema)) {
        await connection.query(statement.replace(/^CREATE TABLE /u, 'CREATE TABLE IF NOT EXISTS '));
        await validateMysqlSchema(connection, { [table]: statement });
      }
    }
  };
}
