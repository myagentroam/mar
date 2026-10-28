import { expect, test } from '@playwright/test';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { prepareMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { ResourceAccessService } from '../../ee/server/src/rbac/resource-access-service.js';
import { ResourceMutationService } from '../../ee/server/src/rbac/resource-mutation-service.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

test('workspace mutations reject authorization revoked after preflight on real MySQL', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-workspace-race-${randomUUID()}`);
  await createPlaywrightTestDatabase(target);
  const pool = mysql.createPool(target.databaseUrl);
  try {
    await prepareMysqlDatabase(pool);
    const database = new MysqlServerDatabase(pool);
    await database.initialize();
    await pool.execute(
      "INSERT INTO organizations(id,name,parent_organization_id,created_at,updated_at) VALUES (2,'Test',1,1,1)"
    );
    await pool.execute(
      "INSERT INTO users(id,username,role,organization_id,created_at,updated_at) VALUES (2,'actor','ORG_ADMIN',2,1,1)"
    );
    await pool.execute(
      "INSERT INTO nodes(id,owner_type,owner_organization_id,registered_address,metadata,created_at,updated_at) VALUES ('node','ORGANIZATION',2,'test','{}',1,1)"
    );
    await pool.execute(
      "INSERT INTO workspaces(workspace_id,display_name,node_id,owner_type,owner_organization_id,registered_at) VALUES ('workspace','Original','node','ORGANIZATION',2,1)"
    );
    const authorization = new AuthorizationService(database);
    const resources = new ResourceAccessService(database, authorization);
    const policy = {
      canManageNode: resources.canManageNode.bind(resources),
      canRegisterWorkspace: resources.canRegisterWorkspace.bind(resources),
      assertOwnershipSelection: resources.assertOwnershipSelection.bind(resources),
      assertCanUnregisterWorkspace: resources.assertCanUnregisterWorkspace.bind(resources),
      resolveWorkspaceOwnership: resources.resolveWorkspaceOwnership.bind(resources)
    };
    const mutations = new ResourceMutationService(database, authorization, policy);
    const originalResolve = policy.resolveWorkspaceOwnership;
    policy.resolveWorkspaceOwnership = async (...args) => {
      const result = await originalResolve(...args);
      if (args[3] === undefined) await pool.execute("UPDATE users SET role='MEMBER' WHERE id=2");
      return result;
    };
    await expect(
      mutations.registerWorkspace(2, 'node', 'new-workspace', {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: 2
      })
    ).rejects.toThrow('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
    const [newRows] = await pool.execute<RowDataPacket[]>(
      "SELECT workspace_id FROM workspaces WHERE workspace_id='new-workspace'"
    );
    expect(newRows).toHaveLength(0);

    await pool.execute("UPDATE users SET role='ORG_ADMIN' WHERE id=2");
    const originalUnregister = policy.assertCanUnregisterWorkspace;
    policy.assertCanUnregisterWorkspace = async (...args) => {
      await originalUnregister(...args);
      if (args[3] === undefined) await pool.execute("UPDATE users SET role='MEMBER' WHERE id=2");
    };
    await expect(mutations.unregisterWorkspace(2, 'node', 'workspace')).rejects.toThrow(
      'WORKSPACE_FORBIDDEN'
    );
    const [rows] = await pool.execute<RowDataPacket[]>(
      "SELECT display_name FROM workspaces WHERE workspace_id='workspace'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['display_name']).toBe('Original');
    const [tombstones] = await pool.execute<RowDataPacket[]>(
      "SELECT workspace_id FROM workspace_tombstones WHERE workspace_id='workspace'"
    );
    expect(tombstones).toHaveLength(0);

    await pool.execute(`INSERT INTO resource_grants
      (id,resource_type,node_id,target_type,target_user_id,grant_scope_organization_id,created_by_user_id,created_by_role,created_at,resource_key,target_key)
      VALUES ('node-grant','NODE','node','USER',2,1,1,'ADMIN',1,'NODE:node:','USER:2')`);
    await pool.execute(`INSERT INTO resource_grants
      (id,resource_type,node_id,workspace_id,target_type,target_user_id,grant_scope_organization_id,created_by_user_id,created_by_role,created_at,resource_key,target_key)
      VALUES ('workspace-grant','WORKSPACE','node','workspace','USER',2,1,1,'ADMIN',1,'WORKSPACE:node:workspace','USER:2')`);
    await mutations.registerWorkspace(2, 'node', 'granted-workspace', {
      ownerType: 'ORGANIZATION',
      ownerOrganizationId: 2
    });
    const [granted] = await pool.execute<RowDataPacket[]>(
      "SELECT workspace_id FROM workspaces WHERE workspace_id='granted-workspace'"
    );
    expect(granted).toHaveLength(1);
    policy.assertCanUnregisterWorkspace = originalUnregister;
    await expect(resources.canRegisterWorkspace(2, 'node')).resolves.toBe(true);
    await expect(mutations.unregisterWorkspace(2, 'node', 'workspace')).rejects.toThrow(
      'WORKSPACE_FORBIDDEN'
    );
    const [afterDirectRevoke] = await pool.execute<RowDataPacket[]>(
      "SELECT display_name FROM workspaces WHERE workspace_id='workspace'"
    );
    expect(afterDirectRevoke).toHaveLength(1);
    expect(afterDirectRevoke[0]?.['display_name']).toBe('Original');
    const [remainingGrants] = await pool.execute<RowDataPacket[]>(
      "SELECT id FROM resource_grants WHERE id='workspace-grant'"
    );
    expect(remainingGrants).toHaveLength(1);

    await pool.execute("UPDATE users SET role='ADMIN',organization_id=1 WHERE id=2");
    await pool.execute('UPDATE nodes SET owner_organization_id=1 WHERE id=?', ['node']);
    const rootHolder = await pool.getConnection();
    const nodeProbe = await pool.getConnection();
    try {
      await rootHolder.beginTransaction();
      await rootHolder.execute('SELECT id FROM organizations WHERE id=1 FOR UPDATE');
      const update = new ResourceMutationService(
        database,
        authorization,
        resources
      ).updateWorkspace(2, 'node', 'workspace', {
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
      });
      const completedEarly = await Promise.race([
        update.then(
          () => true,
          () => true
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))
      ]);
      expect(completedEarly).toBe(false);
      await nodeProbe.beginTransaction();
      await nodeProbe.execute('SET innodb_lock_wait_timeout=2');
      await nodeProbe.execute('SELECT id FROM nodes WHERE id=? FOR UPDATE', ['node']);
      await nodeProbe.rollback();
      await rootHolder.rollback();
      await expect(update).resolves.toBeUndefined();
    } finally {
      await nodeProbe.rollback();
      await rootHolder.rollback();
      nodeProbe.release();
      rootHolder.release();
    }
  } finally {
    await pool.end();
    await dropPlaywrightTestDatabase(target);
  }
});
