import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  clearSessionCookie,
  isAllowedOrigin,
  parseCookies,
  serializeSessionCookie,
  SESSION_COOKIE_NAME
} from '../../src/auth.js';
import {
  assertPasswordPolicy,
  assertResetPasswordPolicy,
  hashPassword,
  INITIAL_ADMIN_PASSWORD,
  verifyPassword
} from '../../src/password.js';
import { csrfMatches, hashOpaque } from '../../src/session-token.js';
import {
  currentSession,
  protectedAdmin,
  protectedManagementAdmin,
  validCsrf,
  type CurrentUserSession
} from '../../src/session.js';
import {
  hashLoginUsername,
  isRateLimited,
  registerFailedLogin,
  type LoginRateRecord
} from '../../src/login-rate.js';

const request = (headers: Record<string, string>, protocol = 'http') =>
  ({ headers, protocol, id: 'req-test' }) as FastifyRequest;

describe('password compatibility', () => {
  it('keeps the existing Argon2id encoding and rejects incorrect passwords and malformed hashes', () => {
    const hash = hashPassword(INITIAL_ADMIN_PASSWORD);
    expect(hash).toMatch(/^argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(verifyPassword(INITIAL_ADMIN_PASSWORD, hash)).toBe(true);
    expect(verifyPassword('incorrect', hash)).toBe(false);
    expect(hashPassword(INITIAL_ADMIN_PASSWORD)).not.toBe(hash);
    for (const invalid of ['', 'plaintext', hash.replace('m=19456', 'm=1'), `${hash}$extra`])
      expect(verifyPassword(INITIAL_ADMIN_PASSWORD, invalid)).toBe(false);
  });

  it('preserves inclusive password limits and local reset behavior', () => {
    expect(() => assertPasswordPolicy('a'.repeat(8))).not.toThrow();
    expect(() => assertPasswordPolicy('a'.repeat(1024))).not.toThrow();
    for (const length of [0, 7, 1025])
      expect(() => assertPasswordPolicy('a'.repeat(length))).toThrow('PASSWORD_POLICY_VIOLATION');
    expect(() => assertResetPasswordPolicy(INITIAL_ADMIN_PASSWORD)).not.toThrow();
    expect(() => assertResetPasswordPolicy('short')).toThrow('PASSWORD_POLICY_VIOLATION');
  });
});

describe('cookie, Origin and CSRF boundaries', () => {
  it('preserves Cookie security attributes and safely decodes the session value', () => {
    const value = 'session/with = punctuation';
    const cookie = serializeSessionCookie(value, true);
    expect(cookie).toContain('Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure');
    expect(parseCookies(request({ cookie }))[SESSION_COOKIE_NAME]).toBe(value);
    expect(serializeSessionCookie(value, false)).not.toContain('; Secure');
    expect(clearSessionCookie(true)).toContain('Max-Age=0; Secure');
    expect(parseCookies(request({ cookie: 'bad=%E0%A4; valid=ok; malformed' }))).toEqual({
      valid: 'ok'
    });
    expect(parseCookies(request({}))).toEqual({});
  });

  it('allows absent Origin but rejects mismatched and missing-host browser origins', () => {
    expect(isAllowedOrigin(request({ host: 'local.test' }))).toBe(true);
    expect(isAllowedOrigin(request({ host: 'local.test', origin: 'http://local.test' }))).toBe(
      true
    );
    expect(isAllowedOrigin(request({ host: 'local.test', origin: 'https://evil.test' }))).toBe(
      false
    );
    expect(isAllowedOrigin(request({ origin: 'https://public.test' }), 'https://public.test')).toBe(
      false
    );
    expect(
      isAllowedOrigin(
        request({ host: 'internal.test', origin: 'https://public.test' }),
        'https://public.test'
      )
    ).toBe(true);
  });

  it('hashes tokens identically and rejects missing, wrong or malformed CSRF values', () => {
    const token = 'test-only-token';
    const hash = hashOpaque(token);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(csrfMatches(hash, token)).toBe(true);
    expect(csrfMatches(hash, undefined)).toBe(false);
    expect(csrfMatches(hash, 'other')).toBe(false);
    expect(csrfMatches('', token)).toBe(false);
    expect(validCsrf(request({ 'x-csrf-token': token }), { csrfTokenHash: hash })).toBe(true);
    expect(validCsrf(request({}), { csrfTokenHash: hash })).toBe(false);
  });
});

describe('request session guards', () => {
  const session: CurrentUserSession = {
    userId: 1,
    username: 'admin',
    isAdmin: true,
    sessionHash: 'hash-only',
    mustChangePassword: false,
    csrfTokenHash: hashOpaque('csrf')
  };
  const authenticatedRequest = request({ cookie: `${SESSION_COOKIE_NAME}=opaque` });
  const store = (value: CurrentUserSession | undefined) => ({
    findCurrentUserSession: (token: string) => (token === 'opaque' ? value : undefined)
  });
  const reply = () => {
    const result = {
      status: 0,
      body: undefined as unknown,
      request: authenticatedRequest,
      code(status: number) {
        this.status = status;
        return this;
      },
      send(body: unknown) {
        this.body = body;
        return this;
      }
    };
    return { result, response: result as unknown as FastifyReply };
  };

  it('queries only the supplied session token and never synthesizes an identity', () => {
    expect(currentSession(store(session), authenticatedRequest)).toBe(session);
    expect(currentSession(store(session), request({}))).toBeUndefined();
    expect(currentSession(store(undefined), authenticatedRequest)).toBeUndefined();
  });

  it('rejects anonymous, first-login and non-management identities at the appropriate guard', () => {
    const anonymous = reply();
    expect(
      protectedAdmin(store(undefined), authenticatedRequest, anonymous.response)
    ).toBeUndefined();
    expect(anonymous.result.status).toBe(401);
    const firstLogin = reply();
    expect(
      protectedAdmin(
        store({ ...session, mustChangePassword: true }),
        authenticatedRequest,
        firstLogin.response
      )
    ).toBeUndefined();
    expect(firstLogin.result.body).toMatchObject({ error: { code: 'PASSWORD_CHANGE_REQUIRED' } });
    const member = { ...session, isAdmin: false };
    expect(protectedAdmin(store(member), authenticatedRequest, reply().response)).toBe(member);
    const management = reply();
    expect(
      protectedManagementAdmin(store(member), authenticatedRequest, management.response)
    ).toBeUndefined();
    expect(management.result.status).toBe(403);
    expect(protectedManagementAdmin(store(session), authenticatedRequest, reply().response)).toBe(
      session
    );
  });

  it('propagates lookup failures instead of treating backend failures as authentication success', () => {
    const unavailable = {
      findCurrentUserSession() {
        throw new Error('LOOKUP_UNAVAILABLE');
      }
    };
    expect(() => protectedAdmin(unavailable, authenticatedRequest, reply().response)).toThrow(
      'LOOKUP_UNAVAILABLE'
    );
  });
});

describe('login throttling', () => {
  it('limits the fifth failure, isolates keys and expires at the ten-minute boundary', () => {
    const records = new Map<string, LoginRateRecord>();
    for (let count = 0; count < 4; count++) registerFailedLogin(records, 'one', 100);
    expect(isRateLimited(records, 'one', 100)).toBe(false);
    registerFailedLogin(records, 'one', 100);
    expect(isRateLimited(records, 'one', 100)).toBe(true);
    expect(isRateLimited(records, 'other', 100)).toBe(false);
    expect(isRateLimited(records, 'one', 600_100)).toBe(false);
    expect(records.size).toBe(0);
    expect(hashLoginUsername('admin')).toBe(hashLoginUsername('admin'));
  });

  it('bounds distinct login keys and restarts expired attempts', () => {
    const records = new Map<string, LoginRateRecord>();
    for (let count = 0; count <= 10_000; count++) registerFailedLogin(records, String(count), 0);
    expect(records.size).toBe(10_000);
    expect(records.has('0')).toBe(false);
    registerFailedLogin(records, '10000', 600_000);
    expect(records.get('10000')).toEqual({ attempts: 1, resetAt: 1_200_000 });
  });
});
