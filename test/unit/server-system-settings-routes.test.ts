import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { AuditService } from '../../ee/server/src/audit/audit-service.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { registerSystemSettingsRoutes } from '../../ee/server/src/route/system-settings-routes.js';
import type { SkillNetworkPolicy } from '../../ee/server/src/skill/skill-network-policy.js';

const csrfToken = 'csrf-token';
const headers = {
  cookie: 'mar_user_session=session-id',
  'x-csrf-token': csrfToken
};

describe('Server system settings routes', () => {
  it('protects the default-on resource URL setting with ADMIN and CSRF checks', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    let useResourceUrl = true;
    const resourceInput = {
      read: vi.fn(async () => ({ useResourceUrl })),
      write: vi.fn(async (value: { useResourceUrl: boolean }) => {
        useResourceUrl = value.useResourceUrl;
      })
    };
    registerSystemSettingsRoutes({
      app,
      database: fixture.database,
      audits: fixture.audits,
      network: fixture.network,
      htmlPreviewOrigin: fixture.htmlPreviewOrigin,
      resourceInput,
      publicOrigin: 'https://console.example.test'
    });
    try {
      expect(
        (await app.inject({ url: '/api/system-settings', headers })).json().useResourceUrl
      ).toBe(true);
      const update = (payload: Record<string, unknown>, requestHeaders = headers) =>
        app.inject({
          method: 'PATCH',
          url: '/api/system-settings/mar-agent-resource-input',
          headers: requestHeaders,
          payload
        });
      expect((await update({ useResourceUrl: false })).statusCode).toBe(200);
      expect(useResourceUrl).toBe(false);
      expect((await update({ useResourceUrl: 'true' })).statusCode).toBe(400);
      expect(
        (await update({ useResourceUrl: true }, { cookie: headers.cookie, 'x-csrf-token': '' }))
          .statusCode
      ).toBe(403);
      fixture.session.isAdmin = false;
      expect((await update({ useResourceUrl: true })).statusCode).toBe(403);
      expect(resourceInput.write).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('uses the same administrator, Origin and CSRF gates for the Web Push switch', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    let enabled = false;
    const webPush = {
      read: vi.fn(async () => ({ enabled, available: true, publicKey: null })),
      setEnabled: vi.fn(async (value: boolean) => {
        enabled = value;
      })
    };
    registerSystemSettingsRoutes({
      app,
      database: fixture.database,
      audits: fixture.audits,
      network: fixture.network,
      htmlPreviewOrigin: fixture.htmlPreviewOrigin,
      webPush,
      publicOrigin: 'https://console.example.test'
    });
    try {
      const before = await app.inject({ method: 'GET', url: '/api/system-settings', headers });
      expect(before.json().webPushEnabled).toBe(false);
      const write = await app.inject({
        method: 'PATCH',
        url: '/api/system-settings/web-push',
        headers,
        payload: { enabled: true }
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().webPushEnabled).toBe(true);
      expect(webPush.setEnabled).toHaveBeenCalledWith(true);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/system-settings/web-push',
            headers,
            payload: { enabled: 'true' }
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/system-settings/web-push',
            headers: { ...headers, 'x-csrf-token': 'wrong' },
            payload: { enabled: false }
          })
        ).statusCode
      ).toBe(403);
      fixture.session.isAdmin = false;
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/system-settings/web-push',
            headers,
            payload: { enabled: false }
          })
        ).statusCode
      ).toBe(403);
      expect(webPush.setEnabled).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('uses one ADMIN-protected snapshot and per-setting update contract', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerSystemSettingsRoutes({
      app,
      database: fixture.database,
      audits: fixture.audits,
      network: fixture.network,
      htmlPreviewOrigin: fixture.htmlPreviewOrigin,
      publicOrigin: 'https://console.example.test'
    });

    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/system-settings',
      headers: { cookie: headers.cookie }
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toEqual({
      auditRetentionDays: 180,
      htmlPreviewOrigin: '',
      skillTlsVerificationDisabled: false
    });
    expect(fixture.audits.readRetentionDays).toHaveBeenCalledWith(1);
    expect(fixture.network.disabled).toHaveBeenCalledOnce();

    const auditUpdated = await app.inject({
      method: 'PATCH',
      url: '/api/system-settings/audit-retention',
      headers,
      payload: { days: 365 }
    });
    expect(auditUpdated.statusCode).toBe(200);
    expect(auditUpdated.json()).toEqual({
      auditRetentionDays: 365,
      htmlPreviewOrigin: '',
      skillTlsVerificationDisabled: false
    });
    expect(fixture.audits.setRetentionDays).toHaveBeenCalledWith(1, 365);

    const tlsUpdated = await app.inject({
      method: 'PATCH',
      url: '/api/system-settings/skill-tls',
      headers,
      payload: { verificationDisabled: true }
    });
    expect(tlsUpdated.statusCode).toBe(200);
    expect(tlsUpdated.json()).toEqual({
      auditRetentionDays: 365,
      htmlPreviewOrigin: '',
      skillTlsVerificationDisabled: true
    });
    expect(fixture.network.setDisabled).toHaveBeenCalledWith(true);
    await app.close();
  });

  it('rejects non-ADMIN, missing CSRF, unknown settings and invalid values consistently', async () => {
    const fixture = routeFixture({ isAdmin: false });
    const app = Fastify();
    registerSystemSettingsRoutes({
      app,
      database: fixture.database,
      audits: fixture.audits,
      network: fixture.network,
      htmlPreviewOrigin: fixture.htmlPreviewOrigin,
      publicOrigin: 'https://console.example.test'
    });

    await expect(
      app.inject({
        method: 'PATCH',
        url: '/api/system-settings/audit-retention',
        headers,
        payload: { days: 365 }
      })
    ).resolves.toMatchObject({ statusCode: 403 });

    await expect(
      app.inject({
        method: 'PATCH',
        url: '/api/system-settings/audit-retention',
        headers: { ...headers, origin: 'https://untrusted.example.test' },
        payload: { days: 365 }
      })
    ).resolves.toMatchObject({ statusCode: 403 });

    fixture.session.isAdmin = true;
    await expect(
      app.inject({
        method: 'PATCH',
        url: '/api/system-settings/audit-retention',
        headers: { cookie: headers.cookie },
        payload: { days: 365 }
      })
    ).resolves.toMatchObject({ statusCode: 403 });

    await expect(
      app.inject({
        method: 'PATCH',
        url: '/api/system-settings/unknown',
        headers,
        payload: {}
      })
    ).resolves.toMatchObject({
      statusCode: 404,
      json: expect.any(Function)
    });

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/system-settings/audit-retention',
      headers,
      payload: { days: 0 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'SYSTEM_SETTING_INPUT_INVALID' } });
    expect(fixture.audits.setRetentionDays).not.toHaveBeenCalled();
    await app.close();
  });
});

function routeFixture(session = { isAdmin: true }) {
  const settings = {
    auditRetentionDays: 180,
    skillTlsVerificationDisabled: false,
    htmlPreviewOrigin: ''
  };
  const database = {
    findCurrentUserSession: vi.fn(() => ({
      userId: 1,
      username: 'admin',
      sessionHash: 'admin-session',
      isAdmin: session.isAdmin,
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    }))
  } as unknown as MysqlServerDatabase;
  const audits = {
    readRetentionDays: vi.fn(async () => settings.auditRetentionDays),
    setRetentionDays: vi.fn(async (_userId: number, days: number) => {
      settings.auditRetentionDays = days;
    })
  } as unknown as AuditService & {
    readRetentionDays: ReturnType<typeof vi.fn>;
    setRetentionDays: ReturnType<typeof vi.fn>;
  };
  const network = {
    disabled: vi.fn(async () => settings.skillTlsVerificationDisabled),
    setDisabled: vi.fn(async (disabled: boolean) => {
      settings.skillTlsVerificationDisabled = disabled;
    })
  } as unknown as SkillNetworkPolicy & {
    disabled: ReturnType<typeof vi.fn>;
    setDisabled: ReturnType<typeof vi.fn>;
  };
  const htmlPreviewOrigin = {
    read: vi.fn(async () => settings.htmlPreviewOrigin),
    write: vi.fn(async (value: string) => {
      settings.htmlPreviewOrigin = value;
    })
  };
  return { database, audits, network, htmlPreviewOrigin, session };
}
