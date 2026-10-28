import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import { createServerApp } from '../../ee/server/src/app.js';
import { createTestServerApp } from '../support/create-test-server-app.js';
import { openServerDatabase } from '../../ee/server/src/database.js';
import { createMysqlPool } from '../../ee/server/src/mysql/connection.js';
import {
  ENTERPRISE_MYSQL_MIGRATIONS,
  ENTERPRISE_MYSQL_SCHEMA_V6
} from '../../ee/server/src/mysql/enterprise-migrations.js';
import { runServerMysqlMigrations } from '../../packages/server-core/src/mysql-migrations.js';
import {
  CORE_MYSQL_MIGRATIONS,
  CORE_MYSQL_SCHEMA_V9
} from '../../packages/server-core/src/mysql-schema.js';
import { validateMysqlSchema } from '../../packages/server-core/src/mysql-schema-support.js';
import { hashPassword, INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';
import {
  createPlaywrightTestLicenseDocument,
  getPlaywrightTestLicensePublicKey,
  PLAYWRIGHT_LICENSE_PRODUCT_UUID
} from './support/playwright-test-license.js';

const HISTORICAL_INITIAL_PASSWORD = 'mar102030';

const HISTORICAL_CORE_SCHEMA_V14 = {
  ...CORE_MYSQL_SCHEMA_V9,
  mar_agent_models: CORE_MYSQL_SCHEMA_V9['mar_agent_models']!.replace(
    "  `fast_mode` tinyint(1) NOT NULL DEFAULT '0',",
    "  `fast_mode` tinyint(1) NOT NULL DEFAULT '0',\n  `service_tier` enum('auto','default','flex','priority','fast','ultrafast') DEFAULT NULL,"
  ),
  workbench_notifications: CORE_MYSQL_SCHEMA_V9['workbench_notifications']!.replace(
    "enum('run','approval','plan','user-input')",
    "enum('run','approval','plan','user-input','schedule')"
  )
};

async function validateHistoricalMysqlDatabase(
  connection: Parameters<typeof validateMysqlSchema>[0]
): Promise<void> {
  await validateMysqlSchema(connection, HISTORICAL_CORE_SCHEMA_V14);
  await validateMysqlSchema(connection, ENTERPRISE_MYSQL_SCHEMA_V6);
}

test('Internal marctl removes deployment keys during MySQL upgrade and rejects external credentials', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-marctl-migration`);
  await createPlaywrightTestDatabase(target);
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  const pool = createMysqlPool({ url: target.databaseUrl });
  try {
    directory = await mkdtemp(join(tmpdir(), 'marctl-migration-e2e-'));
    const options = {
      databaseUrl: target.databaseUrl,
      dataDirectory: directory,
      productUuid: PLAYWRIGHT_LICENSE_PRODUCT_UUID,
      secureCookies: false,
      logger: false as const
    };
    const migrationPool = createMysqlPool({ url: target.databaseUrl });
    try {
      await runServerMysqlMigrations(migrationPool, {
        edition: 'enterprise',
        core: CORE_MYSQL_MIGRATIONS.filter(({ version }) => version <= 14),
        enterprise: ENTERPRISE_MYSQL_MIGRATIONS.filter(({ version }) => version <= 6),
        validate: validateHistoricalMysqlDatabase
      });
    } finally {
      await migrationPool.end();
    }
    const legacyKey = `marmgr_${'x'.repeat(43)}`;
    const hash = createHash('sha256').update(legacyKey).digest('hex');
    await pool.execute(
      `INSERT INTO users
       (id,username,password_hash,must_change_password,enabled,is_fixed_admin,created_at,updated_at)
       VALUES (1,'admin',?,TRUE,TRUE,TRUE,1,1)`,
      [hashPassword(HISTORICAL_INITIAL_PASSWORD)]
    );
    await pool.execute(
      "INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES ('marmgr_management_key',JSON_OBJECT('hash',?),123)",
      [hash]
    );
    // Resume the real v14/v6 history only after the retired key and fixed admin exist.
    app = (await createServerApp(options)).app;
    await app.ready();
    await pool.execute('UPDATE users SET must_change_password=FALSE WHERE id=1');
    const headers = { authorization: `Bearer ${legacyKey}` };
    expect((await app.inject({ url: '/api/marctl/nodes', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/marmgr/nodes', headers })).statusCode).toBe(404);
    const [rows] = await pool.execute(
      "SELECT setting_key,JSON_UNQUOTE(JSON_EXTRACT(setting_value,'$.hash')) AS key_hash,updated_at FROM system_settings WHERE setting_key IN ('marmgr_management_key','marctl_management_key')"
    );
    expect(rows).toEqual([]);
    await app.close();
    app = (await createServerApp(options)).app;
    await app.ready();
    expect((await app.inject({ url: '/api/marctl/nodes', headers })).statusCode).toBe(401);
    const historicalLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: HISTORICAL_INITIAL_PASSWORD }
    });
    expect(historicalLogin.statusCode).toBe(200);
    const newDefaultLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(newDefaultLogin.statusCode).toBe(401);
  } finally {
    await app?.close();
    await pool.end();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    await dropPlaywrightTestDatabase(target);
  }
});

test('The product stack covers authentication, License activation, and enterprise authorization in isolated MySQL', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-product-composition`);
  await createPlaywrightTestDatabase(target);
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  const previousKey = process.env['MAR_LICENSE_PUBLIC_KEY'];
  try {
    directory = await mkdtemp(join(tmpdir(), 'product-composition-e2e-'));
    process.env['MAR_LICENSE_PUBLIC_KEY'] = getPlaywrightTestLicensePublicKey();
    app = (
      await createServerApp({
        databaseUrl: target.databaseUrl,
        dataDirectory: directory,
        productUuid: PLAYWRIGHT_LICENSE_PRODUCT_UUID,
        secureCookies: false,
        logger: false
      })
    ).app;
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/license' })).statusCode).toBe(401);
    const retiredLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: HISTORICAL_INITIAL_PASSWORD }
    });
    expect(retiredLogin.statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      authenticated: true,
      edition: 'COMMUNITY',
      licenseState: 'COMMUNITY'
    });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.statusCode).toBe(200);
    const auditPool = createMysqlPool({ url: target.databaseUrl });
    try {
      const [rows] = await auditPool.execute(
        `SELECT event_type,actor_username,actor_ip,result,metadata
         FROM audit_events WHERE event_type='password_changed'`
      );
      expect(rows).toMatchObject([
        { event_type: 'password_changed', actor_username: 'admin', result: 'SUCCESS' }
      ]);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(INITIAL_ADMIN_PASSWORD);
      expect(JSON.stringify(rows)).not.toContain(login.json().csrfToken);
    } finally {
      await auditPool.end();
    }
    const headers = {
      cookie: String(changed.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': changed.json().csrfToken as string
    };
    const imported = await app.inject({
      method: 'POST',
      url: '/api/license/import',
      headers,
      payload: { document: createPlaywrightTestLicenseDocument() }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ edition: 'ENTERPRISE', state: 'ENTERPRISE_VALID' });
    const current = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      authenticated: true,
      mustChangePassword: false,
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_VALID',
      role: 'ADMIN',
      organizationId: expect.any(Number),
      managementWritable: true
    });
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      expect(
        (await app.inject({ method, url: '/api/system-settings/management-key', headers }))
          .statusCode
      ).toBe(404);
    }
    for (const key of [
      `marctl_${'x'.repeat(43)}`,
      `marmgr_${'x'.repeat(43)}`,
      `marctl_user_${'x'.repeat(43)}`
    ]) {
      expect(
        (
          await app.inject({
            url: '/api/marctl/nodes',
            headers: { authorization: `Bearer ${key}` }
          })
        ).statusCode
      ).toBe(401);
    }
    const organizations = await app.inject({ method: 'GET', url: '/api/organizations', headers });
    expect(organizations.statusCode).toBe(200);
    expect(organizations.json().organizations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: current.json().organizationId })])
    );
  } finally {
    if (previousKey === undefined) delete process.env['MAR_LICENSE_PUBLIC_KEY'];
    else process.env['MAR_LICENSE_PUBLIC_KEY'] = previousKey;
    try {
      await app?.close();
    } finally {
      try {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      } finally {
        await dropPlaywrightTestDatabase(target);
      }
    }
  }
});

test('Fixed admin profile editing preserves recovery protection and rejects organization admins', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-fixed-admin-profile`);
  await createPlaywrightTestDatabase(target);
  const pool = createMysqlPool({ url: target.databaseUrl });
  const previousKey = process.env['MAR_LICENSE_PUBLIC_KEY'];
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'fixed-admin-profile-e2e-'));
    process.env['MAR_LICENSE_PUBLIC_KEY'] = getPlaywrightTestLicensePublicKey();
    app = (
      await createServerApp({
        databaseUrl: target.databaseUrl,
        dataDirectory: directory,
        productUuid: PLAYWRIGHT_LICENSE_PRODUCT_UUID,
        secureCookies: false,
        logger: false
      })
    ).app;
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.statusCode).toBe(200);
    const headers = {
      cookie: String(changed.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': changed.json().csrfToken as string
    };
    const imported = await app.inject({
      method: 'POST',
      url: '/api/license/import',
      headers,
      payload: { document: createPlaywrightTestLicenseDocument() }
    });
    expect(imported.statusCode).toBe(200);
    const [identityBefore] = await pool.execute(
      'SELECT username,role,organization_id,is_fixed_admin,enabled,password_hash FROM users WHERE id=1'
    );
    const profile = {
      email: 'admin@example.com',
      nickname: '恢复管理员',
      role: 'ADMIN',
      organizationId: 1
    };
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/enterprise/users/1',
      headers,
      payload: profile
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().user).toMatchObject({ ...profile, username: 'admin', fixedAdmin: true });
    const listed = await app.inject({ method: 'GET', url: '/api/enterprise/users', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().users).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 1, ...profile })])
    );
    for (const membership of [
      { role: 'MEMBER', organizationId: 1 },
      { role: 'ORG_ADMIN', organizationId: 1 },
      { role: 'ADMIN', organizationId: 999 }
    ]) {
      const denied = await app.inject({
        method: 'PATCH',
        url: '/api/enterprise/users/1',
        headers,
        payload: { ...profile, email: 'forbidden@example.com', ...membership }
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.code).toBe('ADMIN_USER_PROTECTED');
    }
    const deleted = await app.inject({ method: 'DELETE', url: '/api/management/users/1', headers });
    expect(deleted.statusCode).toBe(400);
    expect(deleted.json().error.code).toBe('ADMIN_USER_PROTECTED');
    const reset = await app.inject({
      method: 'POST',
      url: '/api/management/users/1/reset-password',
      headers
    });
    expect(reset.statusCode).toBe(400);
    await pool.execute(
      `INSERT INTO users (username,password_hash,must_change_password,enabled,role,organization_id,is_fixed_admin,created_at,updated_at)
       VALUES ('org-admin',?,FALSE,TRUE,'ORG_ADMIN',1,FALSE,1,1)`,
      [hashPassword('org-admin-password')]
    );
    const orgLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'org-admin', password: 'org-admin-password' }
    });
    expect(orgLogin.statusCode).toBe(200);
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/enterprise/users/1',
      headers: {
        cookie: String(orgLogin.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': orgLogin.json().csrfToken
      },
      payload: { ...profile, nickname: 'Forbidden' }
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe('RBAC_TARGET_ROLE_DENIED');
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/enterprise/users/1',
      headers,
      payload: { ...profile, email: null, nickname: null }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().user).toMatchObject({ email: null, nickname: null });
    const [identityAfter] = await pool.execute(
      'SELECT username,role,organization_id,is_fixed_admin,enabled,password_hash FROM users WHERE id=1'
    );
    expect(identityAfter).toEqual(identityBefore);
  } finally {
    if (previousKey === undefined) delete process.env['MAR_LICENSE_PUBLIC_KEY'];
    else process.env['MAR_LICENSE_PUBLIC_KEY'] = previousKey;
    try {
      await app?.close();
    } finally {
      await pool.end();
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      await dropPlaywrightTestDatabase(target);
    }
  }
});

test('A new database supports the default login and first password change while invalidating old sessions', async ({
  request
}) => {
  await withServer(async (baseUrl, databasePath) => {
    const admin = await playwrightRequest.newContext({ baseURL: baseUrl });
    const retiredLogin = await admin.post('/api/auth/login', {
      data: { username: 'admin', password: HISTORICAL_INITIAL_PASSWORD }
    });
    expect(retiredLogin.status()).toBe(401);
    const login = await admin.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const loginBody = await login.json();
    expect(login.ok()).toBeTruthy();
    expect(loginBody).toMatchObject({ authenticated: true, mustChangePassword: true });

    const changed = await admin.post('/api/auth/change-password', {
      headers: { 'x-csrf-token': loginBody.csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.ok()).toBeTruthy();
    expect((await admin.get('/api/auth/me')).status()).toBe(200);

    const oldSession = await playwrightRequest.newContext({ baseURL: baseUrl });
    await oldSession.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const database = openServerDatabase(databasePath);
    database.resetPassword(INITIAL_ADMIN_PASSWORD, 'e2e-local-command');
    database.close();
    expect((await oldSession.get('/api/auth/me')).status()).toBe(401);

    const temporaryLogin = await request.post(`${baseUrl}/api/auth/login`, {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(await temporaryLogin.json()).toMatchObject({ mustChangePassword: true });
    await admin.dispose();
    await oldSession.dispose();
  });
});

test('At most five active logins are retained, new logins evict the least-recently-used session, and accounts can list sessions', async () => {
  await withServer(async (baseUrl) => {
    const devices = await Promise.all(
      Array.from({ length: 6 }, () => playwrightRequest.newContext({ baseURL: baseUrl }))
    );
    const [firstDevice, secondDevice, ...otherDevices] = devices;
    if (firstDevice === undefined || secondDevice === undefined)
      throw new Error('DEVICE_FIXTURE_INVALID');
    try {
      const logins = [];
      for (const device of devices.slice(0, 5)) {
        logins.push(
          await device.post('/api/auth/login', {
            data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
          })
        );
      }
      const firstLogin = logins[0];
      if (firstLogin === undefined) throw new Error('LOGIN_FIXTURE_INVALID');
      expect((await firstDevice.get('/api/auth/me')).status()).toBe(200);
      const sixthDevice = devices[5];
      if (sixthDevice === undefined) throw new Error('DEVICE_FIXTURE_INVALID');
      const sixthLogin = await sixthDevice.post('/api/auth/login', {
        data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
      });
      expect([...logins, sixthLogin].map((login) => login.status())).toEqual([
        200, 200, 200, 200, 200, 200
      ]);
      expect((await secondDevice.get('/api/auth/me')).status()).toBe(401);
      const sessionList = (await (await firstDevice.get('/api/auth/sessions')).json()) as {
        sessions: Array<{ id: string; current: boolean }>;
      };
      expect(sessionList.sessions).toHaveLength(5);
      expect(sessionList.sessions.some((session) => session.current)).toBe(true);

      const secondSession = sessionList.sessions.find((session) => !session.current);
      if (secondSession === undefined) throw new Error('SESSION_FIXTURE_INVALID');
      expect(
        (
          await firstDevice.delete(`/api/auth/sessions/${encodeURIComponent(secondSession.id)}`, {
            headers: { 'x-csrf-token': (await firstLogin.json()).csrfToken }
          })
        ).status()
      ).toBe(204);
      expect((await firstDevice.get('/api/auth/me')).status()).toBe(200);
      expect((await firstDevice.get('/api/auth/sessions')).status()).toBe(200);
    } finally {
      await Promise.all(
        [firstDevice, secondDevice, ...otherDevices].map((device) => device.dispose())
      );
    }
  });
});

test('Login attempts are rate-limited and no second-account registration endpoint is exposed', async ({
  request
}) => {
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await request.post(`${baseUrl}/api/auth/login`, {
            data: { username: 'admin', password: 'invalid' }
          })
        ).status()
      ).toBe(401);
    }
    expect(
      (
        await request.post(`${baseUrl}/api/auth/login`, {
          data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
        })
      ).status()
    ).toBe(429);
    expect(
      (
        await request.post(`${baseUrl}/api/auth/register`, { data: { username: 'another' } })
      ).status()
    ).toBe(404);
  });
});

async function withServer(
  callback: (baseUrl: string, databasePath: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-server-e2e-'));
  const databasePath = join(directory, 'server.sqlite');
  const app = createTestServerApp({
    databasePath,
    // Local Playwright HTTP tests explicitly allow non-Secure cookies; production defaults remain Secure.
    secureCookies: false
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await callback(address, databasePath);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
