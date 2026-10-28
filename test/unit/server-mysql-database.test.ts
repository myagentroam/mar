import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { openMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { createTestMysqlEnvironmentSecretService } from '../support/mysql-environment-secret-service.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from '../e2e/support/playwright-test-database.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

describe.skipIf(process.env['MAR_TEST_DATABASE_ADMIN_URL'] === undefined)(
  'Server MySQL database integration',
  () => {
    let pool: Awaited<ReturnType<typeof openMysqlDatabase>>;
    let database: MysqlServerDatabase;
    let target: ReturnType<typeof resolvePlaywrightTestDatabase> | undefined;
    const createdUsers: number[] = [];

    beforeAll(async () => {
      const runId = process.env['MAR_TEST_RUN_ID'];
      if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
      const candidate = resolvePlaywrightTestDatabase(`${runId}-server-mysql-unit`);
      await createPlaywrightTestDatabase(candidate);
      target = candidate;
      pool = await openMysqlDatabase({ url: target.databaseUrl });
      database = new MysqlServerDatabase(pool);
      await database.initialize();
    });

    afterAll(async () => {
      try {
        if (database !== undefined) {
          try {
            for (const userId of createdUsers) await database.deleteUser(userId);
          } finally {
            await database.close();
          }
        }
      } finally {
        if (target !== undefined) await dropPlaywrightTestDatabase(target);
      }
    });

    it('initializes the fixed admin and persists an authenticated session', async () => {
      const admin = await database.getAdmin();
      const login = await database.findUserForLogin('admin');
      expect(login?.id).toBe(admin.id);
      const session = await database.createUserSession(admin.id, {
        ipAddress: '127.0.0.1',
        userAgent: 'mysql-integration-test'
      });
      expect((await database.findCurrentUserSession(session.sessionId))?.userId).toBe(admin.id);
      await database.revokeSession(session.sessionId);
      expect(await database.findCurrentUserSession(session.sessionId)).toBeUndefined();
    });

    it('resets the fixed admin password and revokes its sessions', async () => {
      const admin = await database.getAdmin();
      const session = await database.createUserSession(admin.id, {
        ipAddress: '127.0.0.1',
        userAgent: 'mysql-reset-test'
      });
      try {
        await database.resetPassword('temporary-admin-password-1', 'local-command');
        expect(await database.findCurrentUserSession(session.sessionId)).toBeUndefined();
        expect(await database.findUserForLogin('admin')).toMatchObject({
          mustChangePassword: true
        });
      } finally {
        await database.resetPassword(INITIAL_ADMIN_PASSWORD, 'local-command');
      }
    });

    it('allows only the fixed admin to log in before first enterprise activation', async () => {
      const suffix = randomUUID();
      const userId = await database.createUser({
        username: `personal-${suffix}`,
        email: null,
        nickname: null,
        password: 'temporary-password-1'
      });
      createdUsers.push(userId);
      expect(await database.findUserForLogin(`personal-${suffix}`)).toBeUndefined();
    });

    it('deletes personal Server data while retaining the target username audit snapshot', async () => {
      const suffix = randomUUID();
      const username = `delete-user-${suffix}`;
      const userId = await database.createUser({
        username,
        email: null,
        nickname: null,
        password: 'temporary-password-1'
      });
      const admin = await database.getAdmin();
      await expect(database.deleteUser(userId, admin.id)).resolves.toEqual([]);
      await vi.waitFor(async () => {
        const [rawRows] = await database.raw.execute(
          `SELECT actor_username,target_id,metadata FROM audit_events
         WHERE event_type='user_deleted_by_admin' AND target_id=? ORDER BY occurred_at DESC LIMIT 1`,
          [String(userId)]
        );
        const rows = rawRows as Array<{
          actor_username: string;
          target_id: string;
          metadata: string | object;
        }>;
        const metadata =
          typeof rows[0]?.metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0]?.metadata;
        expect(rows[0]).toMatchObject({ actor_username: 'admin', target_id: String(userId) });
        expect(metadata).toEqual({ name: username, category: 'ORGANIZATION' });
      });
    });

    it('registers more than two personal Nodes without a capacity limit', async () => {
      const admin = await database.getAdmin();
      const nodeIds: string[] = [];
      try {
        const tokens = await Promise.all(
          Array.from({ length: 3 }, () =>
            database.createNodeRegistrationToken(admin.id, 10 * 60 * 1000, {
              ownerType: 'PERSONAL',
              ownerUserId: admin.id
            })
          )
        );
        for (const token of tokens) {
          const node = await database.registerNode(token.token, { metadata: '{}' });
          expect(node).toBeDefined();
          nodeIds.push(node!.nodeId);
        }
        expect((await database.listNodesForUser(admin.id)).length).toBe(3);
        const token = await database.createNodeRegistrationToken(admin.id, 10 * 60 * 1000, {
          ownerType: 'PERSONAL',
          ownerUserId: admin.id
        });
        expect(token.token).toBeTruthy();
      } finally {
        for (const nodeId of nodeIds) await database.deleteNode(nodeId, admin.id);
      }
    });

    it('atomically exchanges a personal registration token for node credentials', async () => {
      await setEnterpriseActivated(true);
      const suffix = randomUUID();
      const userId = await database.createUser({
        username: `mysql-${suffix}`,
        email: null,
        nickname: null,
        password: 'temporary-password-1'
      });
      createdUsers.push(userId);
      try {
        const token = await database.createNodeRegistrationToken(
          userId,
          undefined,
          undefined,
          '开发节点'
        );
        const registered = await database.registerNode(token.token, {
          metadata: JSON.stringify({ nodeAppVersion: '0.1.5' })
        });
        expect(registered).toBeDefined();
        expect(await database.registerNode(token.token, { metadata: '{}' })).toBeUndefined();
        expect(
          await database.authenticateNode(registered!.nodeId, registered!.credential)
        ).toMatchObject({ ownerUserId: userId, displayName: '开发节点', disabled: false });
        expect(await database.listNodesForUser(userId)).toContainEqual(
          expect.objectContaining({ id: registered!.nodeId, ownerUserId: userId, disabled: false })
        );
      } finally {
        await setEnterpriseActivated(false);
      }
    });

    it('deleting a Node tombstones registered Workspace IDs without touching host data', async () => {
      await setEnterpriseActivated(true);
      const suffix = randomUUID();
      const userId = await database.createUser({
        username: `delete-node-${suffix}`,
        email: null,
        nickname: null,
        password: 'temporary-password-1'
      });
      createdUsers.push(userId);
      try {
        const token = await database.createNodeRegistrationToken(userId);
        const registered = await database.registerNode(token.token, { metadata: '{}' });
        const workspaceId = `workspace-${suffix}`;
        await database.raw.execute(
          `INSERT INTO workspaces
         (workspace_id,display_name,node_id,owner_type,owner_user_id,owner_organization_id,registered_at)
         VALUES (?,?,?,'PERSONAL',?,NULL,?)`,
          [workspaceId, workspaceId, registered!.nodeId, userId, Date.now()]
        );
        const admin = await database.getAdmin();
        await expect(database.deleteNode(registered!.nodeId, admin.id)).resolves.toBe(true);
        const [rows] = await database.raw.execute(
          'SELECT workspace_id FROM workspace_tombstones WHERE workspace_id=?',
          [workspaceId]
        );
        expect(rows).toHaveLength(1);
        await vi.waitFor(async () => {
          const [auditRows] = await database.raw.execute(
            `SELECT actor_username,target_type,target_id,node_id FROM audit_events
           WHERE event_type='node_deleted' AND target_id=? ORDER BY occurred_at DESC LIMIT 1`,
            [registered!.nodeId]
          );
          expect(auditRows).toMatchObject([
            {
              actor_username: 'admin',
              target_type: 'NODE',
              target_id: registered!.nodeId,
              node_id: registered!.nodeId
            }
          ]);
        });
      } finally {
        await setEnterpriseActivated(false);
      }
    });

    it('Only public organization secrets inherit into child organizations while local private secrets stay private', async () => {
      await setEnterpriseActivated(true);
      const suffix = randomUUID().replaceAll('-', '');
      const userId = await database.createUser({
        username: `secret-${suffix}`,
        email: null,
        nickname: null,
        password: 'temporary-password-1'
      });
      createdUsers.push(userId);
      let childOrganizationId: number | undefined;
      let nodeId: string | undefined;
      const secretIds: string[] = [];
      try {
        const now = Date.now();
        await database.raw.execute(
          `INSERT INTO organizations (id,name,parent_organization_id,created_at,updated_at)
         VALUES (1,?,NULL,?,?) ON DUPLICATE KEY UPDATE id=id`,
          [`secret-root-${suffix}`, now, now]
        );
        const [organizationResult] = await database.raw.execute(
          'INSERT INTO organizations (name,parent_organization_id,created_at,updated_at) VALUES (?,1,?,?)',
          [`secret-child-${suffix}`, now, now]
        );
        const childId = Number((organizationResult as { insertId: number }).insertId);
        expect(childId).toBeGreaterThan(1);
        childOrganizationId = childId;
        const token = await database.createNodeRegistrationToken(userId, 600_000, {
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: childId
        });
        const registered = await database.registerNode(token.token, {
          metadata: JSON.stringify({ nodeAppVersion: '0.1.5' })
        });
        nodeId = registered!.nodeId;
        const service = createTestMysqlEnvironmentSecretService(
          database,
          async () => true,
          async () => true,
          async () => [1, childId],
          async () => true
        );
        const rootPrivate = await service.create(
          { userId, isAdmin: false },
          {
            scope: 'ORGANIZATION',
            organizationId: 1,
            visibility: 'PRIVATE',
            name: `PRIVATE_${suffix}`,
            value: 'root-private'
          }
        );
        const rootPublic = await service.create(
          { userId, isAdmin: false },
          {
            scope: 'ORGANIZATION',
            organizationId: 1,
            visibility: 'PUBLIC',
            name: `PUBLIC_${suffix}`,
            value: 'root-public'
          }
        );
        const childPrivate = await service.create(
          { userId, isAdmin: false },
          {
            scope: 'ORGANIZATION',
            organizationId: childId,
            visibility: 'PRIVATE',
            name: `CHILD_${suffix}`,
            value: 'child-private'
          }
        );
        secretIds.push(rootPrivate.id, rootPublic.id, childPrivate.id);
        const environment = await service.resolve(userId, nodeId);
        expect(environment[`PRIVATE_${suffix}`]).toBeUndefined();
        expect(environment[`PUBLIC_${suffix}`]).toBe('root-public');
        expect(environment[`CHILD_${suffix}`]).toBe('child-private');
        for (const id of secretIds) await service.remove({ userId, isAdmin: false }, id);
        secretIds.length = 0;
      } finally {
        if (nodeId !== undefined) await database.deleteNode(nodeId);
        if (childOrganizationId !== undefined) {
          await database.raw.execute(
            'DELETE FROM node_registration_tokens WHERE owner_organization_id=?',
            [childOrganizationId]
          );
          await database.raw.execute('DELETE FROM organizations WHERE id=?', [childOrganizationId]);
        }
        await setEnterpriseActivated(false);
      }
    });

    async function setEnterpriseActivated(value: boolean): Promise<void> {
      await database.raw.execute('UPDATE license_state SET ever_activated=? WHERE singleton_id=1', [
        value
      ]);
    }
  }
);

describe('Server MySQL user deletion cleanup', () => {
  it('blocks deletion when the user created a non-personal resource', async () => {
    const fixture = mysqlDeletionFixture({ nonPersonalCreator: true });

    await expect(fixture.database.deleteUser(7, 1)).rejects.toThrow('USER_IN_USE');
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).not.toHaveBeenCalled();
  });

  it('explains the protected reference without exposing database details', async () => {
    const fixture = mysqlDeletionFixture({ creatorReference: 'template' });

    await expect(fixture.database.deleteUser(7, 1)).rejects.toMatchObject({
      message: 'USER_IN_USE',
      publicDetails: expect.stringContaining('conversation template')
    });
  });

  it.each(['template', 'version', 'publish-job'] as const)(
    'retains a user referenced by a %s even when its resources are personal',
    async (creatorReference) => {
      const fixture = mysqlDeletionFixture({ creatorReference });

      await expect(fixture.database.deleteUser(7, 1)).rejects.toMatchObject({
        message: 'USER_IN_USE',
        publicDetails: expect.any(String)
      });
    }
  );

  it('allows cleanup of personal resources and same-user Skill favorites', async () => {
    const fixture = mysqlDeletionFixture({
      personalModel: true,
      personalSkillSource: true,
      personalSkillFavorite: true
    });
    vi.spyOn(fixture.database, 'auditWithConnection').mockResolvedValue();

    await expect(fixture.database.deleteUser(7, 1)).resolves.toEqual([]);
    expect(fixture.sql).toContain('DELETE FROM mar_agent_models WHERE id IN (?)');
    expect(fixture.sql).toContain('DELETE FROM skill_versions WHERE favorite_id IN (?)');
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
  });

  it('blocks a personal Skill source referenced by another user favorite', async () => {
    const fixture = mysqlDeletionFixture({
      personalSkillSource: true,
      crossUserSkillFavorite: true
    });

    await expect(fixture.database.deleteUser(7, 1)).rejects.toMatchObject({
      message: 'USER_IN_USE',
      publicDetails: expect.stringContaining('another user')
    });
    expect(fixture.connection.commit).not.toHaveBeenCalled();
  });

  it('reuses the deletion transaction for personal Node cleanup and user references', async () => {
    const fixture = mysqlDeletionFixture({ personalNode: true });
    vi.spyOn(fixture.database, 'auditWithConnection').mockResolvedValue();

    await expect(fixture.database.deleteUser(7, 1)).resolves.toEqual(['node-7']);
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
    expect(fixture.sql).toContain(
      'UPDATE nodes SET registered_by_user_id=NULL WHERE registered_by_user_id=?'
    );
    expect(
      fixture.sql.some(
        (sql) => sql.includes("resource_type='NODE'") && sql.includes('DELETE FROM resource_grants')
      )
    ).toBe(true);
    expect(fixture.sql).toContain('DELETE FROM workbench_notifications WHERE user_id=?');
    expect(fixture.sql).toContain('DELETE FROM mail_deliveries WHERE user_id=?');
    expect(fixture.sql).toContain('DELETE FROM external_identities WHERE user_id=?');
  });
});

function mysqlDeletionFixture(options: {
  nonPersonalCreator?: boolean;
  creatorReference?: 'template' | 'version' | 'publish-job';
  personalModel?: boolean;
  personalSkillSource?: boolean;
  personalSkillFavorite?: boolean;
  crossUserSkillFavorite?: boolean;
  personalNode?: boolean;
}) {
  const sql: string[] = [];
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (statement: string) => {
      sql.push(statement.trim());
      if (statement.startsWith('SELECT username,organization_id,is_fixed_admin'))
        return [[{ username: 'user-7', organization_id: 2, is_fixed_admin: false }], []];
      if (statement.startsWith('SELECT id FROM users WHERE id IN')) return [[{ id: 1 }], []];
      if (options.nonPersonalCreator && statement.includes('FROM mar_agent_models'))
        return [[{ id: 'model-7' }], []];
      if (
        options.creatorReference === 'template' &&
        statement.includes('FROM conversation_templates') &&
        statement.includes('created_by_user_id')
      )
        return [[{ id: 'template-7' }], []];
      if (
        options.creatorReference === 'version' &&
        statement.includes('FROM conversation_template_versions')
      )
        return [[{ id: 'version-7' }], []];
      if (
        options.creatorReference === 'publish-job' &&
        statement.includes('FROM conversation_template_publish_jobs') &&
        statement.includes('requested_by_user_id')
      )
        return [[{ id: 'publish-job-7' }], []];
      if (statement.startsWith("SELECT id FROM mar_agent_models WHERE owner_type='PERSONAL'"))
        return [options.personalModel ? [{ id: 'model-7' }] : [], []];
      if (statement.startsWith("SELECT id FROM skill_sources WHERE scope='PERSONAL'"))
        return [options.personalSkillSource ? [{ id: 'source-7' }] : [], []];
      if (statement.startsWith("SELECT id FROM skill_favorites WHERE scope='PERSONAL'"))
        return [options.personalSkillFavorite ? [{ id: 'favorite-7' }] : [], []];
      if (statement.includes('source_id IN (') && options.crossUserSkillFavorite)
        return [[{ id: 'favorite-other' }], []];
      if (statement.startsWith("SELECT id FROM nodes WHERE owner_type='PERSONAL'"))
        return [options.personalNode ? [{ id: 'node-7' }] : [], []];
      if (statement.startsWith('SELECT id FROM nodes WHERE id=? FOR UPDATE'))
        return [[{ id: 'node-7' }], []];
      if (statement.includes('conversation_templates WHERE source_node_id=?')) return [[], []];
      if (statement.includes('SELECT workspace_id FROM workspaces WHERE node_id=?'))
        return [[], []];
      if (
        statement.includes(
          "SELECT workspace_id,node_id FROM workspaces WHERE owner_type='PERSONAL'"
        )
      )
        return [[], []];
      if (statement.startsWith('SELECT id FROM skill_favorites')) return [[], []];
      return [{ affectedRows: 1 }, []];
    })
  };
  const database = new MysqlServerDatabase(
    { getConnection: vi.fn(async () => connection) } as unknown as Pool,
    () => 2_000
  );
  return { database, connection, sql };
}
