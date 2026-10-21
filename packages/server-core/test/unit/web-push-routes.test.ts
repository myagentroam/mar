import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerWebPushRoutes } from '../../src/web-push-routes.js';
import type { CurrentUserSession } from '../../src/session.js';
import { hashOpaque } from '../../src/session-token.js';

function fixture() {
  let timestamp = 1000;
  const session: CurrentUserSession = {
    userId: 1,
    username: 'alice',
    sessionHash: 'a'.repeat(43),
    csrfTokenHash: hashOpaque('csrf'),
    isAdmin: false,
    mustChangePassword: false
  };
  const database = {
    findCurrentUserSession: vi.fn<() => CurrentUserSession | undefined>(() => session)
  };
  const capability = { enabled: true, available: true, publicKey: 'public' };
  const configuration = { read: vi.fn(async () => capability) };
  const clients = {
    inspect: vi.fn(async () => undefined),
    register: vi.fn(async () => ({ subscriptionId: 'record-1', bindingVersion: 1, enabled: true }))
  };
  const app = Fastify();
  registerWebPushRoutes({
    app,
    database,
    clients,
    configuration,
    publicOrigin: 'https://console.example.test',
    now: () => timestamp
  });
  const headers = {
    cookie: 'mar_user_session=session-id',
    'x-csrf-token': 'csrf',
    origin: 'https://console.example.test'
  };
  const body = {
    expectedAccount: 'alice',
    clientKind: 'mobile',
    clientToken: Buffer.alloc(32, 3).toString('base64url'),
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/client',
      keys: {
        p256dh: Buffer.alloc(65, 4).toString('base64url'),
        auth: Buffer.alloc(16, 5).toString('base64url')
      }
    }
  };
  return {
    app,
    database,
    session,
    capability,
    clients,
    headers,
    body,
    now: (value: number) => {
      timestamp = value;
    }
  };
}

describe('authenticated Web Push subscription routes', () => {
  it('rejects an old registration without client kind before calling the client store', async () => {
    const f = fixture();
    try {
      const { clientKind: _clientKind, ...legacyRegistration } = f.body;
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/notifications/push/clients',
        headers: f.headers,
        payload: legacyRegistration
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'WEB_PUSH_INPUT_INVALID' } });
      expect(f.clients.register).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it('rejects a stale page when the current Cookie account changed before registration or lookup', async () => {
    const f = fixture();
    try {
      for (const [url, payload] of [
        ['/api/notifications/push/clients', { ...f.body, expectedAccount: 'previous-account' }],
        [
          '/api/notifications/push/clients/resolve',
          { clientToken: f.body.clientToken, expectedAccount: 'previous-account' }
        ]
      ] as const) {
        const response = await f.app.inject({ method: 'POST', url, headers: f.headers, payload });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: 'WEB_PUSH_SESSION_INVALID' } });
      }
      expect(f.clients.register).not.toHaveBeenCalled();
      expect(f.clients.inspect).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it('resolves only the authenticated account binding after Origin and CSRF checks', async () => {
    const f = fixture();
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/notifications/push/clients/resolve',
        headers: f.headers,
        payload: { clientToken: f.body.clientToken, expectedAccount: f.session.username }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ binding: null });
      expect(f.clients.inspect).toHaveBeenCalledWith(f.session, f.body.clientToken);
      const denied = await f.app.inject({
        method: 'POST',
        url: '/api/notifications/push/clients/resolve',
        headers: { ...f.headers, 'x-csrf-token': 'wrong' },
        payload: { clientToken: f.body.clientToken, expectedAccount: f.session.username }
      });
      expect(denied.statusCode).toBe(403);
      expect(f.clients.inspect).toHaveBeenCalledTimes(1);
    } finally {
      await f.app.close();
    }
  });

  it('exposes a minimal capability to normal users and binds registration to the authenticated identity', async () => {
    const f = fixture();
    try {
      const read = await f.app.inject({
        method: 'GET',
        url: '/api/notifications/push',
        headers: f.headers
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ ...f.capability, account: 'alice' });
      const write = await f.app.inject({
        method: 'POST',
        url: '/api/notifications/push/clients',
        headers: f.headers,
        payload: f.body
      });
      expect(write.statusCode).toBe(200);
      const { expectedAccount: _expected, ...registration } = f.body;
      expect(f.clients.register).toHaveBeenCalledWith(f.session, {
        ...registration,
        enabled: true
      });
      expect(write.json()).toEqual({
        subscriptionId: 'record-1',
        bindingVersion: 1,
        enabled: true,
        account: 'alice'
      });
      expect(write.body).not.toContain(f.body.clientToken);
      expect(write.body).not.toContain(f.body.subscription.endpoint);
    } finally {
      await f.app.close();
    }
  });

  it('rejects unauthenticated and password-change sessions, invalid origins, CSRF and caller identities', async () => {
    const f = fixture();
    try {
      for (const [headers, payload, expected] of [
        [{ ...f.headers, origin: 'https://evil.example' }, f.body, 403],
        [{ ...f.headers, 'x-csrf-token': 'wrong' }, f.body, 403],
        [f.headers, { ...f.body, userId: 2 }, 400]
      ] as const) {
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: '/api/notifications/push/clients',
              headers,
              payload
            })
          ).statusCode
        ).toBe(expected);
      }
      f.database.findCurrentUserSession.mockReturnValue(undefined);
      expect(
        (await f.app.inject({ method: 'GET', url: '/api/notifications/push', headers: f.headers }))
          .statusCode
      ).toBe(401);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/notifications/push/clients',
            headers: f.headers,
            payload: f.body
          })
        ).statusCode
      ).toBe(401);
      f.database.findCurrentUserSession.mockReturnValue({ ...f.session, mustChangePassword: true });
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/notifications/push/clients',
            headers: f.headers,
            payload: f.body
          })
        ).statusCode
      ).toBe(401);
      expect(f.clients.register).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it('blocks enabling while globally disabled but still permits local disabling', async () => {
    const f = fixture();
    try {
      f.capability.enabled = false;
      const rejected = await f.app.inject({
        method: 'POST',
        url: '/api/notifications/push/clients',
        headers: f.headers,
        payload: f.body
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().error.code).toBe('WEB_PUSH_DISABLED');
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/notifications/push/clients',
            headers: f.headers,
            payload: { ...f.body, enabled: false }
          })
        ).statusCode
      ).toBe(200);
      expect(f.clients.register).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it('rate-limits registration per authenticated user and allows a fresh bounded window', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 30; i++)
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: '/api/notifications/push/clients',
              headers: f.headers,
              payload: f.body
            })
          ).statusCode
        ).toBe(200);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/notifications/push/clients',
            headers: f.headers,
            payload: f.body
          })
        ).statusCode
      ).toBe(429);
      expect(f.clients.register).toHaveBeenCalledTimes(30);
      f.now(61_001);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/notifications/push/clients',
            headers: f.headers,
            payload: f.body
          })
        ).statusCode
      ).toBe(200);
    } finally {
      await f.app.close();
    }
  });
});
