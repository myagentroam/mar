import { describe, expect, it, vi } from 'vitest';
import {
  MarAgentError,
  SecretValue,
  createMarAgent,
  parseModelCatalog,
  testMarAgentModelTransport,
  type CreateMarAgentOptions
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import { usesResponsesConfigurationUpdates } from '../../src/agent-core/model/configuration.js';

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
      createMarAgent({
        adapterFactory: () => ({})
      } as unknown as CreateMarAgentOptions)
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
        yield { type: 'completed', reason: 'completed' };
      });
    try {
      await expect(testMarAgentModelTransport(configuration, signal)).resolves.toBe(true);
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
        testMarAgentModelTransport(configuration, new AbortController().signal)
      ).resolves.toBe(false);
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

  it('rejects the removed high-density compaction model option', () => {
    expect(() =>
      parseModelCatalog({
        version: 1,
        defaultModelId: 'coding',
        models: [{ ...model, highDensityCompaction: true }]
      })
    ).toThrow('Model catalog is invalid.');
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
    ).toThrowError(MarAgentError);
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
