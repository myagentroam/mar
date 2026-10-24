import { describe, expect, it, vi } from 'vitest';
import type { CodexLoginAttempt } from '@myagentroam/protocol';
import type { NodeSummary } from '../../src/model/workbench.js';
import {
  CodexLoginAttemptPoller,
  buildCodexModelImportRequest,
  codexCredentialErrorMessageKey,
  credentialRefreshOutcome,
  createCodexCredentialManagementService,
  eligibleMarAgentTransportTestNodes,
  modelProtocolChoice,
  modelSupportsNodeTransport
} from '../../src/service/codex-credential-management-service.js';

const credential = {
  id: 'credential-1',
  name: 'Primary Codex',
  type: 'CODEX_OAUTH',
  ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
  status: 'ACTIVE',
  accessTokenExpiresAt: 1_800_000,
  lastRefreshAt: 600_000,
  lastCheckedAt: 900_000,
  accountId: 'account-secret',
  proxy: { configured: false },
  revision: 2
} as const;

const catalog = {
  catalogHash: 'a'.repeat(64),
  fetchedAt: 1_000,
  models: [
    {
      upstreamModelId: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      reasoningEfforts: ['low', 'medium', 'high'],
      unsupportedReasoningEfforts: ['extreme'],
      inputCapabilities: ['TEXT', 'IMAGE'],
      hostedWebSearch: true,
      warnings: ['Unsupported reasoning effort: extreme'],
      requiredInputs: []
    },
    {
      upstreamModelId: 'gpt-5-mini',
      displayName: 'GPT-5 Mini',
      reasoningEfforts: [],
      unsupportedReasoningEfforts: [],
      inputCapabilities: ['TEXT'],
      hostedWebSearch: false,
      warnings: [],
      requiredInputs: ['contextWindowTokens']
    }
  ]
} as const;
const usage = {
  runner: 'codex',
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
    dailyUsageBuckets: [
      { startDate: '2026-09-15', tokens: 8_000_000 },
      { startDate: '2026-09-16', tokens: 16_000_000 },
      { startDate: '2026-09-17', tokens: 7_000_000 }
    ]
  }
} as const;
const grokUsage = {
  runner: 'codex',
  windows: [],
  fetchedAt: 1_000_000,
  cached: false,
  profile: {
    lifetimeTokens: null,
    currentDayTokens: null,
    lastSevenDaysTokens: null,
    statsAsOf: null,
    dailyUsageBuckets: []
  },
  subscription: {
    provider: 'XAI',
    period: 'WEEKLY',
    startsAt: null,
    resetsAt: 1_800_000,
    usedPercentage: 37.5,
    prepaidBalanceCents: 1_234
  }
} as const;

describe('Web Codex credential management service', () => {
  it('distinguishes a deferred refresh, actual rotation, degradation and unchanged timestamps', () => {
    const chatgpt = {
      ...credential,
      type: 'CHATGPT_OAUTH' as const,
      earliestRefreshAt: 1_500_000
    };
    expect(credentialRefreshOutcome(chatgpt, chatgpt, 1_000_000)).toBe('DEFERRED');
    expect(
      credentialRefreshOutcome(
        chatgpt,
        {
          ...chatgpt,
          lastRefreshAt: 1_000_000,
          accessTokenExpiresAt: 4_600_000
        },
        1_000_000
      )
    ).toBe('REFRESHED');
    expect(
      credentialRefreshOutcome(
        chatgpt,
        {
          ...chatgpt,
          status: 'DEGRADED'
        },
        1_000_000
      )
    ).toBe('DEGRADED');
    expect(credentialRefreshOutcome(credential, credential, 1_000_000)).toBe('UNCHANGED');
  });
  it.each([
    ['CREDENTIAL_REF', 'https://api.openai.com/v1', 'OPENAI_RESPONSES', 'CHATGPT'],
    ['CREDENTIAL_REF', 'https://chatgpt.com/backend-api/codex', 'OPENAI_RESPONSES', 'CODEX'],
    ['CREDENTIAL_REF', 'https://cli-chat-proxy.grok.com/v1', 'OPENAI_RESPONSES', 'GROK'],
    ['INLINE_API_KEY', 'https://api.openai.com/v1', 'OPENAI_RESPONSES', 'OPENAI_RESPONSES'],
    ['INLINE_API_KEY', 'https://api.x.ai/v1', 'OPENAI_RESPONSES', 'OPENAI_RESPONSES'],
    [
      'INLINE_API_KEY',
      'https://cli-chat-proxy.grok.com/v1',
      'OPENAI_RESPONSES',
      'OPENAI_RESPONSES'
    ],
    ['INLINE_API_KEY', 'https://api.anthropic.com', 'ANTHROPIC_MESSAGES', 'ANTHROPIC_MESSAGES']
  ] as const)(
    'classifies %s at %s consistently for display and editing',
    (credentialType, baseUrl, protocol, expected) => {
      expect(modelProtocolChoice({ credentialType, baseUrl, protocol })).toBe(expected);
    }
  );
  it('sends the selected local Node for ChatGPT login and parses a redacted OAuth attempt', async () => {
    const pending = {
      id: 'login',
      type: 'CHATGPT_OAUTH',
      status: 'PENDING',
      verificationUri: 'http://127.0.0.1:1455/auth/start?ticket=fake',
      expiresAt: 1_800_000,
      pollIntervalMs: 2000
    } as const;
    const request = vi.fn(async () => ({ attempt: pending }));
    const service = createCodexCredentialManagementService(request as never);
    expect(
      await service.startLogin({
        type: 'CHATGPT_OAUTH',
        nodeId: 'local',
        name: ' ChatGPT ',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
      })
    ).toEqual(pending);
    expect(
      JSON.parse(String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    ).toEqual({
      type: 'CHATGPT_OAUTH',
      nodeId: 'local',
      name: 'ChatGPT',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    });
    expect(codexCredentialErrorMessageKey('CHATGPT_PLAN_UNAUTHORIZED')).toBe(
      'marAgentModels.chatgptUnauthorizedHint'
    );
  });
  it('sends XAI OAuth login without a local Node', async () => {
    const pending = {
      id: 'grok-login',
      type: 'XAI_OAUTH',
      status: 'PENDING',
      userCode: 'GROK-CODE',
      verificationUri: 'https://auth.example.test/grok/device',
      expiresAt: 1_800_000,
      pollIntervalMs: 2_000
    } as const;
    const request = vi.fn(async () => ({ attempt: pending }));
    const service = createCodexCredentialManagementService(request as never);

    await expect(
      service.startLogin({
        type: 'XAI_OAUTH',
        name: ' Grok ',
        ownership: { ownerType: 'PERSONAL' },
        socks5Url: 'socks5://proxy.example.test:1080'
      })
    ).resolves.toEqual(pending);
    expect(
      JSON.parse(String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    ).toEqual({
      type: 'XAI_OAUTH',
      name: 'Grok',
      ownership: { ownerType: 'PERSONAL' },
      socks5Url: 'socks5://proxy.example.test:1080'
    });
  });
  it('strictly validates credential, attempt, catalog and import responses', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const service = createCodexCredentialManagementService(async (path, init) => {
      requests.push(init === undefined ? { path } : { path, init });
      if (path === '/api/admin/mar-agent/codex-credentials')
        return { credentials: [credential] } as never;
      if (path === '/api/admin/mar-agent/codex-credentials/credential-1')
        return {
          details: {
            credential: {
              ...credential,
              proxy: {
                configured: true,
                host: 'proxy.example.test',
                port: 1080,
                hasUsername: true
              }
            },
            socks5Url: 'socks5://user:password@proxy.example.test:1080'
          }
        } as never;
      if (path === '/api/admin/mar-agent/codex-credentials/credential-1/usage')
        return { usage } as never;
      if (path.endsWith('/models/load')) return { catalog } as never;
      if (path.endsWith('/models/import'))
        return {
          result: {
            items: [
              {
                upstreamModelId: 'gpt-5-codex',
                status: 'CREATED',
                modelId: 'model-1'
              }
            ]
          }
        } as never;
      return {
        attempt: {
          id: 'attempt-1',
          status: 'PENDING',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://auth.example.test/codex/device',
          expiresAt: 10_000,
          pollIntervalMs: 1_000
        }
      } as never;
    });

    await expect(service.listCredentials()).resolves.toEqual([credential]);
    await expect(
      service.startLogin({
        name: ' Primary Codex ',
        socks5Url: 'socks5://proxy.example.test:1080',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 },
        custom: { team: 'platform' },
        ignored: 'must-not-be-sent'
      } as never)
    ).resolves.toMatchObject({ id: 'attempt-1', status: 'PENDING' });
    await expect(service.credentialDetails(credential.id)).resolves.toMatchObject({
      credential: { id: credential.id },
      socks5Url: 'socks5://user:password@proxy.example.test:1080'
    });
    expect(requests[2]).toEqual({
      path: '/api/admin/mar-agent/codex-credentials/credential-1',
      init: { cache: 'no-store' }
    });
    await expect(service.loadCatalog(credential.id)).resolves.toEqual(catalog);
    await expect(
      service.importModels(
        credential.id,
        buildCodexModelImportRequest(catalog, [
          {
            upstreamModelId: 'gpt-5-codex',
            selected: true,
            name: ' GPT-5 Codex ',
            contextWindowTokens: 200_000
          }
        ])
      )
    ).resolves.toEqual({
      items: [{ upstreamModelId: 'gpt-5-codex', status: 'CREATED', modelId: 'model-1' }]
    });

    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      name: 'Primary Codex',
      socks5Url: 'socks5://proxy.example.test:1080',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 }
    });
    expect(requests[3]).toMatchObject({
      path: '/api/admin/mar-agent/codex-credentials/credential-1/models/load',
      init: { method: 'POST' }
    });
    await expect(service.credentialUsage(credential.id)).resolves.toEqual(usage);
    expect(requests[5]).toEqual({
      path: '/api/admin/mar-agent/codex-credentials/credential-1/usage',
      init: { cache: 'no-store' }
    });

    const invalid = createCodexCredentialManagementService(
      async () => ({ credentials: [{ ...credential, accessToken: 'secret' }] }) as never
    );
    await expect(invalid.listCredentials()).rejects.toThrow('CODEX_CREDENTIAL_RESPONSE_INVALID');
    const sanitizedUsage = createCodexCredentialManagementService(
      async () => ({ usage: { ...usage, accessToken: 'secret' } }) as never
    );
    await expect(sanitizedUsage.credentialUsage(credential.id)).resolves.toEqual(usage);
    expect(JSON.stringify(await sanitizedUsage.credentialUsage(credential.id))).not.toContain(
      'secret'
    );
    const invalidUsage = createCodexCredentialManagementService(
      async () =>
        ({
          usage: {
            ...usage,
            windows: [{ ...usage.windows[0], usedPercentage: 101 }]
          }
        }) as never
    );
    await expect(invalidUsage.credentialUsage(credential.id)).rejects.toThrow(
      'CODEX_USAGE_RESPONSE_INVALID'
    );
  });
  it('parses XAI subscription usage with empty token windows', async () => {
    const service = createCodexCredentialManagementService(
      async () => ({ usage: grokUsage }) as never
    );
    await expect(service.credentialUsage('grok-credential')).resolves.toEqual(grokUsage);
    for (const code of [
      'XAI_DEVICE_AUTH_UNAVAILABLE',
      'XAI_LOGIN_FAILED',
      'XAI_LOGIN_DENIED',
      'XAI_LOGIN_CONFLICT',
      'XAI_RESPONSE_INVALID',
      'XAI_ENTITLEMENT_REQUIRED',
      'XAI_REFRESH_FAILED',
      'XAI_USAGE_LOAD_FAILED',
      'XAI_USAGE_RATE_LIMITED',
      'XAI_CATALOG_LOAD_FAILED',
      'XAI_REQUEST_FAILED'
    ])
      expect(codexCredentialErrorMessageKey(code)).toMatch(/^marAgentModels\.grokError/u);
  });

  it('keeps image generation out of credential updates and omits removed custom metadata', async () => {
    const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return { credential } as never;
    });
    const service = createCodexCredentialManagementService(request);

    await service.updateCredential(credential.id, {
      name: ' Renamed Codex ',
      socks5Url: 'socks5://proxy.example.test:1080',
      ownership: { ownerType: 'PERSONAL', ownerUserId: 7 },
      custom: { team: 'platform' }
    } as never);

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      name: 'Renamed Codex',
      socks5Url: 'socks5://proxy.example.test:1080',
      ownership: { ownerType: 'PERSONAL', ownerUserId: 7 }
    });
  });

  it('preserves model transport test error details', async () => {
    const request = vi.fn(
      async () =>
        ({
          success: false,
          code: 'invalid_request_error',
          message: 'Store must be set to false',
          httpStatus: 400
        }) as never
    );
    const service = createCodexCredentialManagementService(request);

    await expect(service.testModel('model-1', 'node-1')).resolves.toEqual({
      success: false,
      code: 'invalid_request_error',
      message: 'Store must be set to false',
      httpStatus: 400
    });
    expect(request).toHaveBeenCalledWith('/api/admin/mar-agent/models/model-1/test', {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'node-1' })
    });
  });

  it('loads and saves the provider-based image generation configuration', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const configuration = [
      {
        id: 'image-1',
        name: 'Image',
        enabled: true,
        provider: 'CODEX' as const,
        config: { credentialId: 'credential-1', modelId: 'gpt-image-2' }
      }
    ];
    const service = createCodexCredentialManagementService(async (path, init) => {
      requests.push(init === undefined ? { path } : { path, init });
      return { configuration } as never;
    });

    await expect(service.imageGenerationConfiguration()).resolves.toEqual(configuration);
    await expect(service.updateImageGenerationConfiguration(configuration)).resolves.toEqual(
      configuration
    );
    expect(requests).toEqual([
      { path: '/api/admin/mar-agent/image-generation' },
      {
        path: '/api/admin/mar-agent/image-generation',
        init: { method: 'PUT', body: expect.any(String) }
      }
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(configuration);
  });

  it('builds catalog imports with only missing context and no model transport settings', () => {
    expect(() =>
      buildCodexModelImportRequest(catalog, [
        {
          upstreamModelId: 'gpt-5-mini',
          selected: true,
          name: 'GPT-5 Mini',
          contextWindowTokens: 0
        }
      ])
    ).toThrow('CODEX_MODEL_IMPORT_LIMIT_REQUIRED');

    expect(
      buildCodexModelImportRequest(catalog, [
        {
          upstreamModelId: 'gpt-5-mini',
          selected: true,
          name: 'GPT-5 Mini',
          contextWindowTokens: 100_000
        },
        {
          upstreamModelId: 'gpt-5-codex',
          selected: false,
          name: 'Ignored',
          contextWindowTokens: 200_000
        }
      ])
    ).toEqual({
      catalogHash: 'a'.repeat(64),
      models: [
        {
          upstreamModelId: 'gpt-5-mini',
          name: 'GPT-5 Mini',
          contextWindowTokens: 100_000,
          enabled: true
        }
      ]
    });
  });

  it('polls the active attempt, stops at terminal state and ignores stale starts', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const first = deferred<{
        id: string;
        status: 'PENDING';
        userCode: string;
        verificationUri: string;
        expiresAt: number;
        pollIntervalMs: number;
      }>();
      const poll = vi.fn(async () => ({
        id: 'attempt-2',
        status: 'SUCCEEDED' as const,
        credentialId: 'credential-2'
      }));
      const service = {
        startLogin: vi
          .fn()
          .mockImplementationOnce(() => first.promise)
          .mockResolvedValueOnce({
            id: 'attempt-2',
            status: 'PENDING',
            userCode: 'SECOND',
            verificationUri: 'https://auth.example.test/codex/device',
            expiresAt: 20_000,
            pollIntervalMs: 1_000
          }),
        loginAttempt: poll,
        cancelLogin: vi.fn(async () => undefined)
      };
      const changes: string[] = [];
      const terminal: string[] = [];
      const poller = new CodexLoginAttemptPoller(service, {
        now: () => Date.now(),
        onChange: (attempt) => changes.push(`${attempt.id}:${attempt.status}`),
        onTerminal: (attempt) => terminal.push(`${attempt.id}:${attempt.status}`)
      });

      void poller.begin({ name: 'First', ownership: { ownerType: 'PERSONAL' } });
      await poller.begin({ name: 'Second', ownership: { ownerType: 'PERSONAL' } });
      first.resolve({
        id: 'attempt-1',
        status: 'PENDING',
        userCode: 'FIRST',
        verificationUri: 'https://auth.example.test/codex/device',
        expiresAt: 20_000,
        pollIntervalMs: 1_000
      });
      await Promise.resolve();
      expect(poller.current()).toMatchObject({ id: 'attempt-2' });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(poll).toHaveBeenCalledWith('attempt-2');
      expect(poller.current()).toEqual({
        id: 'attempt-2',
        status: 'SUCCEEDED',
        credentialId: 'credential-2'
      });
      expect(changes).toEqual(['attempt-2:PENDING', 'attempt-2:SUCCEEDED']);
      expect(terminal).toEqual(['attempt-2:SUCCEEDED']);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(poll).toHaveBeenCalledTimes(1);
      poller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('manually refreshes the pending attempt and replaces its scheduled poll', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const service = {
        startLogin: vi.fn(async () => ({
          id: 'attempt-1',
          status: 'PENDING' as const,
          userCode: 'CODE',
          verificationUri: 'https://auth.example.test/codex/device',
          expiresAt: 20_000,
          pollIntervalMs: 1_000
        })),
        loginAttempt: vi.fn(async () => ({
          id: 'attempt-1',
          status: 'SUCCEEDED' as const,
          credentialId: 'credential-1'
        })),
        cancelLogin: vi.fn(async () => undefined)
      };
      const terminal: string[] = [];
      const poller = new CodexLoginAttemptPoller(service, {
        now: () => Date.now(),
        onTerminal: (attempt) => terminal.push(attempt.status)
      });

      await poller.begin({ name: 'Primary', ownership: { ownerType: 'PERSONAL' } });
      await poller.refresh();

      expect(service.loginAttempt).toHaveBeenCalledOnce();
      expect(service.loginAttempt).toHaveBeenCalledWith('attempt-1');
      expect(poller.current()).toEqual({
        id: 'attempt-1',
        status: 'SUCCEEDED',
        credentialId: 'credential-1'
      });
      expect(terminal).toEqual(['SUCCEEDED']);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(service.loginAttempt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an automatic poll response superseded by a manual refresh', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const automatic = deferred<{
        id: string;
        status: 'PENDING';
        userCode: string;
        verificationUri: string;
        expiresAt: number;
        pollIntervalMs: number;
      }>();
      const manual = deferred<{
        id: string;
        status: 'SUCCEEDED';
        credentialId: string;
      }>();
      const service = {
        startLogin: vi.fn(async () => ({
          id: 'attempt-1',
          status: 'PENDING' as const,
          userCode: 'CODE',
          verificationUri: 'https://auth.example.test/codex/device',
          expiresAt: 20_000,
          pollIntervalMs: 1_000
        })),
        loginAttempt: vi
          .fn()
          .mockImplementationOnce(() => automatic.promise)
          .mockImplementationOnce(() => manual.promise),
        cancelLogin: vi.fn(async () => undefined)
      };
      const changes: string[] = [];
      const terminal: string[] = [];
      const poller = new CodexLoginAttemptPoller(service, {
        now: () => Date.now(),
        onChange: (attempt) => changes.push(attempt.status),
        onTerminal: (attempt) => terminal.push(attempt.status)
      });

      await poller.begin({ name: 'Primary', ownership: { ownerType: 'PERSONAL' } });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      expect(service.loginAttempt).toHaveBeenCalledOnce();

      const refresh = poller.refresh();
      expect(service.loginAttempt).toHaveBeenCalledTimes(2);
      manual.resolve({
        id: 'attempt-1',
        status: 'SUCCEEDED',
        credentialId: 'credential-1'
      });
      await refresh;

      automatic.resolve({
        id: 'attempt-1',
        status: 'PENDING',
        userCode: 'STALE',
        verificationUri: 'https://auth.example.test/codex/device',
        expiresAt: 20_000,
        pollIntervalMs: 1_000
      });
      await Promise.resolve();

      expect(poller.current()).toEqual({
        id: 'attempt-1',
        status: 'SUCCEEDED',
        credentialId: 'credential-1'
      });
      expect(changes).toEqual(['PENDING', 'SUCCEEDED']);
      expect(terminal).toEqual(['SUCCEEDED']);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(service.loginAttempt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['cancel', 'dispose'] as const)('clears a late start after %s', async (action) => {
    const pending = deferred<CodexLoginAttempt>();
    const service = {
      startLogin: vi.fn(() => pending.promise),
      loginAttempt: vi.fn(),
      cancelLogin: vi.fn(async () => undefined)
    };
    const onChange = vi.fn();
    const poller = new CodexLoginAttemptPoller(service, { onChange });
    const started = poller.begin({ name: 'ChatGPT', ownership: { ownerType: 'PERSONAL' } });
    await poller[action]();
    pending.resolve({
      id: 'late-attempt',
      type: 'CHATGPT_OAUTH',
      status: 'PENDING',
      verificationUri: 'http://127.0.0.1:1455/auth/start?ticket=test',
      expiresAt: Date.now() + 60_000,
      pollIntervalMs: 2000
    });
    expect(await started).toBeUndefined();
    expect(service.cancelLogin).toHaveBeenCalledWith('late-attempt');
    expect(onChange).not.toHaveBeenCalled();
    expect(poller.current()).toBeUndefined();
  });

  it('cancels only the current pending attempt and clears scheduled polling', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const service = {
        startLogin: vi.fn(async () => ({
          id: 'attempt-1',
          status: 'PENDING' as const,
          userCode: 'CODE',
          verificationUri: 'https://auth.example.test/codex/device',
          expiresAt: 20_000,
          pollIntervalMs: 1_000
        })),
        loginAttempt: vi.fn(),
        cancelLogin: vi.fn(async () => undefined)
      };
      const poller = new CodexLoginAttemptPoller(service, { now: () => Date.now() });
      await poller.begin({ name: 'Primary', ownership: { ownerType: 'PERSONAL' } });
      await poller.cancel();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(service.cancelLogin).toHaveBeenCalledWith('attempt-1');
      expect(service.loginAttempt).not.toHaveBeenCalled();
      expect(poller.current()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gates real model transport tests by Node status, capability and protocol, not app version', () => {
    const nodes = [
      node('node-ready', 'unknown', true, {
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1', '2']
      }),
      node('node-old', '0.9.30', true, {
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1', '2']
      }),
      node('node-prerelease', '0.9.31-beta.1', true, {
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1', '2']
      }),
      node('node-offline', 'unknown', false, {
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1', '2']
      }),
      node('node-h1', 'unknown', true, {
        apiVersion: 1,
        websocket: false,
        httpVersions: ['1.1']
      })
    ];

    expect(eligibleMarAgentTransportTestNodes(nodes).map((value) => value.id)).toEqual([
      'node-ready',
      'node-old',
      'node-prerelease',
      'node-h1'
    ]);
    expect(modelSupportsNodeTransport(nodes[0]!, { transport: 'WEBSOCKET' })).toBe(true);
    expect(modelSupportsNodeTransport(nodes[4]!, { transport: 'WEBSOCKET' })).toBe(false);
    expect(modelSupportsNodeTransport(nodes[4]!, { transport: 'HTTP', httpVersion: '1.1' })).toBe(
      true
    );
    expect(modelSupportsNodeTransport(nodes[4]!, { transport: 'HTTP', httpVersion: '2' })).toBe(
      false
    );
  });

  it('filters model tests by standard service-tier capability without Ultrafast fallback', () => {
    const old = node('old', 'unknown', true, {
      apiVersion: 1,
      websocket: true,
      httpVersions: ['1.1'],
      fastMode: true
    });
    const modern = node('modern', 'unknown', true, {
      apiVersion: 1,
      websocket: true,
      httpVersions: ['1.1'],
      serviceTiers: ['default', 'priority', 'ultrafast']
    });
    const httpContinuation = {
      ...modern,
      capabilities: {
        ...modern.capabilities,
        marAgentRuntimeCredentials: {
          ...modern.capabilities.marAgentRuntimeCredentials!,
          responsesHttpContinuation: true
        }
      }
    };
    expect(codexCredentialErrorMessageKey('MAR_AGENT_MODEL_HTTP_CONTINUATION_UNAVAILABLE')).toBe(
      'marAgentModels.modelTestHttpContinuationUnavailable'
    );
    expect(modelSupportsNodeTransport(old, undefined, 'default', false, true)).toBe(false);
    expect(
      modelSupportsNodeTransport(old, { transport: 'WEBSOCKET' }, 'default', false, true)
    ).toBe(true);
    expect(
      modelSupportsNodeTransport(
        httpContinuation,
        { transport: 'HTTP', httpVersion: '1.1' },
        'default',
        false,
        true
      )
    ).toBe(true);
    expect(modelSupportsNodeTransport(old, undefined, 'default')).toBe(true);
    expect(modelSupportsNodeTransport(old, undefined, 'priority')).toBe(true);
    expect(modelSupportsNodeTransport(old, undefined, 'ultrafast')).toBe(false);
    expect(modelSupportsNodeTransport(modern, { transport: 'WEBSOCKET' }, 'ultrafast')).toBe(true);
    expect(
      modelSupportsNodeTransport(modern, { transport: 'HTTP', httpVersion: '2' }, 'ultrafast')
    ).toBe(false);
  });

  it('requires responsesOptionalParameters only for Grok model tests', () => {
    const oldNode = node('old-grok', 'unknown', true, {
      apiVersion: 1,
      websocket: true,
      httpVersions: ['1.1']
    });
    const grokNode = node('grok', 'unknown', true, {
      apiVersion: 1,
      websocket: true,
      httpVersions: ['1.1'],
      responsesOptionalParameters: true
    });
    const incompleteGrokNode = node('incomplete-grok', 'unknown', true, {
      apiVersion: 1,
      websocket: true,
      httpVersions: ['1.1'],
      responsesOptionalParameters: false
    });

    expect(
      modelSupportsNodeTransport(
        oldNode,
        { transport: 'HTTP', httpVersion: '1.1' },
        undefined,
        true
      )
    ).toBe(false);
    expect(
      modelSupportsNodeTransport(
        grokNode,
        { transport: 'HTTP', httpVersion: '1.1' },
        undefined,
        true
      )
    ).toBe(true);
    expect(
      modelSupportsNodeTransport(
        incompleteGrokNode,
        { transport: 'HTTP', httpVersion: '1.1' },
        undefined,
        true
      )
    ).toBe(false);
    expect(modelSupportsNodeTransport(oldNode, { transport: 'HTTP', httpVersion: '1.1' })).toBe(
      true
    );
  });

  it('maps stable credential and catalog errors to localized message keys', () => {
    expect(codexCredentialErrorMessageKey('CODEX_CREDENTIAL_IN_USE')).toBe(
      'marAgentModels.codexErrorInUse'
    );
    expect(codexCredentialErrorMessageKey('CODEX_CATALOG_CHANGED')).toBe(
      'marAgentModels.codexErrorCatalogChanged'
    );
    expect(codexCredentialErrorMessageKey('CODEX_CREDENTIAL_REAUTH_REQUIRED')).toBe(
      'marAgentModels.codexErrorReauthRequired'
    );
    expect(codexCredentialErrorMessageKey('UNKNOWN')).toBeUndefined();
  });
});

function node(
  id: string,
  nodeAppVersion: string,
  connected: boolean,
  marAgentRuntimeCredentials: NonNullable<
    NodeSummary['capabilities']['marAgentRuntimeCredentials']
  > & { readonly responsesOptionalParameters?: boolean }
): NodeSummary {
  return {
    id,
    displayName: id,
    registeredAddress: '127.0.0.1',
    platform: 'linux',
    architecture: 'x64',
    nodeAppVersion,
    nodeVersion: 'v22.18.0',
    connected,
    disabled: false,
    capabilities: { marAgentRuntimeCredentials }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
