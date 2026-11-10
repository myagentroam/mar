import type { AuditEvent } from './audit.js';
import {
  emitAuditAfterCommit,
  commitMysqlAudits,
  discardMysqlAudits,
  resourceAuditEvent
} from './audit.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ResourceOwnership } from '@myagentroam/protocol';
import type { StoredNode } from './node-identity.js';
import type { StoredNodeUpgrade } from './node-upgrade-progress.js';
import { lockMysqlUsers } from './mysql-reference-store.js';
export interface NodeIdentityAuditEvent extends AuditEvent {
  readonly eventType:
    | 'node_registration_token_created'
    | 'node_registered'
    | 'node_display_name_updated'
    | 'node_display_name_cleared'
    | 'node_revoked'
    | 'node_deleted';
  readonly actorUserId?: number;
  readonly nodeId?: string;
}
export interface MysqlNodeIdentityOptions {
  readonly now?: () => number;
  readonly lockOwnership: (
    connection: PoolConnection,
    ownership: ResourceOwnership
  ) => Promise<void>;
  readonly audit: (connection: PoolConnection, event: NodeIdentityAuditEvent) => Promise<void>;
  readonly cleanupNodeResources?: (connection: PoolConnection, nodeId: string) => Promise<void>;
}
export class MysqlNodeIdentityStorage {
  private readonly now: () => number;
  constructor(
    private readonly raw: Pool,
    private readonly options: MysqlNodeIdentityOptions
  ) {
    this.now = options.now ?? Date.now;
  }
  private recordAudit(connection: PoolConnection, event: NodeIdentityAuditEvent): void {
    emitAuditAfterCommit({ audit: () => this.options.audit(connection, event) }, connection, event);
  }

  async createNodeRegistrationToken(
    userId: number,
    ttlMs = 10 * 60 * 1000,
    ownership: ResourceOwnership = { ownerType: 'PERSONAL', ownerUserId: userId },
    displayName: string | null = null,
    transaction?: PoolConnection
  ): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken();
    const timestamp = this.now();
    const expiresAt = timestamp + ttlMs;
    const connection = transaction ?? (await this.raw.getConnection());
    try {
      if (transaction === undefined) await connection.beginTransaction();
      await this.options.lockOwnership(connection, ownership);
      await lockMysqlUsers(connection, [
        userId,
        ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null
      ]);
      await connection.execute(
        `INSERT INTO node_registration_tokens
         (token_hash,created_by_user_id,owner_type,owner_user_id,owner_organization_id,display_name,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          sha256(token),
          userId,
          ownership.ownerType,
          ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null,
          ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null,
          displayName,
          timestamp,
          expiresAt
        ]
      );
      this.recordAudit(connection, {
        eventType: 'node_registration_token_created',
        actorUserId: userId,
        ...(displayName === null ? {} : { targetName: displayName }),
        ...(ownership.ownerType === 'ORGANIZATION'
          ? { organizationId: ownership.ownerOrganizationId }
          : {}),
        metadata: JSON.stringify({ ownerType: ownership.ownerType })
      });
      if (transaction === undefined) {
        await connection.commit();
        commitMysqlAudits(connection);
      }
    } catch (error) {
      if (transaction === undefined) {
        discardMysqlAudits(connection);
        await connection.rollback();
      }
      throw error;
    } finally {
      if (transaction === undefined) connection.release();
    }
    return { token, expiresAt };
  }

  /** Recover only an unused personal token; never infer a lost registration result. */
  async recoverPersonalNodeRegistrationToken(
    token: string,
    userId: number,
    ttlMs: number
  ): Promise<{ token: string; expiresAt: number } | undefined> {
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT expires_at,display_name FROM node_registration_tokens
         WHERE token_hash=? AND used_at IS NULL AND created_by_user_id=?
         AND owner_type='PERSONAL' AND owner_user_id=? AND owner_organization_id IS NULL FOR UPDATE`,
        [sha256(token), userId, userId]
      );
      const row = rows[0];
      if (!row) {
        await connection.rollback();
        return undefined;
      }
      const expiresAt = Number(row['expires_at']);
      const result =
        expiresAt > this.now()
          ? { token, expiresAt }
          : await this.createNodeRegistrationToken(
              userId,
              ttlMs,
              { ownerType: 'PERSONAL', ownerUserId: userId },
              row['display_name'] == null ? null : String(row['display_name']),
              connection
            );
      // Keep the expired, unusable row so a failed local file write can retry safely.
      await connection.commit();
      commitMysqlAudits(connection);
      return result;
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async registerNode(
    token: string,
    input: { readonly metadata: string },
    registeredAddress = 'unknown'
  ): Promise<{ nodeId: string; credential: string } | undefined> {
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const timestamp = this.now();
      const [tokenRows] = await connection.execute<RowDataPacket[]>(
        `SELECT created_by_user_id,owner_type,owner_user_id,owner_organization_id,display_name
         FROM node_registration_tokens
         WHERE token_hash=? AND used_at IS NULL AND expires_at>? FOR UPDATE`,
        [sha256(token), timestamp]
      );
      const tokenRow = tokenRows[0];
      if (!tokenRow) {
        discardMysqlAudits(connection);
        await connection.rollback();
        return undefined;
      }
      await this.options.lockOwnership(
        connection,
        tokenRow['owner_type'] === 'ORGANIZATION'
          ? {
              ownerType: 'ORGANIZATION',
              ownerOrganizationId: Number(tokenRow['owner_organization_id'])
            }
          : { ownerType: 'PERSONAL', ownerUserId: Number(tokenRow['owner_user_id']) }
      );
      const nodeId = randomUUID();
      await lockMysqlUsers(connection, [
        Number(tokenRow['created_by_user_id']),
        tokenRow['owner_type'] === 'PERSONAL' ? Number(tokenRow['owner_user_id']) : null
      ]);
      const credential = randomToken();
      await connection.execute(
        `INSERT INTO nodes
         (id,registered_by_user_id,owner_type,owner_user_id,owner_organization_id,
          display_name,registered_address,metadata,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          nodeId,
          Number(tokenRow['created_by_user_id']),
          tokenRow['owner_type'],
          tokenRow['owner_user_id'],
          tokenRow['owner_organization_id'],
          tokenRow['display_name'],
          registeredAddress,
          input.metadata,
          timestamp,
          timestamp
        ]
      );
      await connection.execute(
        'INSERT INTO node_credentials (node_id,credential_hash,created_at) VALUES (?,?,?)',
        [nodeId, sha256(credential), timestamp]
      );
      await connection.execute('UPDATE node_registration_tokens SET used_at=? WHERE token_hash=?', [
        timestamp,
        sha256(token)
      ]);
      this.recordAudit(connection, {
        eventType: 'node_registered',
        actorUserId: Number(tokenRow['created_by_user_id']),
        targetName: String(tokenRow['display_name'] ?? nodeId),
        ...(tokenRow['owner_organization_id'] == null
          ? {}
          : { organizationId: Number(tokenRow['owner_organization_id']) }),
        metadata: JSON.stringify({ ownerType: tokenRow['owner_type'] }),
        nodeId
      });
      await connection.commit();
      commitMysqlAudits(connection);
      return { nodeId, credential };
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async authenticateNode(nodeId: string, credential: string): Promise<StoredNode | undefined> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      `SELECT n.*,c.credential_hash,c.revoked_at FROM nodes n
       JOIN node_credentials c ON c.node_id=n.id WHERE n.id=?`,
      [nodeId]
    );
    const row = rows[0];
    if (
      !row ||
      row['revoked_at'] !== null ||
      Boolean(row['disabled']) ||
      row['credential_hash'] !== sha256(credential)
    )
      return undefined;
    return mysqlStoredNode(row);
  }

  async updateNodeUpgrade<T>(
    nodeId: string,
    update: (current: StoredNodeUpgrade | null) => {
      readonly next: StoredNodeUpgrade | null;
      readonly result: T;
    }
  ): Promise<T> {
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT disabled,upgrade_snapshot FROM nodes WHERE id=? FOR UPDATE',
        [nodeId]
      );
      const row = rows[0];
      if (!row || Boolean(row['disabled'])) throw new Error('NODE_NOT_FOUND');
      const rawSnapshot: unknown = row['upgrade_snapshot'];
      const current =
        rawSnapshot === null
          ? null
          : ((typeof rawSnapshot === 'string'
              ? JSON.parse(rawSnapshot)
              : rawSnapshot) as StoredNodeUpgrade);
      const { next, result } = update(current);
      if (next !== current) {
        await connection.execute('UPDATE nodes SET upgrade_snapshot=? WHERE id=?', [
          next === null ? null : JSON.stringify(next),
          nodeId
        ]);
      }
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateNodeHeartbeat(
    nodeId: string,
    capabilities?: { readonly metadata: string }
  ): Promise<void> {
    await this.raw.execute(
      `UPDATE nodes SET last_heartbeat_at=?,metadata=COALESCE(?,metadata),updated_at=?
       WHERE id=?`,
      [this.now(), capabilities?.metadata ?? null, this.now(), nodeId]
    );
  }

  async listNodes(): Promise<readonly StoredNode[]> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      'SELECT * FROM nodes ORDER BY created_at,id'
    );
    return rows.map(mysqlStoredNode);
  }

  async listNodesForUser(userId: number): Promise<readonly StoredNode[]> {
    const [rows] = await this.raw.execute<RowDataPacket[]>(
      "SELECT * FROM nodes WHERE owner_type='PERSONAL' AND owner_user_id=? ORDER BY created_at,id",
      [userId]
    );
    return rows.map(mysqlStoredNode);
  }

  async updateNodeDisplayName(
    nodeId: string,
    displayName: string | null,
    actorUserId?: number
  ): Promise<StoredNode | undefined> {
    return this.updateNodeField(
      nodeId,
      'display_name',
      displayName,
      displayName === null ? 'node_display_name_cleared' : 'node_display_name_updated',
      actorUserId
    );
  }

  private async updateNodeField(
    nodeId: string,
    column: 'display_name',
    value: string | null,
    eventType: NodeIdentityAuditEvent['eventType'],
    actorUserId?: number
  ): Promise<StoredNode | undefined> {
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM nodes WHERE id=? FOR UPDATE',
        [nodeId]
      );
      const before = rows[0];
      if (!before) {
        await connection.rollback();
        return undefined;
      }
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE nodes SET ${column}=?,updated_at=? WHERE id=?`,
        [value, this.now(), nodeId]
      );
      if (result.affectedRows !== 1) {
        discardMysqlAudits(connection);
        await connection.rollback();
        return undefined;
      }
      this.recordAudit(
        connection,
        resourceAuditEvent(
          {
            eventType,
            nodeId,
            targetType: 'NODE',
            targetId: nodeId,
            targetName: String(before['display_name'] ?? nodeId),
            ...(actorUserId === undefined ? {} : { actorUserId })
          },
          before,
          { before: { name: before['display_name'] }, after: { name: value } }
        )
      );
      const updated = mysqlStoredNode({ ...before, [column]: value } as RowDataPacket);
      await connection.commit();
      commitMysqlAudits(connection);
      return updated;
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async revokeNode(nodeId: string, actorUserId?: number): Promise<boolean> {
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT id,display_name,owner_type,owner_organization_id FROM nodes WHERE id=? FOR UPDATE',
        [nodeId]
      );
      const before = rows[0];
      if (!before) {
        await connection.rollback();
        return false;
      }
      const [result] = await connection.execute<ResultSetHeader>(
        'UPDATE nodes SET disabled=TRUE,updated_at=? WHERE id=?',
        [this.now(), nodeId]
      );
      await connection.execute(
        'UPDATE node_credentials SET revoked_at=? WHERE node_id=? AND revoked_at IS NULL',
        [this.now(), nodeId]
      );
      if (result.affectedRows === 1)
        this.recordAudit(
          connection,
          resourceAuditEvent(
            {
              eventType: 'node_revoked',
              nodeId,
              targetType: 'NODE',
              targetId: nodeId,
              targetName: String(before['display_name'] ?? nodeId),
              ...(actorUserId === undefined ? {} : { actorUserId })
            },
            before
          )
        );
      await connection.commit();
      commitMysqlAudits(connection);
      return result.affectedRows === 1;
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteNode(nodeId: string, actorUserId?: number): Promise<boolean> {
    const connection = await this.raw.getConnection();
    try {
      await connection.beginTransaction();
      const deleted = await this.deleteNodeWithConnection(connection, nodeId, actorUserId);
      await connection.commit();
      commitMysqlAudits(connection);
      return deleted;
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /** Called inside the caller's transaction, including account deletion. */
  async deleteNodeWithConnection(
    connection: PoolConnection,
    nodeId: string,
    actorUserId?: number
  ): Promise<boolean> {
    const [nodeRows] = await connection.execute<RowDataPacket[]>(
      'SELECT id,display_name,owner_type,owner_organization_id FROM nodes WHERE id=? FOR UPDATE',
      [nodeId]
    );
    if (nodeRows.length === 0) {
      return false;
    }
    const [templates] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM conversation_templates WHERE source_node_id=?
       OR source_workspace_id IN (SELECT workspace_id FROM workspaces WHERE node_id=?)
       LIMIT 1 FOR SHARE`,
      [nodeId, nodeId]
    );
    if (templates.length > 0)
      throw Object.assign(new Error('NODE_IN_USE'), {
        publicDetails:
          'A conversation template still references this Node or one of its workspaces.'
      });
    await connection.execute('SELECT workspace_id FROM workspaces WHERE node_id=? FOR UPDATE', [
      nodeId
    ]);
    await this.options.cleanupNodeResources?.(connection, nodeId);
    await connection.execute(
      `INSERT INTO workspace_tombstones (workspace_id,deleted_at)
         SELECT workspace_id,? FROM workspaces WHERE node_id=?
         ON DUPLICATE KEY UPDATE deleted_at=VALUES(deleted_at)`,
      [this.now(), nodeId]
    );
    this.recordAudit(connection, {
      eventType: 'node_deleted',
      nodeId,
      targetName: String(nodeRows[0]?.['display_name'] ?? nodeId),
      ...(nodeRows[0]?.['owner_organization_id'] == null
        ? {}
        : { organizationId: Number(nodeRows[0]['owner_organization_id']) }),
      metadata: JSON.stringify({ ownerType: nodeRows[0]?.['owner_type'] }),
      ...(actorUserId === undefined ? {} : { actorUserId })
    });
    await connection.execute(
      `DELETE secret FROM environment_secrets secret
        LEFT JOIN workspaces workspace ON workspace.workspace_id=secret.workspace_id
        WHERE secret.node_id=? OR workspace.node_id=?`,
      [nodeId, nodeId]
    );
    await connection.execute('DELETE FROM session_shares WHERE node_id=?', [nodeId]);
    await connection.execute('DELETE FROM workspaces WHERE node_id=?', [nodeId]);
    await connection.execute('DELETE FROM node_credentials WHERE node_id=?', [nodeId]);
    const [result] = await connection.execute<ResultSetHeader>('DELETE FROM nodes WHERE id=?', [
      nodeId
    ]);
    return result.affectedRows === 1;
  }
}
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
function mysqlStoredNode(row: RowDataPacket): StoredNode {
  return {
    id: String(row['id']),
    ownerUserId: Number(row['owner_user_id'] ?? row['registered_by_user_id']),
    displayName: row['display_name'] === null ? null : String(row['display_name']),
    registeredAddress: String(row['registered_address']),
    metadata:
      typeof row['metadata'] === 'string' ? row['metadata'] : JSON.stringify(row['metadata']),
    disabled: Boolean(row['disabled']),
    lastHeartbeatAt: row['last_heartbeat_at'] === null ? null : Number(row['last_heartbeat_at'])
  };
}
