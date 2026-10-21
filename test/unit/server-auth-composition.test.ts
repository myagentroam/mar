import type { Pool } from 'mysql2/promise';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { openServerDatabase } from '../../ee/server/src/database.js';
import { registerAuthRoutes } from '../../ee/server/src/route/auth-routes.js';
import { hashOpaque } from '../../packages/server-core/src/session-token.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

function transactionalDatabase() {
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute: vi.fn(async (sql: string) => {
      expect(sql).toEqual(expect.any(String));
      return [{ affectedRows: 1 }, []];
    }),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  const database = new MysqlServerDatabase(
    { getConnection: async () => connection } as unknown as Pool,
    () => 1_000
  );
  return { database, connection };
}

describe('authentication persistence composition', () => {
  it.each(['reset-user', 'reset-admin', 'delete-user'] as const)(
    'invalidates the shared projection after enterprise %s commits',
    async (operation) => {
      const { database, connection } = transactionalDatabase();
      const session = {
        id: 7,
        username: 'fixture',
        role: 'MEMBER',
        is_fixed_admin: false,
        must_change_password: false,
        session_hash: hashOpaque('fixture-cookie'),
        csrf_token_hash: hashOpaque('fixture-csrf'),
        expires_at: 10_000
      };
      Object.assign(database.raw, { execute: vi.fn(async () => [[session], []]) });
      await database.initialize();
      expect(database.findCurrentUserSession('fixture-cookie')?.userId).toBe(7);
      connection.commit.mockClear();
      connection.execute.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }], []] as never;
        if (sql.startsWith('SELECT username')) return [[session], []] as never;
        if (sql.startsWith('SELECT id FROM nodes')) return [[], []] as never;
        return [{ affectedRows: 1 }, []];
      });
      vi.spyOn(database, 'auditWithConnection').mockResolvedValue();
      if (operation === 'reset-user') await database.resetUserPassword(7, 'fixture-password');
      else if (operation === 'reset-admin') await database.resetPassword('fixture-password');
      else await database.deleteUser(7);
      expect(connection.commit).toHaveBeenCalledOnce();
      expect(database.findCurrentUserSession('fixture-cookie')).toBeUndefined();
    }
  );

  it('connects shared session lifecycle events to both terminal and Workbench closures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'core-auth-adapter-'));
    const database = openServerDatabase(join(directory, 'server.sqlite'), { now: () => 1_000 });
    const app = Fastify();
    const nodeControl = {
      closeUserTerminals: vi.fn(),
      closeUserWorkbench: vi.fn(),
      closeAllTerminals: vi.fn(),
      closeAllWorkbench: vi.fn()
    };
    try {
      registerAuthRoutes({
        app,
        database,
        nodeControl,
        now: () => 1_000,
        loginRate: new Map(),
        secureCookies: false,
        publicOrigin: undefined
      });
      const login = () =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
        });
      const first = await login();
      expect(first.statusCode).toBe(200);
      const firstToken = String(first.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
      // Equal timestamps use the existing database tie-break; assert the actual evicted hash.
      for (let index = 0; index < 5; index++) expect((await login()).statusCode).toBe(200);
      expect(nodeControl.closeUserTerminals).toHaveBeenCalledOnce();
      expect(nodeControl.closeUserWorkbench.mock.calls).toEqual(
        nodeControl.closeUserTerminals.mock.calls
      );
      expect(nodeControl.closeUserTerminals.mock.calls[0]![0]).not.toBe(firstToken);
      expect(nodeControl.closeUserTerminals.mock.calls[0]![0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const latest = await login();
      const changed = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: {
          cookie: String(latest.headers['set-cookie']).split(';')[0]!,
          'x-csrf-token': latest.json().csrfToken
        },
        payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
      });
      expect(changed.statusCode).toBe(200);
      expect(nodeControl.closeAllTerminals).toHaveBeenCalledOnce();
      expect(nodeControl.closeAllWorkbench).toHaveBeenCalledOnce();
      const cookie = String(changed.headers['set-cookie']).split(';')[0]!;
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie, 'x-csrf-token': changed.json().csrfToken }
      });
      expect(logout.statusCode).toBe(204);
      expect(nodeControl.closeUserTerminals).toHaveBeenLastCalledWith(
        hashOpaque(cookie.split('=')[1]!)
      );
      expect(nodeControl.closeUserWorkbench).toHaveBeenLastCalledWith(
        hashOpaque(cookie.split('=')[1]!)
      );
    } finally {
      await app.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('hands password-change audit off only after the business transaction commits', async () => {
    const { database, connection } = transactionalDatabase();
    const audit = vi.spyOn(database, 'audit').mockResolvedValue();
    await database.changePassword(7, 'new-test-password', 'password_changed', '127.0.0.1');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'password_changed',
        actorUserId: 7,
        ipAddress: '127.0.0.1'
      })
    );
    expect(audit.mock.invocationCallOrder[0]).toBeGreaterThan(
      connection.commit.mock.invocationCallOrder[0]!
    );
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('does not roll back password changes when asynchronous audit writing fails', async () => {
    const { database, connection } = transactionalDatabase();
    vi.spyOn(database, 'audit').mockRejectedValue(new Error('AUDIT_WRITE_FAILED'));
    await expect(
      database.changePassword(7, 'new-test-password', 'password_changed', '127.0.0.1')
    ).resolves.toBeUndefined();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });
});
