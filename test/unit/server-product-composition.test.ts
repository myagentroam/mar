import { generateKeyPairSync } from 'node:crypto';
import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../ee/server/src/database.js';
import {
  computeHostFingerprint,
  createLicenseDocument
} from '../../ee/server/src/license/license-domain.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import {
  type ProductCapabilities,
  type ProductCapabilityProvider
} from '../../ee/server/src/product/product-policy.js';
import { createEnterpriseServerProduct } from '../../ee/server/src/composition/enterprise-product.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import { hashPassword } from '../../packages/server-core/src/password.js';
import { registerAuthRoutes } from '../../ee/server/src/route/auth-routes.js';

const productUuid = '00000000-0000-0000-0000-309c23637c46';
const now = () => 2_000;
const passwordHash = hashPassword('correct-horse-battery-staple');
const publicOrigin = 'https://console.example.test';

describe('Server product composition', () => {
  it('uses a structural capability provider for fresh login and current-user capability results', async () => {
    const app = Fastify();
    const database = authDatabaseFixture();
    const productCapabilities = {
      capability: vi
        .fn<() => Promise<ProductCapabilities>>()
        .mockResolvedValueOnce({
          edition: 'ENTERPRISE',
          licenseState: 'ENTERPRISE_VALID',
          role: 'ORG_ADMIN',
          organizationId: 7,
          managementWritable: true
        })
        .mockResolvedValueOnce({
          edition: 'ENTERPRISE',
          licenseState: 'ENTERPRISE_FROZEN',
          role: 'MEMBER',
          organizationId: 9,
          managementWritable: false
        })
    } satisfies ProductCapabilityProvider;

    registerAuthRoutes({
      app,
      store: database,
      audit: { record: database.audit },
      nodeControl: nodeControlFixture(),
      publicOrigin: undefined,
      secureCookies: false,
      now,
      loginRate: new Map(),
      productCapabilities
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'member', password: 'correct-horse-battery-staple' }
    });
    const current = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'mar_user_session=session-member' }
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      authenticated: true,
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_VALID',
      role: 'ORG_ADMIN',
      organizationId: 7,
      managementWritable: true
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      authenticated: true,
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_FROZEN',
      role: 'MEMBER',
      organizationId: 9,
      managementWritable: false
    });
    expect(productCapabilities.capability).toHaveBeenNthCalledWith(1, 2);
    expect(productCapabilities.capability).toHaveBeenNthCalledWith(2, 2);
    await app.close();
  });

  it('does not disguise a product-capability failure as Community capability', async () => {
    const app = Fastify();
    const database = authDatabaseFixture();
    const productCapabilities = {
      capability: vi.fn(async () => {
        throw new Error('PRODUCT_CAPABILITY_UNAVAILABLE');
      })
    } satisfies ProductCapabilityProvider;

    registerAuthRoutes({
      app,
      store: database,
      audit: { record: database.audit },
      nodeControl: nodeControlFixture(),
      publicOrigin: undefined,
      secureCookies: false,
      now,
      loginRate: new Map(),
      productCapabilities
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'member', password: 'correct-horse-battery-staple' }
    });
    const current = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'mar_user_session=session-member' }
    });

    expect(login.statusCode).toBeGreaterThanOrEqual(500);
    expect(current.statusCode).toBeGreaterThanOrEqual(500);
    expect(login.json()).not.toMatchObject({ edition: 'COMMUNITY', licenseState: 'COMMUNITY' });
    expect(current.json()).not.toMatchObject({ edition: 'COMMUNITY', licenseState: 'COMMUNITY' });
    await app.close();
  });

  it('composes typed capabilities with license reads and the existing frozen-management gate', async () => {
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fixture = mysqlFixture();
    const product = createEnterpriseServerProduct({
      database: fixture.database,
      now,
      productUuid,
      publicKey
    });
    const app = Fastify();
    expect(product.capabilities).toBe(product.licenses);
    expect(product.authorization).toBeDefined();
    product.registerLicenseManagement(app, publicOrigin);
    app.post('/api/management/users', async () => ({ wrote: true }));

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/license' });
    const ordinaryUser = await app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: 'mar_user_session=session-member' }
    });

    fixture.licenseState.currentDocument = null;
    fixture.licenseState.everActivated = false;
    const personal = await app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: 'mar_user_session=session-admin' }
    });

    fixture.licenseState.currentDocument = enterpriseDocument(keys.privateKey, 3_000);
    fixture.licenseState.everActivated = true;
    const valid = await app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: 'mar_user_session=session-admin' }
    });

    fixture.licenseState.currentDocument = enterpriseDocument(keys.privateKey, 1_500);
    const frozen = await app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: 'mar_user_session=session-admin' }
    });
    const frozenManagementWrite = await app.inject({
      method: 'POST',
      url: '/api/management/users',
      headers: {
        cookie: 'mar_user_session=session-admin',
        origin: publicOrigin,
        'x-csrf-token': 'csrf-admin'
      }
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(ordinaryUser.statusCode).toBe(403);
    expect(personal.statusCode).toBe(200);
    expect(personal.json()).toMatchObject({ edition: 'COMMUNITY', state: 'COMMUNITY' });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ edition: 'ENTERPRISE', state: 'ENTERPRISE_VALID' });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json()).toMatchObject({ edition: 'ENTERPRISE', state: 'ENTERPRISE_FROZEN' });
    expect(frozenManagementWrite.statusCode).toBe(403);
    expect(frozenManagementWrite.json()).toMatchObject({
      error: { code: 'LICENSE_MANAGEMENT_FROZEN' }
    });
    await expect(product.capabilities.capability(1)).resolves.toMatchObject({
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_FROZEN',
      role: 'ADMIN',
      organizationId: 1,
      managementWritable: false
    });
    expect(fixture.rawExecute).toHaveBeenCalledWith(
      'SELECT role,organization_id FROM users WHERE id=?',
      [1]
    );
    expect(fixture.rawExecute).toHaveBeenCalledWith(
      expect.stringContaining('SELECT current_document,ever_activated,trusted_time_high_watermark')
    );
    await app.close();
  });
});

function authDatabaseFixture() {
  const sessions = {
    'session-member': {
      userId: 2,
      username: 'member',
      isAdmin: false,
      sessionHash: 'session-member-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque('csrf-member')
    }
  };
  return {
    findUserForLogin: vi.fn(async (username: string) =>
      username === 'member'
        ? {
            id: 2,
            passwordHash,
            mustChangePassword: false,
            isAdmin: false
          }
        : undefined
    ),
    createUserSession: vi.fn(async () => ({
      sessionId: 'session-member',
      csrfToken: 'csrf-member',
      expiresAt: 10_000,
      evictedSessionHashes: []
    })),
    findCurrentUserSession: vi.fn((sessionId: string) => sessions[sessionId as 'session-member']),
    verifyUserPassword: vi.fn(async () => {
      throw new Error('Unexpected password verification');
    }),
    listActiveUserSessions: vi.fn(async () => {
      throw new Error('Unexpected session listing');
    }),
    revokeUserSessionByPublicId: vi.fn(async () => {
      throw new Error('Unexpected session revocation');
    }),
    revokeSession: vi.fn(async () => {
      throw new Error('Unexpected session revocation');
    }),
    rotateCsrfToken: vi.fn(async () => {
      throw new Error('Unexpected CSRF rotation');
    }),
    changePassword: vi.fn(async () => {
      throw new Error('Unexpected password change');
    }),
    audit: vi.fn(async () => undefined)
  };
}

function nodeControlFixture(): Pick<
  NodeControl,
  'closeUserTerminals' | 'closeUserWorkbench' | 'closeAllTerminals' | 'closeAllWorkbench'
> {
  return {
    closeUserTerminals: vi.fn(),
    closeUserWorkbench: vi.fn(),
    closeAllTerminals: vi.fn(),
    closeAllWorkbench: vi.fn()
  };
}

function mysqlFixture() {
  const licenseState = {
    currentDocument: null as string | null,
    everActivated: false,
    trustedTimeHighWatermark: 0
  };
  const rawExecute = vi.fn(async (statement: string, values?: readonly unknown[]) => {
    if (statement.includes('SELECT current_document,ever_activated,trusted_time_high_watermark')) {
      return [
        [
          {
            current_document: licenseState.currentDocument,
            ever_activated: licenseState.everActivated,
            trusted_time_high_watermark: licenseState.trustedTimeHighWatermark
          }
        ],
        []
      ];
    }
    if (statement.includes('SELECT role,organization_id FROM users WHERE id=?')) {
      return [[{ role: values?.[0] === 1 ? 'ADMIN' : 'MEMBER', organization_id: 1 }], []];
    }
    if (statement.includes('INSERT INTO license_state')) {
      licenseState.trustedTimeHighWatermark = Math.max(
        licenseState.trustedTimeHighWatermark,
        Number(values?.[0] ?? 0)
      );
    }
    return [[], []];
  });
  const sessions = {
    'session-admin': {
      userId: 1,
      username: 'admin',
      isAdmin: true,
      sessionHash: 'session-admin-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque('csrf-admin')
    },
    'session-member': {
      userId: 2,
      username: 'member',
      isAdmin: false,
      sessionHash: 'session-member-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque('csrf-member')
    }
  };
  return {
    database: {
      raw: { execute: rawExecute },
      findCurrentUserSession: vi.fn(
        (sessionId: string) => sessions[sessionId as keyof typeof sessions]
      )
    } as unknown as MysqlServerDatabase,
    licenseState,
    rawExecute
  };
}

function enterpriseDocument(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  expiresAt: number
): string {
  return createLicenseDocument(
    {
      formatVersion: 1,
      licenseId: `license-${expiresAt}`,
      enterpriseName: 'Composition test enterprise',
      issuedAt: 1_000,
      expiresAt,
      hostFingerprint: computeHostFingerprint(productUuid),
      features: ['ENTERPRISE']
    },
    privateKey
  );
}
