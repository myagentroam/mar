import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAuthFixture } from './support/auth-fixture.js';
import { hashOpaque } from '../../src/session-token.js';
import { INITIAL_ADMIN_PASSWORD } from '../../src/password.js';

const apps: FastifyInstance[] = [];
function fixture() {
  const value = createAuthFixture();
  apps.push(value.app);
  return value;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const credentials = (response: {
  headers: Record<string, unknown>;
  json(): { csrfToken: string };
}) => ({
  cookie: String(response.headers['set-cookie']).split(';')[0]!,
  'x-csrf-token': response.json().csrfToken
});

describe('portable authentication HTTP flow', () => {
  it('provides health and login, records basic audit, persists locale and projects current capabilities', async () => {
    const { app, login, store, audits, localePreferences, productCapabilities } = fixture();
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    const response = await login();
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('HttpOnly; SameSite=Lax');
    expect(response.headers['set-cookie']).toContain('; Secure');
    expect(response.json()).toMatchObject({
      authenticated: true,
      mustChangePassword: true,
      username: 'admin',
      locale: 'en-US',
      edition: 'COMMUNITY',
      csrfToken: 'csrf-1'
    });
    expect(localePreferences.setLocale).toHaveBeenCalledWith(1, 'en-US');
    expect(audits).toEqual([
      { eventType: 'login_succeeded', actorUserId: 1, ipAddress: '127.0.0.1' }
    ]);
    expect(store.createUserSession).toHaveBeenCalledWith(1, {
      ipAddress: '127.0.0.1',
      userAgent: expect.any(String)
    });
    const me = await app.inject({ url: '/api/auth/me', headers: credentials(response) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ locale: 'en-US', mustChangePassword: true });
    expect(me.json()).not.toHaveProperty('csrfToken');
    expect(productCapabilities.capability).toHaveBeenNthCalledWith(2, 1);
  });

  it('rejects unknown identities and bad passwords, throttles attempts and records failures without credentials', async () => {
    const { app, audits, now, store } = fixture();
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'unavailable-user', password: 'test-only-invalid-password' }
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'unavailable-user', password: 'test-only-invalid-password' }
    });
    expect(limited.statusCode).toBe(429);
    expect(store.createUserSession).not.toHaveBeenCalled();
    expect(audits.map((event) => event.eventType)).toEqual([
      ...Array.from({ length: 5 }, () => 'login_failed'),
      'login_rate_limited'
    ]);
    expect(JSON.stringify(audits)).not.toContain('test-only-invalid-password');
    expect(JSON.stringify(audits)).not.toContain('unavailable-user');
    now.mockReturnValue(601_000);
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' }
    });
    expect(wrongPassword.statusCode).toBe(401);
  });

  it('closes each LRU-evicted session by hash before recording successful login', async () => {
    const { login, store, lifecycle, audits, audit } = fixture();
    store.createUserSession.mockResolvedValueOnce({
      sessionId: 'new-cookie',
      csrfToken: 'new-csrf',
      expiresAt: 601_000,
      evictedSessionHashes: ['evicted-hash-a', 'evicted-hash-b']
    });
    expect((await login()).statusCode).toBe(200);
    expect(lifecycle.closeSessionConnections.mock.calls).toEqual([
      ['evicted-hash-a'],
      ['evicted-hash-b']
    ]);
    expect(audits.map((event) => event.eventType)).toEqual([
      'login_session_lru_evicted',
      'login_succeeded'
    ]);
    expect(lifecycle.closeSessionConnections.mock.invocationCallOrder.at(-1)).toBeLessThan(
      audit.record.mock.invocationCallOrder[0]!
    );
  });

  it('rejects cross-origin login and rejects writes with missing or invalid CSRF', async () => {
    const { app, login, store } = fixture();
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://other.example.test' },
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(foreign.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    expect(store.findUserForLogin).not.toHaveBeenCalled();
    const loginResponse = await login();
    for (const path of ['/api/auth/logout', '/api/auth/change-password']) {
      const invalid = await app.inject({
        method: 'POST',
        url: path,
        headers: { cookie: credentials(loginResponse).cookie, 'x-csrf-token': 'incorrect' }
      });
      expect(invalid.statusCode).toBe(403);
      expect(invalid.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
    }
    expect(store.revokeSession).not.toHaveBeenCalled();
    expect(store.changePassword).not.toHaveBeenCalled();
  });

  it('renews CSRF without an old token, invalidates the old token and persists validated language preferences', async () => {
    const { app, login, localePreferences } = fixture();
    const headers = credentials(await login());
    const renewed = await app.inject({
      method: 'POST',
      url: '/api/auth/csrf',
      headers: { cookie: headers.cookie }
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().csrfToken).not.toBe(headers['x-csrf-token']);
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/auth/preferences/locale',
      headers,
      payload: { locale: 'zh-CN' }
    });
    expect(rejected.statusCode).toBe(403);
    headers['x-csrf-token'] = renewed.json().csrfToken;
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/auth/preferences/locale',
      headers,
      payload: { locale: 'unsupported' }
    });
    expect(invalid.json()).toMatchObject({ error: { code: 'LOCALE_INVALID' } });
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/auth/preferences/locale',
      headers,
      payload: { locale: 'zh-CN' }
    });
    expect(saved.statusCode).toBe(204);
    expect(localePreferences.setLocale).toHaveBeenLastCalledWith(1, 'zh-CN');
    expect((await app.inject({ url: '/api/auth/me', headers })).json().locale).toBe('zh-CN');
  });

  it('lists safe session summaries, refuses unknown public IDs and closes a revoked current session', async () => {
    const { app, login, lifecycle, audits } = fixture();
    const headers = credentials(await login());
    const list = await app.inject({ url: '/api/auth/sessions', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions).toMatchObject([{ id: 'public-1', current: true }]);
    expect(JSON.stringify(list.json())).not.toMatch(/csrf|sessionHash|session-1/u);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/auth/sessions/unknown',
          headers
        })
      ).statusCode
    ).toBe(404);
    expect(lifecycle.closeSessionConnections).not.toHaveBeenCalled();
    const revoked = await app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions/public-1',
      headers
    });
    expect(revoked.statusCode).toBe(204);
    expect(revoked.headers['set-cookie']).toContain('Max-Age=0');
    expect(lifecycle.closeSessionConnections).toHaveBeenCalledWith(hashOpaque('session-1'));
    expect(audits.at(-1)?.eventType).toBe('user_session_revoked');
    expect((await app.inject({ url: '/api/auth/me', headers })).statusCode).toBe(401);
  });

  it('changes the password through the atomic store operation before closing connections and issuing a new session', async () => {
    const { app, login, store, lifecycle, audits } = fixture();
    const headers = credentials(await login());
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'updated-test-password' }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ authenticated: true, mustChangePassword: false });
    expect(store.changePassword).toHaveBeenCalledWith(
      1,
      'updated-test-password',
      'password_changed',
      '127.0.0.1'
    );
    expect(store.changePassword.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.closeAllConnections.mock.invocationCallOrder[0]!
    );
    expect(lifecycle.closeAllConnections.mock.invocationCallOrder[0]).toBeLessThan(
      store.createUserSession.mock.invocationCallOrder[1]!
    );
    expect(audits.filter((event) => event.eventType === 'password_changed')).toEqual([]);
    expect((await app.inject({ url: '/api/auth/me', headers })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/auth/me', headers: credentials(changed) })).statusCode
    ).toBe(200);
  });

  it('rejects incorrect current passwords and invalid new passwords before modifying state', async () => {
    const { app, login, store, lifecycle } = fixture();
    const headers = credentials(await login());
    for (const [currentPassword, password, code] of [
      ['wrong', 'new-test-password', 'CURRENT_PASSWORD_INVALID'],
      [INITIAL_ADMIN_PASSWORD, 'short', 'PASSWORD_POLICY_VIOLATION']
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers,
        payload: { currentPassword, password }
      });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({ error: { code } });
    }
    expect(store.changePassword).not.toHaveBeenCalled();
    expect(lifecycle.closeAllConnections).not.toHaveBeenCalled();
  });

  it('logs out only the current session and never sends raw cookies to the lifecycle sink', async () => {
    const { app, login, lifecycle, audit } = fixture();
    const headers = credentials(await login());
    const other = credentials(await login());
    const result = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(result.statusCode).toBe(204);
    expect(result.headers['set-cookie']).toContain('Max-Age=0');
    expect(lifecycle.closeSessionConnections).toHaveBeenCalledWith(hashOpaque('session-1'));
    expect(lifecycle.closeAllConnections).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenLastCalledWith({
      eventType: 'logout',
      actorUserId: 1,
      ipAddress: '127.0.0.1'
    });
    expect((await app.inject({ url: '/api/auth/me', headers: other })).statusCode).toBe(200);
  });

  it('does not return authentication success after an audit, capability or password transaction failure', async () => {
    const first = fixture();
    first.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    expect((await first.login()).statusCode).toBe(500);
    const second = fixture();
    second.productCapabilities.capability.mockRejectedValueOnce(
      new Error('CAPABILITIES_UNAVAILABLE')
    );
    expect((await second.login()).statusCode).toBe(500);
    const third = fixture();
    const headers = credentials(await third.login());
    third.store.changePassword.mockRejectedValueOnce(new Error('PASSWORD_TRANSACTION_FAILED'));
    const changed = await third.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'new-test-password' }
    });
    expect(changed.statusCode).toBe(500);
    expect(third.lifecycle.closeAllConnections).not.toHaveBeenCalled();
    expect(third.store.createUserSession).toHaveBeenCalledTimes(1);
  });
});
