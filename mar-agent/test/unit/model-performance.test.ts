import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import type { ModelAdapter, ModelEvent } from '../../src/agent-core/model/contracts.js';
import {
  observeModelStreamEvent,
  modelStreamEventObservedAt,
  parseSse
} from '../../src/agent-core/model/sse.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import { startResponsesWebSocketServer } from './support/responses-transport-servers.js';

const model: MarAgentModelConfiguration = {
  id: 'performance',
  name: 'Performance',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test-only'),
  modelId: 'performance',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  titleGeneration: false,
  codeMode: false,
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

async function measure(
  schedule: readonly (readonly [number, ModelEvent, number?])[],
  options: { readonly cancelAfterUsage?: boolean } = {}
) {
  const home = await mkdtemp(join(tmpdir(), 'mar-model-performance-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const adapter = {
    configuration: model,
    async *start(): AsyncIterable<ModelEvent> {
      for (const [at, event, observedAt] of schedule) {
        now = at;
        yield observeModelStreamEvent(structuredClone(event), observedAt);
      }
    }
  };
  const agent = await createMarAgentWithAdapter({
    mode: 'normal',
    models: [model],
    host: new LocalAgentHost({ homeDirectory: home, workspace }),
    adapterFactory: () => adapter
  });
  try {
    const session = await agent.createSession({ workspace, title: 'Performance' });
    const execution = session.run({ prompt: 'Measure without estimating tokens.' });
    const events = [];
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      for await (const event of execution) {
        events.push(event);
        if (
          options.cancelAfterUsage &&
          cancellationTimer === undefined &&
          event.type === 'usage.updated'
        )
          cancellationTimer = setTimeout(() => execution.cancel(), 0);
      }
      const result = await execution.result();
      if (options.cancelAfterUsage) expect(result.status).toBe('cancelled');
    } finally {
      if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
    }
    const persisted = await readFile(
      join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl'),
      'utf8'
    );
    return {
      events,
      persisted,
      metrics: events.filter((event) => event.type === 'model.performance')
    };
  } finally {
    await agent.dispose();
    clock.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
}

const delta = (text: string): ModelEvent => ({
  type: 'text.delta',
  itemId: 'answer',
  phase: 'final_answer',
  delta: text
});
const answer: ModelEvent = { type: 'text.completed', itemId: 'answer', text: 'Done.' };
const usage = (outputTokens: number): ModelEvent => ({ type: 'usage', usage: { outputTokens } });
const complete: ModelEvent = { type: 'completed', reason: 'completed' };

describe('Model output TPS evidence', () => {
  it.each([0, 0.5, 302_000 / 244_948.5, 999.5, 999.999, 1_000, 1_000.001])(
    'requires at least one second of unrounded transport timing for a %s ms window',
    async (duration) => {
      const startedAt = 8_880;
      const endedAt = startedAt + duration;
      const result = await measure([
        [startedAt, { type: 'output.started' }, startedAt],
        [9_000, delta('A'), startedAt],
        [20_000, { type: 'output.completed' }, endedAt],
        [20_000, { type: 'usage', final: true, usage: { outputTokens: 302 } }, endedAt],
        [20_000, answer],
        [20_000, complete, endedAt]
      ]);
      expect(result.metrics[0]).toMatchObject({ latencyMs: startedAt });
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: 'usage.updated', outputTokens: 302 })
      );
      if (duration < 1_000) expect(result.metrics).toHaveLength(1);
      else
        expect(result.metrics.at(-1)).toMatchObject({
          outputTokens: 302,
          outputDurationMs: Math.round(duration),
          tokensPerSecond: Number((302_000 / duration).toFixed(2))
        });
    }
  );

  it('does not publish private-only TPS below one second', async () => {
    const result = await measure(
      [
        [100, { type: 'output.started' }],
        [1_099.999, { type: 'output.completed' }],
        [5_000, { type: 'usage', final: true, usage: { outputTokens: 302 } }],
        [10_000, complete]
      ],
      { cancelAfterUsage: true }
    );
    expect(result.metrics).toEqual([]);
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'usage.updated', outputTokens: 302 })
    );
  });

  it.each([499.999, 500, 500.001])(
    'applies the minimum to summed %s ms segments without hosted execution time',
    async (segmentDuration) => {
      const result = await measure([
        [100, { type: 'output.started' }],
        [100, delta('A')],
        [100 + segmentDuration, { type: 'output.paused' }],
        [10_000, { type: 'output.started' }],
        [10_000, delta('B')],
        [10_000 + segmentDuration, { type: 'output.completed' }],
        [20_000, { type: 'usage', final: true, usage: { outputTokens: 100 } }],
        [20_000, answer],
        [20_000, complete]
      ]);
      if (segmentDuration < 500) expect(result.metrics).toHaveLength(1);
      else
        expect(result.metrics.at(-1)).toMatchObject({
          outputDurationMs: Math.round(segmentDuration * 2),
          tokensPerSecond: Number((100_000 / (segmentDuration * 2)).toFixed(2))
        });
    }
  );

  it('publishes TPS from private generation boundaries without requiring a Latency response', async () => {
    const result = await measure(
      [
        [100, { type: 'output.started' }],
        [1_100, { type: 'output.completed' }],
        [1_500, { type: 'usage', final: true, usage: { outputTokens: 100 } }],
        [3_000, complete]
      ],
      { cancelAfterUsage: true }
    );
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]).toMatchObject({
      outputTokens: 100,
      outputDurationMs: 1_000,
      tokensPerSecond: 100
    });
    expect(result.metrics[0]).not.toHaveProperty('latencyMs');
    expect(result.persisted).not.toContain('model.performance');
  });

  it('starts TPS on private generation deltas, not a late public summary', async () => {
    const result = await measure([
      [100, { type: 'output.delta' }],
      [2_000, { type: 'output.delta' }],
      [
        3_900,
        {
          type: 'reasoning.completed',
          representation: 'summary',
          itemId: 'thinking',
          text: 'Public summary.'
        }
      ],
      [4_000, answer],
      [4_000, usage(1_000)],
      [4_000, complete]
    ]);
    expect(result.metrics).toEqual([
      expect.objectContaining({ latencyMs: 100 }),
      expect.objectContaining({
        latencyMs: 100,
        outputTokens: 1_000,
        outputDurationMs: 3_900,
        tokensPerSecond: 256.41
      })
    ]);
    expect(result.events.some((event) => (event.type as string) === 'output.delta')).toBe(false);
    expect(result.persisted).not.toContain('output.delta');
    expect(result.persisted).not.toContain('model.performance');
  });

  it.each(['completed-only', 'same-instant', 'sub-millisecond'] as const)(
    'does not publish TPS without a positive generation window for %s output',
    async (kind) => {
      const schedule: (readonly [number, ModelEvent])[] = [];
      if (kind !== 'completed-only') schedule.push([3_990, delta('A')]);
      if (kind === 'same-instant') schedule.push([3_990, delta('B')]);
      if (kind === 'sub-millisecond') schedule.push([3_990.4, delta('B')]);
      const end = kind === 'same-instant' ? 3_990 : kind === 'sub-millisecond' ? 3_990.4 : 4_000;
      schedule.push([end, answer], [end, usage(1_000)], [end, complete]);
      const result = await measure(schedule);
      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0]).not.toHaveProperty('tokensPerSecond');
    }
  );

  it('includes hidden generation before the first public reasoning summary', async () => {
    const result = await measure(
      [
        [100, { type: 'output.started' }],
        [
          29_900,
          {
            type: 'reasoning.completed',
            representation: 'summary',
            itemId: 'thinking',
            text: 'Summary.'
          }
        ],
        [30_000, delta('A')],
        [30_050, delta('B')],
        [30_100, usage(5_100)],
        [30_100, complete]
      ],
      { cancelAfterUsage: true }
    );
    expect(result.metrics.at(-1)).toMatchObject({
      latencyMs: 29_900,
      outputTokens: 5_100,
      outputDurationMs: 30_000,
      tokensPerSecond: 170
    });
    expect(result.persisted).not.toContain('output.started');
    expect(result.events.some((event) => (event.type as string) === 'output.started')).toBe(false);
  });

  it('accepts one delta and uses the native final-usage boundary instead of late completion', async () => {
    const result = await measure([
      [100, delta('A')],
      [2_000, { type: 'output.completed' }, 1_100],
      [2_000, usage(100)],
      [5_000, answer],
      [5_000, complete]
    ]);
    expect(result.metrics.at(-1)).toMatchObject({
      outputDurationMs: 1_000,
      tokensPerSecond: 100
    });
    expect(result.persisted).not.toContain('output.completed');
  });

  it('sums generation segments without hosted tool execution or final-usage delivery delays', async () => {
    const result = await measure([
      [100, { type: 'output.started' }],
      [200, delta('A')],
      [700, { type: 'output.paused' }],
      [
        700,
        { type: 'hosted_tool', itemId: 'web', kind: 'WEB_SEARCH', status: 'RUNNING', summary: {} }
      ],
      [
        10_000,
        { type: 'hosted_tool', itemId: 'web', kind: 'WEB_SEARCH', status: 'COMPLETED', summary: {} }
      ],
      [10_100, { type: 'output.started' }],
      [10_200, delta('B')],
      [10_700, { type: 'output.completed' }],
      [15_000, usage(120)],
      [20_000, answer],
      [20_000, complete]
    ]);
    expect(result.metrics.at(-1)).toMatchObject({ outputDurationMs: 1_200, tokensPerSecond: 100 });
  });

  it('resets generation boundaries as well as tokens before a successful retry', async () => {
    const result = await measure([
      [100, { type: 'output.started' }],
      [200, { type: 'output.completed' }],
      [200, usage(1_000)],
      [900, { type: 'output.reset' }],
      [1_000, { type: 'output.started' }],
      [1_500, delta('A')],
      [2_000, { type: 'output.completed' }],
      [2_100, usage(100)],
      [2_500, answer],
      [3_000, complete]
    ]);
    expect(result.metrics.at(-1)).toMatchObject({ outputDurationMs: 1_000, tokensPerSecond: 100 });
  });

  it('does not start TPS on provider context or hosted execution status', async () => {
    const result = await measure([
      [50, { type: 'response.item', provider: 'OPENAI_RESPONSES', item: { type: 'reasoning' } }],
      [
        100,
        { type: 'hosted_tool', itemId: 'web', kind: 'WEB_SEARCH', status: 'RUNNING', summary: {} }
      ],
      [1_000, delta('A')],
      [2_000, delta('B')],
      [3_000, answer],
      [3_000, usage(100)],
      [3_000, complete]
    ]);
    expect(result.metrics.at(-1)).toMatchObject({
      latencyMs: 50,
      outputDurationMs: 2_000,
      tokensPerSecond: 50
    });
  });

  it('uses the latest authoritative tokens and unrounded monotonic duration', async () => {
    const result = await measure([
      [100.2, delta('A')],
      [200, usage(10)],
      [300, delta('B')],
      [1_199.7, answer],
      [1_199.7, usage(100)],
      [1_199.7, complete]
    ]);
    expect(result.metrics.at(-1)).toMatchObject({
      outputTokens: 100,
      outputDurationMs: 1_100,
      tokensPerSecond: 90.95
    });
  });

  it('preserves zero tokens without estimating missing usage from deltas', async () => {
    for (const tokens of [0, undefined]) {
      const schedule: (readonly [number, ModelEvent])[] = [
        [100, delta('A')],
        [900, delta('B')],
        [1_100, answer]
      ];
      if (tokens !== undefined) schedule.push([1_100, usage(tokens)]);
      schedule.push([1_100, complete]);
      const result = await measure(schedule);
      if (tokens === 0) expect(result.metrics.at(-1)).toMatchObject({ tokensPerSecond: 0 });
      else expect(result.metrics).toHaveLength(1);
    }
  });

  it('does not substitute an intermediate usage snapshot for missing final output tokens', async () => {
    const result = await measure([
      [100, delta('A')],
      [200, { type: 'usage', usage: { outputTokens: 100 }, final: false }],
      [1_100, { type: 'output.completed' }],
      [1_100, { type: 'usage', usage: {}, final: true }],
      [2_000, answer],
      [2_000, complete]
    ]);
    expect(result.metrics).toHaveLength(1);
  });

  it.each(['cancelled', 'missing'] as const)(
    'does not settle %s model completion',
    async (terminal) => {
      const schedule: (readonly [number, ModelEvent])[] = [
        [100, delta('A')],
        [1_100, answer],
        [1_100, usage(100)]
      ];
      if (terminal === 'cancelled')
        schedule.push([1_100, { type: 'completed', reason: 'cancelled' }]);
      const result = await measure(schedule);
      expect(result.metrics).toHaveLength(1);
    }
  );

  it('does not turn delayed consumption of one transport batch into a generation window', async () => {
    const result = await measure([
      [900, delta('A'), 100],
      [3_990, delta('B'), 100],
      [4_000, answer],
      [4_000, usage(1_000)],
      [4_000, complete, 100]
    ]);
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]).toMatchObject({ latencyMs: 100 });
    expect(result.metrics[0]).not.toHaveProperty('tokensPerSecond');
  });

  it('uses transport completion time instead of consumer-side processing delay', async () => {
    const result = await measure([
      [900, delta('A'), 100],
      [3_990, delta('B'), 2_000],
      [5_000, answer],
      [5_000, usage(1_000)],
      [5_000, complete, 4_000]
    ]);
    expect(result.metrics.at(-1)).toMatchObject({
      latencyMs: 100,
      outputDurationMs: 3_900,
      tokensPerSecond: 256.41
    });
  });

  it('discards failed-attempt generation samples while preserving logical request latency', async () => {
    const result = await measure([
      [100, { type: 'output.delta' }],
      [200, { type: 'output.delta' }],
      [200, usage(1_000)],
      [900, { type: 'output.reset' }],
      [1_000, { type: 'output.delta' }],
      [1_900, { type: 'output.delta' }],
      [2_000, answer],
      [2_000, usage(100)],
      [2_000, complete]
    ]);
    expect(result.metrics.at(-1)).toMatchObject({
      latencyMs: 100,
      outputTokens: 100,
      outputDurationMs: 1_000,
      tokensPerSecond: 100
    });
    expect(result.persisted).not.toContain('output.reset');
    expect(result.events.some((event) => (event.type as string) === 'output.reset')).toBe(false);
  });
});

async function nativeEvents(
  protocol: MarAgentModelConfiguration['protocol'],
  source: readonly unknown[]
) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(source.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const configuration = { ...model, protocol, baseUrl: `http://127.0.0.1:${address.port}` };
    const adapter: ModelAdapter =
      protocol === 'ANTHROPIC_MESSAGES'
        ? new AnthropicMessagesAdapter(configuration)
        : new OpenAiResponsesAdapter(configuration);
    const events: ModelEvent[] = [];
    for await (const event of adapter.start(
      { system: 'Timing fixture', messages: [], tools: [] },
      new AbortController().signal
    ))
      events.push(event);
    await adapter.close?.();
    return events;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('Native generation timing normalization', () => {
  it('keeps WebSocket receipt timing while the SDK consumer is delayed', async () => {
    const server = await startResponsesWebSocketServer([
      { type: 'response.created', response: { id: 'reply' } },
      { type: 'response.output_text.delta', item_id: 'answer', delta: 'A' },
      { type: 'response.output_text.delta', item_id: 'answer', delta: 'B' },
      {
        type: 'response.completed',
        response: { id: 'reply', output: [], usage: { output_tokens: 10 } }
      }
    ]);
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const adapter = new OpenAiResponsesAdapter({
      ...model,
      protocol: 'OPENAI_RESPONSES',
      baseUrl: server.baseUrl,
      responsesTransport: { transport: 'WEBSOCKET' }
    });
    try {
      const deltas: ModelEvent[] = [];
      for await (const event of adapter.start(
        { system: 'Timing fixture', messages: [], tools: [] },
        new AbortController().signal
      )) {
        if (event.type === 'text.delta') {
          deltas.push(event);
          now = 4_000;
        }
      }
      expect(deltas).toHaveLength(2);
      expect(deltas.map((event) => modelStreamEventObservedAt(event))).toEqual([100, 100]);
    } finally {
      await adapter.close();
      await server.server.close();
      clock.mockRestore();
    }
  });

  it('gives all frames in one SSE chunk the same trusted observation time', async () => {
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const response = new Response(
      'data: {"type":"first","observedAt":999999}\n\ndata: {"type":"second"}\n\n'
    );
    const stream = parseSse(response, new AbortController().signal)[Symbol.asyncIterator]();
    try {
      const first = (await stream.next()).value;
      now = 4_000;
      const second = (await stream.next()).value;
      expect(modelStreamEventObservedAt(first)).toBe(100);
      expect(modelStreamEventObservedAt(second)).toBe(100);
      expect(first).toEqual({ type: 'first', observedAt: 999999 });
      expect(second).toEqual({ type: 'second' });
      await stream.next();
    } finally {
      await stream.return?.();
      clock.mockRestore();
    }
  });

  it('receives later SSE chunks while the SDK consumer is processing an earlier event', async () => {
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      }
    });
    const encoder = new TextEncoder();
    source.enqueue(encoder.encode('data: {"type":"first"}\n\n'));
    const stream = parseSse(new Response(body), new AbortController().signal)[
      Symbol.asyncIterator
    ]();
    try {
      expect(modelStreamEventObservedAt((await stream.next()).value)).toBe(100);
      now = 200;
      source.enqueue(encoder.encode('data: {"type":"second"}\n\n'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      source.close();
      now = 4_000;
      expect(modelStreamEventObservedAt((await stream.next()).value)).toBe(200);
      await stream.next();
    } finally {
      await stream.return?.();
      clock.mockRestore();
    }
  });

  it('cancels an eager SSE receiver when the consumer returns early', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"first"}\n\n'));
        },
        cancel() {
          cancelled = true;
        }
      })
    );
    const stream = parseSse(response, new AbortController().signal)[Symbol.asyncIterator]();
    await stream.next();
    await stream.return?.();
    expect(cancelled).toBe(true);
  });

  it('bounds queued SSE bytes and cancels the receiver before delayed consumption resumes', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    source.enqueue(new TextEncoder().encode('data: {"type":"first"}\n\n'));
    const stream = parseSse(new Response(body), new AbortController().signal, 64)[
      Symbol.asyncIterator
    ]();
    await stream.next();
    source.enqueue(new Uint8Array(65));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
    await expect(stream.next()).rejects.toThrow(/size limit/);
  });

  it('observes Anthropic thinking and tool JSON, but not empty or signature deltas', async () => {
    const events = await nativeEvents('ANTHROPIC_MESSAGES', [
      {
        type: 'message_start',
        message: { id: 'reply', usage: { input_tokens: 10, output_tokens: 0 } }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Private reasoning.' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'private-signature' }
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool', name: 'read', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"reads":[]}' }
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' }
    ]);
    const progress = events.filter((event) => event.type === 'output.delta');
    expect(progress).toEqual([{ type: 'output.delta' }, { type: 'output.delta' }]);
    expect(events.filter((event) => event.type === 'output.started')).toHaveLength(2);
    expect(events.every((event) => modelStreamEventObservedAt(event) !== undefined)).toBe(true);
    const end = events.find((event) => event.type === 'output.completed');
    const finalUsage = events.find((event) => event.type === 'usage' && event.final === true);
    expect(finalUsage).toBeDefined();
    expect(modelStreamEventObservedAt(end)).toBe(modelStreamEventObservedAt(finalUsage));
    expect(progress.every((event) => modelStreamEventObservedAt(event) !== undefined)).toBe(true);
    expect(JSON.stringify(progress)).not.toContain('Private reasoning');
    expect(JSON.stringify(progress)).not.toContain('private-signature');
    expect(events.findIndex((event) => event.type === 'output.delta')).toBeLessThan(
      events.findIndex((event) => event.type === 'reasoning.completed')
    );
    expect(events.find((event) => event.type === 'client_tool.call')).toMatchObject({
      callId: 'tool',
      arguments: { reads: [] }
    });
  });

  it('observes Responses reasoning, function and custom input without exposing delta content', async () => {
    const events = await nativeEvents('OPENAI_RESPONSES', [
      { type: 'response.created', response: { id: 'reply' } },
      { type: 'response.output_item.added', item: { id: 'thinking', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'thinking', delta: '' },
      { type: 'response.reasoning_text.delta', item_id: 'thinking', delta: '' },
      { type: 'response.reasoning_text.delta', item_id: 'thinking', delta: 'Private reasoning.' },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'thinking',
        delta: 'Private reasoning.'
      },
      {
        type: 'response.output_item.added',
        item: { id: 'function', type: 'function_call', name: 'read', call_id: 'read' }
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'function',
        delta: '{"reads":[]}'
      },
      {
        type: 'response.output_item.added',
        item: { id: 'custom', type: 'custom_tool_call', name: 'exec', call_id: 'exec' }
      },
      { type: 'response.custom_tool_call_input.delta', item_id: 'custom', delta: '' },
      { type: 'response.custom_tool_call_input.delta', item_id: 'custom', delta: 'command source' },
      {
        type: 'response.completed',
        response: { id: 'reply', output: [], usage: { input_tokens: 10, output_tokens: 10 } }
      }
    ]);
    const progress = events.filter((event) => event.type === 'output.delta');
    expect(progress).toEqual([
      { type: 'output.delta' },
      { type: 'output.delta' },
      { type: 'output.delta' },
      { type: 'output.delta' }
    ]);
    expect(progress.every((event) => modelStreamEventObservedAt(event) !== undefined)).toBe(true);
    expect(events.filter((event) => event.type === 'output.started')).toHaveLength(3);
    expect(events.every((event) => modelStreamEventObservedAt(event) !== undefined)).toBe(true);
    const end = events.find((event) => event.type === 'output.completed');
    const finalUsage = events.find((event) => event.type === 'usage' && event.final === true);
    expect(finalUsage).toBeDefined();
    expect(modelStreamEventObservedAt(end)).toBe(modelStreamEventObservedAt(finalUsage));
    expect(JSON.stringify(events)).not.toContain('Private reasoning');
    expect(JSON.stringify(progress)).not.toContain('reads');
    expect(JSON.stringify(progress)).not.toContain('command source');
  });

  it('pauses Anthropic hosted execution only after server-tool argument generation', async () => {
    const events = await nativeEvents('ANTHROPIC_MESSAGES', [
      { type: 'message_start', message: { id: 'hosted', usage: { input_tokens: 10 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'web', name: 'web_search', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"example"}' }
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' }
    ]);
    const generated = events.findIndex((event) => event.type === 'output.delta');
    const paused = events.findIndex((event) => event.type === 'output.paused');
    expect(paused).toBeGreaterThan(generated);
    expect(modelStreamEventObservedAt(events[paused])).toBeDefined();
  });

  it('pauses Responses hosted search at its execution boundary', async () => {
    const events = await nativeEvents('OPENAI_RESPONSES', [
      { type: 'response.created', response: { id: 'hosted' } },
      { type: 'response.output_item.added', item: { id: 'thinking', type: 'reasoning' } },
      { type: 'response.web_search_call.in_progress', item_id: 'web' },
      { type: 'response.web_search_call.searching', item_id: 'web' },
      {
        type: 'response.completed',
        response: { id: 'hosted', output: [], usage: { output_tokens: 10 } }
      }
    ]);
    expect(events.filter((event) => event.type === 'output.paused')).toHaveLength(1);
    const paused = events.find((event) => event.type === 'output.paused');
    expect(modelStreamEventObservedAt(paused)).toBeDefined();
  });
});
