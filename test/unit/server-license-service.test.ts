import { generateKeyPairSync } from 'node:crypto';
import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import {
  createLicenseDocument,
  computeHostFingerprint
} from '../../ee/server/src/license/license-domain.js';
import { LicenseService } from '../../ee/server/src/license/license-service.js';
import { registerLicenseRoutes } from '../../ee/server/src/route/license-routes.js';

const productUuid = '00000000-0000-0000-0000-309c23637c46';
const fingerprint = computeHostFingerprint(productUuid);
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const document = createLicenseDocument(
  {
    formatVersion: 1,
    licenseId: 'activation-test',
    enterpriseName: 'Test Enterprise',
    issuedAt: 1_000,
    expiresAt: 3_000,
    hostFingerprint: fingerprint,
    features: ['ENTERPRISE']
  },
  keys.privateKey
);

describe('Server License activation service', () => {
  it('commits first-activation convergence and publishes a valid capability', async () => {
    const fixture = licenseDatabaseFixture(0);
    const service = new LicenseService(fixture.database, publicKey, {
      now: () => 2_000,
      productUuid
    });
    await expect(service.import(document, 1)).resolves.toMatchObject({
      edition: 'ENTERPRISE',
      state: 'ENTERPRISE_VALID',
      enterpriseName: 'Test Enterprise'
    });
    expect(fixture.sql.some((sql) => sql.includes('INSERT INTO organizations'))).toBe(true);
    expect(
      fixture.sql.some((sql) => sql.includes("role=IF(is_fixed_admin,'ADMIN','MEMBER')"))
    ).toBe(true);
    expect(fixture.commit).toHaveBeenCalledOnce();
    expect(fixture.audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'license_activated', actorUserId: 1 })
    );
    expect(fixture.commit.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.audit.mock.invocationCallOrder[0]!
    );
  });

  it('rolls back when first-activation convergence validation fails', async () => {
    const fixture = licenseDatabaseFixture(1);
    const service = new LicenseService(fixture.database, publicKey, {
      now: () => 2_000,
      productUuid
    });
    await expect(service.import(document, 1)).rejects.toThrow(
      'LICENSE_FIRST_ACTIVATION_CONVERGENCE_FAILED'
    );
    expect(fixture.rollback).toHaveBeenCalledOnce();
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it('Application codes are fresh and uncacheable and status responses omit host fingerprints', async () => {
    const app = Fastify();
    const database = {
      findCurrentUserSession: vi.fn(() => ({
        userId: 1,
        username: 'admin',
        isAdmin: true,
        mustChangePassword: false
      }))
    };
    const licenses = new LicenseService(database as unknown as MysqlServerDatabase, publicKey, {
      now: () => 2_000,
      productUuid
    });
    const status = vi.spyOn(licenses, 'status').mockResolvedValue({
      edition: 'COMMUNITY',
      state: 'COMMUNITY',
      reason: null,
      licenseId: null,
      enterpriseName: null,
      expiresAt: null,
      managementWritable: true
    });
    registerLicenseRoutes({
      app,
      database: database as unknown as MysqlServerDatabase,
      licenses,
      publicOrigin: undefined
    });
    const headers = { cookie: 'mar_user_session=session' };

    const first = await app.inject({ method: 'GET', url: '/api/license/request-code', headers });
    const second = await app.inject({ method: 'GET', url: '/api/license/request-code', headers });
    const current = await app.inject({ method: 'GET', url: '/api/license', headers });

    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json<{ requestCode: string }>().requestCode).not.toBe(
      second.json<{ requestCode: string }>().requestCode
    );
    expect(current.headers['cache-control']).toBe('private, no-store');
    expect(current.json()).toMatchObject({ activationAvailable: true });
    expect(current.json()).not.toHaveProperty('hostFingerprint');
    expect(status).toHaveBeenCalledOnce();
    await app.close();
  });
});

function licenseDatabaseFixture(invalidCount: number) {
  const sql: string[] = [];
  let currentDocument: string | null = null;
  let everActivated = false;
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit,
    rollback,
    release: vi.fn(),
    execute: vi.fn(async (statement: string, values?: unknown[]) => {
      sql.push(statement);
      if (statement.includes('SELECT ever_activated'))
        return [[{ ever_activated: everActivated, trusted_time_high_watermark: 0 }], []];
      if (statement.includes(' AS count')) return [[{ count: invalidCount }], []];
      if (statement.includes('INSERT INTO license_state')) {
        currentDocument = String(values?.[0]);
        everActivated = true;
      }
      return [[], []];
    })
  };
  const raw = {
    getConnection: vi.fn(async () => connection),
    execute: vi.fn(async (statement: string) => {
      if (statement.includes('SELECT current_document')) {
        return [
          [
            {
              current_document: currentDocument,
              ever_activated: everActivated,
              trusted_time_high_watermark: 2_000
            }
          ],
          []
        ];
      }
      return [[], []];
    })
  };
  const audit = vi.fn(async () => undefined);
  return {
    database: { raw, audit } as unknown as MysqlServerDatabase,
    audit,
    sql,
    commit,
    rollback
  };
}
