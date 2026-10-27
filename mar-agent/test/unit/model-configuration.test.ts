import { describe, expect, it, vi } from 'vitest';
import {
  AgentError,
  SecretValue,
  createAgent,
  parseModelCatalog,
  testAgentModelTransport,
  type CreateAgentOptions
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import {
  normalizeRuntimeModelConfiguration,
  resolveModelDefaultReasoningEffort,
  usesResponsesConfigurationUpdates
} from '../../src/model/configuration.js';
import { prepareModelConfiguration } from '../../src/model/request-configuration.js';

const model = {
  id: 'coding',
  name: 'Coding',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://api.example.test',
  apiKey: 'top-secret',
  modelId: 'coding',
  contextWindowTokens: 200_000,
  maxOutputTokens: 16_384,
  inputCapabilities: ['TEXT', 'IMAGE'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  hostedWebSearch: false,
  enabled: true
} as const;

describe('public model boundary', () => {
  it('rejects custom adapter injection through the public factory', async () => {
    await expect(
      createAgent({
        adapterFactory: () => ({})
      } as unknown as CreateAgentOptions)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_CONFIG_INVALID' });
  });

  it('probes the built-in transport without exposing adapter events', async () => {
    const configuration = parseModelCatalog({ version: 1, models: [model] }).models[0]!;
    const signal = new AbortController().signal;
    const start = vi
      .spyOn(AnthropicMessagesAdapter.prototype, 'start')
      .mockImplementation(async function* (request, receivedSignal) {
        expect(receivedSignal).toBe(signal);
        expect(request.tools).toEqual([]);
        expect(request.allowTools).toBe(false);
        yield { type: 'text.completed', itemId: 'first', text: 'first' };
        yield { type: 'text.completed', itemId: 'last', text: '  final text\n' };
        yield { type: 'completed', reason: 'completed' };
      });
    try {
      await expect(testAgentModelTransport(configuration, signal)).resolves.toEqual({
        completed: true,
        response: '  final text\n'
      });
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      start.mockRestore();
    }
  });

  it('does not report success when the stream ends without completion', async () => {
    const configuration = parseModelCatalog({ version: 1, models: [model] }).models[0]!;
    const start = vi
      .spyOn(AnthropicMessagesAdapter.prototype, 'start')
      .mockImplementation(async function* () {
        yield { type: 'unknown', nativeType: 'partial' };
      });
    try {
      await expect(
        testAgentModelTransport(configuration, new AbortController().signal)
      ).resolves.toEqual({ completed: false, response: '' });
    } finally {
      start.mockRestore();
    }
  });
});

describe('model catalog', () => {
  it('uses native Responses configuration updates only for endpoints declaring the capability', () => {
    const responses = {
      ...model,
      protocol: 'OPENAI_RESPONSES' as const,
      responsesConfigurationUpdates: true
    };
    expect(usesResponsesConfigurationUpdates(responses)).toBe(true);
    expect(
      usesResponsesConfigurationUpdates({ ...responses, responsesConfigurationUpdates: false })
    ).toBe(false);
  });

  it('parses independent model connections and protects the key', () => {
    const catalog = parseModelCatalog({ version: 1, defaultModelId: 'coding', models: [model] });
    expect(catalog.models[0]?.apiKey).toBeInstanceOf(SecretValue);
    expect(catalog.models[0]).not.toHaveProperty('highDensityCompaction');
    expect(catalog.models[0]?.fastMode).toBeUndefined();
    expect(JSON.stringify(catalog)).not.toContain('top-secret');
    expect(catalog.defaultModelId).toBe('coding');
  });

  it.each([
    { transport: 'HTTP', httpVersion: '2', futureTransportOption: 'transport-secret' },
    { transport: 'WEBSOCKET', futureTransportOption: 'transport-secret' }
  ])('strips unknown options without leaking them from %j', (responsesTransport) => {
    const parsed = parseModelCatalog({
      version: 1,
      models: [
        {
          ...model,
          protocol: 'OPENAI_RESPONSES',
          highDensityCompaction: true,
          futureModelOption: 'model-secret',
          responsesConfigurationUpdates: true,
          responsesTransport,
          responsesOptionalParameters: {
            reasoningEffort: true,
            reasoningSummary: false,
            textVerbosity: true,
            promptCacheKey: false,
            futureParameter: 'parameter-secret'
          }
        }
      ]
    }).models[0]!;
    expect(parsed).not.toHaveProperty('highDensityCompaction');
    expect(parsed).not.toHaveProperty('futureModelOption');
    expect(parsed.responsesTransport).not.toHaveProperty('futureTransportOption');
    expect(parsed.responsesOptionalParameters).toEqual({
      reasoningEffort: true,
      reasoningSummary: false,
      textVerbosity: true,
      promptCacheKey: false
    });
    expect(parsed.responsesConfigurationUpdates).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/model-secret|transport-secret|parameter-secret/);
  });

  it.each([
    { protocol: 'UNKNOWN' },
    { protocol: 'OPENAI_RESPONSES', responsesTransport: { transport: 'QUIC' } },
    { protocol: 'OPENAI_RESPONSES', responsesTransport: { transport: 'HTTP' } },
    { protocol: 'OPENAI_RESPONSES', responsesTransport: { transport: 'HTTP', httpVersion: '3' } },
    { protocol: 'OPENAI_RESPONSES', responsesConfigurationUpdates: 'yes' },
    {
      protocol: 'OPENAI_RESPONSES',
      responsesOptionalParameters: {
        reasoningEffort: 'yes',
        reasoningSummary: false,
        textVerbosity: true,
        promptCacheKey: false
      }
    },
    { protocol: 'OPENAI_RESPONSES', responsesOptionalParameters: { reasoningEffort: true } },
    { credentialProvider: { acquire: () => {} } },
    { credential: { type: 'CODEX_AUTH_FILE' } },
    { modelId: undefined },
    { baseUrl: 'https://user:pass@example.test' }
  ])('still rejects invalid known fields and credential conflicts: %j', (overrides) => {
    expect(() =>
      parseModelCatalog({ version: 1, models: [{ ...model, ...overrides }] })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('accepts Fast mode only for Responses models', () => {
    expect(
      parseModelCatalog({
        version: 1,
        models: [{ ...model, protocol: 'OPENAI_RESPONSES', fastMode: true }]
      }).models[0]?.fastMode
    ).toBe(true);
    expect(() =>
      parseModelCatalog({ version: 1, models: [{ ...model, fastMode: true }] })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('accepts standard Responses service tiers without a Codex credential', () => {
    for (const serviceTier of ['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast']) {
      expect(
        parseModelCatalog({
          version: 1,
          models: [{ ...model, protocol: 'OPENAI_RESPONSES', serviceTier }]
        }).models[0]?.serviceTier
      ).toBe(serviceTier);
      expect(() =>
        parseModelCatalog({
          version: 1,
          models: [{ ...model, serviceTier }]
        })
      ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
    }
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [{ ...model, protocol: 'OPENAI_RESPONSES', serviceTier: 'invalid' }]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('rejects duplicate case-insensitive names and invalid capabilities', () => {
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [model, { ...model, id: 'fast', name: 'coding', modelId: 'coding-flash' }]
      })
    ).toThrowError(AgentError);
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [{ ...model, inputCapabilities: ['IMAGE'] }]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('allows loopback HTTP only when explicitly requested', () => {
    expect(() =>
      parseModelCatalog({ version: 1, models: [{ ...model, baseUrl: 'http://127.0.0.1:8123' }] })
    ).toThrow();
    expect(
      parseModelCatalog(
        { version: 1, models: [{ ...model, baseUrl: 'http://127.0.0.1:8123' }] },
        { allowLoopbackHttp: true }
      ).models
    ).toHaveLength(1);
  });

  it('keeps the CLI-specific external credential marker outside the public catalog parser', () => {
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [
          {
            ...model,
            protocol: 'OPENAI_RESPONSES',
            apiKey: undefined,
            credential: { type: 'CODEX_AUTH_FILE' },
            responsesTransport: { transport: 'HTTP', httpVersion: '2' },
            responsesPreviousResponseId: true
          }
        ]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('rejects missing credentials and protocol-incompatible transport choices', () => {
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [{ ...model, apiKey: undefined }]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [
          {
            ...model,
            responsesTransport: { transport: 'WEBSOCKET' }
          }
        ]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it.each([
    undefined,
    { transport: 'HTTP', httpVersion: '1.1' },
    { transport: 'HTTP', httpVersion: '2' },
    { transport: 'WEBSOCKET' }
  ])('allows Responses continuation over %j', (responsesTransport) => {
    const responsesModel = {
      ...model,
      protocol: 'OPENAI_RESPONSES',
      responsesPreviousResponseId: true,
      ...(responsesTransport === undefined ? {} : { responsesTransport })
    };
    expect(parseModelCatalog({ version: 1, models: [responsesModel] }).models[0]).toMatchObject({
      responsesPreviousResponseId: true
    });
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [{ ...responsesModel, protocol: 'ANTHROPIC_MESSAGES' }]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('requires a non-empty default reasoning effort compatible with exposed choices', () => {
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [{ ...model, defaultReasoningEffort: '' }]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [
          {
            ...model,
            reasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'medium'
          }
        ]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [{ ...model, reasoningEfforts: ['minimal'], defaultReasoningEffort: 'minimal' }]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() =>
      parseModelCatalog({
        version: 1,
        models: [{ ...model, reasoningEfforts: [], defaultReasoningEffort: 'minimal' }]
      })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(
      parseModelCatalog({
        version: 1,
        models: [{ ...model, reasoningEfforts: [], defaultReasoningEffort: 'medium' }]
      }).models[0]?.defaultReasoningEffort
    ).toBe('medium');
  });
});

describe('runtime model configuration', () => {
  const provider = { acquire: vi.fn(), invalidate: vi.fn(), close: vi.fn() };
  const runtimeModel = {
    ...model,
    protocol: 'OPENAI_RESPONSES',
    apiKey: undefined,
    credentialProvider: provider,
    responsesTransport: { transport: 'HTTP', httpVersion: '2', future: 'transport-secret' },
    responsesOptionalParameters: {
      reasoningEffort: true,
      reasoningSummary: false,
      textVerbosity: true,
      promptCacheKey: false,
      future: 'parameter-secret'
    },
    future: 'model-secret'
  };

  it('ignores the obsolete credential flag and enables native updates only by explicit capability', () => {
    const obsolete = normalizeRuntimeModelConfiguration({ ...runtimeModel, codexCredential: true });
    expect(obsolete).not.toHaveProperty('codexCredential');
    expect(usesResponsesConfigurationUpdates(obsolete)).toBe(false);
    const context = { baselineEffort: 'low' as const, messages: [] };
    expect(prepareModelConfiguration(obsolete, 'high', context).updates).toEqual([]);

    const enabled = normalizeRuntimeModelConfiguration({
      ...runtimeModel,
      codexCredential: false,
      responsesConfigurationUpdates: true
    });
    expect(enabled).not.toHaveProperty('codexCredential');
    expect(usesResponsesConfigurationUpdates(enabled)).toBe(true);
    expect(prepareModelConfiguration(enabled, 'high', context).updates).toEqual([
      expect.objectContaining({
        item: { type: 'configuration_update', reasoning: { effort: 'high' } }
      })
    ]);
  });

  it('projects known fields while preserving the original credential object', () => {
    const normalized = normalizeRuntimeModelConfiguration(runtimeModel);
    expect(normalized.credentialProvider).toBe(provider);
    expect(normalized.responsesTransport).toEqual({ transport: 'HTTP', httpVersion: '2' });
    expect(normalized.responsesOptionalParameters).toEqual({
      reasoningEffort: true,
      reasoningSummary: false,
      textVerbosity: true,
      promptCacheKey: false
    });
    expect(normalized).not.toHaveProperty('future');
    const key = new SecretValue('runtime-secret');
    expect(
      normalizeRuntimeModelConfiguration({
        ...runtimeModel,
        apiKey: key,
        credentialProvider: undefined
      }).apiKey
    ).toBe(key);
    expect(
      normalizeRuntimeModelConfiguration({ ...runtimeModel, baseUrl: 'http://example.test' })
        .baseUrl
    ).toBe('http://example.test');
  });

  it.each([
    { protocol: 'UNKNOWN' },
    { responsesTransport: { transport: 'UNKNOWN' } },
    { responsesTransport: { transport: 'HTTP' } },
    { responsesOptionalParameters: { reasoningEffort: 'yes' } },
    { enabled: 'yes' },
    { modelId: undefined },
    { credentialProvider: undefined },
    { apiKey: new SecretValue('conflict') },
    { credentialProvider: {} },
    { credential: { type: 'CODEX_AUTH_FILE' } }
  ])('rejects invalid runtime models: %j', (overrides) => {
    expect(() =>
      normalizeRuntimeModelConfiguration({ ...runtimeModel, ...overrides })
    ).toThrowError('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('retains the direct SDK defaults for omitted optional settings', () => {
    const normalized = normalizeRuntimeModelConfiguration({
      ...runtimeModel,
      defaultReasoningEffort: undefined,
      conversationModel: undefined,
      responsesPreviousResponseId: undefined
    });
    expect(normalized.defaultReasoningEffort).toBeUndefined();
    expect(normalized.conversationModel).toBe(true);
    expect(normalized.responsesPreviousResponseId).toBe(false);
    expect(resolveModelDefaultReasoningEffort(normalized)).toBe('medium');
    expect(
      resolveModelDefaultReasoningEffort(
        normalizeRuntimeModelConfiguration({
          ...runtimeModel,
          reasoningEfforts: ['low'],
          defaultReasoningEffort: 'high'
        })
      )
    ).toBe('low');
  });
});
