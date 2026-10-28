import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestServerApp as createServerApp } from '../support/create-test-server-app.js';
import { openServerDatabase } from '../../ee/server/src/database.js';
import { createTestNodeControl } from '../support/create-test-node-control.js';
import { INITIAL_ADMIN_PASSWORD, verifyPassword } from '../../packages/server-core/src/password.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Server SQLite initialization', () => {
  it('excludes personal internal operations and retains Server lifecycle asynchronously', async () => {
    const database = openServerDatabase(await temporaryDatabasePath());
    try {
      database.audit({
        eventType: 'workspace.file.write',
        metadata: JSON.stringify({ content: 'must not persist' })
      });
      database.audit({
        eventType: 'shared_conversation_input_accepted',
        metadata: JSON.stringify({ userMessage: 'must not persist' })
      });
      database.audit({
        eventType: 'node_registered',
        metadata: JSON.stringify({ nodeId: 'personal-node' })
      });
      await vi.waitFor(() =>
        expect(
          database.raw
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_events WHERE event_type='node_registered'"
            )
            .get()?.['count']
        ).toBe(1)
      );
      expect(
        database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE event_type IN ('workspace.file.write','shared_conversation_input_accepted')"
          )
          .get()?.['count']
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it('Stores optional Node display names while retaining registration addresses by default', async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openServerDatabase(databasePath);
    const admin = database.getAdmin();
    const token = database.createNodeRegistrationToken(admin.id);
    const registered = database.registerNode(
      token.token,
      {
        metadata: JSON.stringify({
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.1.4',
          nodeVersion: '24',
          osVersion: 'Linux 6'
        })
      },
      '192.0.2.8'
    );
    expect(registered).toBeDefined();
    const nodeId = registered!.nodeId;
    expect(database.listNodes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: nodeId,
          displayName: null,
          registeredAddress: '192.0.2.8',
          metadata: JSON.stringify({
            platform: 'linux',
            architecture: 'x64',
            nodeAppVersion: '0.1.4',
            nodeVersion: '24',
            osVersion: 'Linux 6'
          })
        })
      ])
    );
    expect(database.updateNodeDisplayName(nodeId, '开发机', admin.id)).toMatchObject({
      displayName: '开发机'
    });
    expect(database.updateNodeDisplayName(nodeId, null, admin.id)).toMatchObject({
      displayName: null,
      registeredAddress: '192.0.2.8'
    });
    database.close();
  });

  it('creates the single admin account with an Argon2id hash and all base tables', async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openServerDatabase(databasePath);
    const admin = database.getAdmin();
    const tableNames = database.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row['name']));

    expect(admin.mustChangePassword).toBe(true);
    expect(admin.passwordHash).toMatch(/^argon2id\$v=19\$/);
    expect(admin.passwordHash).not.toContain(INITIAL_ADMIN_PASSWORD);
    expect(verifyPassword(INITIAL_ADMIN_PASSWORD, admin.passwordHash)).toBe(true);
    expect(verifyPassword('mar102030', admin.passwordHash)).toBe(false);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        'users',
        'user_sessions',
        'node_registration_tokens',
        'node_credentials',
        'audit_events',
        'schema_migrations'
      ])
    );
    expect(tableNames).not.toContain('owner_sessions');
    database.close();
  });

  it('preserves an existing admin password when reopening the database', async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openServerDatabase(databasePath);
    database.resetPassword('existing-admin-fixture-password', 'local-command');
    database.close();

    const reopened = openServerDatabase(databasePath);
    try {
      const admin = reopened.getAdmin();
      expect(verifyPassword('existing-admin-fixture-password', admin.passwordHash)).toBe(true);
      expect(verifyPassword(INITIAL_ADMIN_PASSWORD, admin.passwordHash)).toBe(false);
      expect(admin.mustChangePassword).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('runs migrations idempotently and enforces user foreign-key constraints', async () => {
    const databasePath = await temporaryDatabasePath();
    const first = openServerDatabase(databasePath);
    first.close();
    const second = openServerDatabase(databasePath);

    expect(() =>
      second.raw
        .prepare(
          "INSERT INTO user_sessions (session_hash, user_id, csrf_token_hash, created_at, expires_at) VALUES ('x', 999, 'x', 0, 1)"
        )
        .run()
    ).toThrow();
    expect(
      second.raw.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()
    ).toMatchObject({ count: 18 });
    second.createNodeRegistrationToken(second.getAdmin().id);
    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`])
      expect((await stat(candidate)).mode & 0o777).toBe(0o600);
    second.close();
  });

  it('v018 only adds the Workspace group column when a historical SQLite workspace table exists', async () => {
    const databasePath = await temporaryDatabasePath();
    const initial = openServerDatabase(databasePath);
    initial.raw.exec(
      `CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY) STRICT;
       DELETE FROM schema_migrations WHERE version=18;`
    );
    initial.close();

    const upgraded = openServerDatabase(databasePath);
    expect(
      upgraded.raw
        .prepare('PRAGMA table_info(workspaces)')
        .all()
        .map((row) => row['name'])
    ).toEqual(['workspace_id', 'group_name']);
    upgraded.close();
  });

  it('v016 migrates ciphertext once with the legacy master key and then stores readable values only', async () => {
    const databasePath = await temporaryDatabasePath();
    const initial = openServerDatabase(databasePath);
    const key = randomBytes(32);
    const id = 'legacy-secret';
    const name = 'API_TOKEN';
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([id, 'SYSTEM', null, null, name])));
    const ciphertext = Buffer.concat([cipher.update('legacy-value', 'utf8'), cipher.final()]);
    initial.raw.exec(
      `DROP TABLE environment_secrets;
       CREATE TABLE environment_secrets (
         id TEXT PRIMARY KEY,
         scope TEXT NOT NULL,
         owner_user_id INTEGER,
         node_id TEXT,
         name TEXT NOT NULL,
         ciphertext TEXT NOT NULL,
         nonce TEXT NOT NULL,
         auth_tag TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT;
       DELETE FROM schema_migrations WHERE version >= 16;`
    );
    initial.raw
      .prepare(
        `INSERT INTO environment_secrets
         (id, scope, owner_user_id, node_id, name, ciphertext, nonce, auth_tag, created_at, updated_at)
         VALUES (?, 'SYSTEM', NULL, NULL, ?, ?, ?, ?, 1, 1)`
      )
      .run(
        id,
        name,
        ciphertext.toString('base64'),
        nonce.toString('base64'),
        cipher.getAuthTag().toString('base64')
      );
    initial.close();

    const previousKey = process.env['MAR_SECRET_ENCRYPTION_KEY'];
    try {
      delete process.env['MAR_SECRET_ENCRYPTION_KEY'];
      expect(() => openServerDatabase(databasePath)).toThrow(
        'LEGACY_SECRET_ENCRYPTION_KEY_REQUIRED'
      );
      const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
      ).toMatchObject({ version: 15 });
      expect(
        rolledBack
          .prepare('PRAGMA table_info(environment_secrets)')
          .all()
          .map((row) => row['name'])
      ).toContain('ciphertext');
      rolledBack.close();

      process.env['MAR_SECRET_ENCRYPTION_KEY'] = key.toString('base64');
      const upgraded = openServerDatabase(databasePath);
      expect(
        upgraded.raw.prepare('SELECT name, value FROM environment_secrets').get()
      ).toMatchObject({ name, value: 'legacy-value' });
      expect(
        upgraded.raw
          .prepare('PRAGMA table_info(environment_secrets)')
          .all()
          .map((row) => row['name'])
      ).not.toContain('ciphertext');
      upgraded.close();
    } finally {
      if (previousKey === undefined) delete process.env['MAR_SECRET_ENCRYPTION_KEY'];
      else process.env['MAR_SECRET_ENCRYPTION_KEY'] = previousKey;
    }
  });

  it('Rejects Server database versions newer than the running code', async () => {
    const databasePath = await temporaryDatabasePath();
    const initial = openServerDatabase(databasePath);
    initial.raw.prepare('UPDATE schema_migrations SET version = 99 WHERE version = 11').run();
    initial.close();

    expect(() => openServerDatabase(databasePath)).toThrow('SERVER_DATABASE_VERSION_UNSUPPORTED');
  });

  it('Rebuilding legacy nodes tables preserves Nodes with existing credentials', async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openServerDatabase(databasePath);
    const admin = database.getAdmin();
    const token = database.createNodeRegistrationToken(admin.id);
    const registered = database.registerNode(token.token, {
      metadata: JSON.stringify({ platform: 'linux', architecture: 'x64', nodeVersion: 'v24' })
    });
    expect(registered).toBeDefined();
    database.raw.exec(
      `ALTER TABLE nodes ADD COLUMN platform TEXT NOT NULL DEFAULT 'linux';
       ALTER TABLE nodes ADD COLUMN architecture TEXT NOT NULL DEFAULT 'x64';
       ALTER TABLE nodes ADD COLUMN node_app_version TEXT NOT NULL DEFAULT 'unknown';
       ALTER TABLE nodes ADD COLUMN node_version TEXT NOT NULL DEFAULT 'v24';
       ALTER TABLE nodes ADD COLUMN capabilities TEXT NOT NULL DEFAULT '{}';
       DELETE FROM schema_migrations WHERE version >= 13;`
    );
    database.close();

    const upgraded = openServerDatabase(databasePath);
    expect(upgraded.listNodes()).toHaveLength(1);
    expect(
      upgraded.raw
        .prepare('PRAGMA table_info(nodes)')
        .all()
        .map((row) => row['name'])
    ).not.toContain('platform');
    upgraded.close();
  });

  it('Removes legacy Server execution projections to enforce Node-owned data and supports idempotent reopening', async () => {
    const databasePath = await temporaryDatabasePath();
    const initial = openServerDatabase(databasePath);
    // Simulate legacy centralized table residue; after upgrade, Server keeps only authentication and Node information.
    initial.raw.exec(
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY);
       CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY);
       DELETE FROM schema_migrations WHERE version >= 6;
       PRAGMA foreign_keys = ON;`
    );
    initial.close();

    const upgraded = openServerDatabase(databasePath);
    expect(
      upgraded.raw
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => row['version'])
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(
      upgraded.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
        .get()
    ).toBeUndefined();
    expect(
      upgraded.raw
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'
           AND name IN ('agent_sessions', 'agent_runs', 'run_events', 'approvals', 'workspace_leases', 'run_snapshots')`
        )
        .get()
    ).toMatchObject({ count: 0 });
    expect(
      upgraded.raw
        .prepare('PRAGMA table_info(nodes)')
        .all()
        .map((row) => row['name'])
    ).toEqual([
      'id',
      'display_name',
      'registered_address',
      'metadata',
      'disabled',
      'last_heartbeat_at',
      'created_at',
      'updated_at',
      'owner_user_id'
    ]);
    upgraded.close();

    const reopened = openServerDatabase(databasePath);
    expect(
      reopened.raw.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()
    ).toMatchObject({ count: 18 });
    reopened.close();
  });

  it('Login-limit migration retains only the five most recent active Sessions', async () => {
    const databasePath = await temporaryDatabasePath();
    const initial = openServerDatabase(databasePath);
    const expiresAt = Date.now() + 60_000;
    for (let index = 0; index < 6; index += 1) {
      initial.raw
        .prepare(
          `INSERT INTO user_sessions (session_hash, user_id, csrf_token_hash, created_at, expires_at)
           VALUES (?, 1, ?, ?, ?)`
        )
        .run(`session-${index}`, `csrf-${index}`, index, expiresAt);
    }
    initial.raw.prepare('DELETE FROM schema_migrations WHERE version >= 8').run();
    initial.close();

    const upgraded = openServerDatabase(databasePath);
    expect(
      upgraded.raw
        .prepare('SELECT COUNT(*) AS count FROM user_sessions WHERE revoked_at IS NULL')
        .get()
    ).toMatchObject({ count: 5 });
    expect(
      upgraded.raw
        .prepare("SELECT revoked_at FROM user_sessions WHERE session_hash = 'session-0'")
        .get()
    ).toMatchObject({ revoked_at: expect.any(Number) });
    upgraded.close();
  });

  it('keeps a failed transaction from partially persisting a password update', async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openServerDatabase(databasePath);
    const before = database.getAdmin().passwordHash;

    expect(() => {
      database.raw.exec('BEGIN IMMEDIATE');
      database.raw.prepare("UPDATE users SET password_hash = 'changed' WHERE id = 1").run();
      throw new Error('simulate failure');
    }).toThrow('simulate failure');
    database.raw.exec('ROLLBACK');

    expect(database.getAdmin().passwordHash).toBe(before);
    database.close();
  });
});

describe('Server admin authentication', () => {
  it('HTTP errors use random request IDs unique across Server instances', async () => {
    const requestId = async (app: ReturnType<typeof createServerApp>): Promise<string> => {
      const response = await app.inject({ method: 'GET', url: '/api/not-found' });
      expect(response.statusCode).toBe(404);
      return response.json<{ error: { requestId: string } }>().error.requestId;
    };
    const first = createServerApp({ databasePath: ':memory:' });
    const firstIds: string[] = [];
    try {
      firstIds.push(await requestId(first), await requestId(first));
    } finally {
      await first.close();
    }
    const restarted = createServerApp({ databasePath: ':memory:' });
    let restartedId: string;
    try {
      restartedId = await requestId(restarted);
    } finally {
      await restarted.close();
    }

    const ids = [...firstIds, restartedId];
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => /^req-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id))).toBe(
      true
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Admin retains at most five Sessions, evicts old logins by LRU, and exposes redacted login information', async () => {
    let now = 1_700_000_000_000;
    const app = createServerApp({
      databasePath: await temporaryDatabasePath(),
      now: () => now++
    });
    const logins = [];
    for (let index = 0; index < 5; index += 1) {
      logins.push(
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          remoteAddress: `192.0.2.${index + 1}`,
          headers: { 'user-agent': `test-device-${index + 1}` },
          payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
        })
      );
    }
    expect(logins.map((login) => login.statusCode)).toEqual([200, 200, 200, 200, 200]);
    const [first, second] = logins;
    if (first === undefined || second === undefined) throw new Error('LOGIN_FIXTURE_INVALID');
    const firstCookie = cookieFrom(first.headers['set-cookie']);
    const secondCookie = cookieFrom(second.headers['set-cookie']);

    expect(firstCookie).toMatch(/^mar_user_session=/);
    expect(secondCookie).toMatch(/^mar_user_session=/);
    expect(firstCookie).not.toBe(secondCookie);
    const legacyCookie = firstCookie.replace('mar_user_session=', 'mar_owner_session=');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: legacyCookie }
        })
      ).statusCode
    ).toBe(401);
    await expect(
      app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: firstCookie } })
    ).resolves.toMatchObject({ statusCode: 200 });
    const sessions = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: firstCookie }
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          current: true,
          ipAddress: '192.0.2.1',
          userAgent: 'test-device-1'
        })
      ])
    });
    expect(sessions.json<{ sessions: unknown[] }>().sessions).toHaveLength(5);
    expect(JSON.stringify(sessions.json())).not.toMatch(/csrf|session_hash|sessionHash/i);

    const sixth = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'user-agent': 'test-device-6' },
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(sixth.statusCode).toBe(200);
    const sixthCookie = cookieFrom(sixth.headers['set-cookie']);
    expect(sixthCookie).toMatch(/^mar_user_session=/);

    await expect(
      app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: firstCookie } })
    ).resolves.toMatchObject({
      statusCode: 200
    });
    await expect(
      app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: secondCookie } })
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sixthCookie } })
    ).resolves.toMatchObject({ statusCode: 200 });

    const sessionsAfterEviction = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: firstCookie }
    });
    expect(sessionsAfterEviction.json<{ sessions: unknown[] }>().sessions).toHaveLength(5);

    const otherSession = sessionsAfterEviction
      .json<{ sessions: Array<{ id: string; current: boolean; userAgent: string }> }>()
      .sessions.find((session) => session.userAgent === 'test-device-3');
    if (otherSession === undefined) throw new Error('SESSION_FIXTURE_INVALID');
    const logout = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${encodeURIComponent(otherSession.id)}`,
      headers: {
        cookie: firstCookie,
        'x-csrf-token': first.json<{ csrfToken: string }>().csrfToken
      }
    });
    expect(logout.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: firstCookie } }))
        .statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: secondCookie } }))
        .statusCode
    ).toBe(401);
    await app.close();
  });

  it('requires first-login password change, CSRF, and revokes the original session', async () => {
    const databasePath = await temporaryDatabasePath();
    const app = createServerApp({ databasePath, secureCookies: true });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const oldCookie = cookieFrom(login.headers['set-cookie']);
    const csrfToken = login.json<{ csrfToken: string }>().csrfToken;

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ authenticated: true, mustChangePassword: true });
    expect(oldCookie).toContain('HttpOnly');
    expect(oldCookie).toContain('SameSite=Lax');
    expect(oldCookie).toContain('Secure');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/change-password',
          headers: { cookie: oldCookie },
          payload: { password: INITIAL_ADMIN_PASSWORD }
        })
      ).json()
    ).toEqual({
      error: {
        code: 'CSRF_INVALID',
        message: 'CSRF is invalid.',
        requestId: expect.any(String)
      }
    });

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: oldCookie, 'x-csrf-token': csrfToken },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    const newCookie = cookieFrom(change.headers['set-cookie']);
    expect(change.statusCode).toBe(200);
    expect(change.json()).toMatchObject({ authenticated: true, mustChangePassword: false });
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: oldCookie } })
      ).json()
    ).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required.',
        requestId: expect.any(String)
      }
    });
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: newCookie } })
      ).json()
    ).toEqual({
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true,
      locale: 'zh-CN'
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
        })
      ).json()
    ).toMatchObject({ authenticated: true, mustChangePassword: false });
    await app.close();

    const database = openServerDatabase(databasePath);
    const eventTypes = database.raw
      .prepare('SELECT event_type FROM audit_events ORDER BY id')
      .all()
      .map((row) => String(row['event_type']));
    expect(eventTypes).toEqual(
      expect.arrayContaining(['admin_initialized', 'login_succeeded', 'password_changed'])
    );
    database.close();
  });

  it('rejects a password that does not satisfy the policy', async () => {
    const app = createServerApp({ databasePath: await temporaryDatabasePath() });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: cookieFrom(login.headers['set-cookie']),
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'short' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'PASSWORD_POLICY_VIOLATION',
        message: 'Password policy was violated.',
        requestId: expect.any(String)
      }
    });
    await app.close();
  });

  it('requires the current password before changing it', async () => {
    const app = createServerApp({ databasePath: await temporaryDatabasePath() });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: cookieFrom(login.headers['set-cookie']),
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
      },
      payload: { currentPassword: 'incorrect-password', password: 'new-password' }
    });
    expect(response.json()).toEqual({
      error: {
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'Current password is invalid.',
        requestId: expect.any(String)
      }
    });
    await app.close();
  });

  it('enforces Origin, per-IP-account login rate limiting, and does not expose reset over HTTP', async () => {
    const app = createServerApp({
      databasePath: await temporaryDatabasePath(),
      publicOrigin: 'http://localhost:5090'
    });
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://attacker.example' },
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(crossOrigin.json()).toEqual({
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Origin is not allowed.',
        requestId: expect.any(String)
      }
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '192.0.2.12',
        payload: { username: 'admin', password: 'wrong-password' }
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.0.2.12',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({
      error: {
        code: 'LOGIN_RATE_LIMITED',
        message: 'Login is rate limited.',
        requestId: expect.any(String)
      }
    });

    const resetEndpoint = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { password: INITIAL_ADMIN_PASSWORD }
    });
    expect(resetEndpoint.statusCode).toBe(404);
    await app.close();
  });

  it('allows the local reset command path to revoke all admin sessions', async () => {
    const databasePath = await temporaryDatabasePath();
    const app = createServerApp({ databasePath });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const database = openServerDatabase(databasePath);
    database.resetPassword(INITIAL_ADMIN_PASSWORD, 'local-command');
    database.close();

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookieFrom(login.headers['set-cookie']) }
        })
      ).json()
    ).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required.',
        requestId: expect.any(String)
      }
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
        })
      ).json()
    ).toMatchObject({ mustChangePassword: true });
    await app.close();
  });

  it('allows the local reset command to restore the documented initial password only with forced change', async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openServerDatabase(databasePath);
    database.resetPassword(INITIAL_ADMIN_PASSWORD, 'local-command');
    database.close();

    const app = createServerApp({ databasePath });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ mustChangePassword: true });
    await app.close();
  });

  it('does not expose registration or an additional permanent account API', async () => {
    const app = createServerApp({ databasePath: await temporaryDatabasePath() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'another' }
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('Only system administrators who changed their initial password can read recent Server traffic samples', async () => {
    const app = createServerApp({ databasePath: await temporaryDatabasePath() });
    await app.ready();
    expect(
      (await app.inject({ method: 'GET', url: '/api/management/server-traffic' })).statusCode
    ).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const firstCookie = cookieFrom(login.headers['set-cookie']);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/management/server-traffic',
          headers: { cookie: firstCookie }
        })
      ).statusCode
    ).toBe(403);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: firstCookie,
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const response = await app.inject({
      method: 'GET',
      url: '/api/management/server-traffic',
      headers: { cookie: cookieFrom(changed.headers['set-cookie']) }
    });

    expect(response.statusCode).toBe(200);
    const traffic = response.json<{
      sampledAt: number;
      samples: { channels: { http: { inMessages: number; outBytes: number } } }[];
    }>();
    expect(traffic.sampledAt).toEqual(expect.any(Number));
    expect(traffic.samples.length).toBeGreaterThan(0);
    expect(traffic.samples.at(-1)!.channels.http.inMessages).toBeGreaterThan(0);
    expect(traffic.samples.at(-1)!.channels.http.outBytes).toBeGreaterThan(0);
    await app.close();
  });

  it('assigns registered nodes to their creating user and rejects another owner', async () => {
    const database = openServerDatabase(await temporaryDatabasePath());
    const userId = database.createUser({
      username: 'alice',
      email: null,
      nickname: null,
      password: 'alice-password'
    });
    const token = database.createNodeRegistrationToken(userId);
    const registered = database.registerNode(token.token, { metadata: '{}' });
    expect(registered).toBeDefined();
    expect(database.listNodesForUser(userId)).toHaveLength(1);
    expect(database.userOwnsNode(1, registered!.nodeId)).toBe(false);
    expect(database.userOwnsNode(userId, registered!.nodeId)).toBe(true);
    await expect(
      createTestNodeControl(database, (userId, nodeId) =>
        database.userOwnsNode(userId, nodeId)
      ).requestNode(
        registered!.nodeId,
        'workspace.list',
        {},
        {
          userId: 1,
          sessionHash: 'admin-session'
        }
      )
    ).rejects.toThrow('NODE_ACCESS_DENIED');
    expect(database.deleteUser(userId, 1)).toEqual([registered!.nodeId]);
    expect(database.listNodesForUser(userId)).toEqual([]);
    database.close();
  });
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-server-'));
  temporaryDirectories.push(directory);
  return join(directory, 'server.sqlite');
}

function cookieFrom(value: string | string[] | number | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return typeof value === 'string' ? value : '';
}
