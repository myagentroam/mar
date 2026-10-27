import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSessionTitle, SecretValue } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import type { AgentModelConfiguration } from '../../src/index.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';

const model: AgentModelConfiguration = {
  id: 'current',
  name: 'Current',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  apiKey: new SecretValue('test-key'),
  modelId: 'current',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'low',
  hostedWebSearch: false,
  enabled: true
};

afterEach(() => vi.restoreAllMocks());

function input(prompt = 'Inspect parser') {
  return {
    models: [model],
    currentModelId: model.id,
    prompt,
    signal: new AbortController().signal
  };
}

function complete(text = 'Parser inspection', reason: 'completed' | 'tool_use' = 'completed') {
  return async function* (): AsyncIterable<ModelEvent> {
    yield { type: 'text.completed', itemId: 'title', text };
    yield { type: 'completed', reason };
  };
}

describe('shared auto title', () => {
  it.each([
    ['short', 'Inspect parser', 'Inspect parser'],
    ['boundary', 'b'.repeat(1000), 'b'.repeat(1000)],
    ['long', 'a'.repeat(1000) + 'tail', 'a'.repeat(1000)],
    ['unicode', '中'.repeat(999) + '😀tail', '中'.repeat(999) + '😀']
  ])(
    'bounds the title input without changing the caller input: %s',
    async (_name, prompt, expected) => {
      const start = vi
        .spyOn(OpenAiResponsesAdapter.prototype, 'start')
        .mockImplementation(complete(`<think>hidden</think>\n ${'😀'.repeat(60)}\nignored`));
      const close = vi.spyOn(OpenAiResponsesAdapter.prototype, 'close');
      const options = input(prompt);
      await expect(generateSessionTitle(options)).resolves.toBe('😀'.repeat(50));
      expect(options.prompt).toBe(prompt);
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: expected }],
          tools: [],
          allowTools: false,
          reasoningEffort: 'low',
          retryState: { attempts: 0, maxAttempts: 1 }
        }),
        expect.any(AbortSignal)
      );
      expect(close).toHaveBeenCalledOnce();
    }
  );

  it('uses the first enabled title model and borrows its credential provider', async () => {
    const provider = { acquire: vi.fn(), invalidate: vi.fn(), close: vi.fn() };
    const title = {
      ...model,
      id: 'title',
      conversationModel: false,
      titleGeneration: true,
      apiKey: undefined,
      credentialProvider: provider
    };
    const start = vi
      .spyOn(OpenAiResponsesAdapter.prototype, 'start')
      .mockImplementation(async function* (this: OpenAiResponsesAdapter, request: ModelRequest) {
        expect(this.configuration.id).toBe('title');
        expect(request.reasoningEffort).toBe('low');
        yield* complete()();
      });
    await generateSessionTitle({
      ...input(),
      models: [
        { ...title, id: 'disabled', enabled: false },
        model,
        title,
        { ...title, id: 'second' }
      ]
    });
    expect(start).toHaveBeenCalledOnce();
    expect(provider.close).not.toHaveBeenCalled();
  });

  it('falls back to the current Anthropic model', async () => {
    const start = vi
      .spyOn(AnthropicMessagesAdapter.prototype, 'start')
      .mockImplementation(complete());
    await expect(
      generateSessionTitle({ ...input(), models: [{ ...model, protocol: 'ANTHROPIC_MESSAGES' }] })
    ).resolves.toBe('Parser inspection');
    expect(start).toHaveBeenCalledOnce();
  });

  it('uses the optional default language only as a language fallback', async () => {
    const start = vi
      .spyOn(OpenAiResponsesAdapter.prototype, 'start')
      .mockImplementation(complete());
    await generateSessionTitle({ ...input('👍'), defaultLanguage: 'zh-CN' });
    const system = start.mock.calls[0]![0].system;
    expect(system).toContain('Use the same language as the user message.');
    expect(system).toContain('does not establish a language, use "zh-CN"');
    await generateSessionTitle(input());
    expect(start.mock.calls[1]![0].system).not.toContain('default language');
  });

  it.each(['', ' ', 'x'.repeat(129)])(
    'rejects an invalid default language',
    async (defaultLanguage) => {
      await expect(generateSessionTitle({ ...input(), defaultLanguage })).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
    }
  );

  it.each(['', '<think>hidden</think>\n '])('ignores empty output', async (text) => {
    vi.spyOn(OpenAiResponsesAdapter.prototype, 'start').mockImplementation(complete(text));
    await expect(generateSessionTitle(input())).resolves.toBeUndefined();
  });

  it('ignores a non-completed response and closes failed requests', async () => {
    const start = vi
      .spyOn(OpenAiResponsesAdapter.prototype, 'start')
      .mockImplementation(complete('Invalid', 'tool_use'));
    const close = vi.spyOn(OpenAiResponsesAdapter.prototype, 'close');
    await expect(generateSessionTitle(input())).resolves.toBeUndefined();
    // eslint-disable-next-line require-yield -- This fixture fails or waits for cancellation without emitting model events.
    start.mockImplementation(async function* () {
      throw new Error('unavailable');
    });
    await expect(generateSessionTitle(input())).rejects.toThrow('unavailable');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('rejects unavailable models and already cancelled requests', async () => {
    await expect(
      generateSessionTitle({ ...input(), models: [{ ...model, enabled: false }] })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_DISABLED' });
    await expect(
      generateSessionTitle({ ...input(), signal: AbortSignal.abort() })
    ).rejects.toThrow();
  });

  it('cancels an active request and closes its adapter', async () => {
    const controller = new AbortController();
    const close = vi.spyOn(OpenAiResponsesAdapter.prototype, 'close');
    vi.spyOn(OpenAiResponsesAdapter.prototype, 'start').mockImplementation(
      // eslint-disable-next-line require-yield -- This fixture fails or waits for cancellation without emitting model events.
      async function* (_request, signal) {
        controller.abort();
        signal.throwIfAborted();
      }
    );
    await expect(generateSessionTitle({ ...input(), signal: controller.signal })).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ['HTTP', 'cancel'],
    ['HTTP', 'timeout'],
    ['WEBSOCKET', 'cancel'],
    ['WEBSOCKET', 'timeout']
  ] as const)(
    'settles %s credential waits on title %s without closing borrowed credentials',
    async (transport, interruption) => {
      const caller = new AbortController();
      const timeout = new AbortController();
      const timeoutFactory = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
      let acquired!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = {
        acquire: vi.fn(async () => {
          acquired();
          await released;
          return {
            revision: 1,
            expiresAt: Date.now() + 60_000,
            bearer: new SecretValue('test-key'),
            headers: {}
          };
        }),
        invalidate: vi.fn(),
        close: vi.fn(async () => undefined)
      };
      const close = vi.spyOn(OpenAiResponsesAdapter.prototype, 'close');
      let settled = false;
      let result: unknown;
      const completion = generateSessionTitle({
        ...input(),
        models: [
          {
            ...model,
            apiKey: undefined,
            credentialProvider: provider,
            responsesTransport:
              transport === 'HTTP' ? { transport, httpVersion: '1.1' } : { transport }
          }
        ],
        signal: caller.signal
      }).then(
        (value) => {
          result = value;
          settled = true;
        },
        (error) => {
          result = error;
          settled = true;
        }
      );
      const reason = new Error(`title ${interruption}`);
      try {
        await started;
        (interruption === 'cancel' ? caller : timeout).abort(reason);
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 250, interval: 10 });
        expect(result).toBe(reason);
        expect(timeoutFactory).toHaveBeenCalledWith(30_000);
        expect(provider.close).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
      } finally {
        release();
        await completion;
      }
    }
  );
});
