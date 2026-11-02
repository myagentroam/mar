import { describe, expect, it, vi } from 'vitest';
import type { MarAgentStoredModelConfiguration } from '@myagentroam/protocol';
import { MarAgentRuntimeModelService } from '../../src/mar-agent-runtime-model-service.js';

function model(
  id: string,
  credential:
    | { readonly type: 'INLINE_API_KEY'; readonly value: string }
    | { readonly type: 'CREDENTIAL_REF'; readonly credentialId: string },
  responsesTransport:
    | { readonly transport: 'WEBSOCKET' }
    | { readonly transport: 'HTTP'; readonly httpVersion: '1.1' | '2' }
    | undefined = undefined
): MarAgentStoredModelConfiguration {
  return {
    id,
    name: id,
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    credential,
    modelId: id,
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    hostedWebSearch: false,
    ...(responsesTransport === undefined ? {} : { responsesTransport }),
    responsesPreviousResponseId: true,
    enabled: true
  };
}

describe('Server MAR Agent runtime model service', () => {
  it('requires explicit Node capability only when GC is disabled', async () => {
    const configured = {
      ...model('api', { type: 'INLINE_API_KEY', value: 'key' }),
      responsesPreviousResponseId: false,
      gcEnabled: false
    };
    let supported = false;
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [configured]),
        stored: vi.fn(async () => configured)
      },
      tickets: { issue: vi.fn() },
      capability: () => ({
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1'],
        contextGcControl: supported
      })
    });
    const context = { userId: 1, nodeId: 'node', workspaceId: 'workspace' };
    await expect(service.prepare(context)).rejects.toThrow('CAPABILITY_VERSION_UNSUPPORTED');
    supported = true;
    await expect(service.prepare(context)).resolves.toMatchObject({
      models: [{ gcEnabled: false }]
    });
    supported = false;
    configured.gcEnabled = true;
    await expect(service.prepare(context)).resolves.toMatchObject({
      models: [{ gcEnabled: true }]
    });
  });
  it('keeps auxiliary models for generation while refusing them as conversation models', async () => {
    const conversation = model('conversation', { type: 'INLINE_API_KEY', value: 'key' });
    const auxiliary = {
      ...model('auxiliary', { type: 'INLINE_API_KEY', value: 'key' }),
      conversationModel: false
    };
    const issue = vi.fn();
    let supportsConversationModels = true;
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [auxiliary, conversation]),
        stored: vi.fn(async () => auxiliary)
      },
      tickets: { issue },
      capability: () => ({
        apiVersion: 1,
        conversationModels: supportsConversationModels,
        responsesHttpContinuation: true,
        websocket: true,
        httpVersions: ['1.1', '2']
      })
    });
    const context = { userId: 7, nodeId: 'node-1', workspaceId: 'workspace-1' };
    expect(await service.prepare({ ...context, selectedModelId: 'conversation' })).toMatchObject({
      model: { id: 'conversation', conversationModel: true },
      models: [
        { id: 'auxiliary', conversationModel: false },
        { id: 'conversation', conversationModel: true }
      ]
    });
    await expect(service.prepare({ ...context, selectedModelId: 'auxiliary' })).rejects.toThrow(
      'MAR_AGENT_MODEL_DISABLED'
    );
    supportsConversationModels = false;
    await expect(service.prepare({ ...context, selectedModelId: 'conversation' })).rejects.toThrow(
      'CAPABILITY_VERSION_UNSUPPORTED'
    );
    expect(
      await service.preparePromptCompletion({ ...context, selectedModelId: 'auxiliary' })
    ).toMatchObject({
      model: { id: 'auxiliary', conversationModel: false }
    });
    expect(await service.prepareTest({ ...context, modelId: 'auxiliary' })).toMatchObject({
      model: { id: 'auxiliary' }
    });
    expect(issue).not.toHaveBeenCalled();
  });
  it('projects inline HTTP continuation and rejects Nodes without that capability', async () => {
    const configured: MarAgentStoredModelConfiguration = {
      ...model(
        'api',
        { type: 'INLINE_API_KEY', value: 'test-only' },
        { transport: 'HTTP', httpVersion: '1.1' }
      ),
      baseUrl: 'https://api.openai.com/v1'
    };
    let supportsHttpContinuation = true;
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [configured]),
        stored: vi.fn(async () => configured)
      },
      tickets: { issue: vi.fn() },
      capability: () => ({
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1'],
        responsesHttpContinuation: supportsHttpContinuation
      })
    });
    const context = { userId: 1, nodeId: 'node', workspaceId: 'workspace' };
    await expect(service.prepare(context)).resolves.toMatchObject({
      models: [
        {
          responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
          responsesPreviousResponseId: true
        }
      ]
    });
    supportsHttpContinuation = false;
    await expect(service.prepare(context)).rejects.toThrow(
      'MAR_AGENT_MODEL_HTTP_CONTINUATION_UNAVAILABLE'
    );
    configured.responsesPreviousResponseId = false;
    await expect(service.prepare(context)).resolves.toMatchObject({
      models: [{ responsesPreviousResponseId: false }]
    });
  });
  it.each(
    [true, false].flatMap((hostedWebSearch) => [
      {
        hostedWebSearch,
        responsesPreviousResponseId: true,
        responsesTransport: { transport: 'HTTP' as const, httpVersion: '1.1' as const }
      },
      ...[true, false].map((responsesPreviousResponseId) => ({
        hostedWebSearch,
        responsesPreviousResponseId,
        responsesTransport: { transport: 'WEBSOCKET' as const }
      }))
    ])
  )(
    'projects Grok hosted search $hostedWebSearch over $responsesTransport.transport without Codex fields and rejects older Nodes',
    async ({ hostedWebSearch, responsesTransport, responsesPreviousResponseId }) => {
      const configured = {
        ...model(
          'grok',
          { type: 'CREDENTIAL_REF', credentialId: 'grok-credential' },
          responsesTransport
        ),
        baseUrl: 'https://cli-chat-proxy.grok.com/v1',
        hostedWebSearch,
        responsesPreviousResponseId,
        serviceTier: 'default' as const,
        reasoningEfforts: []
      };
      let supported = true;
      const issue = vi.fn(async (input) => ({
        ...input,
        issuedAt: 1,
        expiresAt: 100,
        nonce: 'nonce',
        signature: 'a'.repeat(64)
      }));
      const service = new MarAgentRuntimeModelService({
        models: {
          storedConfigurationsForUser: vi.fn(async () => [configured]),
          stored: vi.fn(async () => configured)
        },
        capability: () => ({
          apiVersion: 1,
          responsesHttpContinuation: true,
          websocket: true,
          httpVersions: ['1.1'],
          responsesOptionalParameters: supported,
          serviceTiers: ['default', 'priority']
        }),
        tickets: { issue }
      });
      const value = (await service.prepare({ userId: 1, nodeId: 'node', workspaceId: 'workspace' }))
        .models[0]!;
      expect(value).toMatchObject({
        hostedWebSearch,
        responsesConfigurationUpdates: false,
        responsesPreviousResponseId,
        responsesTransport,
        responsesOptionalParameters: {
          reasoningEffort: false,
          reasoningSummary: false,
          textVerbosity: false,
          promptCacheKey: false
        }
      });
      expect(value.serviceTier).toBeUndefined();
      expect(value.responsesToolNamespace).toBeUndefined();
      issue.mockClear();
      supported = false;
      await expect(
        service.prepare({ userId: 1, nodeId: 'old', workspaceId: 'workspace' })
      ).rejects.toThrow('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
      expect(issue).not.toHaveBeenCalled();
    }
  );
  it('shares a ChatGPT credential across compatible Nodes with WS previous and distinct tickets', async () => {
    const configured = {
      ...model(
        'chatgpt',
        { type: 'CREDENTIAL_REF', credentialId: 'shared' },
        { transport: 'WEBSOCKET' }
      ),
      baseUrl: 'https://api.openai.com/v1',
      responsesPreviousResponseId: true
    };
    let supported = true;
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [configured]),
        stored: vi.fn(async () => configured)
      },
      capability: () => ({
        apiVersion: 1,
        responsesHttpContinuation: true,
        websocket: true,
        namespacedTools: supported,
        httpVersions: ['1.1', '2']
      }),
      tickets: {
        issue: vi.fn(async (input) => ({
          ...input,
          issuedAt: 1,
          expiresAt: 100,
          nonce: 'nonce',
          signature: 'a'.repeat(64)
        }))
      }
    });
    for (const nodeId of ['remote-one', 'remote-two']) {
      const value = (await service.prepare({ userId: 7, nodeId, workspaceId: 'workspace' }))
        .models[0]!;
      expect(value).toMatchObject({
        responsesToolNamespace: 'mar',
        responsesConfigurationUpdates: false,
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true,
        credential: { type: 'RUNTIME_TICKET', ticket: { credentialId: 'shared', nodeId } }
      });
      expect(JSON.stringify(value)).not.toContain('refreshToken');
    }
    supported = false;
    await expect(
      service.prepare({ userId: 7, nodeId: 'old-node', workspaceId: 'workspace' })
    ).rejects.toThrow('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
  });
  it('enables native configuration updates only for Codex credential targets', async () => {
    const configured = model(
      'codex',
      { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
      { transport: 'WEBSOCKET' }
    );
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [configured]),
        stored: vi.fn(async () => configured)
      },
      capability: () => ({
        apiVersion: 1,
        responsesHttpContinuation: true,
        websocket: true,
        httpVersions: ['1.1']
      }),
      tickets: {
        issue: vi.fn(async (input) => ({
          ...input,
          issuedAt: 1,
          expiresAt: 100,
          nonce: 'nonce',
          signature: 'a'.repeat(64)
        }))
      }
    });
    await expect(
      service.prepare({ userId: 7, nodeId: 'node-1', workspaceId: 'workspace' })
    ).resolves.toMatchObject({
      models: [expect.objectContaining({ responsesConfigurationUpdates: true })]
    });
  });
  it('sends Fast only to Nodes that advertise support, including test requests', async () => {
    const configured = {
      ...model(
        'codex-fast',
        { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
        { transport: 'WEBSOCKET' }
      ),
      serviceTier: 'priority'
    };
    let supported = false;
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [configured]),
        stored: vi.fn(async () => configured)
      },
      tickets: {
        issue: vi.fn(async () => ({
          userId: 7,
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          credentialId: 'credential-1',
          runtimeScopeId: 'scope-1',
          allowedModelIds: ['codex-fast'],
          issuedAt: 1,
          expiresAt: 100,
          nonce: 'nonce',
          signature: 'a'.repeat(64)
        }))
      },
      capability: () => ({
        apiVersion: 1,
        responsesHttpContinuation: true,
        websocket: true,
        httpVersions: ['1.1', '2'],
        ...(supported ? { serviceTiers: ['priority'] as const } : { fastMode: true })
      })
    });
    const context = { userId: 7, nodeId: 'node-1', workspaceId: 'workspace-1' };
    await expect(service.prepare(context)).rejects.toThrow(
      'MAR_AGENT_MODEL_SERVICE_TIER_UNAVAILABLE'
    );
    await expect(service.prepareTest({ ...context, modelId: 'codex-fast' })).rejects.toThrow(
      'MAR_AGENT_MODEL_SERVICE_TIER_UNAVAILABLE'
    );
    supported = true;
    expect((await service.prepare(context)).models[0]?.serviceTier).toBe('priority');
    expect(
      (await service.prepareTest({ ...context, modelId: 'codex-fast' })).model.serviceTier
    ).toBe('priority');
  });

  it.each(['default', 'priority', 'ultrafast', 'auto', 'flex', 'fast'] as const)(
    'projects standard tier %s without degrading it on unsupported Nodes',
    async (serviceTier) => {
      const configured = {
        ...model('standard', { type: 'INLINE_API_KEY', value: 'key' }),
        baseUrl: 'https://api.openai.com/v1',
        serviceTier
      };
      let modern = true;
      const service = new MarAgentRuntimeModelService({
        models: {
          storedConfigurationsForUser: vi.fn(async () => [configured]),
          stored: vi.fn(async () => configured)
        },
        tickets: { issue: vi.fn() },
        capability: () => ({
          apiVersion: 1,
          responsesHttpContinuation: true,
          websocket: true,
          httpVersions: ['1.1', '2'],
          ...(modern
            ? {
                serviceTiers: ['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast'] as const
              }
            : { fastMode: true })
        })
      });
      const context = { userId: 7, nodeId: 'node', workspaceId: 'workspace' };
      expect((await service.prepare(context)).models[0]).toMatchObject({ serviceTier });
      expect((await service.prepareTest({ ...context, modelId: 'standard' })).model).toMatchObject({
        serviceTier
      });
      modern = false;
      if (serviceTier === 'default') {
        expect((await service.prepare(context)).models[0]).not.toHaveProperty('serviceTier');
      } else {
        await expect(service.prepare(context)).rejects.toThrow(
          'MAR_AGENT_MODEL_SERVICE_TIER_UNAVAILABLE'
        );
        await expect(service.prepareTest({ ...context, modelId: 'standard' })).rejects.toThrow(
          'MAR_AGENT_MODEL_SERVICE_TIER_UNAVAILABLE'
        );
      }
    }
  );

  it('uses the configured Ark URL unchanged for both generation and editing', async () => {
    const url = 'https://images.example.test/custom/generate';
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [
          {
            ...model('static-model', { type: 'INLINE_API_KEY', value: 'text-key' }),
            responsesPreviousResponseId: false
          }
        ])
      },
      imageGeneration: {
        forUser: vi.fn(async () => ({
          id: 'ark-image',
          name: 'Ark image',
          enabled: true,
          provider: 'BYTED_ARK' as const,
          config: { url, modelId: 'explicit-image-model', apiKey: 'image-key' }
        }))
      },
      tickets: { issue: vi.fn() },
      capability: () => undefined,
      id: () => 'scope-1'
    });
    const result = await service.prepare({
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      selectedModelId: 'static-model'
    });
    expect(result.model?.imageGeneration).toMatchObject({
      provider: 'BYTED_ARK',
      generateEndpoint: url,
      editEndpoint: url,
      imageModelId: 'explicit-image-model',
      credential: { type: 'INLINE_API_KEY', value: 'image-key' }
    });
  });
  it('keeps static keys compatible and groups credential-reference models onto one scoped ticket', async () => {
    const values = [
      model('static-model', { type: 'INLINE_API_KEY', value: 'static-secret' }),
      {
        ...model(
          'codex-primary',
          { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
          { transport: 'WEBSOCKET' }
        ),
        inputCapabilities: ['TEXT', 'IMAGE'] as const
      },
      model(
        'codex-review',
        { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
        { transport: 'HTTP', httpVersion: '2' }
      )
    ];
    const issue = vi.fn(async (input) => ({
      ...input,
      issuedAt: 10,
      expiresAt: 900_010,
      nonce: 'nonce-1',
      signature: 'a'.repeat(64)
    }));
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => values)
      },
      imageGeneration: {
        forUser: vi.fn(async () => ({
          id: 'image-1',
          name: 'Image',
          enabled: true,
          provider: 'CODEX' as const,
          config: { credentialId: 'credential-1', modelId: 'gpt-image-2' }
        }))
      },
      tickets: { issue },
      capability: () => ({
        apiVersion: 1,
        responsesHttpContinuation: true,
        resourceInput: true,
        websocket: true,
        httpVersions: ['1.1', '2']
      }),
      id: () => 'scope-1'
    });

    const result = await service.prepare({
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      selectedModelId: 'codex-primary'
    });

    expect(result.runtimeScopeId).toBe('scope-1');
    expect(result.model).toMatchObject({
      id: 'codex-primary',
      codeMode: false,
      defaultReasoningEffort: 'high',
      credential: {
        type: 'RUNTIME_TICKET',
        credentialId: 'credential-1',
        ticket: { runtimeScopeId: 'scope-1' }
      },
      imageGeneration: {
        generateEndpoint: 'https://chatgpt.com/backend-api/codex/images/generations',
        editEndpoint: 'https://chatgpt.com/backend-api/codex/images/edits',
        imageModelId: 'gpt-image-2',
        httpVersion: '1.1'
      }
    });
    expect(result.models.find((entry) => entry.id === 'static-model')).toMatchObject({
      credential: { type: 'INLINE_API_KEY', value: 'static-secret' }
    });
    const primaryTicket = result.models.find((entry) => entry.id === 'codex-primary')!.credential;
    const reviewTicket = result.models.find((entry) => entry.id === 'codex-review')!.credential;
    expect(primaryTicket).toEqual(reviewTicket);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenNthCalledWith(1, {
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['codex-primary', 'codex-review']
    });
    expect(issue).toHaveBeenNthCalledWith(2, {
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['image-generation'],
      purpose: 'IMAGE_GENERATION'
    });
    expect(JSON.stringify(result)).not.toContain('account-secret');
  });

  it('preserves explicit model-level runtime capabilities', async () => {
    const configured: MarAgentStoredModelConfiguration = {
      ...model('static-model', { type: 'INLINE_API_KEY', value: 'key' }),
      responsesPreviousResponseId: false,
      codeMode: true
    };
    const service = new MarAgentRuntimeModelService({
      models: { storedConfigurationsForUser: vi.fn(async () => [configured]) },
      tickets: { issue: vi.fn() },
      capability: () => undefined,
      id: () => 'scope-1'
    });

    const result = await service.prepare({
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      selectedModelId: configured.id
    });

    expect(result.model?.codeMode).toBe(true);
    expect(result.model).not.toHaveProperty('highDensityCompaction');
  });

  it('uses a new runtime scope for every operation and rejects unavailable transports', async () => {
    let nextScope = 0;
    const values = [
      model(
        'codex-primary',
        { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
        { transport: 'WEBSOCKET' }
      )
    ];
    const createService = (
      capability: () => {
        apiVersion: 1;
        websocket: boolean;
        httpVersions: ('1.1' | '2')[];
      }
    ) =>
      new MarAgentRuntimeModelService({
        models: {
          storedConfigurationsForUser: vi.fn(async () => values)
        },
        tickets: {
          issue: vi.fn(async (input) => ({
            ...input,
            issuedAt: 10,
            expiresAt: 900_010,
            nonce: 'nonce-1',
            signature: 'a'.repeat(64)
          }))
        },
        capability,
        id: () => `scope-${++nextScope}`
      });
    const supported = createService(() => ({
      apiVersion: 1,
      responsesHttpContinuation: true,
      websocket: true,
      httpVersions: ['1.1', '2']
    }));
    const first = await supported.prepare({
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      selectedModelId: 'codex-primary'
    });
    const second = await supported.prepare({
      userId: 7,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      selectedModelId: 'codex-primary'
    });
    expect(first.runtimeScopeId).not.toBe(second.runtimeScopeId);

    await expect(
      createService(() => ({
        apiVersion: 1,
        responsesHttpContinuation: true,
        websocket: false,
        httpVersions: ['1.1', '2']
      })).prepare({
        userId: 7,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        selectedModelId: 'codex-primary'
      })
    ).rejects.toThrow('MAR_AGENT_MODEL_WEBSOCKET_UNAVAILABLE');
  });

  it('rejects a selected model outside the authorized enabled catalog', async () => {
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [
          model('static-model', { type: 'INLINE_API_KEY', value: 'static-secret' })
        ])
      },
      tickets: { issue: vi.fn() },
      capability: () => undefined
    });

    await expect(
      service.prepare({
        userId: 7,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        selectedModelId: 'restricted-model'
      })
    ).rejects.toThrow('MAR_AGENT_MODEL_FORBIDDEN');
  });

  it('prepares only the selected model for an Admin transport test', async () => {
    const selected = model(
      'codex-primary',
      { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
      { transport: 'HTTP', httpVersion: '2' }
    );
    const issue = vi.fn(async (input) => ({
      ...input,
      issuedAt: 10,
      expiresAt: 900_010,
      nonce: 'nonce-1',
      signature: 'a'.repeat(64)
    }));
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(),
        stored: vi.fn(async () => selected)
      },
      tickets: { issue },
      capability: () => ({
        apiVersion: 1,
        responsesHttpContinuation: true,
        websocket: true,
        httpVersions: ['1.1', '2']
      }),
      id: () => 'scope-test'
    });

    await expect(
      service.prepareTest({
        userId: 7,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        modelId: 'codex-primary'
      })
    ).resolves.toMatchObject({
      runtimeScopeId: 'scope-test',
      model: {
        id: 'codex-primary',
        credential: {
          type: 'RUNTIME_TICKET',
          credentialId: 'credential-1',
          ticket: { runtimeScopeId: 'scope-test' }
        }
      }
    });
    expect(issue).toHaveBeenCalledWith({
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      runtimeScopeId: 'scope-test',
      allowedModelIds: ['codex-primary']
    });
  });

  it('prepares an inline Responses model test with the default HTTP transport', async () => {
    const selected = model('static-model', {
      type: 'INLINE_API_KEY',
      value: 'static-secret'
    });
    const issue = vi.fn();
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(),
        stored: vi.fn(async () => selected)
      },
      tickets: { issue },
      capability: () => ({
        apiVersion: 1,
        responsesHttpContinuation: true,
        websocket: false,
        httpVersions: ['1.1']
      }),
      id: () => 'scope-static-test'
    });

    await expect(
      service.prepareTest({
        userId: 7,
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        modelId: 'static-model'
      })
    ).resolves.toEqual({
      runtimeScopeId: 'scope-static-test',
      model: expect.objectContaining({
        id: 'static-model',
        credential: { type: 'INLINE_API_KEY', value: 'static-secret' }
      })
    });
    expect(issue).not.toHaveBeenCalled();
  });
});
