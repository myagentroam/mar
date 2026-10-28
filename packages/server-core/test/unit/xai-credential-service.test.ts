import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XAI_SUBSCRIPTION_BASE_URL, XAI_SUBSCRIPTION_PROXY_BASE_URL } from '@myagentroam/protocol';
import { CodexCredentialService } from '../../src/codex-credential-service.js';
import type { CredentialScopePolicy } from '../../src/credential-scope-policy.js';
import { CredentialDocumentStore } from '../../src/credential-document-store.js';
import { normalizeXaiCatalog, normalizeXaiUsage } from '../../src/xai-oauth-provider.js';
import { startSocks5Proxy } from '../support/socks5-proxy.js';

const NOW = 1_800_000_000_000;
const actor = { userId: 1, sessionFingerprint: 'session' };
const services: CodexCredentialService[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.closeChatgptLogins());
});

function fixture(proxy = false) {
  let now = NOW;
  let document: { version: number; credentials: Record<string, unknown>[] } = {
    version: 3,
    credentials: []
  };
  const tokens = {
    access_token: 'access-private',
    refresh_token: 'refresh-private',
    token_type: 'Bearer',
    expires_in: 3600
  };
  const device = {
    device_code: 'device-private',
    user_code: 'CODE-123',
    verification_uri: 'https://accounts.x.ai/device',
    expires_in: 600,
    interval: 5
  };
  const routes = new Map<string, (init?: RequestInit) => Response | Promise<Response>>();
  routes.set('https://auth.x.ai/oauth2/device/code', () => Response.json(device));
  routes.set('https://auth.x.ai/oauth2/token', () => Response.json(tokens));
  routes.set('https://auth.x.ai/oauth2/userinfo', () => Response.json({ sub: 'subject' }));
  routes.set(`${XAI_SUBSCRIPTION_PROXY_BASE_URL}/user`, () => Response.json({ userId: 'account' }));
  routes.set(`${XAI_SUBSCRIPTION_PROXY_BASE_URL}/models`, () =>
    Response.json({ data: [{ id: 'grok-test', context_window: 200_000 }] })
  );
  routes.set(`${XAI_SUBSCRIPTION_PROXY_BASE_URL}/billing?format=credits`, () =>
    Response.json({
      config: {
        creditUsagePercent: 25,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2027-01-15T08:00:00Z',
          end: '2027-01-22T08:00:00Z'
        },
        prepaidBalance: { val: 1446 }
      }
    })
  );
  routes.set('https://auth.x.ai/oauth2/revoke', () => new Response(null, { status: 200 }));
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(Boolean((init as RequestInit & { dispatcher?: unknown }).dispatcher)).toBe(proxy);
    const handler = routes.get(String(input));
    if (!handler) throw new Error('Unexpected test endpoint');
    return handler(init);
  });
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT setting_value'))
      return [[{ setting_value: JSON.stringify(document) }], []];
    if (sql.startsWith('INSERT INTO system_settings')) {
      document = JSON.parse(String(params[0]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes('AS credential_id')) return [[], []];
    throw new Error('Unexpected fixture SQL');
  });
  const policy: CredentialScopePolicy = {
    canActorManageOwnership: vi.fn(async () => true),
    assertActorCanSelectOwnership: vi.fn(async () => {}),
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
      scopePolicy: policy,
      documentStore: new CredentialDocumentStore({ execute } as unknown as Pool, () => now),
      projectVersion: '0.10.9'
    }
  );
  services.push(service);
  const draft = {
    type: 'XAI_OAUTH',
    name: 'Grok',
    ownership: { ownerType: 'PERSONAL' },
    ...(proxy ? { socks5Url: 'socks5://proxy-user:proxy-password@127.0.0.1:1080' } : {})
  };
  return {
    service,
    request,
    routes,
    tokens,
    device,
    policy,
    draft,
    document: () => document,
    advance: (ms: number) => {
      now += ms;
    },
    login: async () => {
      const attempt = await service.startLogin(actor, draft);
      now += 5000;
      const result = await service.loginAttempt(actor, attempt.id);
      expect(result.status).toBe('SUCCEEDED');
      return result.credentialId!;
    }
  };
}

describe('Grok subscription credential lifecycle', () => {
  it('carries the complete device and quota lifecycle through an authenticated SOCKS5 tunnel', async () => {
    const f = fixture(true);
    const endpoints: string[] = [];
    const server = createServer(async (request, response) => {
      request.resume();
      const url = decodeURIComponent(request.url!.slice(1));
      endpoints.push(url);
      const reply = await f.routes.get(url)!();
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(await reply.text());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const proxy = await startSocks5Proxy({
      targetPort: address.port,
      username: 'proxy-user',
      password: 'proxy-password'
    });
    // Replace only the remote authority with an isolated HTTP fixture; keep the real dispatcher.
    f.request.mockImplementation((url, init) =>
      fetch(`http://grok.internal:${address.port}/${encodeURIComponent(String(url))}`, init)
    );
    try {
      const attempt = await f.service.startLogin(actor, { ...f.draft, socks5Url: proxy.url });
      f.advance(5000);
      const completed = await f.service.loginAttempt(actor, attempt.id);
      expect(completed.status).toBe('SUCCEEDED');
      await f.service.loadCatalog(1, completed.credentialId!);
      await f.service.usage(1, completed.credentialId!);
      await f.service.refresh(1, completed.credentialId!);
      await f.service.remove(1, completed.credentialId!);
      expect(endpoints).toHaveLength(8);
      expect(proxy.destinations).toHaveLength(endpoints.length);
      expect(proxy.destinations.every((destination) => destination.host === 'grok.internal')).toBe(
        true
      );
      expect(
        proxy.authentications.every(
          (auth) => auth.username === 'proxy-user' && auth.password === 'proxy-password'
        )
      ).toBe(true);
      await vi.waitFor(() => expect(proxy.activeConnections()).toBe(0));
    } finally {
      await proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([false, true])(
    'uses the configured network route throughout login, catalog, usage, refresh and revoke (proxy=%s)',
    async (proxy) => {
      const f = fixture(proxy);
      const attempt = await f.service.startLogin(actor, f.draft);
      expect(attempt).toMatchObject({ type: 'XAI_OAUTH', status: 'PENDING', userCode: 'CODE-123' });
      expect(JSON.stringify(attempt)).not.toMatch(/device-private|proxy-password|access-private/);
      const deviceBody = new URLSearchParams(String(f.request.mock.calls[0]?.[1]?.body));
      expect(deviceBody.get('scope')).toContain('grok-cli:access');
      expect(deviceBody.get('scope')).not.toContain('billing:write');
      f.advance(5000);
      const result = await f.service.loginAttempt(actor, attempt.id);
      expect(result.status).toBe('SUCCEEDED');
      const id = result.credentialId!;
      expect(await f.service.loginAttempt(actor, attempt.id)).toEqual(result);
      expect(await f.service.credentialTarget(1, id)).toBe(XAI_SUBSCRIPTION_BASE_URL);
      expect((await f.service.loadCatalog(1, id)).models[0]).toMatchObject({
        upstreamModelId: 'grok-test',
        contextWindowTokens: 200_000
      });
      const usage = await f.service.usage(1, id);
      expect(usage).toMatchObject({
        cached: false,
        subscription: {
          provider: 'XAI',
          period: 'WEEKLY',
          usedPercentage: 25,
          prepaidBalanceCents: 1446
        }
      });
      expect(usage.windows[0]?.resetsAt).toBe(Date.parse('2027-01-22T08:00:00Z'));
      expect(JSON.stringify(usage)).not.toMatch(/private|proxy-password|account/);
      const resolved = await f.service.resolve(id, 'RUNTIME');
      expect(resolved.headers).toMatchObject({
        'x-xai-token-auth': 'xai-grok-cli',
        'x-userid': 'account',
        'x-grok-client-identifier': 'myagentroam',
        'x-grok-client-version': '1.0.52'
      });
      expect(resolved.headers).not.toHaveProperty('ChatGPT-Account-ID');
      expect(resolved.headers['user-agent']).not.toBe('MyAgentRoam/1.0.52');
      expect(resolved.socks5Url).toBe(proxy ? f.draft.socks5Url : undefined);
      f.tokens.access_token = 'renewed-access';
      f.tokens.refresh_token = 'rotated-refresh';
      await f.service.refresh(1, id);
      expect(f.document().credentials[0]).toMatchObject({
        accessToken: 'renewed-access',
        refreshToken: 'rotated-refresh'
      });
      expect(await f.service.remove(1, id)).toEqual({});
      expect(f.document().credentials).toEqual([]);
      expect(
        f.request.mock.calls.every(([url]) => !String(url).startsWith('https://api.x.ai'))
      ).toBe(true);
    }
  );

  it('respects pending and slow_down intervals and coalesces concurrent polls', async () => {
    const f = fixture();
    const attempt = await f.service.startLogin(actor, f.draft);
    f.routes.set('https://auth.x.ai/oauth2/token', () =>
      Response.json({ error: 'slow_down' }, { status: 400 })
    );
    expect((await f.service.loginAttempt(actor, attempt.id)).status).toBe('PENDING');
    expect(f.request).toHaveBeenCalledTimes(1);
    f.advance(5000);
    const pair = await Promise.all([
      f.service.loginAttempt(actor, attempt.id),
      f.service.loginAttempt(actor, attempt.id)
    ]);
    expect(pair[0]).toEqual(pair[1]);
    expect(pair[0]?.pollIntervalMs).toBe(10_000);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.advance(9000);
    await f.service.loginAttempt(actor, attempt.id);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.advance(1000);
    f.routes.set('https://auth.x.ai/oauth2/token', () =>
      Response.json({ error: 'authorization_pending' }, { status: 400 })
    );
    expect((await f.service.loginAttempt(actor, attempt.id)).pollIntervalMs).toBe(10_000);
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it.each(['cancel', 'expire', 'session'] as const)(
    'does not save late tokens after %s',
    async (kind) => {
      const f = fixture();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.routes.set('https://auth.x.ai/oauth2/token', async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json(f.tokens);
      });
      const attempt = await f.service.startLogin(actor, f.draft);
      f.advance(5000);
      const pending = f.service.loginAttempt(actor, attempt.id, () => {
        if (kind === 'session') throw new Error('CHATGPT_LOGIN_FORBIDDEN');
      });
      await started;
      if (kind === 'cancel') await f.service.cancelLogin(actor, attempt.id);
      if (kind === 'expire') f.advance(600_000);
      release();
      expect((await pending).status).toBe(
        kind === 'cancel' ? 'CANCELLED' : kind === 'expire' ? 'EXPIRED' : 'FAILED'
      );
      expect(f.document().credentials).toEqual([]);
    }
  );

  it('binds attempts to both user and session, and rechecks management permission at save', async () => {
    const f = fixture();
    const attempt = await f.service.startLogin(actor, f.draft);
    await expect(f.service.loginAttempt({ ...actor, userId: 2 }, attempt.id)).rejects.toThrow(
      'CODEX_LOGIN_ATTEMPT_NOT_FOUND'
    );
    await expect(
      f.service.cancelLogin({ ...actor, sessionFingerprint: 'other' }, attempt.id)
    ).rejects.toThrow('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
    vi.mocked(f.policy.assertActorCanSelectOwnership).mockRejectedValue(
      new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN')
    );
    f.advance(5000);
    expect((await f.service.loginAttempt(actor, attempt.id)).status).toBe('FAILED');
    expect(f.document().credentials).toEqual([]);
  });

  it('rejects relogin with a different identity or concurrently edited target', async () => {
    const f = fixture();
    const id = await f.login();
    const original = JSON.stringify(f.document());
    let attempt = await f.service.startLogin(actor, { ...f.draft, targetCredentialId: id });
    f.routes.set('https://auth.x.ai/oauth2/userinfo', () =>
      Response.json({ sub: 'other-subject' })
    );
    f.advance(5000);
    expect(await f.service.loginAttempt(actor, attempt.id)).toMatchObject({
      status: 'FAILED',
      code: 'XAI_LOGIN_CONFLICT'
    });
    expect(JSON.stringify(f.document())).toBe(original);
    f.routes.set('https://auth.x.ai/oauth2/userinfo', () => Response.json({ sub: 'subject' }));
    attempt = await f.service.startLogin(actor, { ...f.draft, targetCredentialId: id });
    await f.service.update(1, id, { name: 'Changed' });
    f.advance(5000);
    expect((await f.service.loginAttempt(actor, attempt.id)).code).toBe('XAI_LOGIN_CONFLICT');
    expect(f.document().credentials[0]?.name).toBe('Changed');
  });

  it('serializes rotating refresh tokens and retries usage once on 401', async () => {
    const f = fixture();
    const id = await f.login();
    f.request.mockClear();
    f.tokens.access_token = 'new-access';
    f.tokens.refresh_token = 'new-refresh';
    await Promise.all([f.service.refresh(1, id), f.service.refresh(1, id)]);
    expect(f.request.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(1);
    let calls = 0;
    f.routes.set(`${XAI_SUBSCRIPTION_PROXY_BASE_URL}/billing?format=credits`, () => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 401 })
        : Response.json({ config: { creditUsagePercent: 0 } });
    });
    expect((await f.service.usage(1, id)).subscription?.usedPercentage).toBe(0);
    expect(calls).toBe(2);
    f.routes.set(
      `${XAI_SUBSCRIPTION_PROXY_BASE_URL}/billing?format=credits`,
      () => new Response(null, { status: 401 })
    );
    await expect(f.service.usage(1, id)).rejects.toThrow('CODEX_CREDENTIAL_REAUTH_REQUIRED');
    expect(f.document().credentials[0]?.status).toBe('REAUTH_REQUIRED');
  });

  it('limits usage to one forced refresh across concurrent proxy edits', async () => {
    const f = fixture(true);
    const id = await f.login();
    f.request.mockClear();
    let calls = 0;
    f.routes.set(`${XAI_SUBSCRIPTION_PROXY_BASE_URL}/billing?format=credits`, async () => {
      if (++calls === 2)
        await f.service.update(1, id, { socks5Url: 'socks5://new-proxy.test:1080' });
      return new Response(null, { status: 401 });
    });
    await expect(f.service.usage(1, id)).rejects.toThrow('CODEX_CREDENTIAL_REAUTH_REQUIRED');
    expect(f.request.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(1);
    expect(calls).toBe(3);
    expect(f.document().credentials[0]).toMatchObject({
      proxy: 'socks5://new-proxy.test:1080',
      status: 'REAUTH_REQUIRED'
    });
  });

  it.each([
    [401, null, 'CODEX_CREDENTIAL_REAUTH_REQUIRED'],
    [401, 'unauthorized', 'CODEX_CREDENTIAL_REAUTH_REQUIRED'],
    [403, 'forbidden', 'XAI_ENTITLEMENT_REQUIRED'],
    [503, 'unavailable', 'XAI_REFRESH_FAILED']
  ] as const)('classifies non-JSON refresh HTTP %s responses (%s)', async (status, body, code) => {
    const f = fixture();
    const id = await f.login();
    f.routes.set('https://auth.x.ai/oauth2/token', () => new Response(body, { status }));
    await expect(f.service.refresh(1, id)).rejects.toThrow(code);
    expect(f.document().credentials[0]).toMatchObject({
      accessToken: 'access-private',
      refreshToken: 'refresh-private',
      status: status === 401 ? 'REAUTH_REQUIRED' : 'ACTIVE'
    });
  });

  it.each(['network', 'unavailable'] as const)(
    'keeps an unexpired token during a transient proactive refresh failure (%s)',
    async (failure) => {
      const f = fixture(true);
      const id = await f.login();
      f.advance(55 * 60_000);
      f.routes.set('https://auth.x.ai/oauth2/token', () => {
        if (failure === 'network') throw new Error('proxy-private-error');
        return new Response('unavailable', { status: 503 });
      });
      await expect(f.service.resolve(id, 'RUNTIME')).resolves.toMatchObject({
        bearer: 'access-private',
        socks5Url: f.draft.socks5Url
      });
      expect(f.document().credentials[0]).toMatchObject({
        accessToken: 'access-private',
        refreshToken: 'refresh-private',
        status: 'DEGRADED'
      });
      await expect(f.service.resolve(id, 'UNAUTHORIZED')).rejects.toThrow(
        failure === 'network' ? 'XAI_REQUEST_FAILED' : 'XAI_REFRESH_FAILED'
      );
      f.advance(5 * 60_000);
      await expect(f.service.resolve(id, 'RUNTIME')).rejects.toThrow(
        failure === 'network' ? 'XAI_REQUEST_FAILED' : 'XAI_REFRESH_FAILED'
      );
    }
  );

  it.each(['unknown-expiry', 'unauthorized', 'entitlement', 'invalid-token'] as const)(
    'does not reuse a token after an unsafe proactive refresh failure (%s)',
    async (failure) => {
      const f = fixture();
      if (failure === 'unknown-expiry')
        f.routes.set('https://auth.x.ai/oauth2/token', () =>
          Response.json({
            access_token: f.tokens.access_token,
            refresh_token: f.tokens.refresh_token
          })
        );
      const id = await f.login();
      f.advance(failure === 'unknown-expiry' ? 8 * 24 * 60 * 60_000 : 55 * 60_000);
      const replies = {
        'unknown-expiry': new Response(null, { status: 503 }),
        unauthorized: new Response(null, { status: 401 }),
        entitlement: new Response(null, { status: 403 }),
        'invalid-token': Response.json({ ...f.tokens, refresh_token: '' })
      };
      const codes = {
        'unknown-expiry': 'XAI_REFRESH_FAILED',
        unauthorized: 'CODEX_CREDENTIAL_REAUTH_REQUIRED',
        entitlement: 'XAI_ENTITLEMENT_REQUIRED',
        'invalid-token': 'XAI_RESPONSE_INVALID'
      };
      f.routes.set('https://auth.x.ai/oauth2/token', () => replies[failure]);
      await expect(f.service.resolve(id, 'RUNTIME')).rejects.toThrow(codes[failure]);
      expect(f.document().credentials[0]?.status).toBe(
        failure === 'unauthorized' ? 'REAUTH_REQUIRED' : 'ACTIVE'
      );
    }
  );

  it('does not refresh on entitlement or quota-query failures, or change credential state', async () => {
    const f = fixture();
    const id = await f.login();
    for (const [status, code] of [
      [403, 'XAI_ENTITLEMENT_REQUIRED'],
      [429, 'XAI_USAGE_RATE_LIMITED'],
      [503, 'XAI_USAGE_LOAD_FAILED']
    ] as const) {
      f.request.mockClear();
      f.routes.set(
        `${XAI_SUBSCRIPTION_PROXY_BASE_URL}/billing?format=credits`,
        () => new Response(null, { status })
      );
      await expect(f.service.usage(1, id)).rejects.toThrow(code);
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.document().credentials[0]?.status).toBe('ACTIVE');
    }
  });

  it('preserves a rotated token pair while retaining concurrent proxy and name edits', async () => {
    const f = fixture();
    const id = await f.login();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.routes.set('https://auth.x.ai/oauth2/token', async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({
        ...f.tokens,
        access_token: 'new-access',
        refresh_token: 'new-refresh'
      });
    });
    const refreshing = f.service.refresh(1, id);
    await started;
    await f.service.update(1, id, { name: 'New name', socks5Url: 'socks5://new-proxy.test:1080' });
    release();
    await refreshing;
    expect(f.document().credentials[0]).toMatchObject({
      name: 'New name',
      proxy: 'socks5://new-proxy.test:1080',
      accessToken: 'new-access',
      refreshToken: 'new-refresh'
    });
  });

  it('retains the previous pair on malformed refresh and requires sign-in for invalid_grant', async () => {
    const f = fixture();
    const id = await f.login();
    f.routes.set('https://auth.x.ai/oauth2/token', () =>
      Response.json({ ...f.tokens, refresh_token: '' })
    );
    await expect(f.service.refresh(1, id)).rejects.toThrow('XAI_RESPONSE_INVALID');
    expect(f.document().credentials[0]?.refreshToken).toBe('refresh-private');
    f.routes.set('https://auth.x.ai/oauth2/token', () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 })
    );
    await expect(f.service.refresh(1, id)).rejects.toThrow('CODEX_CREDENTIAL_REAUTH_REQUIRED');
  });

  it('rejects invalid proxies before network access and never retries direct after a proxy failure', async () => {
    const f = fixture(true);
    await expect(
      f.service.startLogin(actor, { ...f.draft, socks5Url: 'http://proxy.test' })
    ).rejects.toThrow('CODEX_CREDENTIAL_INPUT_INVALID');
    expect(f.request).not.toHaveBeenCalled();
    f.routes.set('https://auth.x.ai/oauth2/device/code', () => {
      throw new Error('proxy failed with secret-value');
    });
    await expect(f.service.startLogin(actor, f.draft)).rejects.toMatchObject({
      code: 'XAI_REQUEST_FAILED'
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('accepts omitted expiry without inventing a lifetime and preserves an unrotated refresh token', async () => {
    const f = fixture();
    f.routes.set('https://auth.x.ai/oauth2/token', () =>
      Response.json({ access_token: 'access-private', refresh_token: 'refresh-private' })
    );
    const id = await f.login();
    expect(f.document().credentials[0]?.accessTokenExpiresAt).toBeNull();
    f.routes.set('https://auth.x.ai/oauth2/token', () =>
      Response.json({ access_token: 'new-access' })
    );
    await f.service.refresh(1, id);
    expect(f.document().credentials[0]).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'refresh-private',
      accessTokenExpiresAt: null
    });
  });

  it('bounds upstream bodies and does not expose arbitrary authorization URLs', async () => {
    const f = fixture();
    f.device.verification_uri = 'https://untrusted.test/authorize';
    await expect(f.service.startLogin(actor, f.draft)).rejects.toThrow('XAI_RESPONSE_INVALID');
    f.routes.set(
      'https://auth.x.ai/oauth2/device/code',
      () => new Response('x'.repeat(256 * 1024 + 1))
    );
    await expect(f.service.startLogin(actor, f.draft)).rejects.toThrow('XAI_RESPONSE_INVALID');
    expect(f.document().credentials).toEqual([]);
  });
});

describe('Grok usage normalization', () => {
  it.each([null, [], 'bad', undefined])('rejects an invalid billing configuration %j', (config) => {
    expect(() => normalizeXaiUsage({ config }, NOW)).toThrow('XAI_RESPONSE_INVALID');
  });
  it('normalizes subscription catalog metadata without trusting upstream endpoints or headers', () => {
    const catalog = normalizeXaiCatalog(
      {
        data: [
          {
            model: 'grok-build',
            contextWindow: 256000,
            maxCompletionTokens: 32000,
            apiBackend: 'responses',
            baseUrl: 'https://untrusted.test',
            extraHeaders: { secret: 'private' },
            capabilities: {
              reasoning_effort: ['low', 'high', 'future'],
              default_reasoning_effort: 'high'
            }
          },
          {
            modelId: 'grok-meta',
            _meta: { totalContextTokens: 128000 },
            reasoningEfforts: [{ value: 'medium' }]
          },
          { id: 'hidden', hidden: true },
          { id: 'messages-only', apiBackend: 'messages' }
        ]
      },
      NOW
    );
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]).toMatchObject({
      upstreamModelId: 'grok-build',
      contextWindowTokens: 256000,
      maxOutputTokens: 32000,
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      unsupportedReasoningEfforts: ['future'],
      hostedWebSearch: true
    });
    expect(catalog.models[1]).toMatchObject({
      upstreamModelId: 'grok-meta',
      contextWindowTokens: 128000,
      reasoningEfforts: ['medium'],
      hostedWebSearch: true
    });
    expect(JSON.stringify(catalog)).not.toMatch(/untrusted|private|extraHeaders/);
  });
  it('keeps missing percentages unknown and prepaid zero distinct from absence', () => {
    const usage = normalizeXaiUsage(
      {
        config: {
          prepaidBalance: {},
          currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2027-02-01T00:00:00Z' }
        }
      },
      NOW
    );
    expect(usage.windows).toEqual([]);
    expect(usage.subscription).toMatchObject({
      usedPercentage: null,
      prepaidBalanceCents: 0,
      period: 'MONTHLY'
    });
    expect(normalizeXaiUsage({ config: {} }, NOW).subscription?.prepaidBalanceCents).toBeNull();
    expect(
      normalizeXaiUsage({ config: { creditUsagePercent: 101, prepaidBalance: { val: -1 } } }, NOW)
        .subscription
    ).toMatchObject({ usedPercentage: null, prepaidBalanceCents: null });
    expect(usage.profile.lifetimeTokens).toBeNull();
  });
});
