import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import { registerCodexCredentialRoutes } from '../../ee/server/src/route/codex-credential-routes.js';
import type { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';
import type { CodexCredentialService } from '../../ee/server/src/service/codex-credential-service.js';
import {
  NOW,
  activeCredential,
  authorizationFixture,
  database,
  jwt,
  service
} from './support/codex-credential-service.js';

const actor = { userId: 1, sessionFingerprint: 'owner-session' };
const draft = {
  name: 'Team Codex',
  ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
};
const services: CodexCredentialService[] = [];
afterEach(() => {
  services.splice(0).forEach((credentials) => credentials.closeChatgptLogins());
});

function fixture(relogin = false, stage = '/oauth/token') {
  const initial = relogin ? [activeCredential()] : [];
  const store = database(initial);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const token = jwt({
    exp: Math.floor((NOW + 60 * 60 * 1000) / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-secret' }
  });
  const request = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === stage) {
      entered.resolve();
      await release.promise;
    }
    if (path.endsWith('/usercode'))
      return Response.json({
        device_auth_id: 'device-secret',
        user_code: 'ABCD-EFGH',
        interval: 5
      });
    if (path.endsWith('/deviceauth/token'))
      return Response.json({
        authorization_code: 'authorization-secret',
        code_verifier: 'verifier-secret'
      });
    if (path.endsWith('/oauth/token'))
      return Response.json({
        access_token: token,
        refresh_token: 'new-refresh-secret',
        id_token: token
      });
    if (path.endsWith('/models')) return Response.json({ models: [] });
    throw new Error('Unexpected OAuth fixture endpoint');
  });
  let now = NOW;
  const authorization = authorizationFixture();
  const credentials = service(
    store.database,
    request as typeof fetch,
    () => now,
    () => 'attempt-1',
    authorization
  );
  services.push(credentials);
  return {
    ...store,
    credentials,
    request,
    authorization,
    entered: entered.promise,
    release: () => release.resolve(),
    expire: () => {
      now += 15 * 60 * 1000;
    },
    start: () =>
      credentials.startLogin(actor, {
        ...draft,
        ...(relogin ? { targetCredentialId: 'credential-1' } : {})
      }),
    writes: () =>
      store.execute.mock.calls.filter(([sql]) => sql.includes('INSERT INTO system_settings')),
    initial: { version: 3, credentials: initial }
  };
}

describe('standard Codex in-flight login ownership', () => {
  it.each([false, true])(
    'does not create or replace credentials after cancellation during token exchange, relogin=%s',
    async (relogin) => {
      const f = fixture(relogin);
      const attempt = await f.start();
      const poll = f.credentials.loginAttempt(actor, attempt.id);
      await f.entered;
      await f.credentials.cancelLogin(actor, attempt.id);
      f.release();

      expect(await poll).toMatchObject({ status: 'FAILED', code: 'CODEX_LOGIN_ATTEMPT_NOT_FOUND' });
      expect(f.document()).toEqual(f.initial);
      expect(f.writes()).toHaveLength(0);
      expect(f.audit).not.toHaveBeenCalled();
      await expect(f.credentials.loginAttempt(actor, attempt.id)).rejects.toThrow(
        'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
      );
    }
  );

  it.each([false, true])(
    'coalesces concurrent polls into one exchange, save, revision and audit, relogin=%s',
    async (relogin) => {
      const f = fixture(relogin);
      const attempt = await f.start();
      const first = f.credentials.loginAttempt(actor, attempt.id);
      await f.entered;
      const second = f.credentials.loginAttempt(actor, attempt.id);
      for (const other of [
        { ...actor, userId: 2 },
        { ...actor, sessionFingerprint: 'other' }
      ])
        await expect(f.credentials.loginAttempt(other, attempt.id)).rejects.toThrow(
          'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
        );
      f.release();
      const results = await Promise.all([first, second]);

      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({
        status: 'SUCCEEDED',
        credentialId: relogin ? 'credential-1' : attempt.id
      });
      expect(f.request.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        '/api/accounts/deviceauth/usercode',
        '/api/accounts/deviceauth/token',
        '/oauth/token',
        '/backend-api/codex/models'
      ]);
      expect(f.writes()).toHaveLength(1);
      expect(f.document()).toMatchObject({
        credentials: [{ revision: relogin ? 2 : 1, refreshToken: 'new-refresh-secret' }]
      });
      expect(f.audit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          eventType: 'credential.saved',
          targetId: relogin ? 'credential-1' : attempt.id,
          actorUserId: 1,
          organizationId: 1
        })
      );
    }
  );

  it.each(['/api/accounts/deviceauth/token', '/backend-api/codex/models', 'ownership'])(
    'does not cross a later cancellation while awaiting %s',
    async (stage) => {
      const f = fixture(true, stage);
      const attempt = await f.start();
      const ownership = Promise.withResolvers<void>();
      const releaseOwnership = Promise.withResolvers<void>();
      if (stage === 'ownership')
        vi.spyOn(f.authorization, 'authorize').mockImplementation(async () => {
          ownership.resolve();
          await releaseOwnership.promise;
          return { allowed: true };
        });
      const poll = f.credentials.loginAttempt(actor, attempt.id);
      await (stage === 'ownership' ? ownership.promise : f.entered);
      await f.credentials.cancelLogin(actor, attempt.id);
      f.release();
      releaseOwnership.resolve();

      expect(await poll).toMatchObject({ status: 'FAILED', code: 'CODEX_LOGIN_ATTEMPT_NOT_FOUND' });
      expect(f.document()).toEqual(f.initial);
      expect(f.writes()).toHaveLength(0);
      expect(f.audit).not.toHaveBeenCalled();
    }
  );

  it.each(['expiry', 'close'])('does not save late tokens after attempt %s', async (kind) => {
    const f = fixture(true);
    const attempt = await f.start();
    const poll = f.credentials.loginAttempt(actor, attempt.id);
    await f.entered;
    if (kind === 'expiry') f.expire();
    else f.credentials.closeChatgptLogins();
    f.release();

    expect(await poll).toMatchObject({ status: kind === 'expiry' ? 'EXPIRED' : 'FAILED' });
    expect(f.document()).toEqual(f.initial);
    expect(f.writes()).toHaveLength(0);
    expect(f.audit).not.toHaveBeenCalled();
  });

  it('revalidates the initiating session before committing', async () => {
    const f = fixture();
    const attempt = await f.start();
    let valid = true;
    const poll = f.credentials.loginAttempt(actor, attempt.id, () => {
      if (!valid) throw new Error('CHATGPT_LOGIN_FORBIDDEN');
    });
    await f.entered;
    valid = false;
    f.release();

    expect(await poll).toMatchObject({ status: 'FAILED' });
    expect(f.document()).toEqual(f.initial);
    expect(f.writes()).toHaveLength(0);
    expect(f.audit).not.toHaveBeenCalled();
  });

  it('preserves name uniqueness when another credential is renamed during login', async () => {
    const f = fixture(true);
    const attempt = await f.credentials.startLogin(actor, { ...draft, name: 'New login' });
    const poll = f.credentials.loginAttempt(actor, attempt.id);
    await f.entered;
    await f.credentials.update(actor.userId, 'credential-1', { name: 'New login' });
    const before = structuredClone(f.document());
    f.release();

    expect(await poll).toMatchObject({ status: 'FAILED', code: 'CODEX_CREDENTIAL_NAME_CONFLICT' });
    expect(f.document()).toEqual(before);
    expect(f.writes()).toHaveLength(1);
    expect(
      f.audit.mock.calls.some(
        ([event]) => (event as { eventType: string }).eventType === 'credential.saved'
      )
    ).toBe(false);
  });

  it('releases the single flight after an upstream transport failure so polling can retry', async () => {
    const f = fixture();
    const attempt = await f.start();
    f.request.mockRejectedValueOnce(new Error('upstream unavailable'));
    await expect(f.credentials.loginAttempt(actor, attempt.id)).rejects.toThrow(
      'upstream unavailable'
    );
    const retry = f.credentials.loginAttempt(actor, attempt.id);
    await f.entered;
    f.release();
    expect(await retry).toMatchObject({ status: 'SUCCEEDED' });
    expect(f.writes()).toHaveLength(1);
    expect(f.audit).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'concurrent', 'logout'] as const)(
    'enforces in-flight ownership through real Fastify routes on %s',
    async (mode) => {
      const f = fixture();
      let loggedOut = false;
      const findSession = vi.fn(() =>
        loggedOut
          ? undefined
          : {
              userId: actor.userId,
              username: 'admin',
              isAdmin: true,
              sessionHash: actor.sessionFingerprint,
              mustChangePassword: false,
              csrfTokenHash: hashOpaque('csrf-token')
            }
      );
      Object.assign(f.database, { findCurrentUserSession: findSession });
      const app = Fastify();
      registerCodexCredentialRoutes({
        app,
        database: f.database,
        credentials: f.credentials,
        models: {} as MarAgentModelService
      });
      const url = '/api/admin/mar-agent/codex-login-attempts';
      const headers = { cookie: 'mar_user_session=session-id', 'x-csrf-token': 'csrf-token' };
      try {
        const started = await app.inject({ method: 'POST', url, headers, payload: draft });
        expect(started.statusCode).toBe(201);
        const pollUrl = `${url}/${started.json().attempt.id}`;
        const poll = app.inject({ method: 'GET', url: pollUrl, headers }).then((result) => result);
        await f.entered;
        const authenticated = findSession.mock.calls.length;
        const concurrent =
          mode === 'concurrent'
            ? app.inject({ method: 'GET', url: pollUrl, headers }).then((result) => result)
            : undefined;
        if (mode === 'cancel')
          expect((await app.inject({ method: 'DELETE', url: pollUrl, headers })).statusCode).toBe(
            204
          );
        if (mode === 'logout') loggedOut = true;
        if (concurrent) {
          // Confirm that both requests reached authentication before releasing OAuth.
          await vi.waitFor(() =>
            expect(findSession.mock.calls.length).toBeGreaterThan(authenticated)
          );
        }
        f.release();
        const response = await poll;
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.json().attempt.status).toBe(mode === 'concurrent' ? 'SUCCEEDED' : 'FAILED');
        if (concurrent) {
          expect((await concurrent).json()).toEqual(response.json());
          expect(f.writes()).toHaveLength(1);
          expect(f.audit).toHaveBeenCalledOnce();
          expect(f.document()).toMatchObject({ credentials: [{ revision: 1 }] });
          expect(f.request).toHaveBeenCalledTimes(4);
        } else {
          expect(f.document()).toEqual(f.initial);
          expect(f.writes()).toHaveLength(0);
          expect(f.audit).not.toHaveBeenCalled();
        }
      } finally {
        f.release();
        await app.close();
      }
    }
  );
});
