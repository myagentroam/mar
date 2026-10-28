import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../../../mar-agent/src/index.js';
import type { RuntimeCredentialTicket } from '../../../packages/protocol/src/index.js';
import { MarAgentRuntimeModelFactory } from '../../src/runner/mar-agent/runtime-model-factory.js';
import { MarAgentModelTransportTestService } from '../../src/service/mar-agent-model-transport-test-service.js';

type ModelConfiguration = ReturnType<MarAgentRuntimeModelFactory['create']>[number];
type CredentialProvider = NonNullable<ModelConfiguration['credentialProvider']>;

afterEach(() => vi.restoreAllMocks());

describe('Node MAR Agent model transport test', () => {
  it('relays standard service tiers to the SDK without a credential-specific speed conversion', async () => {
    const factory = new MarAgentRuntimeModelFactory({ resolve: vi.fn() });
    for (const serviceTier of [
      'auto',
      'default',
      'flex',
      'priority',
      'fast',
      'ultrafast'
    ] as const) {
      const [model] = factory.create([{ ...runtimeModel(), serviceTier, fastMode: true }], {
        runtimeScopeId: 'scope-1',
        executionId: 'execution'
      });
      expect(model?.serviceTier).toBe(serviceTier);
      expect(model).not.toHaveProperty('fastMode');
      await model?.credentialProvider?.close();
    }
    const [legacy] = factory.create([{ ...runtimeModel(), fastMode: true }], {
      runtimeScopeId: 'scope-1',
      executionId: 'legacy'
    });
    expect(legacy).not.toHaveProperty('fastMode');
    await legacy?.credentialProvider?.close();
  });
  it('executes the selected transport through the shared runtime model factory', async () => {
    const close = vi.fn(async () => undefined);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const credentialProvider = testCredentialProvider(close);
    const configuration: ModelConfiguration = {
      id: 'model-1',
      name: 'Model One',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://models.example.test/v1',
      credentialProvider,
      modelId: 'gpt-5-codex',
      contextWindowTokens: 100_000,
      maxOutputTokens: 4_096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesTransport: { transport: 'HTTP', httpVersion: '2' },
      responsesPreviousResponseId: true,
      enabled: true
    };
    const create = vi.fn(() => [configuration]);
    const testTransport = vi.fn(async () => ({ completed: true, response: 'OK' }));
    const service = new MarAgentModelTransportTestService({
      modelFactory: { create },
      testTransport
    });

    await expect(
      service.test({
        runtimeScopeId: 'scope-1',
        executionId: 'test-1',
        model: runtimeModel(),
        __requestUserId: 7,
        __workspaceWatchSessionHash: 'session-hash'
      })
    ).resolves.toEqual({
      success: true,
      code: null,
      message: null,
      httpStatus: null
    });
    expect(create).toHaveBeenCalledWith([runtimeModel()], {
      runtimeScopeId: 'scope-1',
      executionId: 'test-1'
    });
    expect(testTransport).toHaveBeenCalledWith(configuration, expect.any(AbortSignal));
    expect(timeout).toHaveBeenCalledWith(30_000);
    timeout.mockRestore();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('projects a stream without a completion marker as a connection failure and closes the provider', async () => {
    const close = vi.fn(async () => undefined);
    const [base] = new MarAgentRuntimeModelFactory({ resolve: vi.fn() }).create([runtimeModel()], {
      runtimeScopeId: 'scope-1',
      executionId: 'test-1'
    });
    await base?.credentialProvider?.close();
    const configuration = {
      ...base!,
      credentialProvider: testCredentialProvider(close)
    };
    const service = new MarAgentModelTransportTestService({
      modelFactory: { create: vi.fn(() => [configuration]) },
      testTransport: vi.fn(async () => ({ completed: false, response: 'partial' }))
    });
    await expect(
      service.test({ runtimeScopeId: 'scope-1', executionId: 'test-1', model: runtimeModel() })
    ).resolves.toEqual({
      success: false,
      code: 'MAR_AGENT_MODEL_CONNECTION_FAILED',
      message: 'Model transport test ended without completion.',
      httpStatus: null
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('preserves the bounded upstream code, message and HTTP status', async () => {
    const close = vi.fn(async () => undefined);
    const configuration: ModelConfiguration = {
      id: 'model-1',
      name: 'Model One',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://models.example.test/v1',
      credentialProvider: testCredentialProvider(close),
      modelId: 'gpt-5-codex',
      contextWindowTokens: 100_000,
      maxOutputTokens: 4_096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesTransport: { transport: 'HTTP', httpVersion: '2' },
      responsesPreviousResponseId: true,
      enabled: true
    };
    const service = new MarAgentModelTransportTestService({
      modelFactory: { create: vi.fn(() => [configuration]) },
      testTransport: vi.fn(async () => {
        const upstream = new AgentError('invalid_request_error', 'Store must be set to false', {
          details: { status: 400 }
        });
        throw new AgentError('invalid_request_error', 'Store must be set to false', {
          details: {
            status: 400,
            credentialRevision: 1,
            body: '{"error":"Store must be set to false"}',
            bodyTruncated: false,
            contentType: 'application/json',
            requestId: 'upstream-400',
            retryAfter: null,
            headers: { authorization: 'not-public' }
          },
          cause: upstream
        });
      })
    });

    await expect(
      service.test({
        runtimeScopeId: 'scope-1',
        executionId: 'test-1',
        model: runtimeModel()
      })
    ).resolves.toEqual({
      success: false,
      code: 'invalid_request_error',
      message: 'Store must be set to false',
      httpStatus: 400,
      response: {
        body: '{"error":"Store must be set to false"}',
        bodyTruncated: false,
        contentType: 'application/json',
        requestId: 'upstream-400',
        retryAfter: null
      }
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed inputs before constructing an adapter', async () => {
    const create = vi.fn();
    const service = new MarAgentModelTransportTestService({
      modelFactory: { create },
      testTransport: vi.fn()
    });

    await expect(service.test({ runtimeScopeId: 'scope-1' })).rejects.toThrow(
      'MAR_AGENT_MODEL_TEST_INPUT_INVALID'
    );
    expect(create).not.toHaveBeenCalled();
  });
});

function runtimeModel() {
  return {
    id: 'model-1',
    name: 'Model One',
    protocol: 'OPENAI_RESPONSES' as const,
    baseUrl: 'https://models.example.test/v1',
    credential: {
      type: 'RUNTIME_TICKET' as const,
      credentialId: 'credential-1',
      ticket: ticket()
    },
    modelId: 'gpt-5-codex',
    contextWindowTokens: 100_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT' as const],
    outputCapabilities: ['TEXT' as const],
    reasoningEfforts: ['high' as const],
    titleGeneration: false,
    conversationModel: true,
    useResourceUrl: false,
    codeMode: false,
    hostedWebSearch: false,
    responsesTransport: { transport: 'HTTP' as const, httpVersion: '2' as const },
    responsesPreviousResponseId: true,
    enabled: true
  };
}

function testCredentialProvider(close: () => Promise<void>): CredentialProvider {
  return {
    acquire: vi.fn(async () => {
      throw new Error('UNEXPECTED_CREDENTIAL_ACQUIRE');
    }),
    invalidate: vi.fn(),
    close
  };
}

function ticket(): RuntimeCredentialTicket {
  return {
    userId: 1,
    credentialId: 'credential-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    runtimeScopeId: 'scope-1',
    allowedModelIds: ['model-1'],
    issuedAt: 1,
    expiresAt: 900_001,
    nonce: 'nonce-1',
    signature: 'a'.repeat(64)
  };
}
