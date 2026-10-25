import { describe, expect, it, vi } from 'vitest';
import type { MarAgentStoredModelConfiguration } from '../../packages/protocol/src/index.js';
import { MarAgentRuntimeModelService } from '../../ee/server/src/service/mar-agent-runtime-model-service.js';

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
    responsesPreviousResponseId: responsesTransport?.transport === 'WEBSOCKET',
    enabled: true
  };
}

describe('Server MAR Agent runtime model service', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
    [true, undefined, false]
  ])('projects global %s AND model %s resource URLs as %s', async (global, selected, expected) => {
    const configured = {
      ...model('vision', { type: 'INLINE_API_KEY', value: 'test-key' }),
      protocol: 'ANTHROPIC_MESSAGES',
      inputCapabilities: ['TEXT', 'IMAGE'],
      ...(selected === undefined ? {} : { metadata: { useResourceUrl: selected } })
    };
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [configured]),
        resourceInputEnabled: vi.fn(async () => global)
      },
      tickets: { issue: vi.fn() },
      capability: () => ({
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1'],
        resourceInput: true
      })
    });
    const result = await service.prepare({ userId: 7, nodeId: 'node', workspaceId: 'workspace' });
    expect(result.models[0]?.useResourceUrl).toBe(expected);
  });

  it('rejects image delivery on a Node without resource input support', async () => {
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [
          {
            ...model('vision', { type: 'INLINE_API_KEY', value: 'test-key' }),
            protocol: 'ANTHROPIC_MESSAGES',
            inputCapabilities: ['TEXT', 'IMAGE']
          }
        ])
      },
      tickets: { issue: vi.fn() },
      capability: () => ({ apiVersion: 1, websocket: true, httpVersions: ['1.1'] })
    });
    await expect(
      service.prepare({ userId: 7, nodeId: 'node', workspaceId: 'workspace' })
    ).rejects.toThrow('MAR_AGENT_MODEL_RESOURCE_INPUT_UNAVAILABLE');
  });

  it('prepares only the authorized completion model without image or Compact configuration', async () => {
    const selected = model(
      'completion',
      { type: 'CREDENTIAL_REF', credentialId: 'credential' },
      { transport: 'WEBSOCKET' }
    );
    const issue = vi.fn(async (input) => ({
      ...input,
      issuedAt: 10,
      expiresAt: 90_010,
      nonce: 'nonce',
      signature: 'a'.repeat(64)
    }));
    const image = vi.fn();
    const compact = vi.fn();
    const available = vi.fn(async () => [
      selected,
      model('unrelated', { type: 'CREDENTIAL_REF', credentialId: 'other' })
    ]);
    const service = new MarAgentRuntimeModelService({
      models: { storedConfigurationsForUser: available },
      tickets: { issue },
      capability: () => ({ apiVersion: 1, websocket: true, httpVersions: ['1.1', '2'] }),
      imageGeneration: { forUser: image },
      compact: { runtime: compact },
      id: () => 'completion-scope'
    });
    const result = await service.preparePromptCompletion({
      userId: 7,
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session',
      selectedModelId: 'completion'
    });
    expect(available).toHaveBeenCalledWith(7);
    expect(result.model.id).toBe('completion');
    expect(result.model.imageGeneration).toBeUndefined();
    expect(issue).toHaveBeenCalledExactlyOnceWith({
      userId: 7,
      credentialId: 'credential',
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session',
      runtimeScopeId: 'completion-scope',
      allowedModelIds: ['completion']
    });
    expect(image).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    available.mockResolvedValueOnce([]);
    await expect(
      service.preparePromptCompletion({
        userId: 7,
        nodeId: 'node',
        workspaceId: 'workspace',
        selectedModelId: 'completion'
      })
    ).rejects.toThrow('MAR_AGENT_MODEL_FORBIDDEN');
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('uses the configured Ark URL unchanged for both generation and editing', async () => {
    const url = 'https://images.example.test/custom/generate';
    const service = new MarAgentRuntimeModelService({
      models: {
        storedConfigurationsForUser: vi.fn(async () => [
          model('static-model', { type: 'INLINE_API_KEY', value: 'text-key' })
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
        websocket: true,
        httpVersions: ['1.1', '2'],
        resourceInput: true
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
      apiKey: 'static-secret'
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

  it('preserves the explicit model-level Code Mode capability', async () => {
    const configured: MarAgentStoredModelConfiguration = {
      ...model('static-model', { type: 'INLINE_API_KEY', value: 'key' }),
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
        apiKey: 'static-secret'
      })
    });
    expect(issue).not.toHaveBeenCalled();
  });
});
