import {
  emitAuditAfterCommit,
  emitAudit,
  resourceAuditEvent,
  commitMysqlAudits,
  discardMysqlAudits
} from '@myagentroam/server-core/audit';
import {
  lockMysqlUsers,
  withMysqlTransaction
} from '@myagentroam/server-core/mysql-reference-store';
import { normalizeWorkspaceGroupName } from '@myagentroam/server-core/workspace-group';
import type {
  WorkspaceResourcePolicy,
  WorkspaceUpdate
} from '@myagentroam/server-core/workspace-route-contracts';
import type { ResourceOwnership } from '@myagentroam/protocol';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';
import { ResourceOwnershipStore, storedOwnership } from './resource-ownership-store.js';
import { requireOwnershipManagement } from './resource-ownership-policy.js';
import { lockOrganizationReference, withOrganizationReference } from './organization-reference.js';
import { revokeOutOfScopeResourceGrants } from './resource-grant-scope.js';
import { validateWorkspacePlacement } from './workspace-ownership-rules.js';
import { hasDirectUserNodeGrant } from './node-grant-facts.js';

interface ResourceMutationPolicy extends Pick<
  WorkspaceResourcePolicy,
  'assertCanUnregisterWorkspace'
> {
  assertCanUnregisterWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    connection?: PoolConnection
  ): Promise<void>;
  resolveWorkspaceOwnership(
    actorUserId: number,
    nodeId: string,
    ownership?: ResourceOwnership,
    connection?: PoolConnection
  ): Promise<ResourceOwnership>;
  canManageNode(actorUserId: number, nodeId: string, connection?: PoolConnection): Promise<boolean>;
  canRegisterWorkspace(
    actorUserId: number,
    nodeId: string,
    connection?: PoolConnection
  ): Promise<boolean>;
  assertOwnershipSelection(
    actorUserId: number,
    ownership: ResourceOwnership,
    connection?: Pick<PoolConnection, 'execute'>
  ): Promise<void>;
}

/** Owns resource registration and ownership-changing transactions. */
export class ResourceMutationService {
  private readonly ownership: ResourceOwnershipStore;
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly policy: ResourceMutationPolicy,
    private readonly now: () => number = Date.now
  ) {
    this.ownership = new ResourceOwnershipStore(database);
  }

  /** Register previously discovered legacy workspaces before projecting their visibility. */
  async backfillNodeWorkspaces<T extends { readonly id: string }>(
    nodeId: string,
    workspaces: readonly T[]
  ): Promise<void> {
    const node = await this.ownership.node(nodeId);
    if (node === undefined) throw new Error('NODE_NOT_FOUND');
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1);
      if (node.ownerType === 'PERSONAL') await lockMysqlUsers(connection, [node.ownerUserId]);
      const [nodeRows] = await connection.execute<RowDataPacket[]>(
        `SELECT owner_type,owner_user_id,owner_organization_id,legacy_ownership_backfill_pending
         FROM nodes WHERE id=? AND disabled=FALSE FOR UPDATE`,
        [nodeId]
      );
      const lockedNode = storedOwnership(nodeRows[0]);
      if (lockedNode === undefined) throw new Error('NODE_NOT_FOUND');
      if (lockedNode.ownerType === 'PERSONAL')
        await lockMysqlUsers(connection, [lockedNode.ownerUserId]);
      await lockOrganizationReference(
        connection,
        lockedNode.ownerType === 'ORGANIZATION' ? lockedNode.ownerOrganizationId : null
      );
      const [licenseRows] = await connection.execute<RowDataPacket[]>(
        'SELECT ever_activated FROM license_state WHERE singleton_id=1'
      );
      const mayBackfill =
        !licenseRows[0]?.['ever_activated'] || nodeRows[0]?.['legacy_ownership_backfill_pending'];
      for (const workspace of workspaces) {
        const [registeredRows] = await connection.execute<RowDataPacket[]>(
          'SELECT node_id FROM workspaces WHERE workspace_id=? FOR UPDATE',
          [workspace.id]
        );
        if (registeredRows.length > 0) {
          if (String(registeredRows[0]?.['node_id']) !== nodeId)
            throw new Error('WORKSPACE_ID_CONFLICT');
          continue;
        }
        const [tombstoneRows] = await connection.execute<RowDataPacket[]>(
          'SELECT workspace_id FROM workspace_tombstones WHERE workspace_id=?',
          [workspace.id]
        );
        if (tombstoneRows.length > 0) throw new Error('WORKSPACE_ID_REUSED');
        if (!mayBackfill) continue;
        const displayName = workspaceDisplayName(workspace);
        await connection.execute(
          `INSERT INTO workspaces
           (workspace_id,display_name,node_id,owner_type,owner_user_id,owner_organization_id,registered_at)
           VALUES (?,?,?,?,?,?,?)`,
          [
            workspace.id,
            displayName,
            nodeId,
            lockedNode.ownerType,
            lockedNode.ownerType === 'PERSONAL' ? lockedNode.ownerUserId : null,
            lockedNode.ownerType === 'ORGANIZATION' ? lockedNode.ownerOrganizationId : null,
            this.now()
          ]
        );
      }
      if (nodeRows[0]?.['legacy_ownership_backfill_pending'])
        await connection.execute(
          'UPDATE nodes SET legacy_ownership_backfill_pending=FALSE,updated_at=? WHERE id=?',
          [this.now(), nodeId]
        );
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async changeNodeOwnership(
    actorUserId: number,
    nodeId: string,
    ownership: ResourceOwnership
  ): Promise<void> {
    const current = await this.ownership.node(nodeId);
    if (current === undefined) throw new Error('NODE_NOT_FOUND');
    if (current.ownerType === 'PERSONAL' || ownership.ownerType === 'PERSONAL')
      throw new Error('PERSONAL_RESOURCE_OWNERSHIP_IMMUTABLE');
    await requireOwnershipManagement(this.authorization, actorUserId, current);
    await this.policy.assertOwnershipSelection(actorUserId, ownership);
    const [workspaceRows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT owner_organization_id FROM workspaces
       WHERE node_id=? AND owner_type='ORGANIZATION'`,
      [nodeId]
    );
    try {
      for (const row of workspaceRows)
        await validateWorkspacePlacement(this.database.raw, ownership, {
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: Number(row['owner_organization_id'])
        });
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE')
        throw nodeOwnershipWorkspacePlacementError();
      throw error;
    }
    await withOrganizationReference(
      this.database.raw,
      1,
      async (connection) => {
        await lockOrganizationReference(connection, ownership.ownerOrganizationId);
        const locked = await this.ownership.node(nodeId, false, connection, true);
        if (locked === undefined) throw new Error('NODE_NOT_FOUND');
        if (locked.ownerType !== 'ORGANIZATION')
          throw new Error('PERSONAL_RESOURCE_OWNERSHIP_IMMUTABLE');
        await requireOwnershipManagement(
          this.authorization,
          actorUserId,
          locked,
          'RESOURCE_MANAGE',
          connection
        );
        await this.policy.assertOwnershipSelection(actorUserId, ownership, connection);
        const [currentWorkspaces] = await connection.execute<RowDataPacket[]>(
          `SELECT owner_organization_id FROM workspaces WHERE node_id=? AND owner_type='ORGANIZATION' FOR SHARE`,
          [nodeId]
        );
        for (const row of currentWorkspaces)
          await validateWorkspacePlacement(connection, ownership, {
            ownerType: 'ORGANIZATION',
            ownerOrganizationId: Number(row['owner_organization_id'])
          });
        await connection.execute(
          `UPDATE nodes SET owner_organization_id=?,updated_at=?
       WHERE id=? AND owner_type='ORGANIZATION'`,
          [ownership.ownerOrganizationId, this.now(), nodeId]
        );
        emitAuditAfterCommit(
          this.database,
          connection,
          resourceAuditEvent(
            {
              eventType: 'node.ownership.changed',
              actorUserId,
              targetType: 'NODE',
              targetId: nodeId,
              nodeId
            },
            locked,
            {
              before: { ownerOrganizationId: locked.ownerOrganizationId },
              after: { ownerOrganizationId: ownership.ownerOrganizationId }
            }
          )
        );
        await revokeOutOfScopeResourceGrants(connection);
      },
      true
    );
  }

  async registerWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    ownership: ResourceOwnership,
    displayName = workspaceId
  ): Promise<void> {
    // Re-evaluate the actor's ownership entitlement after Node-side creation and
    // before persisting its Server registration. This prevents a revoked direct
    // Node grant from being reused with an ownership resolved before the revoke.
    const node = await this.ownership.node(nodeId);
    if (node === undefined) throw new Error('NODE_NOT_FOUND');
    const resolvedOwnership = await this.policy.resolveWorkspaceOwnership(
      actorUserId,
      nodeId,
      ownership
    );
    if (!sameOwnership(resolvedOwnership, ownership))
      throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1);
      if (node.ownerType === 'PERSONAL') await lockMysqlUsers(connection, [node.ownerUserId]);
      const lockedNode = await this.ownership.node(nodeId, false, connection, true);
      if (lockedNode === undefined) throw new Error('NODE_NOT_FOUND');
      if (!sameOwnership(node, lockedNode))
        throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
      if (lockedNode.ownerType === 'PERSONAL')
        await lockMysqlUsers(connection, [lockedNode.ownerUserId]);
      await lockOrganizationReference(
        connection,
        lockedNode.ownerType === 'ORGANIZATION' ? lockedNode.ownerOrganizationId : null
      );
      if (
        !(await this.policy.canManageNode(actorUserId, nodeId, connection)) &&
        !(await hasDirectUserNodeGrant(this.database, actorUserId, nodeId, connection, true))
      )
        throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
      const lockedOwnership = await this.policy.resolveWorkspaceOwnership(
        actorUserId,
        nodeId,
        ownership,
        connection
      );
      if (!sameOwnership(lockedOwnership, ownership))
        throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
      if (ownership.ownerType === 'PERSONAL')
        await lockMysqlUsers(connection, [ownership.ownerUserId]);
      else await lockOrganizationReference(connection, ownership.ownerOrganizationId);
      await validateWorkspacePlacement(connection, lockedNode, ownership);
      const [tombstones] = await connection.execute<RowDataPacket[]>(
        'SELECT workspace_id FROM workspace_tombstones WHERE workspace_id=? FOR UPDATE',
        [workspaceId]
      );
      if (tombstones.length > 0) throw new Error('WORKSPACE_ID_REUSED');
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT node_id FROM workspaces WHERE workspace_id=? FOR UPDATE',
        [workspaceId]
      );
      if (existing.length > 0) throw new Error('WORKSPACE_ID_CONFLICT');
      await connection.execute(
        `INSERT INTO workspaces
         (workspace_id,display_name,node_id,owner_type,owner_user_id,owner_organization_id,registered_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          workspaceId,
          displayName,
          nodeId,
          ownership.ownerType,
          ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null,
          ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null,
          this.now()
        ]
      );
      await connection.commit();
      commitMysqlAudits(connection);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'workspace.registered',
            actorUserId,
            targetType: 'WORKSPACE',
            targetId: workspaceId,
            nodeId,
            workspaceId
          },
          { ...ownership, displayName },
          {}
        )
      );
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateWorkspaceGroupName(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    groupName: string | null
  ): Promise<void> {
    const value = normalizeWorkspaceGroupName(groupName);
    const workspace = await withMysqlTransaction(this.database.raw, async (connection) => {
      if (!(await this.policy.canRegisterWorkspace(actorUserId, nodeId, connection)))
        throw new Error('WORKSPACE_FORBIDDEN');
      const current = await this.ownership.workspace(nodeId, workspaceId, connection, true);
      if (current === undefined) throw new Error('WORKSPACE_NOT_FOUND');
      const [result] = await connection.execute<ResultSetHeader>(
        'UPDATE workspaces SET group_name=? WHERE workspace_id=? AND node_id=?',
        [value, workspaceId, nodeId]
      );
      if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
      return current;
    });
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'workspace.group.updated',
          actorUserId,
          targetType: 'WORKSPACE',
          targetId: workspaceId,
          nodeId,
          workspaceId
        },
        workspace,
        { after: { groupName: value } }
      )
    );
  }

  async updateWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    update: WorkspaceUpdate
  ): Promise<void> {
    if (
      update.displayName !== undefined &&
      (!update.displayName.trim() || update.displayName.length > 255)
    )
      throw new Error('WORKSPACE_INVALID');
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      let node: ResourceOwnership | undefined;
      if (update.ownership !== undefined) {
        if (update.ownership.ownerType === 'ORGANIZATION') {
          await lockOrganizationReference(connection, 1, true);
          await lockOrganizationReference(connection, update.ownership.ownerOrganizationId);
        }
        const [nodeRows] = await connection.execute<RowDataPacket[]>(
          `SELECT owner_type,owner_user_id,owner_organization_id FROM nodes
           WHERE id=? AND disabled=FALSE FOR UPDATE`,
          [nodeId]
        );
        node = storedOwnership(nodeRows[0]);
        if (node === undefined) throw new Error('NODE_NOT_FOUND');
      }
      const current = await this.ownership.workspace(nodeId, workspaceId, connection, true);
      if (current === undefined) throw new Error('WORKSPACE_NOT_FOUND');
      await requireOwnershipManagement(
        this.authorization,
        actorUserId,
        current,
        'RESOURCE_MANAGE',
        connection
      );
      if (update.ownership !== undefined) {
        if (current.ownerType === 'PERSONAL' || update.ownership.ownerType === 'PERSONAL')
          throw new Error('PERSONAL_RESOURCE_OWNERSHIP_IMMUTABLE');
        await this.policy.assertOwnershipSelection(actorUserId, update.ownership, connection);
        await validateWorkspacePlacement(connection, node!, update.ownership);
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE workspaces SET owner_organization_id=?
           WHERE workspace_id=? AND node_id=? AND owner_type='ORGANIZATION'`,
          [update.ownership.ownerOrganizationId, workspaceId, nodeId]
        );
        if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
        await this.revokeResourceGrantsOutsideAuthority(
          'WORKSPACE',
          nodeId,
          workspaceId,
          update.ownership.ownerOrganizationId,
          connection
        );
      }
      if (update.displayName !== undefined) {
        const [result] = await connection.execute<ResultSetHeader>(
          'UPDATE workspaces SET display_name=? WHERE workspace_id=? AND node_id=?',
          [update.displayName, workspaceId, nodeId]
        );
        if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
      }
      await connection.commit();
      commitMysqlAudits(connection);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'workspace.updated',
            actorUserId,
            targetType: 'WORKSPACE',
            targetId: workspaceId,
            nodeId,
            workspaceId
          },
          current,
          {
            before: { name: current.displayName },
            after: {
              name: update.displayName,
              ownerOrganizationId:
                update.ownership?.ownerType === 'ORGANIZATION'
                  ? update.ownership.ownerOrganizationId
                  : undefined
            }
          }
        )
      );
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async unregisterWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<void> {
    await this.policy.assertCanUnregisterWorkspace(actorUserId, nodeId, workspaceId);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await this.policy.assertCanUnregisterWorkspace(actorUserId, nodeId, workspaceId, connection);
      const workspace = await this.ownership.workspace(nodeId, workspaceId, connection, true);
      if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
      await connection.execute(
        "DELETE FROM environment_secrets WHERE scope='WORKSPACE' AND node_id=? AND workspace_id=?",
        [nodeId, workspaceId]
      );
      await connection.execute(
        "DELETE FROM resource_grants WHERE resource_type='WORKSPACE' AND node_id=? AND workspace_id=?",
        [nodeId, workspaceId]
      );
      await connection.execute('DELETE FROM session_shares WHERE workspace_id=? AND node_id=?', [
        workspaceId,
        nodeId
      ]);
      const [result] = await connection.execute<ResultSetHeader>(
        'DELETE FROM workspaces WHERE workspace_id=? AND node_id=?',
        [workspaceId, nodeId]
      );
      if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
      await connection.execute(
        `INSERT INTO workspace_tombstones (workspace_id,deleted_at) VALUES (?,?)
         ON DUPLICATE KEY UPDATE deleted_at=VALUES(deleted_at)`,
        [workspaceId, this.now()]
      );
      await connection.commit();
      commitMysqlAudits(connection);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'workspace.unregistered',
            actorUserId,
            targetType: 'WORKSPACE',
            targetId: workspaceId,
            nodeId,
            workspaceId
          },
          workspace,
          {}
        )
      );
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async revokeResourceGrantsOutsideAuthority(
    resourceType: 'NODE' | 'WORKSPACE',
    nodeId: string,
    workspaceId: string | null,
    ownerOrganizationId: number,
    connection: Pick<PoolConnection, 'execute'> = this.database.raw
  ): Promise<void> {
    await connection.execute(
      `DELETE FROM resource_grants WHERE resource_key=?
       AND NOT EXISTS (
         WITH RECURSIVE ancestors AS (
           SELECT id,parent_organization_id FROM organizations WHERE id=?
           UNION ALL SELECT parent.id,parent.parent_organization_id FROM organizations parent
           JOIN ancestors child ON child.parent_organization_id=parent.id
         ) SELECT 1 FROM ancestors WHERE id=resource_grants.grant_scope_organization_id
       )`,
      [`${resourceType}:${nodeId}:${workspaceId ?? ''}`, ownerOrganizationId]
    );
  }
}

function sameOwnership(left: ResourceOwnership, right: ResourceOwnership): boolean {
  return (
    left.ownerType === right.ownerType &&
    (left.ownerType === 'PERSONAL'
      ? left.ownerUserId ===
        (right as Extract<ResourceOwnership, { ownerType: 'PERSONAL' }>).ownerUserId
      : left.ownerOrganizationId ===
        (right as Extract<ResourceOwnership, { ownerType: 'ORGANIZATION' }>).ownerOrganizationId)
  );
}

function nodeOwnershipWorkspacePlacementError(): Error & {
  readonly publicMessage: string;
  readonly publicDetails: string;
} {
  return Object.assign(new Error('NODE_OWNERSHIP_WORKSPACE_INCOMPATIBLE'), {
    publicMessage:
      "The Node can't be moved to the selected organization because one or more Workspaces would fall outside its organization subtree.",
    publicDetails:
      'Move each affected Workspace to the selected organization or one of its descendant organizations, then retry.'
  });
}

function workspaceDisplayName(workspace: { readonly id: string }): string {
  const path =
    'path' in workspace && typeof workspace.path === 'string' ? workspace.path : undefined;
  return path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace.id;
}
