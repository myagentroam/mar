import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuickStartServerProduct } from '../../ee/server/src/composition/enterprise-product.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import {
  computeMachineIdFingerprint,
  createLicenseDocument,
  inspectLicenseRequestCode
} from '../../ee/server/src/license/license-domain.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const machineId = 'ec2a8f9c70d44a718b71b5c98d871234';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
let currentMachineId = machineId;

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  currentMachineId = machineId;
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(readFileSync).mockImplementation(((path, ...args) => {
    if (path === '/etc/machine-id') return `${currentMachineId}\n`;
    return original.readFileSync(path, ...args);
  }) as typeof readFileSync);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
});

describe('Linux Quick Start License policy', () => {
  it('exposes administrator activation APIs without advertising activation in the Web UI', async () => {
    const fixture = databaseFixture();
    const product = createQuickStartServerProduct({ database: fixture.database, now: () => 2_000 });
    const app = Fastify();
    product.registerLicenseManagement(app, 'http://localhost');
    try {
      const headers = { cookie: 'mar_user_session=session' };
      const status = await app.inject({ url: '/api/license', headers });
      expect(status.json()).toMatchObject({
        state: 'COMMUNITY',
        activationAvailable: true,
        activationVisible: false
      });
      expect(status.json()).not.toHaveProperty('hostFingerprint');
      const first = await app.inject({ url: '/api/license/request-code', headers });
      const second = await app.inject({ url: '/api/license/request-code', headers });
      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('private, no-store');
      expect(first.json().requestCode).not.toBe(second.json().requestCode);
      expect(inspectLicenseRequestCode(first.json().requestCode).hostFingerprint).toBe(
        computeMachineIdFingerprint(machineId)
      );
      expect((await app.inject({ url: '/api/license/request-code' })).statusCode).toBe(401);
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/license/import',
        headers: { ...headers, origin: 'http://localhost' },
        payload: { document: 'test' }
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
      const wrongOrigin = await app.inject({
        method: 'POST',
        url: '/api/license/import',
        headers: { ...headers, origin: 'http://untrusted.test', 'x-csrf-token': 'csrf' },
        payload: { document: 'test' }
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    } finally {
      await app.close();
    }
  });

  it('retains valid, expired and host-mismatched enterprise states across product recreation', async () => {
    const fixture = databaseFixture();
    fixture.state.current_document = createLicenseDocument(
      {
        formatVersion: 1,
        licenseId: 'linux-test',
        enterpriseName: 'Linux Enterprise',
        issuedAt: 1_000,
        expiresAt: 3_000,
        hostFingerprint: computeMachineIdFingerprint(machineId),
        features: ['ENTERPRISE']
      },
      keys.privateKey
    );
    fixture.state.ever_activated = true;
    const create = (time: number) =>
      createQuickStartServerProduct({
        database: fixture.database,
        now: () => time,
        publicKey
      });
    await expect(create(2_000).licenses.status()).resolves.toMatchObject({
      state: 'ENTERPRISE_VALID'
    });
    await expect(create(2_000).capabilities.capability(1)).resolves.toMatchObject({
      edition: 'ENTERPRISE'
    });
    await expect(create(4_000).licenses.status()).resolves.toMatchObject({
      state: 'ENTERPRISE_FROZEN',
      reason: 'LICENSE_EXPIRED',
      managementWritable: false
    });
    currentMachineId = '123456789012345678901234567890ab';
    await expect(create(2_000).licenses.status()).resolves.toMatchObject({
      state: 'ENTERPRISE_FROZEN',
      reason: 'LICENSE_HOST_MISMATCH',
      managementWritable: false
    });
  });

  it('rejects invalid machine IDs instead of silently reverting to fixed Community policy', () => {
    currentMachineId = 'uninitialized';
    expect(() =>
      createQuickStartServerProduct({ database: databaseFixture().database, now: Date.now })
    ).toThrow('LICENSE_HOST_UNAVAILABLE');
  });
});

function databaseFixture() {
  const state = {
    current_document: null as string | null,
    ever_activated: false,
    trusted_time_high_watermark: 0
  };
  return {
    state,
    database: {
      raw: {
        execute: vi.fn(async (sql: string) => [
          sql.includes('SELECT current_document')
            ? [state]
            : [{ role: 'ADMIN', organization_id: 1 }],
          []
        ])
      },
      findCurrentUserSession: () => ({
        userId: 1,
        username: 'admin',
        isAdmin: true,
        mustChangePassword: false,
        sessionHash: hashOpaque('session'),
        csrfTokenHash: hashOpaque('csrf')
      })
    } as unknown as MysqlServerDatabase
  };
}
