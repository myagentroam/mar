import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { registerCodexCredentialRoutes } from '../../ee/server/src/route/codex-credential-routes.js';
import type { CodexCredentialService } from '../../ee/server/src/service/codex-credential-service.js';
import type { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';
import { XaiOAuthError } from '../../packages/server-core/src/xai-oauth-provider.js';

const csrfToken = 'csrf-token';
const headers = {
  cookie: 'mar_user_session=session-id',
  'x-csrf-token': csrfToken
};
const catalog = {
  catalogHash: 'c'.repeat(64),
  fetchedAt: 10,
  models: [
    {
      upstreamModelId: 'gpt-codex',
      displayName: 'GPT Codex',
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      reasoningEfforts: ['high'],
      unsupportedReasoningEfforts: [],
      inputCapabilities: ['TEXT'],
      hostedWebSearch: true,
      warnings: [],
      requiredInputs: []
    }
  ]
};
const usage = {
  runner: 'codex' as const,
  windows: [
    {
      id: 'five_hour',
      label: '5-hour limit',
      usedPercentage: 25,
      resetsAt: 1_800_000
    }
  ],
  fetchedAt: 1_000_000,
  cached: false,
  profile: {
    lifetimeTokens: 420_200_000,
    currentDayTokens: 7_000_000,
    lastSevenDaysTokens: 31_000_000,
    statsAsOf: '2026-09-17',
    dailyUsageBuckets: [{ startDate: '2026-09-17', tokens: 7_000_000 }]
  }
};

describe('Server Codex credential routes', () => {
  it.each([
    [403, 'XAI_ENTITLEMENT_REQUIRED'],
    [429, 'XAI_USAGE_RATE_LIMITED'],
    [502, 'XAI_USAGE_LOAD_FAILED']
  ] as const)('returns Grok usage error %s with a safe code and message', async (status, code) => {
    const fixture = routeFixture();
    vi.mocked(fixture.credentials.usage).mockRejectedValue(new XaiOAuthError(code));
    const app = Fastify();
    registerCodexCredentialRoutes({
      app,
      database: fixture.database,
      credentials: fixture.credentials,
      models: fixture.models
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/mar-agent/codex-credentials/credential-1/usage',
        headers: { cookie: headers.cookie }
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
      expect(response.json().error.message).toBe(new XaiOAuthError(code).publicMessage);
      expect(response.body).not.toMatch(/proxy-password|access_token|refresh_token/);
    } finally {
      await app.close();
    }
  });
  it('binds login attempts, exposes full account IDs and returns one full proxy only by details', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerCodexCredentialRoutes({
      app,
      database: fixture.database,
      credentials: fixture.credentials,
      models: fixture.models
    });

    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/codex-login-attempts',
      headers,
      payload: { name: 'Team Codex' }
    });
    expect(started.statusCode).toBe(201);
    expect(fixture.credentials.startLogin).toHaveBeenCalledWith(
      { userId: 1, sessionFingerprint: 'admin-session' },
      { name: 'Team Codex' }
    );

    const polled = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/codex-login-attempts/attempt-1',
      headers: { cookie: headers.cookie }
    });
    expect(polled.statusCode).toBe(200);
    expect(fixture.credentials.loginAttempt).toHaveBeenCalledWith(
      { userId: 1, sessionFingerprint: 'admin-session' },
      'attempt-1',
      expect.any(Function)
    );

    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/codex-credentials',
      headers: { cookie: headers.cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(fixture.credentials.list).toHaveBeenCalledWith(1);
    expect(listed.json()).toMatchObject({
      credentials: [{ id: 'credential-1', accountId: 'account-secret' }]
    });

    const details = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/codex-credentials/credential-1',
      headers: { cookie: headers.cookie }
    });
    expect(details.statusCode).toBe(200);
    expect(details.headers['cache-control']).toBe('private, no-store');
    expect(details.json()).toMatchObject({
      details: {
        credential: { id: 'credential-1' },
        socks5Url: 'socks5://proxy-user:proxy-password@proxy.example.test:1080'
      }
    });
    expect(fixture.credentials.details).toHaveBeenCalledWith(1, 'credential-1');

    const queriedUsage = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/codex-credentials/credential-1/usage',
      headers: { cookie: headers.cookie }
    });
    expect(queriedUsage.statusCode).toBe(200);
    expect(queriedUsage.headers['cache-control']).toBe('private, no-store');
    expect(queriedUsage.json()).toEqual({ usage });
    expect(fixture.credentials.usage).toHaveBeenCalledWith(1, 'credential-1');
    await app.close();
  });

  it('loads a live catalog and imports the confirmed hash through the model transaction', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerCodexCredentialRoutes({
      app,
      database: fixture.database,
      credentials: fixture.credentials,
      models: fixture.models
    });

    const loaded = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/codex-credentials/credential-1/models/load',
      headers
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toEqual({ catalog });

    const request = {
      catalogHash: catalog.catalogHash,
      models: [
        {
          upstreamModelId: 'gpt-codex',
          enabled: true
        }
      ]
    };
    const imported = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/codex-credentials/credential-1/models/import',
      headers,
      payload: request
    });

    expect(imported.statusCode).toBe(200);
    expect(fixture.credentials.loadCatalog).toHaveBeenNthCalledWith(1, 1, 'credential-1');
    expect(fixture.credentials.loadCatalog).toHaveBeenNthCalledWith(2, 1, 'credential-1');
    expect(fixture.models.importCodexModels).toHaveBeenCalledWith(
      1,
      'credential-1',
      catalog,
      request
    );
    expect(imported.json()).toEqual({
      result: {
        items: [
          {
            upstreamModelId: 'gpt-codex',
            status: 'CREATED',
            modelId: 'model-codex'
          }
        ]
      }
    });
    await app.close();
  });

  it('supports update, refresh, test and delete while returning stable conflict details', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerCodexCredentialRoutes({
      app,
      database: fixture.database,
      credentials: fixture.credentials,
      models: fixture.models
    });

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/admin/mar-agent/codex-credentials/credential-1',
          headers,
          payload: {
            name: 'Renamed',
            socks5Url: 'socks5://next-user:next-password@proxy.example.test:2080'
          }
        })
      ).statusCode
    ).toBe(200);
    expect(fixture.credentials.update).toHaveBeenCalledWith(1, 'credential-1', {
      name: 'Renamed',
      socks5Url: 'socks5://next-user:next-password@proxy.example.test:2080'
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/mar-agent/codex-credentials/credential-1/refresh',
          headers
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/mar-agent/codex-credentials/credential-1/test',
          headers
        })
      ).statusCode
    ).toBe(200);

    fixture.credentials.list.mockClear();
    fixture.credentials.remove.mockRejectedValueOnce(new Error('CODEX_CREDENTIAL_IN_USE'));
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/admin/mar-agent/codex-credentials/credential-1',
      headers
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toEqual({
      error: {
        code: 'CODEX_CREDENTIAL_IN_USE',
        message: 'Codex credential is in use.',
        requestId: expect.any(String)
      }
    });
    expect(fixture.credentials.list).not.toHaveBeenCalled();
    expect(fixture.credentials.remove).toHaveBeenCalledWith(1, 'credential-1');
    await app.close();
  });

  it('allows authenticated non-admin users to manage only the credential set filtered by the service', async () => {
    const fixture = routeFixture({
      userId: 7,
      username: 'member',
      isAdmin: false,
      sessionHash: 'member-session'
    });
    const app = Fastify();
    registerCodexCredentialRoutes({
      app,
      database: fixture.database,
      credentials: fixture.credentials,
      models: fixture.models
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/mar-agent/codex-credentials',
      headers: { cookie: headers.cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(fixture.credentials.list).toHaveBeenCalledWith(7);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/admin/mar-agent/codex-credentials/credential-1/models/import',
      headers,
      payload: { catalogHash: catalog.catalogHash, models: [] }
    });
    expect(imported.statusCode).toBe(200);
    expect(fixture.models.importCodexModels).toHaveBeenCalledWith(7, 'credential-1', catalog, {
      catalogHash: catalog.catalogHash,
      models: []
    });
    await app.close();
  });
});

function routeFixture(
  session: {
    readonly userId: number;
    readonly username: string;
    readonly isAdmin: boolean;
    readonly sessionHash: string;
  } = {
    userId: 1,
    username: 'admin',
    isAdmin: true,
    sessionHash: 'admin-session'
  }
) {
  const summary = {
    id: 'credential-1',
    name: 'Team Codex',
    type: 'CODEX_OAUTH' as const,
    ownership: { ownerType: 'ORGANIZATION' as const, ownerOrganizationId: 1 },
    status: 'ACTIVE' as const,
    accessTokenExpiresAt: 100,
    lastRefreshAt: 90,
    lastCheckedAt: 95,
    accountId: 'account-secret',
    proxy: { configured: false as const },
    revision: 1
  };
  const database = {
    findCurrentUserSession: vi.fn(() => ({
      ...session,
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    }))
  } as unknown as MysqlServerDatabase;
  const credentials = {
    closeChatgptLogins: vi.fn(),
    startLogin: vi.fn(async () => ({
      id: 'attempt-1',
      status: 'PENDING',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example.test/codex/device',
      expiresAt: 1_000,
      pollIntervalMs: 5_000
    })),
    loginAttempt: vi.fn(async () => ({ id: 'attempt-1', status: 'PENDING' })),
    cancelLogin: vi.fn(async () => undefined),
    list: vi.fn(async () => [summary]),
    details: vi.fn(async () => ({
      credential: summary,
      socks5Url: 'socks5://proxy-user:proxy-password@proxy.example.test:1080'
    })),
    usage: vi.fn(async () => usage),
    update: vi.fn(async () => summary),
    remove: vi.fn(async () => ({})),
    refresh: vi.fn(async () => summary),
    test: vi.fn(async () => ({ success: true, code: null })),
    loadCatalog: vi.fn(async () => catalog)
  } as unknown as CodexCredentialService & {
    startLogin: ReturnType<typeof vi.fn>;
    loginAttempt: ReturnType<typeof vi.fn>;
    cancelLogin: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    details: ReturnType<typeof vi.fn>;
    usage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    test: ReturnType<typeof vi.fn>;
    loadCatalog: ReturnType<typeof vi.fn>;
  };
  const models = {
    importCodexModels: vi.fn(async () => ({
      items: [
        {
          upstreamModelId: 'gpt-codex',
          status: 'CREATED',
          modelId: 'model-codex'
        }
      ]
    }))
  } as unknown as MarAgentModelService & {
    importCodexModels: ReturnType<typeof vi.fn>;
  };
  return { database, credentials, models };
}
