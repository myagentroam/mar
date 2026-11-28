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
      if (sql.startsWith('SELECT session_hash')) return [[], []];
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

  it('invalidates only revoked login scopes in terminal and Workbench', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'core-auth-adapter-'));
    const database = openServerDatabase(join(directory, 'server.sqlite'), { now: () => 1_000 });
    const app = Fastify();
    const nodeControl = {
      closeUserTerminals: vi.fn(),
      closeUserWorkbench: vi.fn(),
      closeUserSessions: vi.fn()
    };
    try {
      registerAuthRoutes({
        app,
        store: database,
        audit: { record: (event) => database.audit(event) },
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
      const userId = database.findCurrentUserSession(firstToken)?.userId;
      expect(first.json().userId).toBe(userId);
      expect(userId).toEqual(expect.any(Number));
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `mar_user_session=${firstToken}` }
      });
      expect(me.json().userId).toBe(userId);
      // Equal timestamps use the existing database tie-break; assert the actual evicted hash.
      const issued = [hashOpaque(firstToken)];
      for (let index = 0; index < 5; index++) {
        const session = await login();
        expect(session.statusCode).toBe(200);
        issued.push(
          hashOpaque(String(session.headers['set-cookie']).split(';')[0]!.split('=')[1]!)
        );
      }
      expect(nodeControl.closeUserTerminals).toHaveBeenCalledOnce();
      expect(nodeControl.closeUserWorkbench.mock.calls).toEqual(
        nodeControl.closeUserTerminals.mock.calls
      );
      expect(nodeControl.closeUserTerminals.mock.calls[0]![0]).not.toBe(firstToken);
      expect(nodeControl.closeUserTerminals.mock.calls[0]![0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const latest = await login();
      issued.push(hashOpaque(String(latest.headers['set-cookie']).split(';')[0]!.split('=')[1]!));
      const evicted = new Set(nodeControl.closeUserTerminals.mock.calls.flat());
      const active = issued.filter((hash) => !evicted.has(hash));
      expect(active).toHaveLength(5);
      nodeControl.closeUserTerminals.mockClear();
      nodeControl.closeUserWorkbench.mockClear();
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
      expect(changed.json().userId).toBe(userId);
      expect(nodeControl.closeUserSessions).not.toHaveBeenCalled();
      expect(nodeControl.closeUserTerminals.mock.calls.flat().sort()).toEqual(active.sort());
      expect(nodeControl.closeUserWorkbench.mock.calls).toEqual(
        nodeControl.closeUserTerminals.mock.calls
      );
      const cookie = String(changed.headers['set-cookie']).split(';')[0]!;
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie, 'x-csrf-token': changed.json().csrfToken }
      });
      expect(logout.statusCode).toBe(204);
      const memberId = database.createUser({
        username: 'account-b',
        email: null,
        nickname: null,
        password: 'account-b-password'
      });
      const member = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'account-b', password: 'account-b-password' }
      });
      expect(member.statusCode).toBe(200);
      expect(member.json().userId).toBe(memberId);
      expect(memberId).not.toBe(userId);
      const memberMe = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: String(member.headers['set-cookie']).split(';')[0]! }
      });
      expect(memberMe.json().userId).toBe(memberId);
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
    ).resolves.toEqual([]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });
});
