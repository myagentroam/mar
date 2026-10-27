import { describe, expect, it, vi } from 'vitest';
import type { AgentModelConfiguration } from '../../src/model/configuration.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import {
  observeModelRequestUsage,
  type ModelRequestUsage
} from '../../src/model/usage-observer.js';

const configuration: AgentModelConfiguration = {
  id: 'configuration-1',
  name: 'Configured model',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://example.test',
  modelId: 'requested-model',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  enabled: true
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    system: 'Test system prompt.',
    messages: [{ role: 'user', content: 'Test input.' }],
    tools: [],
    ...overrides
  };
}

async function collect(source: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

describe('observeModelRequestUsage', () => {
  it('publishes one running revision and one terminal revision for a request', async () => {
    const observed: ModelRequestUsage[] = [];
    const events: ModelEvent[] = [{ type: 'completed', reason: 'completed' }];

    const result = await collect(
      observeModelRequestUsage(
        async function* () {
          yield* events;
        },
        request({
          usageRequestId: 'request-1',
          onModelUsage: (value) => observed.push(value)
        }),
        configuration,
        new AbortController().signal,
        vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(200)
      )
    );

    expect(result).toEqual(events);
    expect(observed.map(({ revision, state }) => ({ revision, state }))).toEqual([
      { revision: 1, state: 'running' },
      { revision: 2, state: 'succeeded' }
    ]);
    expect(observed[0]).toMatchObject({
      recordId: observed[1]?.recordId,
      requestId: 'request-1',
      modelConfigurationId: 'configuration-1',
      modelName: 'Configured model',
      provider: 'OPENAI_RESPONSES',
      requestedModel: 'requested-model',
      startedAt: 100
    });
    expect(observed[1]).toMatchObject({
      recordId: observed[0]?.recordId,
      requestId: 'request-1',
      startedAt: 100,
      endedAt: 200
    });
    expect(observed[0]).not.toHaveProperty('endedAt');
  });

  it('replaces snapshots from multiple usage updates without accumulating or duplicating cache counts', async () => {
    const observed: ModelRequestUsage[] = [];

    await collect(
      observeModelRequestUsage(
        async function* () {
          yield { type: 'usage', usage: { totalInputTokens: 100, outputTokens: 10 } };
          yield {
            type: 'usage',
            usage: {
              totalInputTokens: 120,
              inputTokens: 99,
              outputTokens: 7,
              cacheReadTokens: 20,
              cacheWriteTokens: 5,
              reasoningTokens: 2
            }
          };
          yield { type: 'completed', reason: 'completed' };
        },
        request({ onModelUsage: (value) => observed.push(value) }),
        configuration,
        new AbortController().signal,
        () => 100
      )
    );

    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({
      inputTokens: '120',
      outputTokens: '7',
      cacheReadTokens: '20',
      cacheWriteTokens: '5',
      reasoningTokens: '2'
    });
    expect(observed[1]).not.toHaveProperty('inputTokens', '219');
    expect(observed[1]).not.toHaveProperty('outputTokens', '17');
  });

  it('keeps missing and invalid usage values unknown', async () => {
    const observed: ModelRequestUsage[] = [];

    await collect(
      observeModelRequestUsage(
        async function* () {
          yield {
            type: 'usage',
            usage: {
              totalInputTokens: undefined,
              outputTokens: -1,
              cacheReadTokens: 1.5,
              cacheWriteTokens: Number.NaN,
              reasoningTokens: Number.MAX_SAFE_INTEGER + 1
            }
          };
          yield { type: 'completed', reason: 'completed' };
        },
        request({ onModelUsage: (value) => observed.push(value) }),
        configuration,
        new AbortController().signal,
        () => 100
      )
    );

    const terminal = observed[1]!;
    expect(terminal.inputTokens).toBeUndefined();
    expect(terminal.outputTokens).toBeUndefined();
    expect(terminal.cacheReadTokens).toBeUndefined();
    expect(terminal.cacheWriteTokens).toBeUndefined();
    expect(terminal.reasoningTokens).toBeUndefined();
    expect(terminal).not.toHaveProperty('inputTokens');
    expect(terminal).not.toHaveProperty('outputTokens');
    expect(terminal).not.toHaveProperty('cacheReadTokens');
    expect(terminal).not.toHaveProperty('cacheWriteTokens');
    expect(terminal).not.toHaveProperty('reasoningTokens');
  });

  it.each([
    ['success', 'completed', 'succeeded'],
    ['cancellation', 'cancelled', 'cancelled']
  ] as const)('retains partial usage on %s', async (_name, reason, state) => {
    const observed: ModelRequestUsage[] = [];

    await collect(
      observeModelRequestUsage(
        async function* () {
          yield { type: 'usage', usage: { totalInputTokens: 11, outputTokens: 3 } };
          yield { type: 'completed', reason };
        },
        request({ onModelUsage: (value) => observed.push(value) }),
        configuration,
        new AbortController().signal,
        () => 100
      )
    );

    expect(observed[1]).toMatchObject({
      state,
      inputTokens: '11',
      outputTokens: '3'
    });
  });

  it('retains partial usage and preserves a stream error', async () => {
    const observed: ModelRequestUsage[] = [];
    const streamError = new Error('model stream failed');

    await expect(
      collect(
        observeModelRequestUsage(
          async function* () {
            yield { type: 'usage', usage: { totalInputTokens: 13, outputTokens: 4 } };
            throw streamError;
          },
          request({ onModelUsage: (value) => observed.push(value) }),
          configuration,
          new AbortController().signal,
          () => 100
        )
      )
    ).rejects.toBe(streamError);

    expect(observed[1]).toMatchObject({
      state: 'failed',
      inputTokens: '13',
      outputTokens: '4'
    });
  });

  it('does not change the model result when usage callbacks fail and reports failure without details', async () => {
    const events: ModelEvent[] = [
      { type: 'response.started', responseId: 'response-1', modelId: 'actual-model' },
      { type: 'completed', reason: 'completed' }
    ];
    const onModelUsageFailure = vi.fn();

    await expect(
      collect(
        observeModelRequestUsage(
          async function* () {
            yield* events;
          },
          request({
            onModelUsage: () => {
              throw new Error('metering callback details');
            },
            onModelUsageFailure
          }),
          configuration,
          new AbortController().signal,
          () => 100
        )
      )
    ).resolves.toEqual(events);

    expect(onModelUsageFailure).toHaveBeenCalledTimes(2);
    expect(onModelUsageFailure).toHaveBeenCalledWith();
    expect(onModelUsageFailure.mock.calls.every((args) => args.length === 0)).toBe(true);
  });

  it('uses the same request ID and a different record ID for separate attempts', async () => {
    const observed: ModelRequestUsage[] = [];
    const sharedRequest = request({
      usageRequestId: 'request-retry-1',
      onModelUsage: (value) => observed.push(value)
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await collect(
        observeModelRequestUsage(
          async function* () {
            yield { type: 'completed', reason: 'completed' };
          },
          sharedRequest,
          configuration,
          new AbortController().signal,
          () => 100
        )
      );
    }

    expect(observed).toHaveLength(4);
    expect(observed.map(({ requestId }) => requestId)).toEqual([
      'request-retry-1',
      'request-retry-1',
      'request-retry-1',
      'request-retry-1'
    ]);
    expect(observed[0]?.recordId).toBe(observed[1]?.recordId);
    expect(observed[2]?.recordId).toBe(observed[3]?.recordId);
    expect(observed[0]?.recordId).not.toBe(observed[2]?.recordId);
  });

  it('records the response model separately from the requested model', async () => {
    const observed: ModelRequestUsage[] = [];

    await collect(
      observeModelRequestUsage(
        async function* () {
          yield {
            type: 'response.started',
            responseId: 'response-actual-1',
            modelId: 'actual-model'
          };
          yield { type: 'completed', reason: 'completed' };
        },
        request({ onModelUsage: (value) => observed.push(value) }),
        configuration,
        new AbortController().signal,
        () => 100
      )
    );

    expect(observed[1]).toMatchObject({
      requestedModel: 'requested-model',
      actualModel: 'actual-model',
      responseId: 'response-actual-1'
    });
  });

  it('releases the underlying generator when the consumer exits early', async () => {
    const observed: ModelRequestUsage[] = [];
    let released = false;
    const source = observeModelRequestUsage(
      async function* () {
        try {
          yield { type: 'output.started' };
          yield { type: 'output.completed' };
        } finally {
          released = true;
        }
      },
      request({ onModelUsage: (value) => observed.push(value) }),
      configuration,
      new AbortController().signal,
      () => 100
    );
    const iterator = source[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'output.started' }
    });
    await iterator.return?.();

    expect(released).toBe(true);
    expect(observed[1]).toMatchObject({ state: 'interrupted' });
  });
});
