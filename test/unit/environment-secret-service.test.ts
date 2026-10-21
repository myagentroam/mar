import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openServerDatabase } from '../../ee/server/src/database.js';
import { EnvironmentSecretService } from '../../ee/server/src/service/environment-secret-service.js';
import { createServerApp } from '../../ee/server/src/app.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('EnvironmentSecretService', () => {
  it('Personal then Node secrets override duplicate names and return values only to authorized users', async () => {
    const database = openServerDatabase(await databasePath());
    const admin = database.getAdmin();
    const node = database.registerNode(database.createNodeRegistrationToken(admin.id).token, {
      metadata: JSON.stringify({ nodeAppVersion: '0.1.4' })
    })!;
    const service = new EnvironmentSecretService(database);
    service.create(
      { userId: admin.id, isAdmin: true },
      { scope: 'NODE', nodeId: node.nodeId, name: 'API_KEY', value: 'node' }
    );
    service.create(
      { userId: admin.id, isAdmin: true },
      { scope: 'PERSONAL', name: 'API_KEY', value: 'personal' }
    );

    expect(service.resolve(admin.id, node.nodeId)).toEqual({ API_KEY: 'personal' });
    expect(service.list({ userId: admin.id, isAdmin: true }).map((secret) => secret.value)).toEqual(
      ['personal', 'node']
    );
    database.close();
  });

  it('Personal secrets return values while SQLite compatibility rejects organization and other-user Node secrets', async () => {
    const database = openServerDatabase(await databasePath());
    const admin = database.getAdmin();
    const userId = database.createUser({
      username: 'user',
      email: null,
      nickname: null,
      password: 'user-password-123'
    });
    const node = database.registerNode(database.createNodeRegistrationToken(admin.id).token, {
      metadata: JSON.stringify({ nodeAppVersion: '0.1.4' })
    })!;
    const service = new EnvironmentSecretService(database);
    service.create(
      { userId: admin.id, isAdmin: true },
      { scope: 'PERSONAL', name: 'TOKEN', value: 'hidden' }
    );

    expect(service.list({ userId: admin.id, isAdmin: true })[0]?.value).toBe('hidden');
    expect(() =>
      service.create({ userId, isAdmin: false }, { scope: 'ORGANIZATION', name: 'X', value: 'x' })
    ).toThrow('SECRET_SCOPE_INVALID');
    expect(() =>
      service.create(
        { userId, isAdmin: false },
        { scope: 'NODE', nodeId: node.nodeId, name: 'X', value: 'x' }
      )
    ).toThrow('NODE_FORBIDDEN');
    database.close();
  });

  it('Effective secrets cannot be sent to older Nodes without injection capability', async () => {
    const database = openServerDatabase(await databasePath());
    const admin = database.getAdmin();
    const node = database.registerNode(database.createNodeRegistrationToken(admin.id).token, {
      metadata: JSON.stringify({ nodeAppVersion: '0.1.3' })
    })!;
    const service = new EnvironmentSecretService(database);
    service.create(
      { userId: admin.id, isAdmin: true },
      { scope: 'PERSONAL', name: 'TOKEN', value: 'hidden' }
    );

    expect(() => service.resolve(admin.id, node.nodeId)).toThrow('CAPABILITY_VERSION_UNSUPPORTED');
    database.close();
  });

  it('Capacity limits apply only to the effective merged environment', async () => {
    const database = openServerDatabase(await databasePath());
    const admin = database.getAdmin();
    const node = database.registerNode(database.createNodeRegistrationToken(admin.id).token, {
      metadata: JSON.stringify({ nodeAppVersion: '0.1.4' })
    })!;
    const service = new EnvironmentSecretService(database);
    for (const name of ['KEY_A', 'KEY_B', 'KEY_C', 'KEY_D']) {
      for (const scope of ['NODE', 'PERSONAL'] as const)
        service.create(
          { userId: admin.id, isAdmin: true },
          {
            scope,
            name,
            value: `${scope}:`.padEnd(12 * 1024, 'x'),
            ...(scope === 'NODE' ? { nodeId: node.nodeId } : {})
          }
        );
    }

    expect(Object.keys(service.resolve(admin.id, node.nodeId)).sort()).toEqual([
      'KEY_A',
      'KEY_B',
      'KEY_C',
      'KEY_D'
    ]);
    expect(service.resolve(admin.id, node.nodeId)['KEY_A']).toMatch(/^PERSONAL:/u);
    database.close();
  });

  it('Management APIs return secret values only to authorized users and enforce CSRF and uniqueness on writes', async () => {
    const path = await databasePath();
    const database = openServerDatabase(path);
    database.raw.prepare('UPDATE users SET must_change_password = 0').run();
    database.close();
    const app = createServerApp({ databasePath: path, secureCookies: false });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const payload = { scope: 'PERSONAL', name: 'API_TOKEN', value: 'never-return-this' };

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/environment-secrets',
          headers: { cookie },
          payload
        })
      ).json()
    ).toMatchObject({ error: { code: 'CSRF_INVALID', message: expect.any(String) } });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/environment-secrets',
          headers: { cookie, 'x-csrf-token': csrf },
          payload
        })
      ).statusCode
    ).toBe(201);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/environment-secrets',
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain('never-return-this');
    expect(listed.json()).toMatchObject({
      secrets: [{ scope: 'PERSONAL', name: 'API_TOKEN', value: 'never-return-this' }]
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/environment-secrets',
          headers: { cookie, 'x-csrf-token': csrf },
          payload
        })
      ).json()
    ).toMatchObject({ error: { code: 'SECRET_ALREADY_EXISTS', message: expect.any(String) } });
    await app.shutdown();
  });
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mar-secret-service-'));
  temporaryDirectories.push(directory);
  return join(directory, 'server.sqlite');
}
