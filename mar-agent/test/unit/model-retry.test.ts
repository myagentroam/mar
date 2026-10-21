import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchModelResponse,
  modelRetryDelay,
  modelRetryMaxAttempts
} from '../../src/agent-core/model/http.js';
import {
  createMarAgent,
  generateSessionTitle,
  LocalAgentHost,
  MarAgentError,
  SecretValue,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import type { ModelAttemptDiagnostic, ModelEvent } from '../../src/agent-core/model/contracts.js';

vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: vi.fn(async (_ms, _value, options) => {
    if (options?.signal?.aborted) throw options.signal.reason;
  })
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(delay).mockClear();
});

it.each([
  ['UND_ERR_SOCKET', 'MAR_AGENT_MODEL_CONNECTION_FAILED'],
  ['ECONNRESET', 'MAR_AGENT_MODEL_CONNECTION_FAILED'],
  ['ECONNREFUSED', 'MAR_AGENT_MODEL_CONNECTION_FAILED'],
  ['EAI_AGAIN', 'MAR_AGENT_MODEL_CONNECTION_FAILED'],
  ['ETIMEDOUT', 'MAR_AGENT_MODEL_TIMEOUT'],
  ['UND_ERR_CONNECT_TIMEOUT', 'MAR_AGENT_MODEL_TIMEOUT'],
  ['UND_ERR_HEADERS_TIMEOUT', 'MAR_AGENT_MODEL_TIMEOUT']
])(
  'classifies nested %s without changing its cause or retry budget',
  async (code, expectedCode) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const cause = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connection failed.'), { code })
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause);
    for (const attempts of [1, 8]) {
      fetch.mockClear();
      vi.mocked(delay).mockClear();
      const error = await fetchModelResponse(
        'https://example.test',
        {},
        new AbortController().signal,
        attempts
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(MarAgentError);
      expect(error).toMatchObject({
        code: expectedCode,
        retryable: true,
        details: { reason: 'MODEL_TRANSPORT_FAILURE' }
      });
      expect((error as Error).cause).toBe(cause);
      expect(fetch).toHaveBeenCalledTimes(attempts);
      expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual(
        Array.from({ length: attempts - 1 }, (_, index) => (index + 1) * 5000)
      );
    }
  }
);

it('preserves an unclassified fetch error without retrying', async () => {
  const cause = new TypeError('Invalid request.');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause);
  await expect(
    fetchModelResponse('https://example.test', {}, new AbortController().signal)
  ).rejects.toBe(cause);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

it('preserves caller cancellation over a retryable socket rejection', async () => {
  const controller = new AbortController();
  const reason = new Error('Caller cancelled.');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    controller.abort(reason);
    throw Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  });
  await expect(fetchModelResponse('https://example.test', {}, controller.signal)).rejects.toBe(
    reason
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

it('retries actual internal connection timeouts eight times with the shared policy', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );
  await expect(
    fetchModelResponse('https://example.test', {}, new AbortController().signal, undefined, 1)
  ).rejects.toMatchObject({
    code: 'MAR_AGENT_MODEL_TIMEOUT',
    details: { reason: 'MODEL_CONNECTION_TIMEOUT' }
  });
  expect(fetch).toHaveBeenCalledTimes(8);
  expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([
    5000, 10000, 15000, 20000, 25000, 30000, 35000
  ]);
});

it.each([0, 0.999999])('bounds the shared jitter with random=%s', (random) => {
  vi.spyOn(Math, 'random').mockReturnValue(random);
  expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => modelRetryDelay(null, attempt))).toEqual(
    [1, 2, 3, 4, 5, 6, 7].map((attempt) => attempt * 5000 + Math.floor(random * 3001))
  );
  expect(modelRetryDelay('0', 3)).toBe(0);
  expect(modelRetryDelay('90', 3)).toBe(30000);
});

it.each([0, -1, 1.5, 9, NaN])('rejects an invalid request attempt limit %s', (maxAttempts) => {
  expect(() => modelRetryMaxAttempts({ attempts: 0, maxAttempts })).toThrow(
    'MAR_AGENT_MODEL_CONFIG_INVALID'
  );
});

function stream(protocol: string, overload = false, text = 'Recovered') {
  const events = overload
    ? [{ type: 'error', code: 'server_is_overloaded', error: { type: 'overloaded_error' } }]
    : protocol === 'OPENAI_RESPONSES'
      ? [
          { type: 'response.output_text.done', item_id: 'final', text },
          { type: 'response.completed', response: { id: 'success', output: [] } }
        ]
      : [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text }
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' }
        ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  });
}

function partialFailure(protocol: string) {
  const events =
    protocol === 'OPENAI_RESPONSES'
      ? [
          { type: 'response.output_text.delta', item_id: 'partial', delta: 'Partial' },
          { type: 'error', code: 'server_is_overloaded' }
        ]
      : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
          { type: 'error', error: { type: 'overloaded_error' } }
        ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

describe.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
  '%s unified request retry budget',
  (protocol) => {
    function adapter() {
      const configuration: MarAgentModelConfiguration = {
        id: 'test',
        name: 'Test',
        protocol,
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test-key'),
        modelId: 'test',
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true
      };
      return protocol === 'OPENAI_RESPONSES'
        ? new OpenAiResponsesAdapter(configuration)
        : new AnthropicMessagesAdapter(configuration);
    }

    async function run(
      signal = new AbortController().signal,
      diagnostics: ModelAttemptDiagnostic[] = []
    ) {
      const model = adapter();
      const events: ModelEvent[] = [];
      try {
        for await (const event of model.start(
          {
            system: 'Test.',
            messages: [{ role: 'user', content: 'Test.' }],
            tools: [],
            onAttemptDiagnostic: (diagnostic) => {
              diagnostics.push(diagnostic);
            }
          },
          signal
        ))
          events.push(event);
        return events;
      } finally {
        if ('close' in model) await model.close();
      }
    }

    it.each([
      ['socket', false],
      ['socket', true],
      ['timeout', false],
      ['timeout', true]
    ] as const)('preserves %s diagnostics and recovery, exhausted=%s', async (kind, exhausted) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const cause = new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
      });
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (fetch.mock.calls.length === 8 && !exhausted) return stream(protocol);
        if (kind === 'socket') throw cause;
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          });
        });
      });
      const diagnostics: ModelAttemptDiagnostic[] = [];
      const outcome = run(new AbortController().signal, diagnostics).then(
        (events) => ({ events, error: undefined }),
        (error: unknown) => ({ events: [] as ModelEvent[], error })
      );
      await vi.advanceTimersByTimeAsync(8 * 30_000);
      const result = await outcome;
      const code =
        kind === 'socket' ? 'MAR_AGENT_MODEL_CONNECTION_FAILED' : 'MAR_AGENT_MODEL_TIMEOUT';
      if (exhausted) {
        expect(result.error).toMatchObject({ code, retryable: true });
        if (kind === 'socket') {
          const causes: unknown[] = [];
          let current: unknown = result.error;
          for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
            causes.push(current);
            current = current.cause;
          }
          expect(causes).toContain(cause);
        }
        expect(result.events).toEqual([]);
      } else {
        expect(result.error).toBeUndefined();
        expect(result.events).toContainEqual(expect.objectContaining({ type: 'completed' }));
        expect(result.events).toContainEqual(
          expect.objectContaining({ type: 'text.completed', text: 'Recovered' })
        );
      }
      expect(fetch).toHaveBeenCalledTimes(8);
      expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([
        5000, 10000, 15000, 20000, 25000, 30000, 35000
      ]);
      expect(
        diagnostics.filter(({ state }) => state === 'STARTED').map(({ attempt }) => attempt)
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const failures = diagnostics.filter(({ state }) => state === 'FAILED');
      expect(failures).toHaveLength(exhausted ? 8 : 7);
      for (const [index, failure] of failures.entries()) {
        expect(failure).toMatchObject({
          protocol,
          transport: 'HTTP',
          attempt: index + 1,
          maxAttempts: 8,
          semanticEventObserved: false,
          errorCode: code,
          retryable: true,
          willRetry: index < 7,
          ...(index < 7 ? { retryDelayMs: (index + 1) * 5000 } : {})
        });
      }
      expect(diagnostics.filter(({ state }) => state === 'SUCCEEDED')).toHaveLength(
        exhausted ? 0 : 1
      );
    });

    it.each(['eof', 'reset', 'idle'] as const)(
      'retries pre-output stream %s within eight attempts',
      async (kind) => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          if (fetch.mock.calls.length === 8) return stream(protocol);
          if (kind === 'eof') return new Response('');
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(
                  kind === 'idle'
                    ? new MarAgentError('MAR_AGENT_MODEL_TIMEOUT', 'Idle timeout.', {
                        retryable: true,
                        details: { reason: 'MODEL_STREAM_IDLE_TIMEOUT' }
                      })
                    : Object.assign(new Error('read reset'), { code: 'ECONNRESET' })
                );
              }
            })
          );
        });
        await run();
        expect(fetch).toHaveBeenCalledTimes(8);
        expect(delay).toHaveBeenCalledTimes(7);
      }
    );

    it.each(['partial', 'overload', 'http', 'transport'])(
      'does not retry a failed title (%s) or consume the main request budget',
      async (failure) => {
        let titleAttempts = 0;
        let mainAttempts = 0;
        vi.spyOn(Math, 'random').mockReturnValue(0);
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          if (JSON.stringify(body).includes('session title generator')) {
            titleAttempts++;
            if (failure === 'partial') return partialFailure(protocol);
            if (failure === 'overload') return stream(protocol, true);
            if (failure === 'http') return new Response('busy', { status: 503 });
            throw Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
          }
          mainAttempts++;
          return mainAttempts < 8 ? new Response('busy', { status: 503 }) : stream(protocol);
        });
        const home = await mkdtemp(join(tmpdir(), 'mar-title-retry-'));
        const agent = await createMarAgent({
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
          models: [adapter().configuration]
        });
        try {
          const session = await agent.createSession({ workspace: home });
          await expect(
            generateSessionTitle({
              models: [adapter().configuration],
              currentModelId: adapter().configuration.id,
              prompt: 'Continue.',
              signal: new AbortController().signal
            })
          ).rejects.toBeDefined();
          expect((await session.run({ prompt: 'Continue.' }).result()).status).toBe('completed');
          expect(titleAttempts).toBe(1);
          expect(mainAttempts).toBe(8);
          expect(await agent.listSessions()).toMatchObject({
            sessions: [{ title: 'New session' }]
          });
          expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([
            5000, 10000, 15000, 20000, 25000, 30000, 35000
          ]);
        } finally {
          await agent.dispose();
          await rm(home, { recursive: true, force: true });
        }
      }
    );

    it.each([
      ['run', false],
      ['plan', false],
      ['compact', false],
      ['run', true]
    ] as const)(
      'recovers %s from heartbeat-only progress timeouts within the shared budget, exhausted=%s',
      async (mode, exhausted) => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        let testing = false;
        const signals: AbortSignal[] = [];
        const cancellations: unknown[] = [];
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
          if (!testing) return stream(protocol);
          const attempt = fetch.mock.calls.length;
          if (attempt === 8 && !exhausted) return stream(protocol);
          if (attempt !== 1 && attempt !== 8) return new Response('busy', { status: 503 });
          const signal = init!.signal!;
          signals.push(signal);
          let cleanup = () => {};
          return new Response(
            new ReadableStream({
              start(controller) {
                const heartbeat = {
                  type: protocol === 'OPENAI_RESPONSES' ? 'response.in_progress' : 'ping'
                };
                const frame = new TextEncoder().encode(
                  'data: ' + JSON.stringify(heartbeat) + String.fromCharCode(10, 10)
                );
                const interval = setInterval(() => controller.enqueue(frame), 50_000);
                const abort = () => {
                  cleanup();
                  controller.error(signal.reason);
                };
                cleanup = () => {
                  clearInterval(interval);
                  signal.removeEventListener('abort', abort);
                };
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
              },
              cancel(reason) {
                cleanup();
                cancellations.push(reason);
              }
            })
          );
        });
        const home = await mkdtemp(join(tmpdir(), 'mar-progress-retry-'));
        const agent = await createMarAgent({
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
          models: [adapter().configuration]
        });
        try {
          const session = await agent.createSession({ workspace: home, title: 'Progress retry' });
          if (mode === 'compact')
            expect((await session.run({ prompt: 'Remember the task.' }).result()).status).toBe(
              'completed'
            );
          fetch.mockClear();
          vi.mocked(delay).mockClear();
          testing = true;
          vi.useFakeTimers();
          const execution =
            mode === 'compact' ? session.compact() : session[mode]({ prompt: 'Continue.' });
          const result = execution.result();
          await vi.waitFor(() => expect(signals).toHaveLength(1));
          await vi.advanceTimersByTimeAsync(300_000);
          expect(cancellations).toHaveLength(1);
          expect(cancellations[0]).toMatchObject({
            code: 'MAR_AGENT_MODEL_TIMEOUT',
            retryable: true,
            details: { reason: 'MODEL_PROGRESS_TIMEOUT' }
          });
          await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(8));
          if (exhausted) await vi.advanceTimersByTimeAsync(300_000);
          expect(await result).toMatchObject({
            status: exhausted ? 'failed' : 'completed',
            ...(exhausted ? { errorCode: 'MAR_AGENT_MODEL_TIMEOUT' } : {})
          });
          expect(fetch).toHaveBeenCalledTimes(8);
          expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([
            5000, 10000, 15000, 20000, 25000, 30000, 35000
          ]);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
          await agent.dispose();
          await rm(home, { recursive: true, force: true });
        }
      }
    );

    it.each([false, true])(
      'shares one eight-attempt budget before and after visible output, exhausted=%s',
      async (exhausted) => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          const attempt = fetch.mock.calls.length;
          if (attempt === 8 && !exhausted) return stream(protocol);
          return attempt % 2 === 0 || attempt === 8
            ? partialFailure(protocol)
            : new Response('busy', { status: 503 });
        });
        const home = await mkdtemp(join(tmpdir(), 'mar-unified-retry-'));
        const model = adapter().configuration;
        const agent = await createMarAgent({
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
          models: [model]
        });
        try {
          const session = await agent.createSession({ workspace: home, title: 'Retry test' });
          const result = await session.run({ prompt: 'Continue.' }).result();
          expect(result.status).toBe(exhausted ? 'failed' : 'completed');
          expect(fetch).toHaveBeenCalledTimes(8);
          expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([
            5000, 10000, 15000, 20000, 25000, 30000, 35000
          ]);
        } finally {
          await agent.dispose();
          await rm(home, { recursive: true, force: true });
        }
      }
    );

    it.each([false, true])(
      'shares eight attempts across HTTP failures and empty completed responses, exhausted=%s',
      async (exhausted) => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          const attempt = fetch.mock.calls.length;
          if (attempt === 8 && !exhausted) return stream(protocol);
          return attempt % 2 === 0
            ? stream(protocol, false, '')
            : new Response('busy', { status: 503 });
        });
        const home = await mkdtemp(join(tmpdir(), 'mar-empty-output-retry-'));
        const agent = await createMarAgent({
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
          models: [adapter().configuration]
        });
        try {
          const session = await agent.createSession({
            workspace: home,
            title: 'Empty output retry'
          });
          const result = await session.run({ prompt: 'Continue.' }).result();
          expect(result).toMatchObject(
            exhausted
              ? { status: 'failed', errorCode: 'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE' }
              : { status: 'completed', finalAnswer: 'Recovered' }
          );
          expect(fetch).toHaveBeenCalledTimes(8);
          expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([
            5000, 10000, 15000, 20000, 25000, 30000, 35000
          ]);
        } finally {
          await agent.dispose();
          await rm(home, { recursive: true, force: true });
        }
      }
    );

    it.each([false, true])(
      'shares eight attempts across transport/status/stream failures, exhausted=%s',
      async (exhausted) => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const fetch = vi
          .spyOn(globalThis, 'fetch')
          .mockRejectedValueOnce(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }))
          .mockResolvedValueOnce(new Response('busy', { status: 503 }))
          .mockResolvedValueOnce(stream(protocol, true))
          .mockResolvedValueOnce(new Response('conflict', { status: 409 }))
          .mockResolvedValueOnce(new Response('busy', { status: 503 }))
          .mockResolvedValueOnce(new Response('busy', { status: 503 }))
          .mockResolvedValueOnce(new Response('busy', { status: 503 }))
          .mockImplementation(async () =>
            exhausted ? new Response('still busy', { status: 503 }) : stream(protocol)
          );
        if (exhausted) await expect(run()).rejects.toMatchObject({ details: { status: 503 } });
        else await run();
        expect(fetch).toHaveBeenCalledTimes(8);
        expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([
          6500, 11500, 16500, 21500, 26500, 31500, 36500
        ]);
      }
    );

    it('honors Retry-After without adding jitter', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response('busy', { status: 429, headers: { 'retry-after': '2' } })
        )
        .mockResolvedValueOnce(stream(protocol));
      await run();
      expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([2000]);
    });

    it('does not retry caller cancellation', async () => {
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const diagnostics: ModelAttemptDiagnostic[] = [];
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        controller.abort(reason);
        throw reason;
      });
      await expect(run(controller.signal, diagnostics)).rejects.toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(delay).not.toHaveBeenCalled();
      expect(diagnostics.map(({ state }) => state)).toEqual(['STARTED', 'FAILED']);
      expect(diagnostics[1]).toMatchObject({
        attempt: 1,
        semanticEventObserved: false,
        willRetry: false
      });
      expect(diagnostics[1]?.errorCode).not.toBe('MAR_AGENT_MODEL_TIMEOUT');
    });

    it('does not start another request when cancelled during backoff', async () => {
      const controller = new AbortController();
      const reason = new Error('cancelled in backoff');
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('busy', { status: 503 }));
      vi.mocked(delay).mockImplementationOnce(async (_ms, _value, options) => {
        controller.abort(reason);
        throw options!.signal!.reason;
      });
      await expect(run(controller.signal)).rejects.toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }
);
