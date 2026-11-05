import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/model/configuration.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { testAgentModelTransport } from '../../src/model/transport-test.js';

beforeEach(() => {
  Object.defineProperty(AnthropicMessagesAdapter.prototype, 'close', {
    configurable: true,
    value: async () => undefined
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(AnthropicMessagesAdapter.prototype, 'close');
});

function configuration(protocol: AgentModelConfiguration['protocol']): AgentModelConfiguration {
  return {
    id: 'model',
    name: 'Model',
    protocol,
    baseUrl: 'https://example.test/v1',
    apiKey: new SecretValue('test'),
    modelId: 'model',
    contextWindowTokens: 8192,
    maxOutputTokens: 256,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    enabled: true
  };
}

describe('model transport smoke test', () => {
  it.each([
    ['OPENAI_RESPONSES', OpenAiResponsesAdapter],
    ['ANTHROPIC_MESSAGES', AnthropicMessagesAdapter]
  ] as const)(
    'uses default no-tool input and preserves the final raw response for %s',
    async (protocol, Adapter) => {
      const signal = new AbortController().signal;
      const start = vi
        .spyOn(Adapter.prototype, 'start')
        .mockImplementation(async function* (request, receivedSignal) {
          expect(receivedSignal).toBe(signal);
          expect(request).toMatchObject({
            system: 'You are performing a model transport connectivity test.',
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            tools: [],
            allowTools: false
          });
          yield { type: 'text.completed', itemId: 'one', phase: 'commentary', text: 'Earlier' };
          yield { type: 'text.completed', itemId: 'two', phase: 'final_answer', text: '  OK\n' };
          yield { type: 'completed', reason: 'completed' };
        });
      const close = vi
        .spyOn(Adapter.prototype as OpenAiResponsesAdapter, 'close')
        .mockResolvedValue(undefined);
      await expect(testAgentModelTransport(configuration(protocol), signal)).resolves.toEqual({
        completed: true,
        response: '  OK\n'
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    }
  );

  it('applies each optional prompt independently and reports an incomplete stream', async () => {
    const start = vi
      .spyOn(AnthropicMessagesAdapter.prototype, 'start')
      .mockImplementation(async function* (request) {
        expect(request.system).toBe('Custom system');
        expect(request.messages).toEqual([{ role: 'user', content: 'Reply with OK.' }]);
        yield { type: 'text.completed', itemId: 'one', phase: 'final_answer', text: 'partial' };
      });
    const close = vi
      .spyOn(
        AnthropicMessagesAdapter.prototype as AnthropicMessagesAdapter & { close(): Promise<void> },
        'close'
      )
      .mockResolvedValue(undefined);
    await expect(
      testAgentModelTransport(configuration('ANTHROPIC_MESSAGES'), new AbortController().signal, {
        system: 'Custom system'
      })
    ).resolves.toEqual({ completed: false, response: 'partial' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('accepts a custom user prompt without changing the default system instruction', async () => {
    const start = vi
      .spyOn(OpenAiResponsesAdapter.prototype, 'start')
      .mockImplementation(async function* (request) {
        expect(request.system).toBe('You are performing a model transport connectivity test.');
        expect(request.messages).toEqual([{ role: 'user', content: 'Custom prompt' }]);
        yield { type: 'completed', reason: 'completed' };
      });
    const close = vi.spyOn(OpenAiResponsesAdapter.prototype, 'close').mockResolvedValue(undefined);
    await expect(
      testAgentModelTransport(configuration('OPENAI_RESPONSES'), new AbortController().signal, {
        prompt: 'Custom prompt'
      })
    ).resolves.toEqual({ completed: true, response: '' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes its adapter on request failure without closing the caller credential provider', async () => {
    const failure = new Error('upstream failed');
    vi.spyOn(OpenAiResponsesAdapter.prototype, 'start').mockImplementation(async function* () {
      yield* [];
      throw failure;
    });
    const close = vi.spyOn(OpenAiResponsesAdapter.prototype, 'close').mockResolvedValue(undefined);
    const provider = { acquire: vi.fn(), invalidate: vi.fn(), close: vi.fn() };
    const model = {
      ...configuration('OPENAI_RESPONSES'),
      apiKey: undefined,
      credentialProvider: provider
    } as unknown as AgentModelConfiguration;
    await expect(
      testAgentModelTransport(model, new AbortController().signal, { prompt: 'Custom prompt' })
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
    expect(provider.close).not.toHaveBeenCalled();
  });
});
