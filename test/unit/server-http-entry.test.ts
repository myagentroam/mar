import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerApp } from '../../ee/server/src/app.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { hashPassword } from '../../packages/server-core/src/password.js';
import { hashOpaque } from '../../packages/server-core/src/session-token.js';

// Exercise the real product composition and authentication routes with an isolated SQL transport.
vi.mock('../../ee/server/src/mysql/connection.js', () => ({
  createMysqlPool: () => {
    const connection = {
      execute: async () => [[], []],
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    };
    return { ...connection, getConnection: async () => connection, end: async () => {} };
  },
  prepareMysqlDatabase: async () => {}
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('HTTP product entry', () => {
  it.each([
    { origin: 'http://192.0.2.10:5190', secure: false },
    { origin: 'http://mar.example.test:5190', secure: false },
    { origin: 'http://mar.example.test:5190', unsetOrigin: true, secure: false },
    { origin: 'http://mar.example.test:5190', environmentOrigin: true, secure: false },
    { origin: 'https://mar.example.test', environmentOrigin: true, secure: true },
    { origin: 'https://mar.example.test', secure: true },
    { origin: 'https://mar.example.test', override: false, secure: false }
  ])(
    'supports login and session recovery at $origin with Secure=$secure',
    async ({ origin, override, secure, unsetOrigin, environmentOrigin }) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-http-entry-'));
      vi.stubEnv('MAR_SECURE_COOKIES', undefined);
      vi.stubEnv('MAR_PUBLIC_ORIGIN', environmentOrigin ? origin : undefined);
      vi.spyOn(MysqlServerDatabase.prototype, 'initialize').mockResolvedValue();
      vi.spyOn(MysqlServerDatabase.prototype, 'findUserForLogin').mockResolvedValue({
        id: 1,
        passwordHash: hashPassword('fixture-password'),
        isAdmin: true,
        mustChangePassword: false
      });
      vi.spyOn(MysqlServerDatabase.prototype, 'createUserSession').mockResolvedValue({
        sessionId: 'http-fixture-session',
        csrfToken: 'http-fixture-csrf',
        expiresAt: Date.now() + 60_000,
        evictedSessionHashes: []
      });
      vi.spyOn(MysqlServerDatabase.prototype, 'findCurrentUserSession').mockImplementation((id) =>
        id === 'http-fixture-session'
          ? {
              userId: 1,
              username: 'fixture',
              isAdmin: true,
              mustChangePassword: false,
              sessionHash: hashOpaque(id),
              csrfTokenHash: hashOpaque('http-fixture-csrf')
            }
          : undefined
      );
      const { app } = await createServerApp({
        dataDirectory: directory,
        productUuid: null,
        ...(unsetOrigin || environmentOrigin ? {} : { publicOrigin: origin }),
        ...(override === undefined ? {} : { secureCookies: override })
      });
      try {
        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin, host: new URL(origin).host },
          payload: { username: 'fixture', password: 'fixture-password' }
        });
        expect(login.statusCode).toBe(200);
        const cookie = String(login.headers['set-cookie']);
        expect(cookie.includes('; Secure')).toBe(secure);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Lax');
        const me = await app.inject({
          url: '/api/auth/me',
          headers: { cookie: cookie.split(';')[0]! }
        });
        expect(me.statusCode).toBe(200);
        expect(me.json()).toMatchObject({ authenticated: true, username: 'fixture' });
        const foreign = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin: 'http://other.example.test' },
          payload: { username: 'fixture', password: 'fixture-password' }
        });
        expect(foreign.statusCode).toBe(403);
        expect(foreign.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
        if (unsetOrigin) {
          const undeclaredTls = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            headers: { origin: origin.replace('http:', 'https:'), host: new URL(origin).host },
            payload: { username: 'fixture', password: 'fixture-password' }
          });
          expect(undeclaredTls.statusCode).toBe(403);
        }
        const logoutHeaders = {
          origin,
          host: new URL(origin).host,
          cookie: 'mar_user_session=http-fixture-session'
        };
        const denied = await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: logoutHeaders
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
        const logout = await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { ...logoutHeaders, 'x-csrf-token': 'http-fixture-csrf' }
        });
        expect(logout.statusCode).toBe(204);
        const cleared = [logout.headers['set-cookie']]
          .flat()
          .find((value) => value?.startsWith('mar_user_session='));
        expect(cleared).toContain('Max-Age=0');
        expect(cleared?.includes('; Secure')).toBe(secure);
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
