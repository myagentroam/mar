import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { CodexCredentialService } from '../../ee/server/src/service/codex-credential-service.js';
import { startSocks5Proxy } from '../../packages/server-core/test/support/socks5-proxy.js';

const NOW = 1_800_000_000_000;
const PROJECT_USER_AGENT = `MyAgentRoam/0.9.27 (${process.platform}; ${process.arch})`;

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

function activeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'credential-1',
    name: 'Team Codex',
    type: 'CODEX_OAUTH',
    ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
    status: 'ACTIVE',
    accessToken: jwt({ exp: Math.floor((NOW + 60 * 60 * 1000) / 1000) }),
    refreshToken: 'refresh-secret',
    accountId: 'account-secret',
    accessTokenExpiresAt: NOW + 60 * 60 * 1000,
    lastRefreshAt: NOW - 1_000,
    lastCheckedAt: NOW - 1_000,
    proxy: null,
    revision: 1,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    ...overrides
  };
}

function database(
  credentials: readonly Record<string, unknown>[] = [],
  modelCounts: Readonly<Record<string, number>> = {},
  options: {
    readonly version?: 1 | 2 | 3;
    readonly userOrganizations?: Readonly<Record<number, number>>;
    readonly scopedOrganizationIds?: readonly number[];
    readonly modelGrants?: readonly Record<string, unknown>[];
  } = {}
) {
  let document: unknown = { version: options.version ?? 3, credentials };
  const execute = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes("setting_key='mar_agent_credentials'"))
      return [[{ setting_value: JSON.stringify(document) }], []];
    if (sql.includes('INSERT INTO system_settings')) {
      document = JSON.parse(String(parameters[0]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes('credential_id') && sql.includes('mar_agent_models'))
      return [
        Object.entries(modelCounts).map(([credential_id, imported_model_count]) => ({
          credential_id,
          imported_model_count
        })),
        []
      ];
    if (sql.includes('SELECT organization_id FROM users WHERE id=?')) {
      const organizationId = options.userOrganizations?.[Number(parameters[0])];
      return [organizationId === undefined ? [] : [{ organization_id: organizationId }], []];
    }
    if (sql.includes('WITH RECURSIVE ancestors')) {
      const organizationId = Number(parameters[0]);
      const ancestorOrganizationId = Number(parameters[1]);
      const allowed =
        organizationId === ancestorOrganizationId ||
        options.scopedOrganizationIds?.includes(organizationId) === true;
      return [allowed ? [{ present: 1 }] : [], []];
    }
    if (sql.includes('FROM resource_grants') && sql.includes('model_id'))
      return [options.modelGrants ?? [], []];
    return [[], []];
  });
  const audit = vi.fn(async (_event: unknown) => undefined);
  return {
    audit,
    database: { raw: { execute }, audit } as unknown as MysqlServerDatabase,
    execute,
    document: () => document
  };
}

function service(
  database: MysqlServerDatabase,
  request: typeof fetch = vi.fn(),
  now: () => number = () => NOW,
  id: () => string = () => 'generated-id',
  authorization: AuthorizationService = authorizationFixture()
) {
  return new CodexCredentialService(database, {
    authorization,
    request,
    now,
    id,
    authIssuer: 'https://auth.example.test',
    codexBaseUrl: 'https://chatgpt.example.test/backend-api/codex',
    clientId: 'codex-client',
    projectVersion: '0.9.27'
  });
}

function authorizationFixture(
  contexts: Readonly<
    Record<
      number,
      { readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER'; readonly organizationId: number }
    >
  > = {
    1: { role: 'ADMIN', organizationId: 1 },
    2: { role: 'ORG_ADMIN', organizationId: 2 },
    7: { role: 'MEMBER', organizationId: 4 },
    8: { role: 'MEMBER', organizationId: 5 }
  }
): AuthorizationService {
  return {
    actorContext: vi.fn(async (userId: number) => contexts[userId]),
    isPersonalAdmin: vi.fn(async (userId: number) => userId === 99),
    authorize: vi.fn(async (userId: number, _permissionId: string, context: object) => {
      const actor = contexts[userId];
      if (actor?.role === 'ADMIN') return { allowed: true };
      const organizationId = (context as { organizationId?: number }).organizationId;
      if (
        actor?.role === 'ORG_ADMIN' &&
        (organizationId === actor.organizationId || organizationId === 4)
      )
        return { allowed: true };
      return { allowed: false, reason: 'RBAC_SCOPE_DENIED' };
    })
  } as unknown as AuthorizationService;
}

async function startCatalogServer(status = 200, body?: string) {
  const fixtures = join(process.cwd(), 'mar-agent', 'test', 'fixtures');
  const [key, cert] = await Promise.all([
    readFile(join(fixtures, 'localhost-test-key.pem')),
    readFile(join(fixtures, 'localhost-test-cert.pem'))
  ]);
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    hasAuthorization: boolean;
    hasAccountId: boolean;
  }> = [];
  const server = createHttpsServer({ key, cert }, (request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      hasAuthorization: typeof request.headers.authorization === 'string',
      hasAccountId: typeof request.headers['chatgpt-account-id'] === 'string'
    });
    request.resume();
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        body ?? JSON.stringify(status === 200 ? { models: [] } : { error: 'unavailable' })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    port: address.port,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    }
  };
}

describe('Codex credential service', () => {
  it.each([200, 500])(
    'audits explicit organization credential tests without tokens, status=%s',
    async (status) => {
      const fixture = database([activeCredential()]);
      const request = vi.fn(async (url: string | URL | Request) =>
        String(url).includes('/oauth/token')
          ? new Response(
              JSON.stringify({
                access_token: activeCredential().accessToken,
                refresh_token: 'rotated-refresh-secret',
                id_token: jwt({
                  'https://api.openai.com/auth': { chatgpt_account_id: 'account-secret' }
                })
              }),
              { status: 200 }
            )
          : new Response(JSON.stringify({ models: [] }), { status })
      );
      const result = await service(fixture.database, request as typeof fetch).test(
        1,
        'credential-1'
      );
      expect(result.success).toBe(status === 200);
      expect(fixture.audit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          eventType: 'credential.tested',
          actorUserId: 1,
          organizationId: 1,
          targetName: 'Team Codex',
          result: status === 200 ? 'SUCCESS' : 'FAILED'
        })
      );
      expect(JSON.stringify(fixture.audit.mock.calls)).not.toContain('refresh-secret');
      expect(JSON.stringify(fixture.audit.mock.calls)).not.toContain('account-secret');
    }
  );

  it('rejects legacy credential documents outside the startup migration path', async () => {
    const legacy = activeCredential({
      fedramp: false,
      custom: { environment: 'team' }
    });
    Reflect.deleteProperty(legacy, 'ownership');
    const fixture = database([legacy], {}, { version: 1 });
    const credentials = service(fixture.database);

    await expect(credentials.list(1)).rejects.toThrow('CODEX_CREDENTIAL_STORE_INVALID');
  });

  it('rejects unknown fields in a version 2 credential document', async () => {
    const fixture = database([
      activeCredential({
        custom: { environment: 'team' }
      })
    ]);

    await expect(service(fixture.database).list(1)).rejects.toThrow(
      'CODEX_CREDENTIAL_STORE_INVALID'
    );
  });

  it('filters personal and organization credentials by management ownership', async () => {
    const fixture = database([
      activeCredential({
        id: 'personal-7',
        name: 'Personal',
        ownership: { ownerType: 'PERSONAL', ownerUserId: 7 }
      }),
      activeCredential({
        id: 'organization-4',
        name: 'Organization',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 }
      }),
      activeCredential({ id: 'enterprise', name: 'Enterprise' })
    ]);
    const credentials = service(fixture.database);

    await expect(credentials.list(7)).resolves.toMatchObject([
      { id: 'personal-7', ownership: { ownerType: 'PERSONAL', ownerUserId: 7 } }
    ]);
    await expect(credentials.list(2)).resolves.toMatchObject([
      {
        id: 'organization-4',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 }
      }
    ]);
    await expect(credentials.list(1)).resolves.toMatchObject([
      {
        id: 'organization-4',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 }
      },
      { id: 'enterprise', ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 } }
    ]);
    await expect(credentials.details(1, 'personal-7')).rejects.toThrow(
      'CODEX_CREDENTIAL_NOT_FOUND'
    );
    await expect(credentials.details(2, 'organization-4')).resolves.toMatchObject({
      credential: { id: 'organization-4' }
    });
    await expect(credentials.details(7, 'enterprise')).rejects.toThrow(
      'CODEX_CREDENTIAL_NOT_FOUND'
    );
  });

  it('rejects ownership selections outside the current user management scope', async () => {
    const credentials = service(database().database);

    await expect(
      credentials.startLogin(
        { userId: 7, sessionFingerprint: 'member-session' },
        {
          name: 'Other Personal',
          ownership: { ownerType: 'PERSONAL', ownerUserId: 8 }
        }
      )
    ).rejects.toThrow('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
    await expect(
      credentials.startLogin(
        { userId: 2, sessionFingerprint: 'org-admin-session' },
        {
          name: 'Outside Organization',
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 5 }
        }
      )
    ).rejects.toThrow('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
    await expect(
      credentials.startLogin(
        { userId: 2, sessionFingerprint: 'org-admin-session' },
        { name: 'Enterprise', ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 } }
      )
    ).rejects.toThrow('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
    await expect(
      credentials.startLogin(
        { userId: 99, sessionFingerprint: 'personal-admin-session' },
        { name: 'Enterprise', ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 } }
      )
    ).rejects.toThrow('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
  });

  it('rejects a scope reduction while referenced model grants remain outside the new scope', async () => {
    const fixture = database(
      [activeCredential()],
      {},
      {
        modelGrants: [
          {
            model_id: 'model-enterprise',
            target_type: 'ORGANIZATION',
            target_user_id: null,
            target_organization_id: 1
          }
        ]
      }
    );
    const credentials = service(fixture.database);

    await expect(
      credentials.update(1, 'credential-1', {
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 }
      })
    ).rejects.toThrow('CODEX_CREDENTIAL_SCOPE_CONFLICT');
    expect(fixture.document()).toMatchObject({
      credentials: [
        expect.objectContaining({
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
        })
      ]
    });
  });

  it('checks the current user organization whenever a credential is used at runtime', async () => {
    const fixture = database(
      [
        activeCredential({
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 2 }
        })
      ],
      {},
      {
        userOrganizations: { 7: 4, 8: 5 },
        scopedOrganizationIds: [4]
      }
    );
    const credentials = service(fixture.database);

    await expect(credentials.assertUserInScope(7, 'credential-1')).resolves.toBeUndefined();
    await expect(credentials.assertUserInScope(8, 'credential-1')).rejects.toThrow(
      'CODEX_CREDENTIAL_SCOPE_FORBIDDEN'
    );
  });

  it('lists full account IDs without tokens, custom metadata or imported model counts', async () => {
    const fixture = database([activeCredential()], { 'credential-1': 2 });

    const result = await service(fixture.database).list(1);

    expect(result).toEqual([
      expect.objectContaining({
        id: 'credential-1',
        status: 'ACTIVE',
        accountId: 'account-secret',
        proxy: { configured: false }
      })
    ]);
    expect(result[0]).not.toHaveProperty('accessToken');
    expect(result[0]).not.toHaveProperty('fedramp');
    expect(result[0]).not.toHaveProperty('custom');
    expect(result[0]).not.toHaveProperty('importedModelCount');
    expect(
      fixture.execute.mock.calls.some(([sql]) => String(sql).includes('imported_model_count'))
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain(activeCredential().accessToken);
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
  });

  it('persists proxy edits without exposing image generation configuration', async () => {
    const fixture = database([
      activeCredential({
        proxy: 'socks5://proxy-user:proxy-password@127.0.0.1:1080'
      })
    ]);
    const credentials = service(fixture.database);

    await expect(credentials.details(1, 'credential-1')).resolves.toMatchObject({
      credential: {
        id: 'credential-1',
        proxy: {
          configured: true,
          host: '127.0.0.1',
          port: 1080,
          hasUsername: true
        }
      },
      socks5Url: 'socks5://proxy-user:proxy-password@127.0.0.1:1080'
    });

    await credentials.update(1, 'credential-1', {
      socks5Url: 'socks5://next-user:next-password@proxy.example.test:2080'
    });
    await expect(credentials.details(1, 'credential-1')).resolves.toMatchObject({
      credential: { id: 'credential-1' },
      socks5Url: 'socks5://next-user:next-password@proxy.example.test:2080'
    });
    expect(JSON.stringify(fixture.document())).not.toContain('imageModelId');
    expect(JSON.stringify(await credentials.list(1))).not.toContain('next-password');
    expect(JSON.stringify(fixture.document())).not.toContain('fedramp');
    expect(JSON.stringify(fixture.document())).not.toContain('custom');

    await credentials.update(1, 'credential-1', { socks5Url: null });
    await expect(credentials.details(1, 'credential-1')).resolves.toMatchObject({
      credential: { proxy: { configured: false } },
      socks5Url: null
    });
  });

  it('rejects a malformed SOCKS5 URL when updating a credential with a stable input error', async () => {
    const fixture = database([activeCredential()]);
    const credentials = service(fixture.database);

    const rejection = await credentials
      .update(1, 'credential-1', {
        socks5Url: '%'
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(TypeError);
    expect(rejection).toMatchObject({ message: 'CODEX_CREDENTIAL_INPUT_INVALID' });
  });

  it('rejects removed custom metadata from credential login and update requests', async () => {
    const fixture = database([activeCredential()]);
    const credentials = service(fixture.database);
    const actor = { userId: 1, sessionFingerprint: 'session-fingerprint' };

    await expect(
      credentials.startLogin(actor, {
        name: 'Another Codex',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
        custom: { environment: 'team' }
      })
    ).rejects.toThrow('CODEX_CREDENTIAL_INPUT_INVALID');
    await expect(
      credentials.update(1, 'credential-1', {
        custom: { environment: 'team' }
      })
    ).rejects.toThrow('CODEX_CREDENTIAL_INPUT_INVALID');
  });

  it('routes Codex catalog requests through the configured SOCKS5 dispatcher without exposing proxy credentials', async () => {
    const fixture = database([
      activeCredential({
        proxy: 'socks5://proxy-user:proxy-password@127.0.0.1:1080'
      })
    ]);
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    const credentials = service(fixture.database, request as typeof fetch);

    await credentials.loadCatalog(1, 'credential-1');

    expect(request).toHaveBeenCalledWith(
      'https://chatgpt.example.test/backend-api/codex/models?client_version=99.99.99',
      expect.objectContaining({
        dispatcher: expect.anything(),
        redirect: 'error',
        headers: expect.objectContaining({
          'user-agent': PROJECT_USER_AGENT
        })
      })
    );
    const summaries = await credentials.list(1);
    expect(summaries[0]?.proxy).toEqual({
      configured: true,
      host: '127.0.0.1',
      port: 1080,
      hasUsername: true
    });
    expect(JSON.stringify(summaries)).not.toContain('proxy-user');
    expect(JSON.stringify(summaries)).not.toContain('proxy-password');
  });

  it('reads live Codex usage with credential headers and SOCKS5 without exposing secrets', async () => {
    const fixture = database([
      activeCredential({
        proxy: 'socks5://proxy-user:proxy-password@127.0.0.1:1080'
      })
    ]);
    const resetAt = Math.floor((NOW + 30 * 60 * 1000) / 1000);
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void init;
      if (String(url).endsWith('/wham/profiles/me'))
        return new Response(
          JSON.stringify({
            profile: { email: 'account-secret@example.test' },
            stats: { lifetime_tokens: 420_200_000 },
            metadata: { stats_as_of: '2026-09-18' },
            daily_usage_buckets: [
              { start_date: '2026-09-11', tokens: 10 },
              { start_date: '2026-09-12', tokens: 20 },
              { start_date: '2026-09-13', tokens: 30 },
              { start_date: '2026-09-14', tokens: 40 },
              { start_date: '2026-09-15', tokens: 50 },
              { start_date: '2026-09-16', tokens: 60 },
              { start_date: '2026-09-17', tokens: 70 }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      return new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 5 * 60 * 60,
              reset_after_seconds: 1_800,
              reset_at: resetAt
            },
            secondary_window: {
              used_percent: 70,
              limit_window_seconds: 7 * 24 * 60 * 60,
              reset_after_seconds: 86_400,
              reset_at: resetAt + 86_400
            }
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: 'secret-credit-balance'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const queriedAt = Date.parse('2026-09-18T18:00:00.000Z');
    const credentials = service(fixture.database, request as typeof fetch, () => queriedAt);

    const usage = await credentials.usage(1, 'credential-1');

    expect(usage).toEqual({
      runner: 'codex',
      windows: [
        {
          id: 'five_hour',
          label: '5-hour limit',
          usedPercentage: 25,
          resetsAt: resetAt * 1000
        },
        {
          id: 'seven_day',
          label: '7-day limit',
          usedPercentage: 70,
          resetsAt: (resetAt + 86_400) * 1000
        }
      ],
      fetchedAt: queriedAt,
      cached: false,
      profile: {
        lifetimeTokens: 420_200_000,
        currentDayTokens: 70,
        lastSevenDaysTokens: 280,
        statsAsOf: '2026-09-17',
        dailyUsageBuckets: [
          { startDate: '2026-09-11', tokens: 10 },
          { startDate: '2026-09-12', tokens: 20 },
          { startDate: '2026-09-13', tokens: 30 },
          { startDate: '2026-09-14', tokens: 40 },
          { startDate: '2026-09-15', tokens: 50 },
          { startDate: '2026-09-16', tokens: 60 },
          { startDate: '2026-09-17', tokens: 70 }
        ]
      }
    });
    expect(request).toHaveBeenCalledWith(
      'https://chatgpt.example.test/backend-api/wham/usage',
      expect.objectContaining({
        dispatcher: expect.anything(),
        redirect: 'error',
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer /u),
          'ChatGPT-Account-ID': 'account-secret',
          originator: 'myagentroam',
          'user-agent': PROJECT_USER_AGENT
        })
      })
    );
    expect(request).toHaveBeenCalledWith(
      'https://chatgpt.example.test/backend-api/wham/profiles/me',
      expect.objectContaining({
        dispatcher: expect.anything(),
        redirect: 'error',
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer /u),
          'ChatGPT-Account-ID': 'account-secret',
          originator: 'myagentroam',
          'user-agent': PROJECT_USER_AGENT
        })
      })
    );
    const usageHeaders = request.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(usageHeaders).not.toHaveProperty('X-OpenAI-Fedramp');
    expect(JSON.stringify(usage)).not.toContain('account-secret');
    expect(JSON.stringify(usage)).not.toContain('proxy-password');
    expect(JSON.stringify(usage)).not.toContain('secret-credit-balance');
    expect(JSON.stringify(usage)).not.toContain('account-secret@example.test');
  });

  it('shows only the previous Los Angeles day while excluding an active day from the seven-day total', async () => {
    const fixture = database([activeCredential()]);
    let dailyUsageBuckets = Array.from({ length: 8 }, (_, index) => ({
      start_date: `2026-09-${String(index + 10).padStart(2, '0')}`,
      tokens: (index + 1) * 10
    }));
    const request = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/wham/profiles/me')
        ? new Response(
            JSON.stringify({
              stats: { lifetime_tokens: 360 },
              daily_usage_buckets: dailyUsageBuckets
            })
          )
        : new Response(
            JSON.stringify({
              rate_limit: {
                primary_window: {
                  used_percent: 25,
                  limit_window_seconds: 5 * 60 * 60,
                  reset_at: Math.floor(NOW / 1000)
                }
              }
            })
          )
    );
    const usageAt = (isoTime: string) =>
      service(fixture.database, request as typeof fetch, () => Date.parse(isoTime)).usage(
        1,
        'credential-1'
      );

    const beforeMidnight = (await usageAt('2026-09-18T06:59:59.000Z')).profile;
    expect(beforeMidnight.statsAsOf).toBe('2026-09-16');
    expect(beforeMidnight.currentDayTokens).toBe(70);
    expect(beforeMidnight.lastSevenDaysTokens).toBe(280);

    const afterMidnight = (await usageAt('2026-09-18T07:00:00.000Z')).profile;
    expect(afterMidnight.statsAsOf).toBe('2026-09-17');
    expect(afterMidnight.currentDayTokens).toBe(80);
    expect(afterMidnight.lastSevenDaysTokens).toBe(350);

    dailyUsageBuckets = [{ start_date: '2026-09-17', tokens: 80 }];
    const todayOnly = (await usageAt('2026-09-18T06:59:59.000Z')).profile;
    expect(todayOnly.statsAsOf).toBe('2026-09-16');
    expect(todayOnly.currentDayTokens).toBeNull();
    expect(todayOnly.lastSevenDaysTokens).toBeNull();

    dailyUsageBuckets = [
      { start_date: '2026-09-09', tokens: 5 },
      { start_date: '2026-09-15', tokens: 70 },
      { start_date: '2026-09-17', tokens: 80 }
    ];
    const delayedBuckets = (await usageAt('2026-09-18T06:59:59.000Z')).profile;
    expect(delayedBuckets.statsAsOf).toBe('2026-09-16');
    expect(delayedBuckets.currentDayTokens).toBeNull();
    expect(delayedBuckets.lastSevenDaysTokens).toBe(70);
  });

  it('refreshes once after a Codex usage 401 and marks a repeated 401 for reauthentication', async () => {
    const fixture = database([activeCredential()]);
    const refreshedAccess = jwt({
      exp: Math.floor((NOW + 2 * 60 * 60 * 1000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-secret'
      }
    });
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void init;
      const target = String(url);
      if (target.endsWith('/oauth/token'))
        return new Response(
          JSON.stringify({
            access_token: refreshedAccess,
            refresh_token: 'rotated-refresh',
            id_token: refreshedAccess
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      if (target.endsWith('/wham/usage')) return new Response('', { status: 401 });
      throw new Error(`UNEXPECTED_REQUEST:${target}`);
    });
    const credentials = service(fixture.database, request as typeof fetch);

    await expect(credentials.usage(1, 'credential-1')).rejects.toThrow(
      'CODEX_CREDENTIAL_REAUTH_REQUIRED'
    );

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://chatgpt.example.test/backend-api/wham/usage',
      'https://auth.example.test/oauth/token',
      'https://chatgpt.example.test/backend-api/wham/usage'
    ]);
    const retriedHeaders = request.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(retriedHeaders.authorization).toBe(`Bearer ${refreshedAccess}`);
    expect(JSON.stringify(fixture.document())).toContain('"status":"REAUTH_REQUIRED"');
    expect(JSON.stringify(fixture.document())).toContain('rotated-refresh');
  });

  it('returns stable usage errors for upstream rate limits and malformed successful payloads', async () => {
    const fixture = database([activeCredential()]);
    const responses = [
      new Response(JSON.stringify({ error: 'slow down' }), { status: 429 }),
      new Response(JSON.stringify({ rate_limit: { primary_window: null } }), { status: 200 }),
      new Response(
        JSON.stringify({
          stats: { lifetime_tokens: 1 },
          metadata: { stats_as_of: '2026-09-17' },
          daily_usage_buckets: [{ start_date: '2026-09-17', tokens: 1 }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    ];
    const request = vi.fn(async () => responses.shift()!);
    const credentials = service(fixture.database, request as typeof fetch);

    await expect(credentials.usage(1, 'credential-1')).rejects.toThrow('CODEX_USAGE_RATE_LIMITED');
    await expect(credentials.usage(1, 'credential-1')).rejects.toThrow(
      'CODEX_USAGE_RESPONSE_INVALID'
    );
  });

  it('rejects an oversized Codex usage response and closes its SOCKS5 connection', async () => {
    const usagePayload =
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: Math.floor((NOW + 30 * 60 * 1000) / 1000)
          }
        }
      }) + ' '.repeat(256 * 1024);
    const target = await startCatalogServer(200, usagePayload);
    const proxy = await startSocks5Proxy({ targetPort: target.port });
    const previousTlsSetting = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      const fixture = database([activeCredential({ proxy: proxy.url })]);
      const credentials = new CodexCredentialService(fixture.database, {
        authorization: authorizationFixture(),
        now: () => NOW,
        id: () => 'generated-id',
        authIssuer: 'https://auth.example.test',
        codexBaseUrl: `https://catalog.internal:${target.port}/backend-api/codex`,
        clientId: 'codex-client',
        projectVersion: '0.9.27'
      });

      await expect(credentials.usage(1, 'credential-1')).rejects.toThrow(
        'CODEX_USAGE_RESPONSE_INVALID'
      );
      await vi.waitFor(() => expect(proxy.activeConnections()).toBe(0), { timeout: 500 });
    } finally {
      if (previousTlsSetting === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsSetting;
      await Promise.all([target.close(), proxy.close()]);
    }
  });

  it('forwards the live catalog request through authenticated SOCKS5 with proxy-side DNS', async () => {
    const target = await startCatalogServer();
    const proxy = await startSocks5Proxy({
      targetPort: target.port,
      username: 'proxy-user',
      password: 'proxy-password'
    });
    const previousTlsSetting = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      const fixture = database([activeCredential({ proxy: proxy.url })]);
      const credentials = new CodexCredentialService(fixture.database, {
        authorization: authorizationFixture(),
        now: () => NOW,
        id: () => 'generated-id',
        authIssuer: 'https://auth.example.test',
        codexBaseUrl: `https://catalog.internal:${target.port}/backend-api/codex`,
        clientId: 'codex-client',
        projectVersion: '0.9.27'
      });

      const catalog = await credentials.loadCatalog(1, 'credential-1');

      expect(catalog.models).toEqual([]);
      expect(target.requests).toEqual([
        {
          method: 'GET',
          path: '/backend-api/codex/models?client_version=99.99.99',
          hasAuthorization: true,
          hasAccountId: true
        }
      ]);
      expect(proxy.destinations).toEqual([{ host: 'catalog.internal', port: target.port }]);
      expect(proxy.authentications).toEqual([
        { username: 'proxy-user', password: 'proxy-password' }
      ]);
    } finally {
      if (previousTlsSetting === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsSetting;
      await Promise.all([target.close(), proxy.close()]);
    }
  });

  it('closes the SOCKS5 dispatcher when a catalog failure is rejected without reading its body', async () => {
    const target = await startCatalogServer(503);
    const proxy = await startSocks5Proxy({ targetPort: target.port });
    const previousTlsSetting = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      const fixture = database([activeCredential({ proxy: proxy.url })]);
      const credentials = new CodexCredentialService(fixture.database, {
        authorization: authorizationFixture(),
        now: () => NOW,
        id: () => 'generated-id',
        authIssuer: 'https://auth.example.test',
        codexBaseUrl: `https://catalog.internal:${target.port}/backend-api/codex`,
        clientId: 'codex-client',
        projectVersion: '0.9.27'
      });

      await expect(credentials.loadCatalog(1, 'credential-1')).rejects.toThrow(
        'CODEX_CATALOG_LOAD_FAILED'
      );
      await vi.waitFor(() => expect(proxy.activeConnections()).toBe(0), { timeout: 500 });
    } finally {
      if (previousTlsSetting === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsSetting;
      await Promise.all([target.close(), proxy.close()]);
    }
  });

  it('consumes a failed direct catalog response before rejecting it', async () => {
    const fixture = database([activeCredential()]);
    const response = new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    });
    const consume = vi.spyOn(response, 'arrayBuffer');
    const request = vi.fn(async () => response);

    await expect(
      service(fixture.database, request as typeof fetch).loadCatalog(1, 'credential-1')
    ).rejects.toThrow('CODEX_CATALOG_LOAD_FAILED');
    expect(consume).toHaveBeenCalledOnce();
  });

  it('refreshes a due credential once for concurrent callers and persists the rotated token', async () => {
    const fixture = database([
      activeCredential({
        accessToken: jwt({ exp: Math.floor((NOW + 60_000) / 1000) }),
        accessTokenExpiresAt: NOW + 60_000
      })
    ]);
    const refreshedAccess = jwt({
      exp: Math.floor((NOW + 60 * 60 * 1000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-secret',
        chatgpt_account_is_fedramp: false
      }
    });
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      await Promise.resolve();
      return new Response(
        JSON.stringify({
          access_token: refreshedAccess,
          refresh_token: 'rotated-refresh',
          id_token: refreshedAccess
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const credentials = service(fixture.database, request as typeof fetch);

    const [first, second] = await Promise.all([
      credentials.resolve('credential-1', 'RUNTIME'),
      credentials.resolve('credential-1', 'RUNTIME')
    ]);

    expect(request).toHaveBeenCalledOnce();
    expect(first.bearer).toBe(refreshedAccess);
    expect(first.headers).toMatchObject({
      'user-agent': PROJECT_USER_AGENT
    });
    expect(second.revision).toBe(first.revision);
    expect(JSON.stringify(fixture.document())).toContain('rotated-refresh');
    expect(JSON.stringify(fixture.document())).not.toContain('"idToken"');
    expect(request.mock.calls[0]?.[0]).toBe('https://auth.example.test/oauth/token');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      client_id: 'codex-client',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-secret'
    });
  });

  it('does not let an in-flight normal resolution suppress an unauthorized forced refresh', async () => {
    const initial = activeCredential();
    const fixture = database([initial]);
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    fixture.execute.mockImplementationOnce(async (sql: string) => {
      if (!sql.includes("setting_key='mar_agent_credentials'"))
        throw new Error(`UNEXPECTED_SQL:${sql}`);
      readStarted.resolve();
      await releaseRead.promise;
      return [[{ setting_value: JSON.stringify(fixture.document()) }], []];
    });
    const refreshedAccess = jwt({
      exp: Math.floor((NOW + 2 * 60 * 60 * 1000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-secret',
        chatgpt_account_is_fedramp: false
      }
    });
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: refreshedAccess,
            refresh_token: 'rotated-refresh',
            id_token: refreshedAccess
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const credentials = service(fixture.database, request as typeof fetch);

    const normal = credentials.resolve('credential-1', 'RUNTIME');
    await readStarted.promise;
    const unauthorized = credentials.resolve('credential-1', 'UNAUTHORIZED');
    releaseRead.resolve();

    await expect(normal).resolves.toMatchObject({ bearer: initial.accessToken });
    await expect(unauthorized).resolves.toMatchObject({ bearer: refreshedAccess });
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not let an older refresh overwrite credentials replaced by reauthentication', async () => {
    const fixture = database([
      activeCredential({
        accessToken: jwt({ exp: Math.floor((NOW + 60_000) / 1000) }),
        accessTokenExpiresAt: NOW + 60_000
      })
    ]);
    const staleRefreshStarted = deferred<void>();
    const releaseStaleRefresh = deferred<void>();
    const staleAccess = jwt({
      exp: Math.floor((NOW + 60 * 60 * 1000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-secret',
        chatgpt_account_is_fedramp: false
      }
    });
    const reauthenticatedAccess = jwt({
      exp: Math.floor((NOW + 2 * 60 * 60 * 1000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-secret',
        chatgpt_account_is_fedramp: false
      }
    });
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/api/accounts/deviceauth/usercode'))
        return new Response(
          JSON.stringify({
            device_auth_id: 'device-auth-secret',
            user_code: 'ABCD-EFGH',
            interval: '1'
          }),
          { status: 200 }
        );
      if (target.endsWith('/api/accounts/deviceauth/token'))
        return new Response(
          JSON.stringify({
            authorization_code: 'authorization-secret',
            code_verifier: 'verifier-secret'
          }),
          { status: 200 }
        );
      if (target.endsWith('/models?client_version=99.99.99'))
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (target.endsWith('/oauth/token')) {
        const body = String(init?.body);
        const grantType = body.startsWith('{')
          ? (JSON.parse(body) as { grant_type?: string }).grant_type
          : new URLSearchParams(body).get('grant_type');
        if (grantType === 'refresh_token') {
          staleRefreshStarted.resolve();
          await releaseStaleRefresh.promise;
          return new Response(
            JSON.stringify({
              access_token: staleAccess,
              refresh_token: 'stale-rotated-refresh',
              id_token: staleAccess
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            access_token: reauthenticatedAccess,
            refresh_token: 'reauthenticated-refresh',
            id_token: reauthenticatedAccess
          }),
          { status: 200 }
        );
      }
      throw new Error(`UNEXPECTED_REQUEST:${target}`);
    });
    const credentials = service(
      fixture.database,
      request as typeof fetch,
      () => NOW,
      () => 'attempt-1'
    );
    const actor = { userId: 1, sessionFingerprint: 'session-fingerprint' };

    const staleRefresh = credentials.resolve('credential-1', 'RUNTIME');
    await staleRefreshStarted.promise;
    const attempt = await credentials.startLogin(actor, {
      name: 'Team Codex',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      targetCredentialId: 'credential-1'
    });
    await expect(credentials.loginAttempt(actor, attempt.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      credentialId: 'credential-1'
    });
    releaseStaleRefresh.resolve();

    await expect(staleRefresh).resolves.toMatchObject({ bearer: reauthenticatedAccess });
    expect(JSON.stringify(fixture.document())).toContain('reauthenticated-refresh');
    expect(JSON.stringify(fixture.document())).not.toContain('stale-rotated-refresh');
  });

  it('marks permanent refresh failures as reauthentication-required without returning an expired token', async () => {
    const fixture = database([
      activeCredential({
        accessTokenExpiresAt: NOW - 1,
        accessToken: jwt({ exp: Math.floor((NOW - 1) / 1000) })
      })
    ]);
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'refresh_token_expired' } }), { status: 400 })
    );

    await expect(
      service(fixture.database, request as typeof fetch).resolve('credential-1', 'RUNTIME')
    ).rejects.toThrow('CODEX_CREDENTIAL_REAUTH_REQUIRED');

    expect(JSON.stringify(fixture.document())).toContain('"status":"REAUTH_REQUIRED"');
    expect(JSON.stringify(fixture.document())).not.toContain('refresh_token_expired');
  });

  it('marks an authorization-check 401 as reauthentication-required', async () => {
    const fixture = database([
      activeCredential({
        lastCheckedAt: NOW - 24 * 60 * 60 * 1000 - 1
      })
    ]);
    const request = vi.fn(async () => new Response('', { status: 401 }));
    const credentials = service(fixture.database, request as typeof fetch);

    await expect(credentials.resolve('credential-1', 'RUNTIME')).rejects.toThrow(
      'CODEX_CREDENTIAL_REAUTH_REQUIRED'
    );

    expect(JSON.stringify(fixture.document())).toContain('"status":"REAUTH_REQUIRED"');
  });

  it('keeps a credential degraded when an old token passes authorization after refresh fails', async () => {
    const fixture = database([
      activeCredential({
        accessTokenExpiresAt: NOW + 60_000,
        lastCheckedAt: NOW - 24 * 60 * 60 * 1000 - 1
      })
    ]);
    const responses = [
      new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }),
      new Response(JSON.stringify({ models: [] }), { status: 200 })
    ];
    const request = vi.fn(async () => responses.shift()!);
    const credentials = service(fixture.database, request as typeof fetch);

    await expect(credentials.resolve('credential-1', 'RUNTIME')).resolves.toMatchObject({
      bearer: expect.any(String)
    });

    expect(JSON.stringify(fixture.document())).toContain('"status":"DEGRADED"');
  });

  it('marks a repeated catalog 401 after forced refresh as reauthentication-required', async () => {
    const fixture = database([activeCredential()]);
    const refreshedAccess = jwt({
      exp: Math.floor((NOW + 2 * 60 * 60 * 1000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-secret',
        chatgpt_account_is_fedramp: false
      }
    });
    const responses = [
      new Response('', { status: 401 }),
      new Response(
        JSON.stringify({
          access_token: refreshedAccess,
          refresh_token: 'rotated-refresh',
          id_token: refreshedAccess
        }),
        { status: 200 }
      ),
      new Response('', { status: 401 })
    ];
    const request = vi.fn(async () => responses.shift()!);
    const credentials = service(fixture.database, request as typeof fetch);

    await expect(credentials.loadCatalog(1, 'credential-1')).rejects.toThrow(
      'CODEX_CREDENTIAL_REAUTH_REQUIRED'
    );

    expect(JSON.stringify(fixture.document())).toContain('"status":"REAUTH_REQUIRED"');
  });

  it('does not let an older successful catalog response clear reauthentication-required', async () => {
    let now = NOW;
    const fixture = database([activeCredential({ lastCheckedAt: NOW })]);
    const catalogStarted = deferred<void>();
    const releaseCatalog = deferred<void>();
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      if (request.mock.calls.length === 1) {
        catalogStarted.resolve();
        await releaseCatalog.promise;
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response('', { status: 401 });
    });
    const credentials = service(fixture.database, request as typeof fetch, () => now);

    const catalog = credentials.loadCatalog(1, 'credential-1');
    await catalogStarted.promise;
    now += 24 * 60 * 60 * 1000 + 1;
    await expect(credentials.resolve('credential-1', 'RUNTIME')).rejects.toThrow(
      'CODEX_CREDENTIAL_REAUTH_REQUIRED'
    );
    releaseCatalog.resolve();

    await expect(catalog).resolves.toMatchObject({ models: [] });
    expect(JSON.stringify(fixture.document())).toContain('"status":"REAUTH_REQUIRED"');
  });

  it('checks due credentials on startup with at most four concurrent upstream requests', async () => {
    const credentials = Array.from({ length: 6 }, (_, index) =>
      activeCredential({
        id: `credential-${index + 1}`,
        name: `Team Codex ${index + 1}`,
        lastCheckedAt: NOW - 24 * 60 * 60 * 1000 - 1
      })
    );
    const fixture = database(credentials);
    let active = 0;
    let maximum = 0;
    const request = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });
    const service = new CodexCredentialService(fixture.database, {
      authorization: authorizationFixture(),
      request: request as typeof fetch,
      now: () => NOW,
      projectVersion: '0.9.27'
    });

    await expect(service.maintain('STARTUP')).resolves.toEqual({
      attempted: 6,
      deferred: 0,
      failed: 0
    });

    expect(request).toHaveBeenCalledTimes(6);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it('backs off failed background checks without delaying foreground requests', async () => {
    let now = NOW;
    const fixture = database([
      activeCredential({
        lastCheckedAt: NOW - 24 * 60 * 60 * 1000 - 1
      })
    ]);
    const request = vi.fn(async () => {
      throw new Error('offline');
    });
    const service = new CodexCredentialService(fixture.database, {
      authorization: authorizationFixture(),
      request: request as typeof fetch,
      now: () => now,
      projectVersion: '0.9.27'
    });

    await expect(service.maintain('STARTUP')).resolves.toEqual({
      attempted: 1,
      deferred: 0,
      failed: 1
    });
    await expect(service.maintain('EXPIRING')).resolves.toEqual({
      attempted: 0,
      deferred: 1,
      failed: 0
    });
    expect(request).toHaveBeenCalledOnce();

    await expect(service.resolve('credential-1', 'RUNTIME')).rejects.toThrow('offline');
    expect(request).toHaveBeenCalledTimes(2);

    now += 60_000;
    await expect(service.maintain('EXPIRING')).resolves.toEqual({
      attempted: 1,
      deferred: 0,
      failed: 1
    });
    expect(request).toHaveBeenCalledTimes(3);

    for (const [delay, expectedCalls] of [
      [5 * 60_000, 4],
      [15 * 60_000, 5],
      [60 * 60_000, 6],
      [60 * 60_000, 7]
    ] as const) {
      await expect(service.maintain('EXPIRING')).resolves.toEqual({
        attempted: 0,
        deferred: 1,
        failed: 0
      });
      now += delay;
      await expect(service.maintain('EXPIRING')).resolves.toEqual({
        attempted: 1,
        deferred: 0,
        failed: 1
      });
      expect(request).toHaveBeenCalledTimes(expectedCalls);
    }
  });

  it('loads the live model catalog with Codex headers and isolates unsupported reasoning values', async () => {
    const fixture = database([activeCredential()]);
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-codex',
              display_name: 'GPT Codex',
              description: 'Coding model',
              supported_reasoning_levels: [
                { effort: 'low', description: 'Low' },
                { effort: 'ultra', description: 'Ultra' }
              ],
              default_reasoning_level: 'ultra',
              visibility: 'list',
              supported_in_api: true,
              input_modalities: ['text', 'image'],
              context_window: 200000,
              supports_search_tool: true
            },
            {
              slug: 'hidden-model',
              display_name: 'Hidden',
              supported_reasoning_levels: [],
              visibility: 'hide',
              supported_in_api: true
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const catalog = await service(fixture.database, request as typeof fetch).loadCatalog(
      1,
      'credential-1'
    );

    expect(catalog.models).toEqual([
      expect.objectContaining({
        upstreamModelId: 'gpt-codex',
        reasoningEfforts: ['low', 'ultra'],
        defaultReasoningEffort: 'ultra',
        unsupportedReasoningEfforts: [],
        inputCapabilities: ['TEXT', 'IMAGE'],
        hostedWebSearch: true,
        requiredInputs: []
      })
    ]);
    expect(request).toHaveBeenCalledWith(
      'https://chatgpt.example.test/backend-api/codex/models?client_version=99.99.99',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer /u),
          'ChatGPT-Account-ID': 'account-secret',
          originator: 'myagentroam',
          'user-agent': PROJECT_USER_AGENT
        })
      })
    );
    const catalogHeaders = request.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(catalogHeaders).not.toHaveProperty('X-OpenAI-Fedramp');
    expect(JSON.stringify(catalog)).not.toContain('account-secret');
  });

  it('rejects malformed successful catalog responses instead of treating them as an empty catalog', async () => {
    const fixture = database([activeCredential()]);
    const request = vi.fn(async () => new Response('not-json', { status: 200 }));

    await expect(
      service(fixture.database, request as typeof fetch).loadCatalog(1, 'credential-1')
    ).rejects.toThrow('CODEX_CATALOG_LOAD_FAILED');
  });

  it('persists a device login only after polling, token exchange, claim validation and catalog check succeed', async () => {
    let now = NOW;
    const fixture = database();
    const authorizedToken = jwt({
      exp: Math.floor((NOW + 60 * 60 * 1000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-secret',
        chatgpt_account_is_fedramp: true
      }
    });
    const responses = [
      new Response(
        JSON.stringify({
          device_auth_id: 'device-auth-secret',
          user_code: 'ABCD-EFGH',
          interval: '5'
        }),
        { status: 200 }
      ),
      new Response('', { status: 404 }),
      new Response(
        JSON.stringify({
          authorization_code: 'authorization-secret',
          code_challenge: 'challenge',
          code_verifier: 'verifier-secret'
        }),
        { status: 200 }
      ),
      new Response(
        JSON.stringify({
          access_token: authorizedToken,
          refresh_token: 'refresh-secret',
          id_token: authorizedToken
        }),
        { status: 200 }
      ),
      new Response(JSON.stringify({ models: [] }), { status: 200 })
    ];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return responses.shift()!;
    });
    const credentials = service(
      fixture.database,
      request as typeof fetch,
      () => now,
      () => 'attempt-or-credential'
    );
    const actor = { userId: 1, sessionFingerprint: 'session-fingerprint' };

    const started = await credentials.startLogin(actor, {
      name: 'Team Codex',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    });
    expect(started).toMatchObject({
      id: 'attempt-or-credential',
      status: 'PENDING',
      userCode: 'ABCD-EFGH',
      pollIntervalMs: 5_000
    });
    expect(started).not.toHaveProperty('deviceAuthId');
    expect(JSON.stringify(fixture.document())).not.toContain('Team Codex');

    expect(await credentials.loginAttempt(actor, started.id)).toMatchObject({ status: 'PENDING' });
    now += 5_000;
    const completed = await credentials.loginAttempt(actor, started.id);

    expect(completed).toMatchObject({
      status: 'SUCCEEDED',
      credentialId: 'attempt-or-credential'
    });
    const persisted = JSON.stringify(fixture.document());
    expect(persisted).toContain('Team Codex');
    expect(persisted).not.toContain('imageModelId');
    expect(persisted).toContain('refresh-secret');
    expect(persisted).not.toContain('authorization-secret');
    expect(persisted).not.toContain('verifier-secret');
    expect(persisted).not.toContain('device-auth-secret');
    expect(persisted).not.toContain('custom');
    expect(persisted).not.toContain('fedramp');
    expect((await credentials.list(1))[0]).not.toHaveProperty('fedramp');
    const catalogHeaders = request.mock.calls[4]?.[1]?.headers as Record<string, string>;
    expect(catalogHeaders).not.toHaveProperty('X-OpenAI-Fedramp');
  });

  describe('standard device login attempt lifecycle', () => {
    const actor = { userId: 1, sessionFingerprint: 'owner-session' };
    const draft = {
      name: 'Team Codex',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    };
    const ttl = 15 * 60 * 1000;
    const deviceResponse = () =>
      new Response(
        JSON.stringify({ device_auth_id: 'device-secret', user_code: 'ABCD-EFGH', interval: 5 })
      );

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('releases all 128 slots at expiry without polling and keeps unexpired attempts limited', async () => {
      const request = vi.fn(async () => deviceResponse());
      let sequence = 0;
      const credentials = service(
        database().database,
        request as typeof fetch,
        Date.now,
        () => `attempt-${++sequence}`
      );
      const timers = vi.spyOn(globalThis, 'setTimeout');
      for (let index = 0; index < 128; index++) await credentials.startLogin(actor, draft);

      await vi.advanceTimersByTimeAsync(ttl - 1);
      await expect(credentials.startLogin(actor, draft)).rejects.toThrow(
        'CODEX_LOGIN_ATTEMPT_LIMIT_REACHED'
      );
      expect(request).toHaveBeenCalledTimes(128);

      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(credentials.startLogin(actor, draft)).resolves.toMatchObject({
        id: 'attempt-129',
        status: 'PENDING'
      });
      await expect(credentials.loginAttempt(actor, 'attempt-1')).rejects.toThrow(
        'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
      );
      expect(request).toHaveBeenCalledTimes(129);
      expect(vi.getTimerCount()).toBe(1);
      expect(timers).toHaveBeenCalledTimes(129);
      expect(timers.mock.results.every((result) => !result.value.hasRef())).toBe(true);
    });

    it.each([
      { stage: 'success', status: 'SUCCEEDED', code: undefined },
      { stage: 'poll failure', status: 'FAILED', code: 'CODEX_DEVICE_AUTH_FAILED' },
      { stage: 'malformed code', status: 'FAILED', code: 'CODEX_UPSTREAM_RESPONSE_INVALID' },
      { stage: 'token failure', status: 'FAILED', code: 'CODEX_TOKEN_EXCHANGE_FAILED' },
      { stage: 'catalog failure', status: 'FAILED', code: 'CODEX_CREDENTIAL_CHECK_FAILED' }
    ])('clears the expiry timer after $stage', async ({ stage, status, code }) => {
      const fixture = database();
      const authorizedToken = jwt({
        exp: Math.floor((NOW + 60 * 60 * 1000) / 1000),
        'https://api.openai.com/auth': { chatgpt_account_id: 'account-secret' }
      });
      const request = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/usercode')) return deviceResponse();
        if (String(url).endsWith('/deviceauth/token'))
          return new Response(
            JSON.stringify(
              stage === 'malformed code'
                ? {}
                : { authorization_code: 'authorization-secret', code_verifier: 'verifier-secret' }
            ),
            { status: stage === 'poll failure' ? 500 : 200 }
          );
        if (String(url).endsWith('/oauth/token'))
          return new Response(
            JSON.stringify({
              access_token: authorizedToken,
              refresh_token: 'refresh-secret',
              id_token: authorizedToken
            }),
            { status: stage === 'token failure' ? 400 : 200 }
          );
        return new Response(JSON.stringify({ models: [] }), {
          status: stage === 'catalog failure' ? 500 : 200
        });
      });
      const credentials = service(fixture.database, request as typeof fetch, Date.now);
      const attempt = await credentials.startLogin(actor, draft);
      expect(vi.getTimerCount()).toBe(1);

      const completed = await credentials.loginAttempt(actor, attempt.id);
      expect(completed).toMatchObject({ status, ...(code ? { code } : {}) });
      expect(vi.getTimerCount()).toBe(0);
      expect(await credentials.list(1)).toHaveLength(status === 'SUCCEEDED' ? 1 : 0);
      await expect(credentials.loginAttempt(actor, attempt.id)).rejects.toThrow(
        'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
      );
    });

    it('keeps ownership checks and clears only the cancelled attempt timer', async () => {
      const request = vi.fn(async () => deviceResponse());
      let sequence = 0;
      const credentials = service(
        database().database,
        request as typeof fetch,
        Date.now,
        () => `attempt-${++sequence}`
      );
      const first = await credentials.startLogin(actor, draft);
      const second = await credentials.startLogin(actor, draft);
      for (const other of [
        { ...actor, userId: 2 },
        { ...actor, sessionFingerprint: 'other-session' }
      ]) {
        await expect(credentials.loginAttempt(other, first.id)).rejects.toThrow(
          'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
        );
        await expect(credentials.cancelLogin(other, first.id)).rejects.toThrow(
          'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
        );
      }
      expect(vi.getTimerCount()).toBe(2);
      await credentials.cancelLogin(actor, first.id);
      expect(vi.getTimerCount()).toBe(1);
      await expect(credentials.loginAttempt(actor, first.id)).rejects.toThrow(
        'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
      );
      await credentials.cancelLogin(actor, second.id);
      expect(vi.getTimerCount()).toBe(0);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('clears the timer when polling observes expiry before the timer runs', async () => {
      const request = vi.fn(async () => deviceResponse());
      const credentials = service(database().database, request as typeof fetch, Date.now);
      const attempt = await credentials.startLogin(actor, draft);
      vi.setSystemTime(NOW + ttl);
      await expect(credentials.loginAttempt(actor, attempt.id)).resolves.toMatchObject({
        status: 'EXPIRED'
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(request).toHaveBeenCalledOnce();
    });

    it('clears outstanding standard attempt timers through the existing close lifecycle', async () => {
      const request = vi.fn(async () => deviceResponse());
      const credentials = service(database().database, request as typeof fetch, Date.now);
      const attempt = await credentials.startLogin(actor, draft);
      expect(vi.getTimerCount()).toBe(1);
      credentials.closeChatgptLogins();
      credentials.closeChatgptLogins();
      expect(vi.getTimerCount()).toBe(0);
      await expect(credentials.loginAttempt(actor, attempt.id)).rejects.toThrow(
        'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
      );
      expect(request).toHaveBeenCalledOnce();
    });
  });

  it('rejects a malformed SOCKS5 URL when starting login with a stable input error', async () => {
    const fixture = database();
    const request = vi.fn();
    const credentials = service(fixture.database, request as typeof fetch);
    const actor = { userId: 1, sessionFingerprint: 'session-fingerprint' };

    const rejection = await credentials
      .startLogin(actor, {
        name: 'Team Codex',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
        socks5Url: '%'
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(TypeError);
    expect(rejection).toMatchObject({ message: 'CODEX_CREDENTIAL_INPUT_INVALID' });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not recreate a credential deleted while its reauthentication attempt is pending', async () => {
    const fixture = database([activeCredential()]);
    const authorizedToken = jwt({
      exp: Math.floor((NOW + 60 * 60 * 1000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-secret',
        chatgpt_account_is_fedramp: false
      }
    });
    const responses = [
      new Response(
        JSON.stringify({
          device_auth_id: 'device-auth-secret',
          user_code: 'ABCD-EFGH',
          interval: '5'
        }),
        { status: 200 }
      ),
      new Response('', { status: 200 }),
      new Response(
        JSON.stringify({
          authorization_code: 'authorization-secret',
          code_verifier: 'verifier-secret'
        }),
        { status: 200 }
      ),
      new Response(
        JSON.stringify({
          access_token: authorizedToken,
          refresh_token: 'refresh-secret',
          id_token: authorizedToken
        }),
        { status: 200 }
      ),
      new Response(JSON.stringify({ models: [] }), { status: 200 })
    ];
    const request = vi.fn(async () => responses.shift()!);
    const credentials = service(
      fixture.database,
      request as typeof fetch,
      () => NOW,
      () => 'attempt-1'
    );
    const actor = { userId: 1, sessionFingerprint: 'session-fingerprint' };
    const attempt = await credentials.startLogin(actor, {
      name: 'Team Codex',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      targetCredentialId: 'credential-1'
    });

    await credentials.remove(1, 'credential-1');
    const completed = await credentials.loginAttempt(actor, attempt.id);

    expect(completed).toMatchObject({
      status: 'FAILED',
      code: 'CODEX_CREDENTIAL_NOT_FOUND'
    });
    expect(await credentials.list(1)).toEqual([]);
  });

  it('binds login attempts to the initiating admin session', async () => {
    const fixture = database();
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            device_auth_id: 'device-auth-secret',
            user_code: 'ABCD-EFGH',
            interval: '5'
          }),
          { status: 200 }
        )
    );
    const credentials = service(fixture.database, request as typeof fetch);
    const owner = { userId: 1, sessionFingerprint: 'owner-session' };
    const attempt = await credentials.startLogin(owner, {
      name: 'Team Codex',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    });

    await expect(
      credentials.loginAttempt({ userId: 1, sessionFingerprint: 'other-session' }, attempt.id)
    ).rejects.toThrow('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
    await credentials.cancelLogin(owner, attempt.id);
    await expect(credentials.loginAttempt(owner, attempt.id)).rejects.toThrow(
      'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
