import { randomUUID } from 'node:crypto';
import type { ServerDatabase } from '../database.js';

import type {
  EnvironmentSecretScope,
  EnvironmentSecretSummary
} from '@myagentroam/server-core/environment-secret-contracts';
export type {
  EnvironmentSecretScope,
  EnvironmentSecretSummary,
  OrganizationSecretVisibility
} from '@myagentroam/server-core/environment-secret-contracts';

type SecretRow = Record<string, string | number | bigint | Uint8Array | null>;

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRET_VALUE_BYTES = 16 * 1024;
const MAX_STORED_SECRETS_PER_SCOPE = 128;
const MAX_EFFECTIVE_SECRETS = 128;
const MAX_EFFECTIVE_BYTES = 64 * 1024;

export class EnvironmentSecretService {
  constructor(private readonly database: ServerDatabase) {}

  list(user: {
    readonly userId: number;
    readonly isAdmin: boolean;
  }): readonly EnvironmentSecretSummary[] {
    const rows = this.database.raw
      .prepare(
        `SELECT id, scope, name, value, node_id, created_at, updated_at
         FROM environment_secrets
         WHERE owner_user_id = ?
         ORDER BY CASE scope WHEN 'PERSONAL' THEN 1 WHEN 'NODE' THEN 2 ELSE 3 END, name, id`
      )
      .all(user.userId) as SecretRow[];
    return rows.map(summary);
  }

  create(
    user: { readonly userId: number; readonly isAdmin: boolean },
    input: {
      readonly scope: EnvironmentSecretScope;
      readonly name: string;
      readonly value: string;
      readonly nodeId?: string;
    }
  ): EnvironmentSecretSummary {
    this.assertWrite(user, input.scope, input.nodeId);
    assertNameAndValue(input.name, input.value);
    this.assertStoredLimit(user.userId, input.scope, input.nodeId);
    const id = randomUUID();
    if (input.scope === 'ORGANIZATION') throw new Error('SECRET_SCOPE_INVALID');
    const ownerUserId = user.userId;
    const nodeId = input.scope === 'NODE' ? input.nodeId! : null;
    const now = Date.now();
    this.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO environment_secrets
            (id, scope, owner_user_id, node_id, name, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.scope, ownerUserId, nodeId, input.name, input.value, now, now);
      this.database.audit({
        eventType: 'environment_secret_created',
        actorUserId: user.userId,
        metadata: JSON.stringify({ secretId: id, scope: input.scope, name: input.name, nodeId })
      });
    });
    return {
      id,
      scope: input.scope,
      name: input.name,
      value: input.value,
      nodeId,
      workspaceId: null,
      organizationId: null,
      visibility: null,
      createdAt: now,
      updatedAt: now
    };
  }

  replace(
    user: { readonly userId: number; readonly isAdmin: boolean },
    id: string,
    value: string
  ): EnvironmentSecretSummary {
    assertValue(value);
    const row = this.requireWritable(user, id);
    const scope = scopeValue(row.scope);
    const nodeId = typeof row.node_id === 'string' ? row.node_id : null;
    const name = stringValue(row, 'name');
    const now = Date.now();
    this.transaction(() => {
      this.database.raw
        .prepare('UPDATE environment_secrets SET value = ?, updated_at = ? WHERE id = ?')
        .run(value, now, id);
      this.database.audit({
        eventType: 'environment_secret_replaced',
        actorUserId: user.userId,
        metadata: JSON.stringify({ secretId: id, scope, name, nodeId })
      });
    });
    return {
      id,
      scope,
      name,
      value,
      nodeId,
      workspaceId: null,
      organizationId: null,
      visibility: null,
      createdAt: numberValue(row, 'created_at'),
      updatedAt: now
    };
  }

  remove(user: { readonly userId: number; readonly isAdmin: boolean }, id: string): boolean {
    const row = this.requireWritable(user, id);
    this.transaction(() => {
      const result = this.database.raw
        .prepare('DELETE FROM environment_secrets WHERE id = ?')
        .run(id);
      if (result.changes === 0) throw new Error('SECRET_NOT_FOUND');
      this.database.audit({
        eventType: 'environment_secret_deleted',
        actorUserId: user.userId,
        metadata: JSON.stringify({
          secretId: id,
          scope: row.scope,
          name: row.name,
          nodeId: row.node_id
        })
      });
    });
    return true;
  }

  resolve(userId: number, nodeId: string, _workspaceId?: string): Readonly<Record<string, string>> {
    if (!this.database.userOwnsNode(userId, nodeId)) throw new Error('NODE_FORBIDDEN');
    const rows = this.database.raw
      .prepare(
        `SELECT id, scope, owner_user_id, node_id, name, value, created_at, updated_at
         FROM environment_secrets
         WHERE (scope = 'NODE' AND node_id = ?) OR (scope = 'PERSONAL' AND owner_user_id = ?)
         ORDER BY CASE scope WHEN 'NODE' THEN 1 ELSE 2 END, id`
      )
      .all(nodeId, userId) as SecretRow[];
    if (rows.length > 0 && !supportsSecretEnvironment(this.database, nodeId))
      throw new Error('CAPABILITY_VERSION_UNSUPPORTED');
    const environment: Record<string, string> = {};
    for (const row of rows) {
      const name = stringValue(row, 'name');
      const value = stringValue(row, 'value');
      environment[name] = value;
    }
    const entries = Object.entries(environment);
    if (entries.length > MAX_EFFECTIVE_SECRETS)
      throw new Error('SECRET_ENVIRONMENT_LIMIT_EXCEEDED');
    const bytes = entries.reduce(
      (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value),
      0
    );
    if (bytes > MAX_EFFECTIVE_BYTES) throw new Error('SECRET_ENVIRONMENT_LIMIT_EXCEEDED');
    return environment;
  }

  private assertStoredLimit(userId: number, scope: EnvironmentSecretScope, nodeId?: string): void {
    const row = this.database.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM environment_secrets
         WHERE scope = ? AND
           ((? = 'PERSONAL' AND owner_user_id = ?) OR (? = 'NODE' AND node_id = ?))`
      )
      .get(scope, scope, userId, scope, nodeId ?? null) as SecretRow;
    if (numberValue(row, 'count') >= MAX_STORED_SECRETS_PER_SCOPE)
      throw new Error('SECRET_SCOPE_LIMIT_EXCEEDED');
  }

  private assertWrite(
    user: { readonly userId: number; readonly isAdmin: boolean },
    scope: EnvironmentSecretScope,
    nodeId?: string
  ): void {
    if (scope === 'ORGANIZATION' || scope === 'WORKSPACE') throw new Error('SECRET_SCOPE_INVALID');
    if (scope === 'PERSONAL') {
      if (nodeId !== undefined) throw new Error('SECRET_SCOPE_INVALID');
      return;
    }
    if (typeof nodeId !== 'string' || !this.database.userOwnsNode(user.userId, nodeId))
      throw new Error('NODE_FORBIDDEN');
    if (!supportsSecretEnvironment(this.database, nodeId))
      throw new Error('CAPABILITY_VERSION_UNSUPPORTED');
  }

  private requireWritable(
    user: { readonly userId: number; readonly isAdmin: boolean },
    id: string
  ): SecretRow {
    const row = this.database.raw
      .prepare('SELECT * FROM environment_secrets WHERE id = ?')
      .get(id) as SecretRow | undefined;
    if (row === undefined) throw new Error('SECRET_NOT_FOUND');
    scopeValue(row.scope);
    if (row.owner_user_id !== user.userId) throw new Error('SECRET_NOT_FOUND');
    return row;
  }

  private transaction<T>(operation: () => T): T {
    this.database.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

function supportsSecretEnvironment(database: ServerDatabase, nodeId: string): boolean {
  const node = database.listNodes().find((candidate) => candidate.id === nodeId);
  if (node === undefined) return false;
  try {
    const metadata = JSON.parse(node.metadata) as { readonly nodeAppVersion?: unknown };
    if (typeof metadata.nodeAppVersion !== 'string') return false;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(metadata.nodeAppVersion);
    if (match === null) return false;
    const version = match.slice(1).map(Number);
    if (!version.every(Number.isSafeInteger)) return false;
    return version[0]! > 0 || version[1]! > 1 || (version[1] === 1 && version[2]! >= 4);
  } catch {
    return false;
  }
}

function assertNameAndValue(name: string, value: string): void {
  if (!ENVIRONMENT_NAME.test(name)) throw new Error('SECRET_NAME_INVALID');
  assertValue(value);
}

function assertValue(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value) > MAX_SECRET_VALUE_BYTES
  )
    throw new Error('SECRET_VALUE_INVALID');
}

function scopeValue(value: unknown): EnvironmentSecretScope {
  if (value !== 'PERSONAL' && value !== 'ORGANIZATION' && value !== 'NODE')
    throw new Error('DATABASE_VALUE_INVALID:scope');
  return value;
}

function stringValue(row: SecretRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}

function numberValue(row: SecretRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`DATABASE_VALUE_INVALID:${key}`);
  return value;
}

function summary(row: SecretRow): EnvironmentSecretSummary {
  return {
    id: stringValue(row, 'id'),
    scope: scopeValue(row.scope),
    name: stringValue(row, 'name'),
    value: stringValue(row, 'value'),
    nodeId: typeof row.node_id === 'string' ? row.node_id : null,
    workspaceId: null,
    organizationId: null,
    visibility: null,
    createdAt: numberValue(row, 'created_at'),
    updatedAt: numberValue(row, 'updated_at')
  };
}
