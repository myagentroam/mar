import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_ISSUER,
  CHATGPT_JWKS_ENDPOINT,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_RESOURCE,
  CHATGPT_REVOKE_ENDPOINT,
  CHATGPT_TOKEN_ENDPOINT,
  type CodexCredentialOwnership
} from '@myagentroam/protocol';
import {
  CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS,
  CodexCredentialService
} from '../../src/codex-credential-service.js';
import type { CredentialScopePolicy } from '../../src/credential-scope-policy.js';

const NOW = 1_800_000_000_000;
const actor = { userId: 1, sessionFingerprint: 'authenticated-session' };
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' };
const services: CodexCredentialService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.closeChatgptLogins()));
});
function jwt(nonce?: string, overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
    'base64url'
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: CHATGPT_ISSUER,
      aud: 'issued-client',
      sub: 'verified-subject',
      exp: NOW / 1000 + 3600,
      iat: NOW / 1000,
      ...(nonce === undefined ? {} : { nonce }),
      ...overrides
    })
  ).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
function fixture(earliestRefreshAt?: number) {
  let now = NOW;
  let document: { version: number; credentials: Record<string, unknown>[] } = {
    version: 3,
    credentials: []
  };
  let canManage = true;
  const nonces = new Map<string, string>();
  let tokens = {
    access_token: 'fake-access',
    refresh_token: 'fake-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: `openid resource.invoke ${CHATGPT_PLAN_SCOPE}`,
    ...(earliestRefreshAt === undefined ? {} : { earliest_refresh_at: earliestRefreshAt })
  };
  let refreshResponse: Response | undefined;
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT setting_value'))
      return [[{ setting_value: JSON.stringify(document) }], []];
    if (sql.startsWith('INSERT INTO system_settings')) {
      document = JSON.parse(String(params[0]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes('AS credential_id')) return [[], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === CHATGPT_JWKS_ENDPOINT) return Response.json({ keys: [key] });
    if (url === CHATGPT_TOKEN_ENDPOINT)
      return (
        refreshResponse ??
        Response.json({
          ...tokens,
          access_token: 'renewed-access',
          refresh_token: 'rotated-refresh',
          id_token: jwt(undefined, { exp: now / 1000 + 3600 })
        })
      );
    if (url === `${CHATGPT_RESOURCE}/models?client_version=99.99.99`) {
      expect(new Headers(init?.headers).has('ChatGPT-Account-ID')).toBe(false);
      return Response.json({
        models: [
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
          {
            slug: 'eligible-model',
            display_name: 'Eligible model',
            visibility: 'list',
            context_window: 200_000,
            max_output_tokens: 32_000
          }
        ]
      });
    }
    if (url === CHATGPT_REVOKE_ENDPOINT) return new Response(null, { status: 200 });
    throw new Error(`Unexpected endpoint: ${url}`);
  });
  const policy: CredentialScopePolicy = {
    canActorManageOwnership: vi.fn(async () => canManage),
    assertActorCanSelectOwnership: vi.fn(async () => {
      if (!canManage) throw new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
    }),
    assertCredentialScopeChangeAllowed: vi.fn(async () => {}),
    assertUserInCredentialScope: vi.fn(async () => {}),
    assertModelCredentialBinding: vi.fn(async () => {})
  };
  const service = new CodexCredentialService(
    { raw: { execute } as unknown as Pool },
    {
      request: request as typeof fetch,
      now: () => now,
      id: randomUUID,
      createScopePolicy: () => policy
    }
  );
  services.push(service);
  const node = vi.fn(async (_actor: unknown, nodeId: string, operation: string, raw: unknown) => {
    expect(nodeId).toBe('local-node');
    if (operation === 'chatgpt.login.start') {
      nonces.set((raw as { attemptId: string }).attemptId, (raw as { nonce: string }).nonce);
      return {
        status: 'PENDING',
        verificationUri: 'http://127.0.0.1:1455/auth/start?ticket=fake',
        expiresAt: now + 600_000
      };
    }
    if (operation === 'chatgpt.login.status')
      return {
        status: 'SUCCEEDED',
        result: {
          attemptId: (raw as { attemptId: string }).attemptId,
          clientId: 'issued-client',
          hostId: 'urn:uuid:test-host',
          tokens: { ...tokens, id_token: jwt(nonces.get((raw as { attemptId: string }).attemptId)) }
        }
      };
    if (operation === 'chatgpt.login.ack' || operation === 'chatgpt.login.cancel')
      return { acknowledged: true };
    throw new Error('Unexpected Node operation');
  });
  service.configureChatgptLogin(node);
  async function login(
    ownership: CodexCredentialOwnership = { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
  ) {
    const attempt = await service.startLogin(actor, {
      type: 'CHATGPT_OAUTH',
      nodeId: 'local-node',
      name: 'ChatGPT',
      ownership
    });
    return { attempt, result: await service.loginAttempt(actor, attempt.id) };
  }
  return {
    service,
    request,
    node,
    execute,
    policy,
    login,
    document: () => document,
    setNow: (value: number) => {
      now = value;
    },
    setManage: (value: boolean) => {
      canManage = value;
    },
    setScope: (value: string) => {
      tokens = { ...tokens, scope: value };
    },
    setRefresh: (value: Response) => {
      refreshResponse = value;
    }
  };
}

describe('Server-managed ChatGPT OAuth credentials', () => {
  it('rechecks name uniqueness at commit across concurrent login attempts', async () => {
    const f = fixture();
    const draft = {
      type: 'CHATGPT_OAUTH',
      nodeId: 'local-node',
      name: 'Same name',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    };
    const first = await f.service.startLogin(actor, draft);
    const second = await f.service.startLogin(actor, draft);
    expect(await f.service.loginAttempt(actor, first.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await f.service.loginAttempt(actor, second.id)).toMatchObject({
      status: 'FAILED',
      code: 'CODEX_CREDENTIAL_NAME_CONFLICT'
    });
    expect(f.document().credentials).toHaveLength(1);
  });

  it('refuses a save if the authenticated session is revoked during login', async () => {
    const f = fixture();
    const pending = await f.service.startLogin(actor, {
      type: 'CHATGPT_OAUTH',
      nodeId: 'local-node',
      name: 'ChatGPT',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    });
    const checkSession = vi.fn(() => {
      throw new Error('CHATGPT_LOGIN_FORBIDDEN');
    });
    expect(await f.service.loginAttempt(actor, pending.id, checkSession)).toMatchObject({
      status: 'FAILED',
      code: 'CHATGPT_LOGIN_FORBIDDEN'
    });
    expect(checkSession).toHaveBeenCalled();
    expect(f.document().credentials).toHaveLength(0);
  });

  it.each([
    { ownerType: 'PERSONAL', ownerUserId: 1 },
    { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 },
    { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
  ] as const)(
    'persists $ownerType with the existing scope policy and hides tokens',
    async (ownership) => {
      const f = fixture();
      const { attempt, result } = await f.login(ownership);
      expect(attempt).toMatchObject({ type: 'CHATGPT_OAUTH', status: 'PENDING' });
      expect(JSON.stringify(attempt)).not.toContain('fake-refresh');
      expect(result).toMatchObject({ status: 'SUCCEEDED' });
      const details = await f.service.details(1, result.credentialId!);
      expect(details.credential).toMatchObject({
        type: 'CHATGPT_OAUTH',
        ownership,
        authorization: 'AUTHORIZED',
        accountId: 'verified-subject'
      });
      expect(JSON.stringify(details)).not.toMatch(/fake-access|fake-refresh|idToken/);
      const stored = f.document().credentials[0]!;
      expect(stored.refreshToken).toBe('fake-refresh');
      expect(stored.chatgpt).toMatchObject({
        clientId: 'issued-client',
        subject: 'verified-subject'
      });
      const operations = f.node.mock.calls.length;
      expect(await f.service.loginAttempt(actor, attempt.id)).toEqual(result);
      expect(f.node.mock.calls.length).toBe(operations);
      expect(f.node.mock.calls.filter((call) => call[2] === 'chatgpt.login.ack')).toHaveLength(1);
    }
  );

  it('honors the shorter Node deadline and never saves a late result', async () => {
    const f = fixture();
    const pending = await f.service.startLogin(actor, {
      type: 'CHATGPT_OAUTH',
      nodeId: 'local-node',
      name: 'ChatGPT',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    });
    f.setNow(pending.expiresAt!);
    expect(await f.service.loginAttempt(actor, pending.id)).toMatchObject({ status: 'EXPIRED' });
    expect(f.document().credentials).toEqual([]);
    expect(f.node.mock.calls.some((call) => call[2] === 'chatgpt.login.status')).toBe(false);
  });
  it('retains a verified registration as unauthorized and forbids model use', async () => {
    const f = fixture();
    f.setScope('openid profile email');
    const { result } = await f.login();
    expect(result).toMatchObject({ status: 'SUCCEEDED' });
    const id = result.credentialId!;
    await expect(f.service.credentialTarget(1, id)).rejects.toThrow('CHATGPT_PLAN_UNAUTHORIZED');
    await expect(f.service.assertCredentialTarget(1, id, CHATGPT_RESOURCE)).rejects.toThrow(
      'CHATGPT_PLAN_UNAUTHORIZED'
    );
    expect((await f.service.details(1, id)).credential.authorization).toBe('UNAUTHORIZED');
    await expect(f.service.assertUserInScope(1, id)).rejects.toThrow('CHATGPT_PLAN_UNAUTHORIZED');
    await expect(f.service.loadCatalog(1, id)).rejects.toThrow('CHATGPT_PLAN_UNAUTHORIZED');
    await expect(f.service.resolve(id, 'RUNTIME')).rejects.toThrow('CHATGPT_PLAN_UNAUTHORIZED');
    expect(f.request.mock.calls.map((call) => String(call[0]).split('?')[0])).not.toContain(
      `${CHATGPT_RESOURCE}/models`
    );
  });

  it('uses the public catalog and rejects incompatible bindings', async () => {
    const f = fixture();
    const { result } = await f.login();
    const id = result.credentialId!;
    const catalog = await f.service.loadCatalog(1, id);
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      upstreamModelId: 'eligible-model',
      displayName: 'Eligible model',
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      requiredInputs: []
    });
    expect(await f.service.credentialTarget(1, id)).toBe(CHATGPT_RESOURCE);
    await expect(
      f.service.assertCredentialTarget(1, id, CHATGPT_RESOURCE, false)
    ).resolves.toBeUndefined();
    await expect(
      f.service.assertCredentialTarget(1, id, 'https://chatgpt.com/backend-api/codex')
    ).rejects.toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    await expect(
      f.service.assertCredentialTarget(1, id, CHATGPT_RESOURCE, true)
    ).resolves.toBeUndefined();
    expect((await f.service.resolve(id, 'RUNTIME')).headers).toEqual({});
    await expect(f.service.usage(1, id)).rejects.toThrow('CHATGPT_USAGE_UNAVAILABLE');
  });

  it('requests the full public catalog without relaxing model eligibility filters', async () => {
    const f = fixture();
    const { result } = await f.login();
    f.request.mockImplementationOnce(async (input) => {
      expect(String(input)).toBe(`${CHATGPT_RESOURCE}/models?client_version=99.99.99`);
      return Response.json({
        models: [
          {
            slug: 'gpt-6.1-sol',
            display_name: 'GPT-6.1-Sol',
            visibility: 'list',
            supported_in_api: true,
            context_window: 272_000
          },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
          {
            slug: 'unsupported-model',
            display_name: 'Unsupported',
            visibility: 'list',
            supported_in_api: false
          }
        ]
      });
    });
    const catalog = await f.service.loadCatalog(1, result.credentialId!);
    expect(catalog.models.map((model) => model.upstreamModelId)).toEqual(['gpt-6.1-sol']);
  });

  it('defers automatic rotation but allows manual refresh before the advisory time', async () => {
    const earliest = NOW + 3_500_000;
    const f = fixture(earliest / 1000);
    const { result } = await f.login();
    const id = result.credentialId!;
    const initial = (await f.service.details(1, id)).credential;
    expect(initial).toMatchObject({
      accessTokenExpiresAt: NOW + 3_600_000,
      earliestRefreshAt: earliest,
      lastRefreshAt: NOW
    });

    f.setNow(earliest - 1);
    await f.service.resolve(id, 'RUNTIME');
    expect((await f.service.details(1, id)).credential).toEqual(initial);
    expect(
      f.request.mock.calls.filter((call) => String(call[0]) === CHATGPT_TOKEN_ENDPOINT)
    ).toHaveLength(0);

    const refreshedAt = earliest - 1;
    f.setRefresh(
      Response.json({
        access_token: 'renewed-access',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: `openid resource.invoke ${CHATGPT_PLAN_SCOPE}`,
        earliest_refresh_at: (earliest + 3_240_000) / 1000,
        id_token: jwt(undefined, { exp: (earliest + 3_600_000) / 1000 })
      })
    );
    expect(await f.service.refresh(1, id)).toMatchObject({
      accessTokenExpiresAt: refreshedAt + 3_600_000,
      earliestRefreshAt: earliest + 3_240_000,
      lastRefreshAt: refreshedAt
    });
    const runtime = await f.service.resolve(id, 'RUNTIME');
    expect(runtime.bearer).toBe('renewed-access');
    expect(JSON.stringify(runtime)).not.toContain('rotated-refresh');
    expect(f.document().credentials[0]).toMatchObject({
      accessToken: 'renewed-access',
      refreshToken: 'rotated-refresh'
    });
  });

  it('manually rotates a fresh access token without waiting for its expiry window', async () => {
    const f = fixture((NOW + 3_500_000) / 1000);
    const { result } = await f.login();
    f.setNow(NOW + 60_000);
    expect(await f.service.refresh(1, result.credentialId!)).toMatchObject({
      accessTokenExpiresAt: NOW + 60_000 + 3_600_000,
      lastRefreshAt: NOW + 60_000
    });
    expect(f.document().credentials[0]).toMatchObject({
      accessToken: 'renewed-access',
      refreshToken: 'rotated-refresh'
    });
  });

  it('renews an idle authorized credential before access expiry during background maintenance', async () => {
    const f = fixture((NOW + 3_240_000) / 1000);
    await f.login();
    expect(CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS).toBeLessThan(5 * 60 * 1000);
    f.setNow(NOW + 3_300_000);
    expect(await f.service.maintain('EXPIRING')).toMatchObject({ attempted: 1, failed: 0 });
    expect(f.document().credentials[0]).toMatchObject({
      accessToken: 'renewed-access',
      refreshToken: 'rotated-refresh',
      accessTokenExpiresAt: NOW + 3_300_000 + 3_600_000,
      lastRefreshAt: NOW + 3_300_000
    });
  });

  it('single-flights concurrent consumers and atomically rotates the refresh token', async () => {
    const f = fixture();
    const { result } = await f.login();
    const id = result.credentialId!;
    f.setNow(NOW + 3_500_000);
    const values = await Promise.all(
      Array.from({ length: 8 }, () => f.service.resolve(id, 'RUNTIME'))
    );
    expect(values.every((value) => value.bearer === 'renewed-access')).toBe(true);
    const refreshCalls = f.request.mock.calls.filter(
      (call) => String(call[0]) === CHATGPT_TOKEN_ENDPOINT
    );
    expect(refreshCalls).toHaveLength(1);
    const body = new URLSearchParams(String(refreshCalls[0]![1]!.body));
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: 'refresh_token',
      client_id: 'issued-client',
      refresh_token: 'fake-refresh',
      resource: CHATGPT_RESOURCE
    });
    expect(f.document().credentials[0]).toMatchObject({
      refreshToken: 'rotated-refresh',
      accessToken: 'renewed-access',
      accessTokenExpiresAt: NOW + 3_500_000 + 3_600_000
    });
  });

  it('marks permanent refresh failure as requiring sign-in without overwriting tokens', async () => {
    const f = fixture();
    const { result } = await f.login();
    f.setRefresh(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await expect(f.service.refresh(1, result.credentialId!)).rejects.toThrow(
      'CODEX_CREDENTIAL_REAUTH_REQUIRED'
    );
    expect(f.document().credentials[0]).toMatchObject({
      status: 'REAUTH_REQUIRED',
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh'
    });
  });

  it('rechecks management permission before accepting a Node result', async () => {
    const f = fixture();
    const attempt = await f.service.startLogin(actor, {
      type: 'CHATGPT_OAUTH',
      nodeId: 'local-node',
      name: 'ChatGPT',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    });
    await expect(
      f.service.loginAttempt({ ...actor, sessionFingerprint: 'other-session' }, attempt.id)
    ).rejects.toThrow('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
    f.setManage(false);
    await expect(f.service.loginAttempt(actor, attempt.id)).rejects.toThrow(
      'CODEX_CREDENTIAL_SCOPE_FORBIDDEN'
    );
    expect(f.document().credentials).toEqual([]);
  });

  it('does not accept a Node claim of success with an invalid ID token', async () => {
    const f = fixture();
    const attempt = await f.service.startLogin(actor, {
      type: 'CHATGPT_OAUTH',
      nodeId: 'local-node',
      name: 'ChatGPT',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    });
    f.node.mockImplementationOnce(async () => ({
      status: 'SUCCEEDED',
      result: {
        attemptId: attempt.id,
        clientId: 'issued-client',
        hostId: 'urn:uuid:test-host',
        tokens: {
          access_token: 'forged-access',
          refresh_token: 'forged-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: CHATGPT_PLAN_SCOPE,
          id_token: jwt('wrong-nonce')
        }
      }
    }));
    expect(await f.service.loginAttempt(actor, attempt.id)).toMatchObject({
      status: 'FAILED',
      code: 'CHATGPT_IDENTITY_INVALID'
    });
    expect(f.document().credentials).toEqual([]);
  });

  it('preserves the prior credential when a cancelled relogin arrives late', async () => {
    const f = fixture();
    const { result } = await f.login();
    const before = structuredClone(f.document());
    const attempt = await f.service.startLogin(actor, {
      type: 'CHATGPT_OAUTH',
      nodeId: 'local-node',
      name: 'ChatGPT',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      targetCredentialId: result.credentialId
    });
    await f.service.cancelLogin(actor, attempt.id);
    await expect(f.service.loginAttempt(actor, attempt.id)).rejects.toThrow(
      'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
    );
    expect(f.document()).toEqual(before);
  });

  it('revokes using the issued client ID rather than the legacy Codex client ID', async () => {
    const f = fixture();
    const { result } = await f.login();
    await f.service.remove(1, result.credentialId!);
    const revoke = f.request.mock.calls.find(
      (call) => String(call[0]) === CHATGPT_REVOKE_ENDPOINT
    )!;
    expect(new URLSearchParams(String(revoke[1]!.body)).get('client_id')).toBe('issued-client');
    expect(f.document().credentials).toEqual([]);
  });
});
