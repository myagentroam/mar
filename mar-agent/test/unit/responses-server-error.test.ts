import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import type { ModelAttemptDiagnostic, ModelEvent } from '../../src/model/contracts.js';
import { waitForModelRetry } from '../../src/model/http.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import {
  startResponsesWebSocketServer,
  type CloseableServer
} from './support/responses-transport-servers.js';

vi.mock('../../src/model/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/model/http.js')>()),
  waitForModelRetry: vi.fn(async (_value: unknown, _attempt: number, signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason;
  })
}));

const servers: CloseableServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(waitForModelRetry).mockClear();
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

const message = 'The upstream response could not be processed.';
const upstreamError = { code: 'server_error', message };
const envelopes = [
  { name: 'top-level error', event: { type: 'error', ...upstreamError } },
  { name: 'nested error', event: { type: 'error', error: upstreamError } },
  {
    name: 'failed response',
    event: { type: 'response.failed', response: { error: upstreamError } }
  },
  { name: 'untyped error envelope', event: { error: { type: 'server_error', message } } }
];

function configuration(baseUrl: string, transport: 'HTTP' | 'WEBSOCKET'): AgentModelConfiguration {
  return {
    id: 'responses',
    name: 'Responses',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    apiKey: new SecretValue('local-test-key'),
    modelId: 'local-test',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['medium'],
    hostedWebSearch: false,
    responsesTransport: transport === 'HTTP' ? { transport, httpVersion: '1.1' } : { transport },
    responsesPreviousResponseId: true,
    enabled: true
  };
}

async function collect(events: AsyncIterable<ModelEvent>) {
  const result: ModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe.each(['HTTP', 'WEBSOCKET'] as const)(
  '%s structured Responses server_error',
  (transport) => {
    it.each(
      envelopes.flatMap((envelope) => [
        { ...envelope, exhausted: false },
        { ...envelope, exhausted: true }
      ])
    )(
      'recovers $name within eight attempts, exhausted=$exhausted',
      async ({ event, exhausted }) => {
        const responses = [
          ...Array(exhausted ? 8 : 1).fill([
            { type: 'response.created', response: { id: 'discarded' } },
            event
          ]),
          [
            { type: 'response.output_text.done', item_id: 'final', text: 'Recovered' },
            { type: 'response.completed', response: { id: 'success', output: [] } }
          ]
        ];
        const server = await startResponsesWebSocketServer([], { responsesByRequest: responses });
        servers.push(server.server);
        let httpRequests = 0;
        if (transport === 'HTTP')
          vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            const events = responses[httpRequests++]!;
            return new Response(
              events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')
            );
          });
        const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, transport));
        const diagnostics: ModelAttemptDiagnostic[] = [];
        const retryState = { attempts: 0 };
        try {
          const outcome = collect(
            adapter.start(
              {
                system: 'Reply.',
                messages: [{ role: 'user', content: 'Continue.' }],
                tools: [],
                retryState,
                onAttemptDiagnostic: (diagnostic) => {
                  diagnostics.push(diagnostic);
                }
              },
              new AbortController().signal
            )
          );
          if (exhausted)
            await expect(outcome).rejects.toMatchObject({
              code: 'server_error',
              publicMessage: message,
              retryable: true
            });
          else {
            const events = await outcome;
            expect(events).toContainEqual(
              expect.objectContaining({ type: 'text.completed', text: 'Recovered' })
            );
            expect(JSON.stringify(events)).not.toContain('discarded');
          }
          const attempts = exhausted ? 8 : 2;
          expect(transport === 'HTTP' ? httpRequests : server.requests.length).toBe(attempts);
          expect(retryState.attempts).toBe(attempts);
          expect(vi.mocked(waitForModelRetry).mock.calls.map(([, attempt]) => attempt)).toEqual(
            Array.from({ length: exhausted ? 7 : 1 }, (_, index) => index)
          );
          const failures = diagnostics.filter(({ state }) => state === 'FAILED');
          expect(failures).toHaveLength(exhausted ? 8 : 1);
          for (const [index, failure] of failures.entries())
            expect(failure).toMatchObject({
              attempt: index + 1,
              maxAttempts: 8,
              errorCode: 'server_error',
              semanticEventObserved: false,
              retryable: true,
              willRetry: index < 7
            });
          if (transport === 'WEBSOCKET') expect(server.connections()).toBe(attempts);
        } finally {
          await adapter.close();
        }
      }
    );

    it('leaves post-semantic recovery to Runtime instead of replaying in Adapter', async () => {
      const events = [
        { type: 'response.output_text.delta', item_id: 'partial', delta: 'Partial' },
        { type: 'error', ...upstreamError }
      ];
      const server = await startResponsesWebSocketServer(events);
      servers.push(server.server);
      const fetch =
        transport === 'HTTP'
          ? vi
              .spyOn(globalThis, 'fetch')
              .mockResolvedValue(
                new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
              )
          : undefined;
      const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, transport));
      const observed: ModelEvent[] = [];
      const retryState = { attempts: 0 };
      try {
        const outcome = (async () => {
          for await (const event of adapter.start(
            { system: 'Reply.', messages: [], tools: [], retryState },
            new AbortController().signal
          ))
            observed.push(event);
        })();
        await expect(outcome).rejects.toMatchObject({
          code: 'server_error',
          publicMessage: message,
          retryable: true
        });
        expect(observed).toContainEqual(
          expect.objectContaining({ type: 'text.delta', delta: 'Partial' })
        );
        expect(fetch?.mock.calls ?? server.requests).toHaveLength(1);
        expect(retryState.attempts).toBe(1);
        expect(waitForModelRetry).not.toHaveBeenCalled();
      } finally {
        await adapter.close();
      }
    });

    it.each([
      { code: 'unknown_error', message: 'server_error: please retry.' },
      { code: 'authentication_error', message },
      { code: 'invalid_request_error', message },
      { code: 'server_error_extra', message },
      { code: 'SERVER_ERROR', message },
      { message: 'server_error' }
    ])('does not classify free text or another code: $code', async (error) => {
      const server = await startResponsesWebSocketServer([{ type: 'error', ...error }]);
      servers.push(server.server);
      const fetch =
        transport === 'HTTP'
          ? vi
              .spyOn(globalThis, 'fetch')
              .mockResolvedValue(
                new Response(`data: ${JSON.stringify({ type: 'error', ...error })}\n\n`)
              )
          : undefined;
      const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, transport));
      try {
        await expect(
          collect(
            adapter.start(
              { system: 'Reply.', messages: [], tools: [] },
              new AbortController().signal
            )
          )
        ).rejects.toMatchObject({
          code: error.code ?? 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
          retryable: false
        });
        expect(fetch?.mock.calls ?? server.requests).toHaveLength(1);
        expect(waitForModelRetry).not.toHaveBeenCalled();
      } finally {
        await adapter.close();
      }
    });
  }
);
