import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import {
  startResponsesWebSocketServer,
  type CloseableServer
} from './support/responses-transport-servers.js';

const servers: CloseableServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
});
const config = (baseUrl = 'http://127.0.0.1:1'): AgentModelConfiguration => ({
  id: 'test',
  name: 'test',
  protocol: 'OPENAI_RESPONSES',
  baseUrl,
  apiKey: new SecretValue('test'),
  modelId: 'test',
  contextWindowTokens: 10000,
  maxOutputTokens: 1000,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  enabled: true,
  responsesTransport: { transport: 'WEBSOCKET' },
  responsesPreviousResponseId: true
});
const request: ModelRequest = {
  system: '',
  messages: [{ role: 'user', content: 'hello' }],
  tools: []
};
const completed = (id: string) => [
  { type: 'response.created', response: { id } },
  { type: 'response.completed', response: { id, status: 'completed', output: [] } }
];
const tick = () => new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 30));
async function collect(events: AsyncIterable<ModelEvent>) {
  for await (const _ of events) {
    /* consume */
  }
}

describe('Responses Turn lifecycle', () => {
  it('preserves a cleanup error across repeated close and releases the lease', async () => {
    const adapter = new OpenAiResponsesAdapter(config());
    const failure = new Error('cleanup failed');
    const release = Promise.withResolvers<void>();
    vi.spyOn(adapter, 'startTurn').mockImplementation(async function* () {
      try {
        yield { type: 'response.started', responseId: 'response' };
      } finally {
        await release.promise;
        throw failure;
      }
    });
    const turn = adapter.createTurnSession();
    const iterator = turn.start(request, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    const first = turn.close();
    const second = turn.close();
    const results = Promise.allSettled([first, second]);
    expect(await Promise.race([results.then(() => 'closed'), tick()])).toBe('waiting');
    release.resolve();
    expect(await results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ]);
    await expect(turn.close()).rejects.toBe(failure);
    const next = adapter.createTurnSession();
    await next.close();
    await adapter.close();
  });

  it('allows an awaited diagnostic to cancel and return before the owner joins, isolating diagnostic errors', async () => {
    const adapter = new OpenAiResponsesAdapter(config());
    const turn = adapter.createTurnSession();
    const controller = new AbortController();
    const diagnosticError = new Error('diagnostic failed');
    const states: string[] = [];
    const iterator = turn
      .start(
        {
          ...request,
          onAttemptDiagnostic: async (diagnostic) => {
            states.push(diagnostic.state);
            if (diagnostic.state === 'STARTED') {
              controller.abort();
              throw diagnosticError;
            }
          }
        },
        controller.signal
      )
      [Symbol.asyncIterator]();
    try {
      const outcome = await iterator.next().then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      );
      expect(controller.signal.aborted).toBe(true);
      expect(outcome.error).toBeDefined();
      expect(outcome.error).not.toBe(diagnosticError);
      expect(states).toEqual(['STARTED', 'FAILED']);
      await expect(turn.close()).resolves.toBeUndefined();
    } finally {
      await turn.close();
      await adapter.close();
    }
  });

  it('cancels and joins a pending next before returning its cache lease, even across repeated close', async () => {
    const adapter = new OpenAiResponsesAdapter(config());
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let aborted = false;
    let finalized = false;
    vi.spyOn(adapter, 'startTurn').mockImplementation(async function* (_request, signal) {
      try {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true }
          );
        });
      } finally {
        await release.promise;
        finalized = true;
      }
    });
    const external = new AbortController();
    const turn = adapter.createTurnSession();
    const iterator = turn.start(request, external.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    await started.promise;
    const close1 = turn.close();
    const close2 = turn.close();
    try {
      expect(await Promise.race([close1.then(() => 'closed'), tick()])).toBe('waiting');
      expect(await Promise.race([close2.then(() => 'closed'), tick()])).toBe('waiting');
      expect(aborted).toBe(true);
      expect(finalized).toBe(false);
    } finally {
      external.abort();
      release.resolve();
      await Promise.allSettled([next, close1, close2]);
      await iterator.return?.();
      await adapter.close();
    }
    expect(finalized).toBe(true);
  });

  it('closes a generator suspended at yield and joins its cleanup before returning', async () => {
    const adapter = new OpenAiResponsesAdapter(config());
    const release = Promise.withResolvers<void>();
    let finalized = false;
    vi.spyOn(adapter, 'startTurn').mockImplementation(async function* () {
      try {
        yield { type: 'response.started', responseId: 'response' };
      } finally {
        await release.promise;
        finalized = true;
      }
    });
    const turn = adapter.createTurnSession();
    const iterator = turn.start(request, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    const close = turn.close();
    try {
      expect(await Promise.race([close.then(() => 'closed'), tick()])).toBe('waiting');
      expect(finalized).toBe(false);
    } finally {
      release.resolve();
      await close;
      await iterator.return?.();
      await adapter.close();
    }
    expect(finalized).toBe(true);
    expect((await iterator.next()).done).toBe(true);
  });

  it('gives concurrent Turns separate sockets and never caches a late return after Adapter close', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [completed('one'), completed('two')]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(config(server.baseUrl));
    const first = adapter.createTurnSession();
    const second = adapter.createTurnSession();
    try {
      await Promise.all([
        collect(first.start(request, new AbortController().signal)),
        collect(second.start(request, new AbortController().signal))
      ]);
      expect(server.connections()).toBe(2);
      await adapter.close();
      await Promise.all([first.close(), second.close(), first.close()]);
      await vi.waitFor(() => expect(server.closedConnections()).toBe(2));
      expect(() => adapter.createTurnSession()).toThrow();
    } finally {
      await Promise.all([first.close(), second.close(), adapter.close()]);
    }
  });

  it.each(['pending', 'yielded'] as const)(
    'cancels a real WebSocket request while %s and does not reuse its incomplete connection',
    async (mode) => {
      const events =
        mode === 'yielded'
          ? [
              { type: 'response.created', response: { id: 'partial' } },
              {
                type: 'response.output_text.delta',
                delta: 'partial',
                item_id: 'item',
                output_index: 0,
                content_index: 0
              }
            ]
          : [];
      const server = await startResponsesWebSocketServer([], {
        closeWhenEmpty: false,
        responsesByRequest: [events, completed('fresh'), completed('reused')]
      });
      servers.push(server.server);
      const adapter = new OpenAiResponsesAdapter(config(server.baseUrl));
      const first = adapter.createTurnSession();
      const iterator = first.start(request, new AbortController().signal)[Symbol.asyncIterator]();
      const next = iterator.next();
      const settled = next.then(
        () => undefined,
        () => undefined
      );
      try {
        await vi.waitFor(() => expect(server.requests).toHaveLength(1));
        if (mode === 'yielded') expect((await next).done).toBe(false);
        await first.close();
        await settled;
        await vi.waitFor(() => expect(server.closedConnections()).toBe(1));
        const second = adapter.createTurnSession();
        await collect(second.start(request, new AbortController().signal));
        await second.close();
        const third = adapter.createTurnSession();
        await collect(third.start(request, new AbortController().signal));
        await third.close();
        expect(server.connections()).toBe(2);
      } finally {
        await first.close();
        await adapter.close();
      }
    }
  );
});
