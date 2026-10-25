import { describe, expect, it } from 'vitest';
import {
  codexCredentialOwnershipSchema,
  codexCredentialDetailsSchema,
  codexCredentialSummarySchema,
  codexCredentialUsageSchema,
  codexLoginAttemptSchema,
  codexModelCatalogSchema,
  codexModelImportRequestSchema,
  codexModelImportResultSchema,
  marAgentModelTransportTestInputSchema,
  marAgentModelTransportTestResultSchema,
  marAgentModelSummarySchema,
  marAgentRuntimeCredentialCapabilitySchema,
  marAgentRuntimeModelConfigurationSchema,
  marAgentStoredModelConfigurationSchema,
  nodeCapabilitiesSchema,
  runtimeCredentialResolveRequestSchema,
  runtimeCredentialResolveResponseSchema,
  runtimeCredentialTicketSchema,
  workbenchNodeOperationSchema
} from '../../src/index.js';

const baseModel = {
  id: 'model-codex',
  name: 'Codex',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  modelId: 'gpt-5.6-codex',
  contextWindowTokens: 200_000,
  maxOutputTokens: 32_000,
  inputCapabilities: ['TEXT', 'IMAGE'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['low', 'medium', 'high'],
  hostedWebSearch: true,
  responsesPreviousResponseId: true,
  responsesTransport: { transport: 'WEBSOCKET' },
  enabled: true
} as const;

const ticket = {
  userId: 7,
  credentialId: 'credential-1',
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  runtimeScopeId: 'scope-1',
  allowedModelIds: ['model-codex'],
  issuedAt: 1_000,
  expiresAt: 24 * 60 * 60 * 1000 + 1_000,
  nonce: 'nonce-1',
  signature: 'a'.repeat(64)
};

describe('Conversation model purpose', () => {
  it.each([undefined, {}, { useResourceUrl: true }])(
    'keeps resource metadata separate from the effective runtime flag: %j',
    (metadata) => {
      const value = {
        ...baseModel,
        credential: { type: 'INLINE_API_KEY', value: 'test-key' },
        ...(metadata === undefined ? {} : { metadata })
      };
      const stored = marAgentStoredModelConfigurationSchema.parse(value);
      expect(stored.metadata?.useResourceUrl ?? false).toBe(metadata?.useResourceUrl ?? false);
      expect(marAgentRuntimeModelConfigurationSchema.parse(value).useResourceUrl).toBe(false);
      expect(
        marAgentRuntimeModelConfigurationSchema.parse({ ...value, useResourceUrl: true })
          .useResourceUrl
      ).toBe(true);
    }
  );

  it('rejects invalid resource settings and the removed image operation alias', () => {
    const value = { ...baseModel, credential: { type: 'INLINE_API_KEY', value: 'test-key' } };
    expect(
      marAgentStoredModelConfigurationSchema.safeParse({
        ...value,
        metadata: { useResourceUrl: 'true' }
      }).success
    ).toBe(false);
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({ ...value, useResourceUrl: 'true' })
        .success
    ).toBe(false);
    expect(workbenchNodeOperationSchema.safeParse('model.resource.read').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('model.image.read').success).toBe(false);
  });

  it('defaults legacy models to conversation use and preserves auxiliary-only configurations', () => {
    for (const conversationModel of [undefined, false, true]) {
      const value = {
        ...baseModel,
        credential: { type: 'INLINE_API_KEY', value: 'test-key' },
        ...(conversationModel === undefined ? {} : { conversationModel })
      };
      expect(marAgentRuntimeModelConfigurationSchema.parse(value).conversationModel).toBe(
        conversationModel ?? true
      );
      expect(marAgentStoredModelConfigurationSchema.parse(value).conversationModel).toBe(
        conversationModel ?? true
      );
      expect(
        marAgentModelSummarySchema.parse({
          ...baseModel,
          sortOrder: 0,
          access: 'RESTRICTED',
          ...(conversationModel === undefined ? {} : { conversationModel })
        }).conversationModel
      ).toBe(conversationModel ?? true);
    }
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        apiKey: 'test-key',
        conversationModel: 'false'
      }).success
    ).toBe(false);
  });
});

describe('MAR Agent dynamic credential shared protocol', () => {
  it.each(['1.1', '2'])(
    'accepts HTTP/%s continuation without adding a storage setting',
    (httpVersion) => {
      const model = {
        ...baseModel,
        apiKey: 'test-only',
        responsesTransport: { transport: 'HTTP', httpVersion },
        responsesPreviousResponseId: true
      };
      expect(marAgentRuntimeModelConfigurationSchema.parse(model)).toMatchObject({
        responsesPreviousResponseId: true,
        responsesTransport: { transport: 'HTTP', httpVersion }
      });
      expect(
        marAgentRuntimeCredentialCapabilitySchema.parse({
          apiVersion: 1,
          websocket: true,
          httpVersions: ['1.1', '2'],
          responsesHttpContinuation: true
        }).responsesHttpContinuation
      ).toBe(true);
      expect(
        marAgentRuntimeModelConfigurationSchema.safeParse({
          ...model,
          protocol: 'ANTHROPIC_MESSAGES'
        }).success
      ).toBe(false);
    }
  );

  it('accepts Grok device login, unknown quota and explicit request capability restrictions', () => {
    expect(
      codexLoginAttemptSchema.safeParse({
        id: 'grok',
        type: 'XAI_OAUTH',
        status: 'PENDING',
        userCode: 'CODE',
        verificationUri: 'https://auth.x.ai/device',
        expiresAt: 1000,
        pollIntervalMs: 5000
      }).success
    ).toBe(true);
    const parameters = {
      reasoningEffort: false,
      reasoningSummary: false,
      textVerbosity: false,
      promptCacheKey: false,
      nativeTools: false
    };
    expect(
      marAgentRuntimeModelConfigurationSchema.parse({
        ...baseModel,
        apiKey: 'test',
        responsesOptionalParameters: parameters
      }).responsesOptionalParameters
    ).toEqual(parameters);
    expect(
      marAgentRuntimeCredentialCapabilitySchema.parse({
        apiVersion: 1,
        websocket: false,
        httpVersions: ['1.1'],
        responsesOptionalParameters: true
      }).responsesOptionalParameters
    ).toBe(true);
    const quota = {
      runner: 'mar-agent',
      windows: [],
      fetchedAt: 100,
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
        period: 'UNKNOWN',
        usedPercentage: null,
        startsAt: null,
        resetsAt: null,
        prepaidBalanceCents: null
      }
    };
    expect(codexCredentialUsageSchema.safeParse(quota).success).toBe(true);
    expect(
      codexCredentialUsageSchema.safeParse({ ...quota, subscription: undefined }).success
    ).toBe(false);
    expect(
      codexCredentialUsageSchema.safeParse({
        ...quota,
        subscription: { ...quota.subscription, usedPercentage: -1 }
      }).success
    ).toBe(false);
  });
  it.each(['STANDARD', 'LITE'])(
    'rejects obsolete encoding %s in stored configuration',
    (responsesEncoding) => {
      const configuration = {
        ...baseModel,
        credential: { type: 'CREDENTIAL_REF', credentialId: 'credential-1' }
      };
      expect(marAgentStoredModelConfigurationSchema.safeParse(configuration).success).toBe(true);
      expect(
        marAgentStoredModelConfigurationSchema.safeParse({ ...configuration, responsesEncoding })
          .success
      ).toBe(false);
    }
  );

  it.each(['STANDARD', 'LITE', 'invalid'])(
    'strips obsolete encoding %s from runtime snapshots',
    (responsesEncoding) => {
      expect(
        marAgentRuntimeModelConfigurationSchema.parse({
          ...baseModel,
          apiKey: 'test-key',
          responsesEncoding
        })
      ).not.toHaveProperty('responsesEncoding');
    }
  );

  it('exposes only the credential type and transport in public model summaries', () => {
    const parsed = marAgentModelSummarySchema.parse({
      ...baseModel,
      sortOrder: 0,
      access: 'RESTRICTED',
      credentialType: 'CREDENTIAL_REF',
      credentialConfigured: true,
      lastTestedAt: null,
      lastTestStatus: 'UNVERIFIED',
      lastTestCode: null
    });

    expect(parsed).toMatchObject({
      credentialType: 'CREDENTIAL_REF',
      credentialConfigured: true,
      responsesTransport: { transport: 'WEBSOCKET' }
    });
    expect(JSON.stringify(parsed)).not.toContain('credential-1');
    expect(JSON.stringify(parsed)).not.toContain('token');
  });

  it('defaults Code Mode capability to disabled and allows models to enable it explicitly', () => {
    expect(
      marAgentModelSummarySchema.parse({
        ...baseModel,
        sortOrder: 0,
        access: 'RESTRICTED'
      }).codeMode
    ).toBe(false);
    expect(
      marAgentRuntimeModelConfigurationSchema.parse({
        ...baseModel,
        codeMode: true,
        apiKey: 'static-key'
      }).codeMode
    ).toBe(true);
  });

  it('rejects the removed high-density option in public model summaries', () => {
    expect(
      marAgentModelSummarySchema.safeParse({
        ...baseModel,
        highDensityCompaction: true,
        sortOrder: 0,
        access: 'RESTRICTED'
      }).success
    ).toBe(false);
    expect(
      marAgentRuntimeModelConfigurationSchema.parse({
        ...baseModel,
        highDensityCompaction: true,
        apiKey: 'static-key'
      })
    ).not.toHaveProperty('highDensityCompaction');
  });

  it('preserves the Responses configuration-update capability on runtime models', () => {
    expect(
      marAgentRuntimeModelConfigurationSchema.parse({
        ...baseModel,
        apiKey: 'static-key',
        responsesConfigurationUpdates: false
      }).responsesConfigurationUpdates
    ).toBe(false);
  });

  it('accepts missing Fast capability and model flag from older Nodes', () => {
    const capability = { apiVersion: 1, websocket: true, httpVersions: ['1.1'] };
    expect(marAgentRuntimeCredentialCapabilitySchema.parse(capability).fastMode).toBeUndefined();
    expect(
      marAgentRuntimeCredentialCapabilitySchema.parse({ ...capability, fastMode: true }).fastMode
    ).toBe(true);
    const legacy = { ...baseModel, sortOrder: 0, access: 'RESTRICTED' };
    expect(marAgentModelSummarySchema.parse(legacy).fastMode).toBeUndefined();
    expect(
      marAgentRuntimeModelConfigurationSchema.parse({ ...baseModel, apiKey: 'key', fastMode: true })
        .fastMode
    ).toBe(true);
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        protocol: 'ANTHROPIC_MESSAGES',
        hostedWebSearch: false,
        responsesTransport: undefined,
        responsesPreviousResponseId: false,
        apiKey: 'key',
        fastMode: true
      }).success
    ).toBe(false);
  });

  it('preserves standard Responses service tiers and rejects invalid or non-Responses tiers', () => {
    for (const serviceTier of ['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast']) {
      expect(
        marAgentRuntimeModelConfigurationSchema.parse({ ...baseModel, apiKey: 'key', serviceTier })
          .serviceTier
      ).toBe(serviceTier);
      expect(
        marAgentModelSummarySchema.parse({
          ...baseModel,
          sortOrder: 0,
          access: 'RESTRICTED',
          serviceTier
        }).serviceTier
      ).toBe(serviceTier);
    }
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        apiKey: 'key',
        serviceTier: 'invalid'
      }).success
    ).toBe(false);
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        protocol: 'ANTHROPIC_MESSAGES',
        hostedWebSearch: false,
        responsesTransport: undefined,
        responsesPreviousResponseId: false,
        apiKey: 'key',
        serviceTier: 'default'
      }).success
    ).toBe(false);
    expect(
      marAgentRuntimeCredentialCapabilitySchema.parse({
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1'],
        serviceTiers: ['default', 'priority', 'ultrafast']
      }).serviceTiers
    ).toEqual(['default', 'priority', 'ultrafast']);
  });

  it('drops future runtime model fields but still validates known fields and credentials', () => {
    const runtime = { ...baseModel, apiKey: 'key', futureOption: { enabled: true } };
    const parsed = marAgentRuntimeModelConfigurationSchema.parse(runtime);
    expect(parsed).not.toHaveProperty('futureOption');
    expect(parsed.apiKey).toBe('key');
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...runtime,
        maxOutputTokens: 300_000
      }).success
    ).toBe(false);
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        credential: { type: 'INLINE_API_KEY', value: 'key', futureOption: true }
      }).success
    ).toBe(false);
  });

  it('keeps runtime configuration compatible with legacy static keys and strict inline or ticket credentials', () => {
    expect(
      marAgentRuntimeModelConfigurationSchema.parse({
        ...baseModel,
        apiKey: 'legacy-static-key'
      })
    ).toMatchObject({ apiKey: 'legacy-static-key' });

    expect(
      marAgentRuntimeModelConfigurationSchema.parse({
        ...baseModel,
        credential: { type: 'INLINE_API_KEY', value: 'static-key' }
      })
    ).toMatchObject({ credential: { type: 'INLINE_API_KEY', value: 'static-key' } });

    expect(
      marAgentRuntimeModelConfigurationSchema.parse({
        ...baseModel,
        credential: {
          type: 'RUNTIME_TICKET',
          credentialId: 'credential-1',
          ticket
        }
      })
    ).toMatchObject({ credential: { type: 'RUNTIME_TICKET', credentialId: 'credential-1' } });

    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        apiKey: 'legacy-static-key',
        credential: { type: 'INLINE_API_KEY', value: 'static-key' }
      }).success
    ).toBe(false);
  });

  it('uses an independent Provider ticket for image generation without depending on the active model credential or IMAGE input', () => {
    const imageTicket = {
      ...ticket,
      allowedModelIds: ['image-generation'],
      purpose: 'IMAGE_GENERATION' as const
    };
    const imageGeneration = {
      provider: 'CODEX',
      config: { credentialId: 'credential-1', modelId: 'gpt-image-2' },
      generateEndpoint: 'https://chatgpt.com/backend-api/codex/images/generations',
      editEndpoint: 'https://chatgpt.com/backend-api/codex/images/edits',
      imageModelId: 'gpt-image-2',
      httpVersion: '1.1',
      credential: {
        type: 'RUNTIME_TICKET',
        credentialId: 'credential-1',
        ticket: imageTicket
      }
    } as const;

    expect(
      marAgentRuntimeModelConfigurationSchema.parse({
        ...baseModel,
        protocol: 'ANTHROPIC_MESSAGES',
        hostedWebSearch: false,
        responsesTransport: undefined,
        responsesPreviousResponseId: false,
        inputCapabilities: ['TEXT'],
        credential: { type: 'INLINE_API_KEY', value: 'coding-key' },
        imageGeneration
      })
    ).toMatchObject({ imageGeneration });
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        credential: { type: 'INLINE_API_KEY', value: 'coding-key' },
        imageGeneration: {
          ...imageGeneration,
          credential: {
            ...imageGeneration.credential,
            ticket: { ...imageTicket, purpose: 'MODEL' }
          }
        }
      }).success
    ).toBe(false);
  });

  it('allows explicit WS or HTTP versions only for Responses and rejects cross-protocol fields', () => {
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        responsesTransport: { transport: 'HTTP', httpVersion: '2' },
        credential: { type: 'INLINE_API_KEY', value: 'static-key' }
      }).success
    ).toBe(true);
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        protocol: 'ANTHROPIC_MESSAGES',
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        responsesTransport: { transport: 'WEBSOCKET' },
        credential: { type: 'INLINE_API_KEY', value: 'static-key' }
      }).success
    ).toBe(false);
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...baseModel,
        responsesTransport: { transport: 'HTTP', httpVersion: '3' },
        credential: { type: 'INLINE_API_KEY', value: 'static-key' }
      }).success
    ).toBe(false);
  });

  it('strictly binds runtime tickets and resolution messages to the user, Node, Workspace, scope, model, and execution', () => {
    expect(runtimeCredentialTicketSchema.parse(ticket)).toEqual(ticket);
    expect(
      runtimeCredentialTicketSchema.safeParse({
        ...ticket,
        expiresAt: ticket.issuedAt + 24 * 60 * 60 * 1000 + 1
      }).success
    ).toBe(false);
    expect(
      runtimeCredentialResolveRequestSchema.parse({
        ticket,
        modelId: 'model-codex',
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1',
        reason: 'REQUEST'
      })
    ).toMatchObject({ modelId: 'model-codex', executionId: 'execution-1' });
    expect(
      runtimeCredentialResolveResponseSchema.parse({
        credential: {
          bearer: 'access-token',
          headers: {
            'ChatGPT-Account-ID': 'account-1',
            originator: 'myagentroam'
          },
          socks5Url: 'socks5://proxy.example.test:1080',
          expiresAt: 901_000,
          revision: 7
        },
        nextTicket: { ...ticket, nonce: 'nonce-2', signature: 'b'.repeat(64) }
      })
    ).toMatchObject({ credential: { revision: 7 } });
    expect(
      runtimeCredentialResolveRequestSchema.safeParse({
        ticket,
        credentialId: 'credential-1',
        modelId: 'model-codex',
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1',
        reason: 'REQUEST'
      }).success
    ).toBe(false);
  });

  it('declares the dynamic credential version and actual transport in Node capability', () => {
    expect(
      marAgentRuntimeCredentialCapabilitySchema.parse({
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1', '2']
      })
    ).toEqual({ apiVersion: 1, websocket: true, httpVersions: ['1.1', '2'] });

    const capabilities = nodeCapabilitiesSchema.parse({
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.9.27',
      nodeVersion: 'v24.15.0',
      codex: { available: true },
      claudeCode: { available: true },
      marAgent: { available: true, version: '0.9.27' },
      marAgentRuntimeCredentials: {
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1', '2']
      }
    });
    expect(capabilities.marAgentRuntimeCredentials?.httpVersions).toEqual(['1.1', '2']);
  });

  it('uses a closed Node operation and strict result for model transport tests', () => {
    expect(workbenchNodeOperationSchema.parse('mar-agent.model.test')).toBe('mar-agent.model.test');
    expect(
      marAgentModelTransportTestInputSchema.parse({
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1',
        model: {
          ...baseModel,
          credential: {
            type: 'RUNTIME_TICKET',
            credentialId: 'credential-1',
            ticket
          }
        }
      })
    ).toMatchObject({
      runtimeScopeId: 'scope-1',
      executionId: 'execution-1',
      model: { id: 'model-codex' }
    });
    expect(
      marAgentModelTransportTestResultSchema.parse({
        success: false,
        code: 'invalid_request_error',
        message: 'Store must be set to false',
        httpStatus: 400
      })
    ).toEqual({
      success: false,
      code: 'invalid_request_error',
      message: 'Store must be set to false',
      httpStatus: 400
    });
    expect(
      marAgentModelTransportTestResultSchema.safeParse({
        success: true,
        code: null,
        message: null,
        httpStatus: 400
      }).success
    ).toBe(false);
  });

  it('accepts bounded optional transport diagnostics without permitting arbitrary response headers', () => {
    const result = {
      success: false,
      code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      message: 'Upgrade required',
      httpStatus: 426,
      requestId: 'server-request',
      response: {
        body: '{"error":"Upgrade required"}',
        bodyTruncated: false,
        contentType: 'application/json',
        requestId: 'upstream-request',
        retryAfter: null
      }
    };
    expect(marAgentModelTransportTestResultSchema.parse(result)).toEqual(result);
    for (const response of [
      { ...result.response, body: 'x'.repeat(4097) },
      { ...result.response, requestId: 'x'.repeat(257) },
      { ...result.response, headers: { authorization: 'private' } }
    ])
      expect(
        marAgentModelTransportTestResultSchema.safeParse({ ...result, response }).success
      ).toBe(false);
  });

  it('returns the full account ID without custom metadata or model reference counts in Codex list DTOs', () => {
    expect(
      codexCredentialOwnershipSchema.parse({
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: 4
      })
    ).toEqual({ ownerType: 'ORGANIZATION', ownerOrganizationId: 4 });
    expect(
      codexCredentialOwnershipSchema.safeParse({
        ownerType: 'ENTERPRISE',
        ownerOrganizationId: 4
      }).success
    ).toBe(false);
    const credential = codexCredentialSummarySchema.parse({
      id: 'credential-1',
      name: 'Team Codex',
      type: 'CODEX_OAUTH',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      status: 'ACTIVE',
      accessTokenExpiresAt: 901_000,
      lastRefreshAt: 1_000,
      lastCheckedAt: 2_000,
      accountId: 'a'.repeat(512),
      proxy: {
        configured: true,
        host: 'proxy.example.test',
        port: 1080,
        hasUsername: true
      },
      revision: 3
    });
    expect(credential).toMatchObject({
      status: 'ACTIVE',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      accountId: 'a'.repeat(512),
      revision: 3
    });
    expect(
      codexCredentialSummarySchema.safeParse({
        ...credential,
        accountId: 'a'.repeat(513)
      }).success
    ).toBe(false);
    expect(
      codexCredentialSummarySchema.safeParse({
        ...credential,
        custom: { environment: 'team' }
      }).success
    ).toBe(false);
    expect(
      codexCredentialSummarySchema.safeParse({
        ...credential,
        importedModelCount: 2
      }).success
    ).toBe(false);
    expect(
      codexCredentialDetailsSchema.parse({
        credential,
        socks5Url: 'socks5://user:password@proxy.example.test:1080'
      })
    ).toMatchObject({
      credential: { id: 'credential-1' },
      socks5Url: 'socks5://user:password@proxy.example.test:1080'
    });
    expect(
      codexCredentialUsageSchema.parse({
        runner: 'codex',
        windows: [
          {
            id: 'five_hour',
            label: '5-hour limit',
            usedPercentage: 25,
            resetsAt: 1_000
          }
        ],
        fetchedAt: 1_000,
        cached: false,
        profile: {
          lifetimeTokens: 420_200_000,
          currentDayTokens: 7_000_000,
          lastSevenDaysTokens: 31_000_000,
          statsAsOf: '2026-09-17',
          dailyUsageBuckets: [{ startDate: '2026-09-17', tokens: 7_000_000 }]
        }
      })
    ).toMatchObject({
      profile: {
        lifetimeTokens: 420_200_000,
        statsAsOf: '2026-09-17'
      }
    });
    expect(
      codexCredentialUsageSchema.safeParse({
        runner: 'codex',
        windows: [],
        fetchedAt: 1_000,
        cached: false,
        profile: {
          lifetimeTokens: 1,
          currentDayTokens: 1,
          lastSevenDaysTokens: 1,
          statsAsOf: '2026-09-17',
          dailyUsageBuckets: [
            { startDate: '2026-09-17', tokens: 1 },
            { startDate: '2026-09-17', tokens: 2 }
          ]
        }
      }).success
    ).toBe(false);

    expect(
      codexLoginAttemptSchema.parse({
        id: 'attempt-1',
        status: 'PENDING',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.openai.com/codex/device',
        expiresAt: 100_000,
        pollIntervalMs: 5_000
      })
    ).not.toHaveProperty('deviceAuthId');

    expect(
      codexModelCatalogSchema.parse({
        catalogHash: 'c'.repeat(64),
        fetchedAt: 10_000,
        models: [
          {
            upstreamModelId: 'gpt-5.6-codex',
            displayName: 'GPT-5.6 Codex',
            reasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'high',
            unsupportedReasoningEfforts: ['extreme'],
            inputCapabilities: ['TEXT'],
            hostedWebSearch: false,
            warnings: ['Unsupported reasoning effort: extreme'],
            requiredInputs: ['contextWindowTokens']
          }
        ]
      }).models[0]
    ).toMatchObject({
      defaultReasoningEffort: 'high',
      unsupportedReasoningEfforts: ['extreme'],
      requiredInputs: ['contextWindowTokens']
    });
    expect(
      codexModelCatalogSchema.safeParse({
        catalogHash: 'c'.repeat(64),
        fetchedAt: 10_000,
        models: [
          {
            upstreamModelId: 'gpt-5.6-codex',
            displayName: 'GPT-5.6 Codex',
            reasoningEfforts: ['low'],
            defaultReasoningEffort: 'high',
            unsupportedReasoningEfforts: [],
            inputCapabilities: ['TEXT'],
            hostedWebSearch: false,
            warnings: [],
            requiredInputs: ['contextWindowTokens']
          }
        ]
      }).success
    ).toBe(false);

    expect(
      codexModelImportRequestSchema.parse({
        catalogHash: 'c'.repeat(64),
        models: [
          {
            upstreamModelId: 'gpt-5.6-codex',
            enabled: true
          }
        ]
      })
    ).toMatchObject({ models: [{ upstreamModelId: 'gpt-5.6-codex' }] });
    expect(
      codexModelImportRequestSchema.safeParse({
        catalogHash: 'c'.repeat(64),
        models: [
          {
            upstreamModelId: 'gpt-5.6-codex',
            responsesTransport: { transport: 'HTTP', httpVersion: '2' },
            enabled: true
          }
        ]
      }).success
    ).toBe(false);
    expect(
      codexModelImportResultSchema.parse({
        items: [
          {
            upstreamModelId: 'gpt-5.6-codex',
            status: 'CREATED',
            modelId: 'model-codex'
          },
          {
            upstreamModelId: 'unknown',
            status: 'BLOCKED',
            code: 'CODEX_MODEL_IMPORT_BLOCKED'
          }
        ]
      })
    ).toHaveProperty(
      'items',
      expect.arrayContaining([expect.objectContaining({ status: 'BLOCKED' })])
    );
  });
});
