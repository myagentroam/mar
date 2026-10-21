import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { expect, test } from '@playwright/test';
import { openMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import { createServerApp } from '../../ee/server/src/app.js';
import { WebPushClients } from '../../packages/server-core/src/web-push-clients.js';
import { CORE_MYSQL_MIGRATIONS } from '../../packages/server-core/src/mysql-schema.js';
import { NotificationChannelService } from '../../packages/server-core/src/notification-channel-service.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';
import {
  PLAYWRIGHT_LICENSE_PRODUCT_UUID,
  createPlaywrightTestLicenseDocument,
  getPlaywrightTestLicensePublicKey
} from './support/playwright-test-license.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

test('Product Web Push enables with the default transport and retains its VAPID key after restart', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const database = resolvePlaywrightTestDatabase(`${runId}-web-push-product-${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  let directory: string | undefined;
  let app: ReturnType<typeof createServerApp> | undefined;
  const previousLicenseKey = process.env['MAR_LICENSE_PUBLIC_KEY'];
  try {
    process.env['MAR_LICENSE_PUBLIC_KEY'] = getPlaywrightTestLicensePublicKey();
    directory = await mkdtemp(join(tmpdir(), 'web-push-product-'));
    const origin = 'https://console.example.test';
    // Exercise the production assembly without injecting a fake Push transport.
    const options = {
      databaseUrl: database.databaseUrl,
      dataDirectory: directory,
      publicOrigin: origin,
      productUuid: PLAYWRIGHT_LICENSE_PRODUCT_UUID,
      secureCookies: false
    };
    app = createServerApp(options);
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        origin,
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.statusCode).toBe(200);
    const headers = {
      origin,
      cookie: String(changed.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': changed.json().csrfToken as string
    };
    const licensed = await app.inject({
      method: 'POST',
      url: '/api/license/import',
      headers,
      payload: { document: createPlaywrightTestLicenseDocument() }
    });
    expect(licensed.statusCode).toBe(200);
    const before = await app.inject({ url: '/api/notifications/push', headers });
    expect(before.json()).toEqual({
      account: 'admin',
      enabled: false,
      available: true,
      publicKey: null
    });
    let publicKey: string | undefined;
    for (const enabled of [true, false, true]) {
      const write = await app.inject({
        method: 'PATCH',
        url: '/api/system-settings/web-push',
        headers,
        payload: { enabled }
      });
      expect(write.statusCode, write.json().error?.code).toBe(200);
      expect(write.json().webPushEnabled).toBe(enabled);
      const capability = await app.inject({ url: '/api/notifications/push', headers });
      const value = capability.json();
      expect(Object.keys(value).sort()).toEqual(['account', 'available', 'enabled', 'publicKey']);
      expect(value).toMatchObject({ enabled, available: true, account: 'admin' });
      publicKey ??= value.publicKey;
      expect(value.publicKey).toBe(publicKey);
      expect(Buffer.from(value.publicKey, 'base64url')).toHaveLength(65);
    }
    await app.close();
    app = createServerApp(options);
    await app.ready();
    const restored = await app.inject({ url: '/api/notifications/push', headers });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({
      enabled: true,
      available: true,
      account: 'admin',
      publicKey
    });
  } finally {
    await app?.close();
    if (previousLicenseKey === undefined) delete process.env['MAR_LICENSE_PUBLIC_KEY'];
    else process.env['MAR_LICENSE_PUBLIC_KEY'] = previousLicenseKey;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    await dropPlaywrightTestDatabase(database);
  }
});

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const clientToken = (): string => randomBytes(32).toString('base64url');
const endpoint = (): string =>
  `https://fcm.googleapis.com/fcm/send/${randomBytes(18).toString('base64url')}`;

function registration(
  token: string,
  subscriptionEndpoint: string,
  bindingVersion?: number,
  enabled = true
) {
  return {
    clientKind: 'mobile',
    clientToken: token,
    subscription: {
      endpoint: subscriptionEndpoint,
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) }
    },
    ...(bindingVersion === undefined ? {} : { bindingVersion }),
    enabled
  };
}

test('Core v27 initializes web-push storage idempotently and isolates MySQL client bindings', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');

  const database = resolvePlaywrightTestDatabase(`${runId}-web-push-${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  let pool: Awaited<ReturnType<typeof openMysqlDatabase>> | undefined;
  try {
    const firstInitialization = await openMysqlDatabase({ url: database.databaseUrl });
    await firstInitialization.end();
    pool = await openMysqlDatabase({ url: database.databaseUrl });

    const webPushMigration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 27);
    if (!webPushMigration) throw new Error('CORE_MYSQL_V27_MIGRATION_MISSING');
    const [migrationRows] = await pool.execute<RowDataPacket[]>(
      "SELECT version,name,checksum,status FROM schema_migrations WHERE namespace='core' AND version=27"
    );
    expect(migrationRows).toEqual([
      {
        version: 27,
        name: 'web_push_clients',
        checksum: webPushMigration.checksum,
        status: 'COMPLETED'
      }
    ]);

    const latestCoreMigration = CORE_MYSQL_MIGRATIONS.at(-1);
    if (!latestCoreMigration) throw new Error('CORE_MYSQL_MIGRATION_CATALOG_EMPTY');
    const [latestMigrationRows] = await pool.execute<RowDataPacket[]>(
      "SELECT version,name,checksum,status FROM schema_migrations WHERE namespace='core' AND version=?",
      [latestCoreMigration.version]
    );
    expect(latestMigrationRows).toEqual([
      {
        version: latestCoreMigration.version,
        name: latestCoreMigration.name,
        checksum: latestCoreMigration.checksum,
        status: 'COMPLETED'
      }
    ]);

    const [indexRows] = await pool.query<RowDataPacket[]>('SHOW INDEX FROM web_push_clients');
    const indexNames = new Set(indexRows.map((row) => String(row['Key_name'])));
    expect(indexNames.has('uq_web_push_token')).toBe(true);
    expect(indexNames.has('uq_web_push_endpoint')).toBe(true);

    let now = Date.now();
    const createUser = async (username: string): Promise<number> => {
      const [result] = await pool!.execute<ResultSetHeader>(
        `INSERT INTO users
         (username,must_change_password,enabled,is_fixed_admin,created_at,updated_at)
         VALUES (?,FALSE,TRUE,FALSE,?,?)`,
        [username, now, now]
      );
      return Number(result.insertId);
    };
    const userA = await createUser(`web-push-a-${randomUUID()}`);
    const userB = await createUser(`web-push-b-${randomUUID()}`);

    const createSession = async (userId: number): Promise<string> => {
      const sessionHash = hash(`session-${randomUUID()}`);
      await pool!.execute(
        `INSERT INTO user_sessions
         (session_hash,public_id,user_id,csrf_token_hash,created_at,last_accessed_at,expires_at,revoked_at,ip_address,user_agent)
         VALUES (?,?,?,?,?,?,?,NULL,'127.0.0.1','web-push-integration-test')`,
        [sessionHash, randomUUID(), userId, hash(`csrf-${randomUUID()}`), now, now, now + 60_000]
      );
      return sessionHash;
    };
    const sessionA1 = await createSession(userA);
    const sessionA2 = await createSession(userA);
    const sessionB = await createSession(userB);
    const clients = new WebPushClients({ raw: pool }, () => now);
    const actorA1 = { userId: userA, sessionHash: sessionA1 };
    const actorA2 = { userId: userA, sessionHash: sessionA2 };
    const actorB = { userId: userB, sessionHash: sessionB };

    const tokenA1 = clientToken();
    const endpointA1 = endpoint();
    const bindingA1 = await clients.register(actorA1, registration(tokenA1, endpointA1));
    const tokenA2 = clientToken();
    const endpointA2 = endpoint();
    await clients.register(actorA1, registration(tokenA2, endpointA2));
    const tokenA3 = clientToken();
    const endpointA3 = endpoint();
    await clients.register(actorA2, registration(tokenA3, endpointA3));
    const tokenB = clientToken();
    const endpointB = endpoint();
    await clients.register(actorB, registration(tokenB, endpointB));
    expect(await clients.inspect(actorA2, tokenA1)).toEqual(bindingA1);
    expect(await clients.inspect(actorB, tokenA1)).toBeUndefined();

    expect(
      (await clients.eligible(userA)).map(({ subscription }) => subscription.endpoint)
    ).toEqual(expect.arrayContaining([endpointA1, endpointA2, endpointA3]));
    expect(await clients.eligible(userA)).toHaveLength(3);
    expect(
      (await clients.eligible(userB)).map(({ subscription }) => subscription.endpoint)
    ).toEqual([endpointB]);

    const [beforeRejectedRegistration] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM web_push_clients'
    );
    await expect(clients.register(actorB, registration(clientToken(), endpointA1))).rejects.toThrow(
      'WEB_PUSH_CLIENT_CONFLICT'
    );
    await expect(
      clients.register(
        { userId: userB, sessionHash: sessionA1 },
        registration(clientToken(), endpoint())
      )
    ).rejects.toThrow('WEB_PUSH_SESSION_INVALID');
    const [afterRejectedRegistration] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM web_push_clients'
    );
    expect(Number(afterRejectedRegistration[0]?.['count'])).toBe(
      Number(beforeRejectedRegistration[0]?.['count'])
    );

    const replacementEndpoint = endpoint();
    const replacement = await clients.register(
      actorA1,
      registration(tokenA1, replacementEndpoint, bindingA1.bindingVersion)
    );
    expect(replacement).toEqual({
      subscriptionId: bindingA1.subscriptionId,
      bindingVersion: bindingA1.bindingVersion + 1,
      enabled: true
    });
    const [beforeReplayRows] = await pool.execute<RowDataPacket[]>(
      'SELECT binding_version,updated_at FROM web_push_clients WHERE id=?',
      [replacement.subscriptionId]
    );
    expect(beforeReplayRows).toHaveLength(1);
    const beforeReplay = beforeReplayRows[0]!;
    for (const expectedVersion of [bindingA1.bindingVersion, replacement.bindingVersion]) {
      now += 1_000;
      expect(
        await clients.register(actorA1, registration(tokenA1, replacementEndpoint, expectedVersion))
      ).toEqual(replacement);
    }
    const [afterReplayRows] = await pool.execute<RowDataPacket[]>(
      'SELECT binding_version,updated_at FROM web_push_clients WHERE id=?',
      [replacement.subscriptionId]
    );
    expect(afterReplayRows).toHaveLength(1);
    expect(Number(afterReplayRows[0]?.['binding_version'])).toBe(
      Number(beforeReplay['binding_version'])
    );
    expect(Number(afterReplayRows[0]?.['updated_at'])).toBe(Number(beforeReplay['updated_at']));
    expect(
      await clients.expire({
        subscriptionId: bindingA1.subscriptionId,
        bindingVersion: bindingA1.bindingVersion,
        endpoint: endpointA1
      })
    ).toBe(false);
    await expect(
      clients.register(actorA1, registration(tokenA1, endpointA1, bindingA1.bindingVersion))
    ).rejects.toThrow('WEB_PUSH_BINDING_STALE');

    const disabled = await clients.register(
      actorA1,
      registration(tokenA1, replacementEndpoint, replacement.bindingVersion, false)
    );
    expect(disabled).toEqual({
      subscriptionId: bindingA1.subscriptionId,
      bindingVersion: replacement.bindingVersion + 1,
      enabled: false
    });
    expect(
      (await clients.eligible(userA)).map(({ subscription }) => subscription.endpoint)
    ).toEqual(expect.arrayContaining([endpointA2, endpointA3]));
    expect(await clients.eligible(userA)).toHaveLength(2);

    await pool.execute('UPDATE user_sessions SET revoked_at=? WHERE session_hash=?', [
      now,
      sessionA2
    ]);
    expect(
      (await clients.eligible(userA)).map(({ subscription }) => subscription.endpoint)
    ).toEqual([endpointA2]);
    expect(
      (await clients.eligible(userB)).map(({ subscription }) => subscription.endpoint)
    ).toEqual([endpointB]);

    expect(
      await clients.expire({
        subscriptionId: bindingA1.subscriptionId,
        bindingVersion: replacement.bindingVersion,
        endpoint: replacementEndpoint
      })
    ).toBe(false);
    expect(
      await clients.expire({
        subscriptionId: disabled.subscriptionId,
        bindingVersion: disabled.bindingVersion,
        endpoint: replacementEndpoint
      })
    ).toBe(true);
    expect(
      (await clients.eligible(userA)).map(({ subscription }) => subscription.endpoint)
    ).toEqual([endpointA2]);
    // Exercise the real v28 receipt columns and JSON round-trip; SMTP remains a fake boundary.
    let emailAttempts = 0;
    const channelDependencies = {
      database: { raw: pool, userCanRequestNode: async () => true } as never,
      notifications: { consume: async () => true, bySource: async () => undefined },
      mail: {
        send: async () => {
          emailAttempts++;
        }
      },
      now: () => now
    };
    const request = {
      apiVersion: 1,
      eventType: 'notification',
      kind: 'AGENT_MESSAGE',
      occurredAt: now,
      executionId: 'receipt-execution',
      workspaceId: 'receipt-workspace',
      sessionId: 'receipt-session',
      sessionTitle: 'Receipt fixture',
      userId: userB,
      source: 'MANUAL',
      callId: randomUUID(),
      channels: ['email'],
      recipientEmail: 'recipient@example.test',
      message: 'Receipt round-trip'
    };
    const result = await new NotificationChannelService(channelDependencies).send(
      'receipt-node',
      request,
      () => true
    );
    expect(result.email).toEqual({ status: 'accepted' });
    expect(
      await new NotificationChannelService(channelDependencies).send(
        'receipt-node',
        request,
        () => true
      )
    ).toEqual(result);
    expect(emailAttempts).toBe(1);
    const [receipts] = await pool.execute<RowDataPacket[]>(
      'SELECT call_id,notification_result FROM mail_deliveries WHERE user_id=?',
      [userB]
    );
    expect(receipts[0]?.['call_id']).toBe(request.callId);
    expect(receipts[0]?.['notification_result']).toEqual(result);
    await expect(
      new NotificationChannelService(channelDependencies).send(
        'receipt-node',
        { ...request, message: 'Different input' },
        () => true
      )
    ).rejects.toThrow('NOTIFICATION_CALL_CONFLICT');
    expect(emailAttempts).toBe(1);
  } finally {
    await pool?.end();
    await dropPlaywrightTestDatabase(database);
  }
});

test('Core v32 clears legacy Push bindings once while preserving notifications and users', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');

  const database = resolvePlaywrightTestDatabase(`${runId}-web-push-migration-${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  let pool: Awaited<ReturnType<typeof openMysqlDatabase>> | undefined;
  try {
    pool = await openMysqlDatabase({ url: database.databaseUrl });
    const now = Date.now();
    const username = `push-migration-${randomUUID()}`;
    const [userResult] = await pool.execute<ResultSetHeader>(
      `INSERT INTO users
       (username,must_change_password,enabled,is_fixed_admin,created_at,updated_at)
       VALUES (?,FALSE,TRUE,FALSE,?,?)`,
      [username, now, now]
    );
    const userId = Number(userResult.insertId);
    const sessionHash = hash(`migration-session-${randomUUID()}`);
    await pool.execute(
      `INSERT INTO user_sessions
       (session_hash,public_id,user_id,csrf_token_hash,created_at,last_accessed_at,expires_at,revoked_at,ip_address,user_agent)
       VALUES (?,?,?,?,?,?,?,NULL,'127.0.0.1','web-push-migration-test')`,
      [sessionHash, randomUUID(), userId, hash(`csrf-${randomUUID()}`), now, now, now + 60_000]
    );

    const clients = new WebPushClients({ raw: pool }, () => now);
    const legacyEndpoint = endpoint();
    await clients.register({ userId, sessionHash }, registration(clientToken(), legacyEndpoint));

    const notificationId = randomUUID();
    const notificationMessage = 'Preserve this business notification';
    await pool.execute(
      `INSERT INTO workbench_notifications
       (id,user_id,source_id,source_key,kind,title,message,node_id,workspace_id,session_id,session_title,run_id,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        notificationId,
        userId,
        notificationId,
        hash(`notification-${notificationId}`),
        'run',
        'Migration fixture',
        notificationMessage,
        'migration-node',
        'migration-workspace',
        'migration-session',
        'Migration session',
        'migration-run',
        now,
        now + 86_400_000
      ]
    );

    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 32);
    expect(migration).toMatchObject({ name: 'mobile_only_web_push_clients' });
    await pool.execute('DELETE FROM schema_migrations WHERE namespace=? AND version=?', [
      'core',
      32
    ]);
    await pool.end();
    pool = undefined;

    pool = await openMysqlDatabase({ url: database.databaseUrl });
    const [cleanedClients] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM web_push_clients WHERE user_id=?',
      [userId]
    );
    expect(cleanedClients).toEqual([]);
    const [retainedUsers] = await pool.execute<RowDataPacket[]>(
      'SELECT id,username FROM users WHERE id=?',
      [userId]
    );
    expect(retainedUsers.map((row) => ({ ...row }))).toEqual([{ id: userId, username }]);
    const [retainedNotifications] = await pool.execute<RowDataPacket[]>(
      'SELECT id,message FROM workbench_notifications WHERE id=? AND user_id=?',
      [notificationId, userId]
    );
    expect(retainedNotifications.map((row) => ({ ...row }))).toEqual([
      { id: notificationId, message: notificationMessage }
    ]);
    const [completedMigration] = await pool.execute<RowDataPacket[]>(
      'SELECT name,status FROM schema_migrations WHERE namespace=? AND version=?',
      ['core', 32]
    );
    expect(completedMigration.map((row) => ({ ...row }))).toEqual([
      { name: 'mobile_only_web_push_clients', status: 'COMPLETED' }
    ]);

    const mobileEndpoint = endpoint();
    const mobileToken = clientToken();
    const mobileBinding = await new WebPushClients({ raw: pool }, () => now).register(
      { userId, sessionHash },
      registration(mobileToken, mobileEndpoint)
    );
    await pool.end();
    pool = undefined;

    pool = await openMysqlDatabase({ url: database.databaseUrl });
    const [afterRestart] = await pool.execute<RowDataPacket[]>(
      'SELECT id,endpoint FROM web_push_clients WHERE id=?',
      [mobileBinding.subscriptionId]
    );
    expect(afterRestart.map((row) => ({ ...row }))).toEqual([
      { id: mobileBinding.subscriptionId, endpoint: mobileEndpoint }
    ]);
    const [stillRetained] = await pool.execute<RowDataPacket[]>(
      'SELECT id,message FROM workbench_notifications WHERE id=? AND user_id=?',
      [notificationId, userId]
    );
    expect(stillRetained.map((row) => ({ ...row }))).toEqual([
      { id: notificationId, message: notificationMessage }
    ]);
  } finally {
    await pool?.end();
    await dropPlaywrightTestDatabase(database);
  }
});
