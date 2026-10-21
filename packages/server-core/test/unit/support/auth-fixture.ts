import Fastify from 'fastify';
import { vi } from 'vitest';
import { registerAuthenticationRoutes } from '../../../src/auth-routes.js';
import type {
  AuthenticationAuditEvent,
  AuthenticationSessionLifecycle,
  AuthenticationStore,
  UserLocale,
  UserLocalePreferences
} from '../../../src/auth-contracts.js';
import type { ProductCapabilityProvider } from '../../../src/product-capabilities.js';
import { hashPassword, INITIAL_ADMIN_PASSWORD, verifyPassword } from '../../../src/password.js';
import { hashOpaque } from '../../../src/session-token.js';
import type { CurrentUserSession } from '../../../src/session.js';

const initialHash = hashPassword(INITIAL_ADMIN_PASSWORD);

export function createAuthFixture() {
  const app = Fastify();
  const now = vi.fn(() => 1_000);
  const audits: AuthenticationAuditEvent[] = [];
  let passwordHash = initialHash;
  let mustChangePassword = true;
  let sequence = 0;
  let locale: UserLocale = 'zh-CN';
  const sessions = new Map<
    string,
    { current: CurrentUserSession; csrfToken: string; publicId: string }
  >();
  const audit = {
    record: vi.fn(async (event: AuthenticationAuditEvent) => {
      audits.push(event);
    })
  };
  const lifecycle = {
    closeSessionConnections: vi.fn<AuthenticationSessionLifecycle['closeSessionConnections']>(
      async () => undefined
    ),
    closeAllConnections: vi.fn(async () => undefined)
  };
  const localePreferences = {
    locale: vi.fn<UserLocalePreferences['locale']>(async () => locale),
    setLocale: vi.fn(async (_userId: number, value: UserLocale) => {
      locale = value;
    })
  };
  const productCapabilities = {
    capability: vi.fn<ProductCapabilityProvider['capability']>(async () => ({
      edition: 'COMMUNITY',
      licenseState: 'COMMUNITY',
      role: 'ADMIN',
      organizationId: null,
      managementWritable: true
    }))
  };
  const store = {
    findUserForLogin: vi.fn(async (username: string) =>
      username === 'admin' ? { id: 1, passwordHash, mustChangePassword, isAdmin: true } : undefined
    ),
    verifyUserPassword: vi.fn(async (_userId: number, password: string) =>
      verifyPassword(password, passwordHash)
    ),
    findCurrentUserSession: vi.fn((token: string) => sessions.get(token)?.current),
    createUserSession: vi.fn<AuthenticationStore['createUserSession']>(async (userId: number) => {
      const sessionId = `session-${++sequence}`;
      const csrfToken = `csrf-${sequence}`;
      sessions.set(sessionId, {
        current: {
          userId,
          username: 'admin',
          isAdmin: true,
          sessionHash: hashOpaque(sessionId),
          csrfTokenHash: hashOpaque(csrfToken),
          mustChangePassword
        },
        csrfToken,
        publicId: `public-${sequence}`
      });
      return {
        sessionId,
        csrfToken,
        expiresAt: now() + 600_000,
        evictedSessionHashes: [] as string[]
      };
    }),
    listActiveUserSessions: vi.fn(async (userId: number, currentSessionId: string) =>
      [...sessions]
        .filter(([, item]) => item.current.userId === userId)
        .map(([token, item]) => ({
          id: item.publicId,
          createdAt: 1_000,
          expiresAt: 601_000,
          ipAddress: '127.0.0.1',
          userAgent: 'fixture',
          current: token === currentSessionId
        }))
    ),
    revokeUserSessionByPublicId: vi.fn(async (userId: number, publicId: string) => {
      for (const [token, item] of sessions) {
        if (item.current.userId !== userId || item.publicId !== publicId) continue;
        sessions.delete(token);
        return item.current.sessionHash;
      }
      return undefined;
    }),
    rotateCsrfToken: vi.fn(async (token: string) => {
      const item = sessions.get(token);
      if (item === undefined) return undefined;
      item.csrfToken = `renewed-${++sequence}`;
      item.current = { ...item.current, csrfTokenHash: hashOpaque(item.csrfToken) };
      return item.csrfToken;
    }),
    revokeSession: vi.fn(async (token: string) => {
      sessions.delete(token);
    }),
    changePassword: vi.fn<AuthenticationStore['changePassword']>(
      async (_userId: number, password: string) => {
        passwordHash = hashPassword(password);
        mustChangePassword = false;
        sessions.clear();
      }
    )
  } satisfies AuthenticationStore;

  registerAuthenticationRoutes({
    app,
    store,
    audit,
    lifecycle,
    localePreferences,
    productCapabilities,
    now,
    secureCookies: true,
    publicOrigin: 'https://console.example.test',
    loginRate: new Map()
  });
  const login = () =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD, locale: 'en-US' }
    });

  return {
    app,
    now,
    store,
    sessions,
    audit,
    audits,
    lifecycle,
    localePreferences,
    productCapabilities,
    login
  };
}
