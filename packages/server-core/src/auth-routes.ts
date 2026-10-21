import type { FastifyInstance } from 'fastify';
import {
  boundedUserAgent,
  clearSessionCookie,
  isAllowedOrigin,
  parseCookies,
  requestIp,
  serializeSessionCookie,
  SESSION_COOKIE_NAME
} from './auth.js';
import { assertPasswordPolicy, verifyPassword } from './password.js';
import { currentSession, validCsrf } from './session.js';
import { sendError } from './http-errors.js';
import {
  hashLoginUsername,
  isRateLimited,
  registerFailedLogin,
  type LoginRateRecord
} from './login-rate.js';
import type {
  AuthenticationAuditSink,
  AuthenticationSessionLifecycle,
  AuthenticationStore,
  UserLocale,
  UserLocalePreferences
} from './auth-contracts.js';
import type { ProductCapabilityProvider } from './product-capabilities.js';

interface LoginBody {
  username?: unknown;
  password?: unknown;
  locale?: unknown;
}

interface PasswordBody {
  currentPassword?: unknown;
  password?: unknown;
}

export interface AuthenticationRoutesOptions {
  readonly app: FastifyInstance;
  readonly store: AuthenticationStore;
  readonly audit: AuthenticationAuditSink;
  readonly lifecycle: AuthenticationSessionLifecycle;
  readonly publicOrigin: string | undefined;
  readonly secureCookies: boolean;
  readonly now: () => number;
  readonly loginRate: Map<string, LoginRateRecord>;
  readonly productCapabilities?: ProductCapabilityProvider;
  readonly localePreferences?: UserLocalePreferences;
}

export function registerAuthenticationRoutes(input: AuthenticationRoutesOptions): void {
  const {
    app,
    store,
    audit,
    lifecycle,
    publicOrigin,
    secureCookies,
    now,
    loginRate,
    productCapabilities,
    localePreferences
  } = input;

  app.get('/health', async () => ({ status: 'ok' as const }));

  app.post<{ Body: LoginBody }>('/api/auth/login', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) {
      return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    }
    const username = typeof request.body?.username === 'string' ? request.body.username : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const locale = userLocale(request.body?.locale);
    // Use only a fixed-length hash for rate-limit keys so attacker-controlled usernames cannot grow the Map without bound.
    const key = `${requestIp(request)}:${hashLoginUsername(username)}`;
    if (isRateLimited(loginRate, key, now())) {
      await audit.record({ eventType: 'login_rate_limited', ipAddress: requestIp(request) });
      return sendError(reply, 429, 'LOGIN_RATE_LIMITED');
    }
    const user = await store.findUserForLogin(username);
    if (user === undefined || !verifyPassword(password, user.passwordHash)) {
      registerFailedLogin(loginRate, key, now());
      await audit.record({ eventType: 'login_failed', ipAddress: requestIp(request) });
      return sendError(reply, 401, 'INVALID_CREDENTIALS');
    }
    if (localePreferences !== undefined) await localePreferences.setLocale(user.id, locale);
    const session = await store.createUserSession(user.id, {
      ipAddress: requestIp(request),
      userAgent: boundedUserAgent(request.headers['user-agent'])
    });
    for (const sessionHash of session.evictedSessionHashes) {
      await lifecycle.closeSessionConnections(sessionHash);
    }
    if (session.evictedSessionHashes.length > 0) {
      await audit.record({
        eventType: 'login_session_lru_evicted',
        actorUserId: user.id,
        ipAddress: requestIp(request)
      });
    }
    loginRate.delete(key);
    await audit.record({
      eventType: 'login_succeeded',
      actorUserId: user.id,
      ipAddress: requestIp(request)
    });
    reply.header('Set-Cookie', serializeSessionCookie(session.sessionId, secureCookies));
    const capability =
      productCapabilities === undefined ? {} : await productCapabilities.capability(user.id);
    return reply.send({
      authenticated: true,
      mustChangePassword: user.mustChangePassword,
      username: username,
      isAdmin: user.isAdmin,
      locale,
      csrfToken: session.csrfToken,
      ...capability
    });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const current = currentSession(store, request);
    if (current === undefined) {
      return sendError(reply, 401, 'UNAUTHENTICATED');
    }
    const capability =
      productCapabilities === undefined ? {} : await productCapabilities.capability(current.userId);
    const locale =
      localePreferences === undefined ? 'zh-CN' : await localePreferences.locale(current.userId);
    return reply.send({
      authenticated: true,
      mustChangePassword: current.mustChangePassword,
      username: current.username,
      isAdmin: current.isAdmin,
      locale,
      ...capability
    });
  });

  app.put<{ Body: { locale?: unknown } }>(
    '/api/auth/preferences/locale',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const current = currentSession(store, request);
      if (current === undefined) return sendError(reply, 401, 'UNAUTHENTICATED');
      if (!validCsrf(request, current)) return sendError(reply, 403, 'CSRF_INVALID');
      if (request.body?.locale !== 'zh-CN' && request.body?.locale !== 'en-US')
        return sendError(reply, 400, 'LOCALE_INVALID');
      await localePreferences?.setLocale(current.userId, request.body.locale);
      return reply.code(204).send();
    }
  );

  app.get('/api/auth/sessions', async (request, reply) => {
    const sessionId = parseCookies(request)[SESSION_COOKIE_NAME];
    const current = sessionId === undefined ? undefined : store.findCurrentUserSession(sessionId);
    if (current === undefined || sessionId === undefined)
      return sendError(reply, 401, 'UNAUTHENTICATED');
    return reply.send({
      sessions: await store.listActiveUserSessions(current.userId, sessionId)
    });
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/api/auth/sessions/:sessionId',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const sessionId = parseCookies(request)[SESSION_COOKIE_NAME];
      const current = sessionId === undefined ? undefined : store.findCurrentUserSession(sessionId);
      if (current === undefined || sessionId === undefined)
        return sendError(reply, 401, 'UNAUTHENTICATED');
      if (!validCsrf(request, current)) return sendError(reply, 403, 'CSRF_INVALID');
      const sessionHash = await store.revokeUserSessionByPublicId(
        current.userId,
        request.params.sessionId
      );
      if (sessionHash === undefined) return sendError(reply, 404, 'USER_SESSION_NOT_FOUND');
      await lifecycle.closeSessionConnections(sessionHash);
      await audit.record({
        eventType: 'user_session_revoked',
        actorUserId: current.userId,
        ipAddress: requestIp(request)
      });
      if (sessionHash === current.sessionHash)
        reply.header('Set-Cookie', clearSessionCookie(secureCookies));
      return reply.code(204).send();
    }
  );

  // A Cookie-authenticated, same-Origin tab may have no sessionStorage entry
  // (new tab or a refreshed SPA).  Renewing the opaque CSRF secret here does
  // not authorize any Node operation and lets it recover without relogin.
  app.post('/api/auth/csrf', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const sessionId = parseCookies(request)[SESSION_COOKIE_NAME];
    if (sessionId === undefined || store.findCurrentUserSession(sessionId) === undefined)
      return sendError(reply, 401, 'UNAUTHENTICATED');
    const csrfToken = await store.rotateCsrfToken(sessionId);
    if (csrfToken === undefined) return sendError(reply, 401, 'UNAUTHENTICATED');
    return reply.send({ csrfToken });
  });

  app.post<{ Body: PasswordBody }>('/api/auth/change-password', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) {
      return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    }
    const current = currentSession(store, request);
    if (current === undefined) {
      return sendError(reply, 401, 'UNAUTHENTICATED');
    }
    if (!validCsrf(request, current)) {
      return sendError(reply, 403, 'CSRF_INVALID');
    }
    const currentPassword =
      typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!(await store.verifyUserPassword(current.userId, currentPassword)))
      return sendError(reply, 400, 'CURRENT_PASSWORD_INVALID');
    try {
      assertPasswordPolicy(password);
    } catch {
      return sendError(reply, 400, 'PASSWORD_POLICY_VIOLATION');
    }
    await store.changePassword(current.userId, password, 'password_changed', requestIp(request));
    await lifecycle.closeAllConnections();
    const session = await store.createUserSession(current.userId, {
      ipAddress: requestIp(request),
      userAgent: boundedUserAgent(request.headers['user-agent'])
    });
    reply.header('Set-Cookie', serializeSessionCookie(session.sessionId, secureCookies));
    return reply.send({
      authenticated: true,
      mustChangePassword: false,
      username: current.username,
      isAdmin: current.isAdmin,
      csrfToken: session.csrfToken
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) {
      return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    }
    const sessionId = parseCookies(request)[SESSION_COOKIE_NAME];
    const current = sessionId === undefined ? undefined : store.findCurrentUserSession(sessionId);
    if (current === undefined || sessionId === undefined) {
      return sendError(reply, 401, 'UNAUTHENTICATED');
    }
    if (!validCsrf(request, current)) {
      return sendError(reply, 403, 'CSRF_INVALID');
    }
    await store.revokeSession(sessionId);
    await lifecycle.closeSessionConnections(current.sessionHash);
    await audit.record({
      eventType: 'logout',
      actorUserId: current.userId,
      ipAddress: requestIp(request)
    });
    reply.header('Set-Cookie', clearSessionCookie(secureCookies));
    return reply.code(204).send();
  });
}

function userLocale(value: unknown): UserLocale {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}
