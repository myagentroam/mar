import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openMysqlDatabase, prepareMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { ENTERPRISE_MYSQL_MIGRATIONS } from '../../ee/server/src/mysql/enterprise-migrations.js';
import { createEnterpriseServerProduct } from '../../ee/server/src/composition/enterprise-product.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from '../e2e/support/playwright-test-database.js';

describe.skipIf(process.env['MAR_TEST_DATABASE_ADMIN_URL'] === undefined)(
  'Server root identity and removed execution domain',
  () => {
    let database: MysqlServerDatabase;
    let target: ReturnType<typeof resolvePlaywrightTestDatabase> | undefined;
    beforeAll(async () => {
      const runId = process.env['MAR_TEST_RUN_ID'];
      if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
      const candidate = resolvePlaywrightTestDatabase(`${runId}-root-identity`);
      await createPlaywrightTestDatabase(candidate);
      target = candidate;
      database = new MysqlServerDatabase(await openMysqlDatabase({ url: target.databaseUrl }));
      await database.initialize();
    });
    afterEach(async () => {
      await database.raw.execute('DELETE FROM workspaces');
      await database.raw.execute('DELETE FROM node_credentials');
      await database.raw.execute('DELETE FROM nodes');
      await database.raw.execute('DELETE FROM node_registration_tokens');
      await database.raw.query('DROP TABLE IF EXISTS server_managed_nodes');
    });
    afterAll(async () => {
      try {
        await database?.close();
      } finally {
        if (target) await dropPlaywrightTestDatabase(target);
      }
    });

    it('keeps root ADMIN without a License, automatic Nodes or a managed identity table', async () => {
      const admin = await database.getAdmin();
      await prepareMysqlDatabase(database.raw);
      await database.initialize();
      expect(await database.getAdmin()).toEqual(admin);
      expect(await database.listNodes()).toEqual([]);
      const [tables] = await database.raw.execute<RowDataPacket[]>(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='server_managed_nodes'"
      );
      expect(tables).toEqual([]);
      const product = createEnterpriseServerProduct({
        database,
        now: Date.now,
        productUuid: '00000000-0000-0000-0000-309c23637c46'
      });
      expect(await product.capabilities.capability(1)).toMatchObject({
        edition: 'COMMUNITY',
        role: 'ADMIN',
        organizationId: 1
      });
      expect(await product.authorization.isPersonalAdmin(1)).toBe(true);
      expect(
        await product.authorization.authorize(1, 'RESOURCE_USE', {
          ownerType: 'ORGANIZATION',
          organizationId: 1
        })
      ).toMatchObject({ allowed: false, reason: 'ENTERPRISE_LICENSE_REQUIRED' });
    });

    it('upgrades the released ledger, invalidates the managed identity and tokens, and leaves independent Nodes usable', async () => {
      const released = ENTERPRISE_MYSQL_MIGRATIONS.find(({ version }) => version === 8)!;
      const connection = await database.raw.getConnection();
      try {
        await released.up(connection);
        await connection.execute(
          "DELETE FROM schema_migrations WHERE namespace='enterprise' AND version=9"
        );
      } finally {
        connection.release();
      }
      const legacyToken = await database.createNodeRegistrationToken(1, undefined, {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: 1
      });
      const legacy = (await database.registerNode(legacyToken.token, { metadata: '{}' }))!;
      const externalToken = await database.createNodeRegistrationToken(
        1,
        undefined,
        undefined,
        'MyAgentRoam'
      );
      const external = (await database.registerNode(externalToken.token, { metadata: '{}' }))!;
      const pending = await database.createNodeRegistrationToken(1);
      await database.raw.execute(
        `INSERT INTO server_managed_nodes
         (singleton_id,node_id,registration_token_hash,state,created_at,updated_at)
         VALUES (1,?,?,'REGISTERED',?,?)`,
        [
          legacy.nodeId,
          createHash('sha256').update(pending.token).digest('base64url'),
          Date.now(),
          Date.now()
        ]
      );
      await prepareMysqlDatabase(database.raw);
      await prepareMysqlDatabase(database.raw);
      expect(await database.authenticateNode(legacy.nodeId, legacy.credential)).toBeUndefined();
      expect(await database.registerNode(pending.token, { metadata: '{}' })).toBeUndefined();
      expect(await database.authenticateNode(external.nodeId, external.credential)).toBeDefined();
      const [tables] = await database.raw.execute<RowDataPacket[]>(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='server_managed_nodes'"
      );
      expect(tables).toEqual([]);
      const [ledger] = await database.raw.execute<RowDataPacket[]>(
        "SELECT name,status FROM schema_migrations WHERE namespace='enterprise' AND version=9"
      );
      expect(ledger).toEqual([{ name: 'remove_server_managed_node', status: 'COMPLETED' }]);
      expect((await database.listNodes()).find((node) => node.id === legacy.nodeId)).toMatchObject({
        disabled: true
      });
    });
  }
);
