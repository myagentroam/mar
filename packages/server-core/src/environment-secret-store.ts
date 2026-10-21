import {
  emitAuditAfterCommit,
  commitMysqlAudits,
  discardMysqlAudits,
  resourceAuditEvent
} from './audit.js';
import type { AuditObserver } from './audit.js';
import type { ResourceOwnership } from '@myagentroam/protocol';

import { lockMysqlUsers, lockMysqlNode, lockMysqlWorkspace } from './mysql-reference-store.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type {
  EnvironmentSecretActor as Actor,
  EnvironmentSecretScope,
  EnvironmentSecretSummary,
  EnvironmentSecretInput
} from './environment-secret-contracts.js';
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_SCOPE_SECRETS = 128;
export abstract class EnvironmentSecretStore {
  constructor(protected readonly database: { readonly raw: Pool } & Partial<AuditObserver>) {}
  protected abstract assertWrite(
    user: Actor,
    scope: EnvironmentSecretScope,
    nodeId?: string,
    organizationId?: number,
    workspaceId?: string
  ): Promise<void>;
  protected abstract lockScope(
    connection: PoolConnection,
    user: Actor,
    input: Pick<EnvironmentSecretInput, 'scope' | 'nodeId' | 'organizationId' | 'workspaceId'>
  ): Promise<ResourceOwnership>;
  protected abstract writableRow(
    connection: Pool | PoolConnection,
    user: Actor,
    id: string
  ): Promise<RowDataPacket>;
  async create(user: Actor, input: EnvironmentSecretInput): Promise<EnvironmentSecretSummary> {
    if (input.scope !== 'ORGANIZATION' && input.visibility !== undefined)
      throw new Error('SECRET_SCOPE_INVALID');
    if (input.scope !== 'WORKSPACE' && input.workspaceId !== undefined)
      throw new Error('SECRET_SCOPE_INVALID');
    await this.assertWrite(
      user,
      input.scope,
      input.nodeId,
      input.organizationId,
      input.workspaceId
    );
    assertNameAndValue(input.name, input.value);
    const ownerUserId = input.scope === 'PERSONAL' ? user.userId : null;
    const nodeId = input.scope === 'NODE' || input.scope === 'WORKSPACE' ? input.nodeId! : null;
    const workspaceId = input.scope === 'WORKSPACE' ? input.workspaceId! : null;
    const organizationId = input.scope === 'ORGANIZATION' ? input.organizationId! : null;
    const visibility = input.scope === 'ORGANIZATION' ? (input.visibility ?? 'PRIVATE') : null;
    const ownerKey = secretOwnerKey(input.scope, ownerUserId, organizationId, nodeId, workspaceId);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const ownership = await this.lockScope(connection, user, input);
      await lockMysqlUsers(connection, [ownerUserId]);
      if (nodeId !== null) await lockMysqlNode(connection, nodeId);
      if (workspaceId !== null) await lockMysqlWorkspace(connection, workspaceId, nodeId!);
      const [countRows] = await connection.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM environment_secrets WHERE owner_key=? FOR UPDATE',
        [ownerKey]
      );
      if (Number(countRows[0]?.['count']) >= MAX_SCOPE_SECRETS)
        throw new Error('SECRET_SCOPE_LIMIT_EXCEEDED');
      const id = randomUUID();
      const now = Date.now();
      await connection.execute(
        `INSERT INTO environment_secrets
         (id,name,secret_value,scope,owner_user_id,organization_id,visibility,node_id,workspace_id,owner_key,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          input.name,
          input.value,
          input.scope,
          ownerUserId,
          organizationId,
          visibility,
          nodeId,
          workspaceId,
          ownerKey,
          now,
          now
        ]
      );
      emitAuditAfterCommit(
        this.database,
        connection,
        resourceAuditEvent(
          {
            eventType: 'environment_secret_created',
            targetType: 'ENVIRONMENT_SECRET',
            targetId: id,
            targetName: input.name,
            actorUserId: user.userId
          },
          ownership,
          {
            secretId: id,
            scope: input.scope,
            name: input.name,
            nodeId,
            workspaceId
          }
        )
      );
      await connection.commit();
      commitMysqlAudits(connection);
      return {
        id,
        scope: input.scope,
        name: input.name,
        value: input.value,
        nodeId,
        workspaceId,
        organizationId,
        visibility,
        createdAt: now,
        updatedAt: now
      };
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async replace(user: Actor, id: string, value: string): Promise<EnvironmentSecretSummary> {
    assertValue(value);
    const authorizedRow = await this.writableRow(this.database.raw, user, id);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const { row, ownership } = await this.lockWritableRow(connection, user, id, authorizedRow);
      const now = Date.now();
      await connection.execute(
        'UPDATE environment_secrets SET secret_value=?,updated_at=? WHERE id=?',
        [value, now, id]
      );
      emitAuditAfterCommit(
        this.database,
        connection,
        resourceAuditEvent(
          {
            eventType: 'environment_secret_replaced',
            targetType: 'ENVIRONMENT_SECRET',
            targetId: id,
            targetName: String(row['name']),
            actorUserId: user.userId
          },
          ownership,
          {
            secretId: id,
            scope: row['scope'],
            name: row['name'],
            nodeId: row['node_id'],
            workspaceId: row['workspace_id']
          }
        )
      );
      await connection.commit();
      commitMysqlAudits(connection);
      return { ...secretSummary(row), value, updatedAt: now };
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async remove(user: Actor, id: string): Promise<boolean> {
    const authorizedRow = await this.writableRow(this.database.raw, user, id);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const { row, ownership } = await this.lockWritableRow(connection, user, id, authorizedRow);
      const [result] = await connection.execute<ResultSetHeader>(
        'DELETE FROM environment_secrets WHERE id=?',
        [id]
      );
      if (result.affectedRows !== 1) throw new Error('SECRET_NOT_FOUND');
      emitAuditAfterCommit(
        this.database,
        connection,
        resourceAuditEvent(
          {
            eventType: 'environment_secret_deleted',
            targetType: 'ENVIRONMENT_SECRET',
            targetId: id,
            targetName: String(row['name']),
            actorUserId: user.userId
          },
          ownership,
          {
            secretId: id,
            scope: row['scope'],
            name: row['name'],
            nodeId: row['node_id'],
            workspaceId: row['workspace_id']
          }
        )
      );
      await connection.commit();
      commitMysqlAudits(connection);
      return true;
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async lockWritableRow(
    connection: PoolConnection,
    user: Actor,
    id: string,
    authorizedRow: RowDataPacket
  ): Promise<{ row: RowDataPacket; ownership: ResourceOwnership }> {
    const ownership = await this.lockScope(connection, user, {
      scope: authorizedRow['scope'] as EnvironmentSecretScope,
      ...(authorizedRow['node_id'] == null ? {} : { nodeId: String(authorizedRow['node_id']) }),
      ...(authorizedRow['workspace_id'] == null
        ? {}
        : { workspaceId: String(authorizedRow['workspace_id']) }),
      ...(authorizedRow['organization_id'] == null
        ? {}
        : { organizationId: Number(authorizedRow['organization_id']) })
    });
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM environment_secrets WHERE id=? FOR UPDATE',
      [id]
    );
    const row = rows[0];
    const ownershipFields = [
      'scope',
      'owner_user_id',
      'organization_id',
      'node_id',
      'workspace_id',
      'owner_key'
    ];
    if (!row || ownershipFields.some((field) => row[field] !== authorizedRow[field]))
      throw new Error('SECRET_NOT_FOUND');
    return { row, ownership };
  }
}

function secretOwnerKey(
  scope: EnvironmentSecretScope,
  userId: number | null,
  organizationId: number | null,
  nodeId: string | null,
  workspaceId: string | null
): string {
  if (scope === 'WORKSPACE') return `WORKSPACE:${workspaceId}`;
  return `${scope}:${userId ?? ''}:${organizationId ?? ''}:${nodeId ?? ''}`;
}
function assertNameAndValue(name: string, value: string): void {
  if (!ENVIRONMENT_NAME.test(name)) throw new Error('SECRET_NAME_INVALID');
  assertValue(value);
}
function assertValue(value: string): void {
  if (!value || value.includes('\0') || Buffer.byteLength(value) > MAX_VALUE_BYTES)
    throw new Error('SECRET_VALUE_INVALID');
}
export function secretSummary(row: RowDataPacket): EnvironmentSecretSummary {
  return {
    id: String(row['id']),
    scope: row['scope'] as EnvironmentSecretScope,
    name: String(row['name']),
    value: String(row['secret_value']),
    nodeId: row['node_id'] === null ? null : String(row['node_id']),
    workspaceId: row['workspace_id'] == null ? null : String(row['workspace_id']),
    organizationId: row['organization_id'] === null ? null : Number(row['organization_id']),
    visibility:
      row['visibility'] === 'PRIVATE' || row['visibility'] === 'PUBLIC' ? row['visibility'] : null,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  };
}
