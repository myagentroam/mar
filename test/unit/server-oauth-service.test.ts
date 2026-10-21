import { describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import type { LicenseService } from '../../ee/server/src/license/license-service.js';
import { OAuthService } from '../../ee/server/src/oauth/oauth-service.js';

describe('Server OAuth 2.0 multi-provider SSO', () => {
  it('keeps provider keys stable and never returns the client secret', async () => {
    const fixture = oauthFixture();
    const provider = await fixture.service().create(1, {
      providerKey: 'feishu',
      name: 'Feishu',
      clientId: 'client',
      clientSecret: 'top-secret',
      authorizationEndpoint: 'https://login.example/authorize',
      tokenEndpoint: 'https://login.example/token',
      userinfoEndpoint: 'https://login.example/userinfo',
      scopes: ['profile'],
      pkceMode: 'REQUIRED',
      tokenAuthMethod: 'client_secret_basic',
      autoProvisioningEnabled: false,
      mappings: {
        externalUserId: '/data/0/user~1id'
      }
    });
    expect(fixture.createdSecret).toBe('top-secret');
    expect(fixture.connectionSql[0]).toBe('SELECT id FROM organizations WHERE id=? FOR SHARE');
    expect(fixture.connectionSql[1]).toContain('INSERT INTO oauth_providers');
    expect(provider).not.toHaveProperty('clientSecret');
    await expect(
      fixture.service().update(1, 'github', {
        providerKey: 'feishu',
        name: 'Feishu',
        clientId: 'client',
        authorizationEndpoint: 'https://login.example/authorize',
        tokenEndpoint: 'https://login.example/token',
        userinfoEndpoint: 'https://login.example/userinfo',
        scopes: ['profile'],
        pkceMode: 'REQUIRED',
        tokenAuthMethod: 'client_secret_basic',
        autoProvisioningEnabled: false,
        mappings: {
          externalUserId: '/data/0/user~1id'
        }
      })
    ).rejects.toThrow('OAUTH_PROVIDER_KEY_IMMUTABLE');
  });

  it('binds one-time state to provider/browser and emits PKCE authorization URL', async () => {
    const fixture = oauthFixture();
    const service = fixture.service();
    const flow = await service.begin('feishu', 'https://mar.example/oauth/feishu/callback');
    const url = new URL(flow.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://login.example/authorize');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(fixture.transaction).toMatchObject({
      providerId: 'feishu',
      browserFlowId: flow.browserFlowId
    });
    expect(fixture.transaction?.stateHash).not.toBe(url.searchParams.get('state'));

    await expect(
      service.callback({
        providerKey: 'github',
        state: url.searchParams.get('state')!,
        code: 'code',
        browserFlowId: flow.browserFlowId,
        redirectUri: 'https://mar.example/oauth/github/callback'
      })
    ).rejects.toThrow('OAUTH_STATE_INVALID');
  });

  it('uses provider-prefixed external identity and permits frozen login only when bound', async () => {
    const fixture = oauthFixture();
    const service = fixture.service();
    const flow = await service.begin('feishu', 'https://mar.example/oauth/feishu/callback');
    const state = new URL(flow.authorizationUrl).searchParams.get('state')!;
    fixture.boundUserId = 9;
    fixture.licenseState = 'ENTERPRISE_FROZEN';
    await expect(
      service.callback({
        providerKey: 'feishu',
        state,
        code: 'code',
        browserFlowId: flow.browserFlowId,
        redirectUri: 'https://mar.example/oauth/feishu/callback'
      })
    ).resolves.toEqual({ userId: 9, flowType: 'LOGIN' });
    expect(fixture.identityLookup).toEqual(['feishu', 'feishu_xxxx']);

    const unbound = oauthFixture();
    const unboundService = unbound.service();
    const unboundFlow = await unboundService.begin(
      'feishu',
      'https://mar.example/oauth/feishu/callback'
    );
    unbound.licenseState = 'ENTERPRISE_FROZEN';
    await expect(
      unboundService.callback({
        providerKey: 'feishu',
        state: new URL(unboundFlow.authorizationUrl).searchParams.get('state')!,
        code: 'code',
        browserFlowId: unboundFlow.browserFlowId,
        redirectUri: 'https://mar.example/oauth/feishu/callback'
      })
    ).rejects.toThrow('OAUTH_ACCOUNT_BINDING_FROZEN');
  });

  it('defaults automatic provisioning off and creates enabled accounts as root MEMBER', async () => {
    const disabled = oauthFixture();
    const disabledService = disabled.service();
    const disabledFlow = await disabledService.begin(
      'feishu',
      'https://mar.example/oauth/feishu/callback'
    );
    await expect(
      disabledService.callback({
        providerKey: 'feishu',
        state: new URL(disabledFlow.authorizationUrl).searchParams.get('state')!,
        code: 'code',
        browserFlowId: disabledFlow.browserFlowId,
        redirectUri: 'https://mar.example/oauth/feishu/callback'
      })
    ).rejects.toThrow('OAUTH_ACCOUNT_NOT_BOUND');

    const enabled = oauthFixture(true);
    const enabledService = enabled.service();
    const enabledFlow = await enabledService.begin(
      'feishu',
      'https://mar.example/oauth/feishu/callback'
    );
    await expect(
      enabledService.callback({
        providerKey: 'feishu',
        state: new URL(enabledFlow.authorizationUrl).searchParams.get('state')!,
        code: 'code',
        browserFlowId: enabledFlow.browserFlowId,
        redirectUri: 'https://mar.example/oauth/feishu/callback'
      })
    ).resolves.toEqual({ userId: 10, flowType: 'LOGIN' });
    expect(enabled.createdUser).toMatchObject({
      role: 'MEMBER',
      organizationId: 1,
      nickname: '飞书用户'
    });
  });

  it('supports client_secret_post without placing the secret in an Authorization header', async () => {
    const fixture = oauthFixture(false, 'client_secret_post');
    fixture.boundUserId = 9;
    const service = fixture.service();
    const flow = await service.begin('feishu', 'https://mar.example/oauth/feishu/callback');
    await service.callback({
      providerKey: 'feishu',
      state: new URL(flow.authorizationUrl).searchParams.get('state')!,
      code: 'code',
      browserFlowId: flow.browserFlowId,
      redirectUri: 'https://mar.example/oauth/feishu/callback'
    });
    const request = fixture.fetchMock.mock.calls[0]?.[1];
    expect(request?.headers).not.toHaveProperty('authorization');
    expect(String(request?.body)).toContain('client_secret=secret');
  });

  it('binds an enabled provider to the authenticated account without creating a user', async () => {
    const fixture = oauthFixture(false, 'client_secret_json');
    const service = fixture.service();
    const flow = await service.begin('feishu', 'https://mar.example/oauth/feishu/callback', 7);
    await expect(
      service.callback({
        providerKey: 'feishu',
        state: new URL(flow.authorizationUrl).searchParams.get('state')!,
        code: 'code',
        browserFlowId: flow.browserFlowId,
        redirectUri: 'https://mar.example/oauth/feishu/callback'
      })
    ).resolves.toEqual({ userId: 7, flowType: 'BIND' });
    expect(fixture.createdUser).toBeUndefined();
    expect(fixture.fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'content-type': 'application/json'
    });
    expect(String(fixture.fetchMock.mock.calls[0]?.[1]?.body)).toContain(
      '"client_secret":"secret"'
    );
    expect(String(fixture.fetchMock.mock.calls[1]?.[0])).toContain('/userinfo');
    expect(fixture.fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer token'
    });
  });

  it('only marks a provider tested after reachable authorization and OAuth JSON token responses', async () => {
    const fixture = oauthFixture();
    const service = fixture.service();
    await expect(service.test(1, 'feishu')).resolves.toBeUndefined();
    expect(fixture.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'oauth_provider.tested',
        actorUserId: 1,
        targetName: 'Feishu'
      })
    );
    expect(fixture.fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fixture.fetchMock.mock.calls[0]?.[0])).toContain('/authorize');
    expect(String(fixture.fetchMock.mock.calls[1]?.[0])).toContain('/token');
    expect(String(fixture.fetchMock.mock.calls[1]?.[1]?.body)).toContain(
      'grant_type=authorization_code'
    );
    expect(String(fixture.fetchMock.mock.calls[2]?.[0])).toContain('/userinfo');

    const unavailable = oauthFixture();
    unavailable.fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(unavailable.service().test(1, 'feishu')).rejects.toThrow(
      'OAUTH_AUTHORIZATION_ENDPOINT_UNAVAILABLE'
    );

    const providerError = oauthFixture();
    providerError.fetchMock
      .mockResolvedValueOnce(new Response('', { status: 302 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 20029, msg: 'invalid code' }), { status: 400 })
      );
    await expect(providerError.service().test(1, 'feishu')).resolves.toBeUndefined();
  });

  it('removes a damaged provider without parsing configuration just for its audit snapshot', async () => {
    const fixture = oauthFixture();
    fixture.provider.configuration = '{invalid JSON';
    await expect(fixture.service().remove(1, 'feishu')).resolves.toBeUndefined();
    expect(fixture.cleanup).toEqual({ transactions: true, identities: true });
    expect(fixture.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'oauth_provider.deleted',
        actorUserId: 1,
        targetName: 'Feishu'
      })
    );
    expect(fixture.connection.rollback).not.toHaveBeenCalled();
  });

  it('locks the provider and explicitly removes transactions and identities before deleting it', async () => {
    const fixture = oauthFixture();

    await fixture.service().remove(1, 'feishu');

    expect(fixture.cleanup).toEqual({ transactions: true, identities: true });
    expect(fixture.connectionSql.slice(0, 4)).toEqual([
      'SELECT id,name FROM oauth_providers WHERE id=? FOR UPDATE',
      'DELETE FROM oauth_transactions WHERE provider_id=?',
      'DELETE FROM external_identities WHERE provider_id=?',
      'DELETE FROM oauth_providers WHERE id=?'
    ]);
    expect(fixture.connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(fixture.connection.commit).toHaveBeenCalledTimes(1);
  });

  it('keeps provider and user parent checks inside identity binding transactions', async () => {
    const fixture = oauthFixture(false, 'client_secret_json');
    const flow = await fixture
      .service()
      .begin('feishu', 'https://mar.example/oauth/feishu/callback', 7);

    await fixture.service().callback({
      providerKey: 'feishu',
      state: new URL(flow.authorizationUrl).searchParams.get('state')!,
      code: 'code',
      browserFlowId: flow.browserFlowId,
      redirectUri: 'https://mar.example/oauth/feishu/callback'
    });

    expect(fixture.connectionSql).toContain(
      'SELECT id,name FROM oauth_providers WHERE id=? FOR SHARE'
    );
    expect(
      fixture.connectionSql.filter(
        (sql) => sql.startsWith('SELECT * FROM oauth_providers') && sql.endsWith('FOR SHARE')
      )
    ).toHaveLength(2);
    expect(fixture.connectionSql).toContain(
      'SELECT id FROM users WHERE id IN (?) ORDER BY id FOR SHARE'
    );
    expect(fixture.insertedIdentity).toEqual(['feishu', 'feishu_xxxx', 7]);
  });
});

function oauthFixture(
  autoProvisioningEnabled = false,
  tokenAuthMethod:
    'client_secret_basic' | 'client_secret_post' | 'client_secret_json' = 'client_secret_basic'
) {
  const fixture: {
    transaction:
      | {
          stateHash: string;
          providerId: string;
          browserFlowId: string;
          verifier: string | null;
          expiresAt: number;
        }
      | undefined;
    boundUserId?: number;
    identityLookup: readonly unknown[] | undefined;
    insertedIdentity: readonly unknown[] | undefined;
    createdSecret: string | undefined;
    createdUser: { role: string; organizationId: number; nickname: string | null } | undefined;
    licenseState: 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';
    cleanup: { transactions: boolean; identities: boolean };
  } = {
    transaction: undefined,
    identityLookup: undefined,
    insertedIdentity: undefined,
    createdSecret: undefined,
    createdUser: undefined,
    licenseState: 'ENTERPRISE_VALID',
    cleanup: { transactions: false, identities: false }
  };
  const provider = {
    id: 'feishu',
    name: 'Feishu',
    client_id: 'client',
    client_secret: 'secret',
    authorization_endpoint: 'https://login.example/authorize',
    token_endpoint: 'https://login.example/token',
    userinfo_endpoint: 'https://login.example/userinfo',
    default_organization_id: 1,
    enabled: 1,
    tested_at: 1,
    configuration: JSON.stringify({
      scopes: ['profile'],
      pkceMode: 'REQUIRED',
      tokenAuthMethod,
      autoProvisioningEnabled,
      mappings: {
        externalUserId: '/data/0/user~1id',
        displayName: '/data/0/name'
      }
    })
  };
  const connectionSql: string[] = [];
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      connectionSql.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.startsWith('SELECT id,name FROM oauth_providers')) return [[provider], []];
      if (sql.startsWith('SELECT * FROM oauth_providers')) return [[provider], []];
      if (sql.startsWith('SELECT provider_id FROM oauth_transactions'))
        return [
          fixture.transaction === undefined
            ? []
            : [{ provider_id: fixture.transaction.providerId }],
          []
        ];
      if (sql.includes('SELECT provider_id,browser_flow_id'))
        return [
          fixture.transaction === undefined
            ? []
            : [
                {
                  provider_id: fixture.transaction.providerId,
                  browser_flow_id: fixture.transaction.browserFlowId,
                  pkce_verifier: fixture.transaction.verifier,
                  expires_at: fixture.transaction.expiresAt
                }
              ],
          []
        ];
      if (sql.startsWith('DELETE FROM oauth_transactions')) {
        fixture.transaction = undefined;
        if (sql.includes('provider_id')) fixture.cleanup.transactions = true;
      }
      if (sql.startsWith('DELETE FROM external_identities WHERE provider_id=?'))
        fixture.cleanup.identities = true;
      if (sql.startsWith('DELETE FROM oauth_providers')) return [{ affectedRows: 1 }, []];
      if (sql.startsWith('INSERT INTO oauth_providers')) {
        fixture.createdSecret = String(params?.[3]);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('SELECT id FROM organizations')) return [[{ id: 1 }], []];
      if (sql.startsWith('SELECT id FROM users WHERE id IN'))
        return [[{ id: Number(params?.[0]) }], []];
      if (sql.startsWith('SELECT id FROM users WHERE username=')) return [[], []];
      if (sql.startsWith('SELECT id FROM users WHERE email=')) return [[], []];
      if (sql.startsWith('INSERT INTO oauth_transactions')) {
        fixture.transaction = {
          stateHash: String(params?.[0]),
          providerId: String(params?.[1]),
          browserFlowId: String(params?.[2]),
          verifier: params?.[3] === null ? null : String(params?.[3]),
          expiresAt: Number(params?.[5])
        };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('INSERT INTO users')) {
        fixture.createdUser = {
          role: 'MEMBER',
          organizationId: Number(params?.[3]),
          nickname: params?.[2] === null ? null : String(params?.[2])
        };
        return [{ affectedRows: 1, insertId: 10 }, []];
      }
      if (sql.includes('FROM external_identities') && sql.includes('JOIN users')) {
        fixture.identityLookup = params;
        return [fixture.boundUserId === undefined ? [] : [{ user_id: fixture.boundUserId }], []];
      }
      if (sql.startsWith('SELECT external_user_id FROM external_identities')) return [[], []];
      if (sql.startsWith('INSERT INTO external_identities')) {
        fixture.insertedIdentity = [params?.[0], params?.[1], params?.[2]];
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 1 }, []];
    })
  };
  const raw = {
    getConnection: vi.fn(async () => connection),
    execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.startsWith('SELECT * FROM oauth_providers')) return [[provider], []];
      if (sql.startsWith('SELECT id,name,client_id')) return [[provider], []];
      if (sql.startsWith('INSERT INTO oauth_providers')) {
        fixture.createdSecret = String(params?.[3]);
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 1 }, []];
    })
  };
  const audit = vi.fn(async (_event: unknown) => undefined);
  const database = { raw, audit } as unknown as MysqlServerDatabase;
  const authorization = {
    authorize: vi.fn(async () => ({ allowed: true }))
  } as unknown as AuthorizationService;
  const licenses = {
    status: vi.fn(async () => ({
      edition: 'ENTERPRISE',
      state: fixture.licenseState
    }))
  } as unknown as LicenseService;
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    void _url;
    void _init;
    return new Response(
      JSON.stringify({ access_token: 'token', data: [{ 'user/id': 'xxxx', name: '飞书用户' }] }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    );
  });
  return Object.assign(fixture, {
    connection,
    connectionSql,
    provider,
    audit,
    fetchMock: fetchImpl,
    service: () =>
      new OAuthService(database, authorization, licenses, fetchImpl as typeof fetch, () => 1_000)
  });
}
