import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuickStartServerProduct } from '../../ee/server/src/composition/enterprise-product.js';
import { AuditService } from '../../ee/server/src/audit/audit-service.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { registerSystemSettingsRoutes } from '../../ee/server/src/route/system-settings-routes.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }));
afterEach(() => Object.defineProperty(process, 'platform', platform));

describe('Windows Quick Start community product', () => {
  it('reads and updates deployment settings without activating enterprise capabilities', async () => {
    const execute = vi.fn(async (sql: string) => [
      sql.includes('SELECT setting_value')
        ? [{ setting_value: '180' }]
        : [{ role: 'ADMIN', organization_id: 1, is_fixed_admin: 1 }],
      []
    ]);
    const database = {
      raw: { execute },
      findCurrentUserSession: () => ({
        userId: 1,
        username: 'admin',
        isAdmin: true,
        sessionHash: hashOpaque('session'),
        mustChangePassword: false,
        csrfTokenHash: hashOpaque('csrf')
      })
    } as unknown as MysqlServerDatabase;
    const product = createQuickStartServerProduct({ database, now: Date.now });
    const app = Fastify();
    product.registerLicenseManagement(app, 'http://localhost');
    let previewOrigin = '';
    registerSystemSettingsRoutes({
      app,
      database,
      audits: new AuditService(database, product.authorization),
      network: { disabled: async () => false, setDisabled: vi.fn() },
      htmlPreviewOrigin: {
        read: async () => previewOrigin,
        write: async (origin) => {
          previewOrigin = origin;
        }
      },
      publicOrigin: 'http://localhost'
    });
    try {
      const headers = {
        cookie: 'mar_user_session=session',
        origin: 'http://localhost',
        'x-csrf-token': 'csrf'
      };
      const read = await app.inject({ url: '/api/system-settings', headers });
      const write = await app.inject({
        method: 'PATCH',
        url: '/api/system-settings/html-preview-origin',
        headers,
        payload: { origin: 'https://preview.example.test' }
      });
      expect({ read: read.statusCode, write: write.statusCode }).toEqual({
        read: 200,
        write: 200
      });
      expect(read.json()).toMatchObject({ auditRetentionDays: 180, htmlPreviewOrigin: '' });
      expect(write.json()).toMatchObject({ htmlPreviewOrigin: 'https://preview.example.test' });
      expect(
        await product.authorization.authorize(1, 'AUDIT_READ', { ownerType: 'SYSTEM' })
      ).toMatchObject({ allowed: false, reason: 'ENTERPRISE_LICENSE_REQUIRED' });
    } finally {
      await app.close();
    }
  });

  it('retains fixed, enabled root administrator checks for personal authorization', async () => {
    let actor: Record<string, unknown> | undefined = {
      is_fixed_admin: 1,
      role: 'ADMIN',
      organization_id: 1
    };
    const database = {
      raw: {
        execute: vi.fn(async (sql: string) => [
          sql.includes('is_fixed_admin')
            ? actor
              ? [actor]
              : []
            : [{ role: 'ADMIN', organization_id: 1 }],
          []
        ])
      }
    } as unknown as MysqlServerDatabase;
    const product = createQuickStartServerProduct({ database, now: Date.now });
    expect(await product.authorization.isPersonalAdmin(1)).toBe(true);
    actor = { is_fixed_admin: 0, role: 'ADMIN', organization_id: 1 };
    expect(await product.authorization.isPersonalAdmin(1)).toBe(false);
    actor = { is_fixed_admin: 1, role: 'ADMIN', organization_id: 2 };
    expect(await product.authorization.isPersonalAdmin(1)).toBe(false);
    actor = { is_fixed_admin: 1, role: 'MEMBER', organization_id: 1 };
    expect(await product.authorization.isPersonalAdmin(1)).toBe(false);
    actor = undefined;
    expect(await product.authorization.isPersonalAdmin(1)).toBe(false);
  });

  it('keeps the enterprise management gate and does not register activation routes', async () => {
    const execute = vi.fn(async () => [[{ role: 'ADMIN', organization_id: 1 }], []]);
    const database = {
      raw: { execute },
      findCurrentUserSession: () => ({
        userId: 1,
        username: 'admin',
        isAdmin: true,
        sessionHash: hashOpaque('session'),
        mustChangePassword: false,
        csrfTokenHash: hashOpaque('csrf')
      })
    } as unknown as MysqlServerDatabase;
    const product = createQuickStartServerProduct({ database, now: Date.now });
    const app = Fastify();
    product.registerLicenseManagement(app, 'http://localhost');
    let called = false;
    app.post('/api/organizations', async () => {
      called = true;
      return {};
    });
    try {
      const headers = {
        cookie: 'mar_user_session=session',
        origin: 'http://localhost',
        'x-csrf-token': 'csrf'
      };
      const blocked = await app.inject({ method: 'POST', url: '/api/organizations', headers });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ error: { code: 'ENTERPRISE_LICENSE_REQUIRED' } });
      expect(called).toBe(false);
      expect(
        (await app.inject({ method: 'GET', url: '/api/license/request-code', headers })).statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url: '/api/license/import', headers })).statusCode
      ).toBe(404);
      const status = await app.inject({ method: 'GET', url: '/api/license', headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ state: 'COMMUNITY', activationAvailable: false });
      expect(await product.licenses.status()).toMatchObject({
        state: 'COMMUNITY',
        managementWritable: true
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
