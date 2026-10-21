import { afterEach, expect, it, vi } from 'vitest';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest
} from '../../src/agent-core/model/contracts.js';
import { SecretValue } from '../../src/index.js';
import { createModelTurnSession } from '../../src/agent-core/sdk/model-runtime.js';
import { recoverModelStream } from '../../src/agent-core/model/recovery.js';
import { MarAgentError } from '../../src/agent-core/error.js';

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  vi.useRealTimers();
});

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function fixture(start: (signal: AbortSignal) => AsyncIterable<ModelEvent>) {
  vi.useFakeTimers();
  const parent = new AbortController();
  controllers.push(parent);
  let requestSignal!: AbortSignal;
  let closed = false;
  const adapter: ModelAdapter = {
    configuration: {
      id: 'progress',
      name: 'Progress',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('test-only'),
      modelId: 'fake',
      contextWindowTokens: 100_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    },
    async *start(_request, signal) {
      requestSignal = signal;
      try {
        yield* start(signal);
      } finally {
        closed = true;
      }
    }
  };
  const turn = createModelTurnSession(adapter);
  const request: ModelRequest = {
    system: 'Test.',
    messages: [],
    tools: [],
    retryState: { attempts: 0 }
  };
  return { parent, turn, request, signal: () => requestSignal, closed: () => closed };
}

function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  let failure: unknown;
  const done = (async () => {
    try {
      for await (const event of stream) events.push(event);
    } catch (error) {
      failure = error;
    }
  })();
  return { events, done, failure: () => failure };
}

it('times out a completely silent model at 300 seconds and only aborts that request', async () => {
  const f = fixture(async function* (signal) {
    await pause(900_000, signal);
  });
  const run = collect(f.turn.start(f.request, f.parent.signal));
  await vi.advanceTimersByTimeAsync(299_999);
  expect(run.failure()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.signal().aborted).toBe(true);
  await run.done;
  expect(run.failure()).toMatchObject({
    code: 'MAR_AGENT_MODEL_TIMEOUT',
    retryable: true,
    details: { reason: 'MODEL_PROGRESS_TIMEOUT' }
  });
  expect(f.parent.signal.aborted).toBe(false);
  expect(f.closed()).toBe(true);
  expect(f.request.retryState?.attempts).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not let empty content, lifecycle, heartbeat or usage events keep a request alive', async () => {
  const noise: ModelEvent[] = [
    { type: 'unknown', nativeType: 'ping' },
    { type: 'response.started', responseId: 'pending' },
    { type: 'usage', usage: { outputTokens: 0 } },
    { type: 'text.delta', itemId: 'empty', phase: 'commentary', delta: '' },
    { type: 'reasoning.summary', itemId: 'empty', text: '' },
    { type: 'text.completed', itemId: 'empty', text: '' },
    { type: 'response.item', provider: 'OPENAI_RESPONSES', item: { type: 'reasoning' } },
    { type: 'output.started' },
    { type: 'output.reset' },
    { type: 'output.paused' }
  ];
  const f = fixture(async function* (signal) {
    for (let i = 0; ; i++) {
      await pause(10_000, signal);
      yield noise[i % noise.length]!;
    }
  });
  const run = collect(f.turn.start(f.request, f.parent.signal));
  await vi.advanceTimersByTimeAsync(300_000);
  expect(f.signal().aborted).toBe(true);
  await run.done;
  expect(run.events.length).toBeGreaterThan(0);
  expect(run.failure()).toMatchObject({ details: { reason: 'MODEL_PROGRESS_TIMEOUT' } });
});

it.each<ModelEvent>([
  { type: 'text.delta', itemId: 'text', phase: 'commentary', delta: 'Working.' },
  { type: 'output.delta' },
  { type: 'reasoning.summary', itemId: 'thinking', text: 'Summary.' },
  { type: 'text.completed', itemId: 'text', text: 'Working.' },
  { type: 'client_tool.call', callId: 'call', name: 'read', arguments: {} }
])(
  'allows long generation with %s progress and times out relative to its last increment',
  async (progress) => {
    const f = fixture(async function* (signal) {
      for (let i = 0; i < 3; i++) {
        await pause(250_000, signal);
        yield progress;
      }
      await pause(900_000, signal);
    });
    const run = collect(f.turn.start(f.request, f.parent.signal));
    await vi.advanceTimersByTimeAsync(1_049_999);
    expect(run.events).toHaveLength(3);
    expect(run.failure()).toBeUndefined();
    expect(f.signal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signal().aborted).toBe(true);
    await run.done;
    expect(run.failure()).toMatchObject({ details: { reason: 'MODEL_PROGRESS_TIMEOUT' } });
  }
);

it('does not refresh progress for duplicate hosted-tool states', async () => {
  const f = fixture(async function* (signal) {
    for (;;) {
      await pause(50_000, signal);
      yield {
        type: 'hosted_tool',
        itemId: 'search',
        kind: 'WEB_SEARCH',
        status: 'RUNNING',
        summary: { query: 'test' }
      };
    }
  });
  const run = collect(f.turn.start(f.request, f.parent.signal));
  await vi.advanceTimersByTimeAsync(349_999);
  expect(run.failure()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.signal().aborted).toBe(true);
  await run.done;
  expect(run.failure()).toMatchObject({ details: { reason: 'MODEL_PROGRESS_TIMEOUT' } });
});

it('preserves caller cancellation rather than classifying it as a retryable timeout', async () => {
  const f = fixture(async function* (signal) {
    await pause(900_000, signal);
  });
  const run = collect(f.turn.start(f.request, f.parent.signal));
  await vi.advanceTimersByTimeAsync(299_999);
  const reason = new Error('Caller cancelled.');
  f.parent.abort(reason);
  await run.done;
  expect(run.failure()).toBe(reason);
  expect(f.closed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('excludes consumer handling time and cleans up after completion or early return', async () => {
  const f = fixture(async function* () {
    yield { type: 'text.delta', itemId: 'text', phase: 'commentary', delta: 'Working.' };
    yield { type: 'completed', reason: 'completed' };
  });
  const iterator = f.turn.start(f.request, f.parent.signal)[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ value: { type: 'text.delta' } });
  await vi.advanceTimersByTimeAsync(900_000);
  expect(f.signal().aborted).toBe(false);
  expect(await iterator.next()).toMatchObject({ value: { type: 'completed' } });
  expect(await iterator.next()).toMatchObject({ done: true });
  expect(vi.getTimerCount()).toBe(0);
  const early = f.turn.start(f.request, f.parent.signal)[Symbol.asyncIterator]();
  await early.next();
  await early.return?.();
  expect(f.signal().aborted).toBe(true);
  expect(f.closed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves the parent timeout reason when cancellation interrupts recovery backoff', async () => {
  const parent = new AbortController();
  const timeout = new MarAgentError('MAR_AGENT_MODEL_TIMEOUT', 'No generation progress.', {
    details: { reason: 'MODEL_PROGRESS_TIMEOUT' },
    retryable: true
  });
  const retry = recoverModelStream(timeout, { attempts: 1 }, parent.signal);
  const deadline = new MarAgentError('MAR_AGENT_MODEL_TIMEOUT', 'Compaction deadline reached.', {
    details: { reason: 'COMPACTION_DEADLINE_EXCEEDED' }
  });
  parent.abort(deadline);
  await expect(retry).rejects.toBe(deadline);
});
