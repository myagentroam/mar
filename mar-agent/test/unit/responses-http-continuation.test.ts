import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import { renderSubagentUpdate } from '../../src/agent-core/subagent/model-update.js';
import type {
  ModelEvent,
  ModelMessage,
  ModelTurnSession
} from '../../src/agent-core/model/contracts.js';
import {
  startResponsesWebSocketServer,
  type CloseableServer
} from './support/responses-transport-servers.js';

vi.mock('../../src/agent-core/model/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent-core/model/http.js')>();
  return { ...actual, waitForModelRetry: vi.fn(async () => {}) };
});

type ResponsesBody = Record<string, unknown>;
type ResponsesConfigurationOptions = Partial<
  Pick<MarAgentModelConfiguration, 'responsesPreviousResponseId' | 'responsesTransport'>
>;

const servers: CloseableServer[] = [];
const adapters: OpenAiResponsesAdapter[] = [];
const turns: ModelTurnSession[] = [];

afterEach(async () => {
  await Promise.all(turns.splice(0).map((turn) => turn.close()));
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
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

function configuration(
  baseUrl: string,
  options: ResponsesConfigurationOptions = {}
): MarAgentModelConfiguration {
  return {
    id: 'responses-http',
    name: 'Responses HTTP',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    apiKey: new SecretValue('fixture'),
    modelId: 'responses-http',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    responsesTransport: options.responsesTransport ?? { transport: 'HTTP', httpVersion: '1.1' },
    responsesPreviousResponseId: options.responsesPreviousResponseId ?? false,
    enabled: true
  };
}

function responseItem(responseId: string) {
  return {
    type: 'message',
    id: `${responseId}-message`,
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'First answer' }]
  };
}

function completedResponse(responseId: string) {
  const item = responseItem(responseId);
  return [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.done', item },
    {
      type: 'response.completed',
      response: { id: responseId, usage: { input_tokens: 10, output_tokens: 2 } }
    }
  ];
}

async function startHttpResponsesServer(
  responses: readonly (
    readonly unknown[] | { status: number; error: Record<string, unknown> | string }
  )[]
) {
  const requests: ResponsesBody[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const requestIndex = requests.length;
      requests.push(JSON.parse(body) as ResponsesBody);
      const fixture = responses[requestIndex] ?? [];
      if (!Array.isArray(fixture) && 'status' in fixture) {
        response.writeHead(fixture.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: fixture.error }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        (fixture as readonly unknown[])
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function createAdapter(modelConfiguration: MarAgentModelConfiguration) {
  const adapter = new OpenAiResponsesAdapter(modelConfiguration);
  adapters.push(adapter);
  return adapter;
}

function createTurn(adapter: OpenAiResponsesAdapter) {
  const turn = adapter.createTurnSession();
  turns.push(turn);
  return turn;
}

function messagesAfterFirstResponse(responseId: string, nextUser: string): ModelMessage[] {
  return [
    { role: 'user', content: 'First' },
    {
      role: 'provider',
      provider: 'OPENAI_RESPONSES',
      providerModelId: 'responses-http',
      content: '',
      item: responseItem(responseId)
    },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: nextUser }
  ];
}

async function collect(events: AsyncIterable<ModelEvent>) {
  for await (const event of events) void event;
}

function expectFullReplay(body: ResponsesBody, system: string) {
  expect(body).not.toHaveProperty('previous_response_id');
  expect(body).not.toHaveProperty('instructions');
  expect(body.input).toEqual([
    { role: 'developer', content: [{ type: 'input_text', text: system }] },
    { role: 'user', content: 'First' },
    expect.objectContaining({ type: 'message', id: 'response-1-message' }),
    { role: 'user', content: 'Second' }
  ]);
}

describe('Responses HTTP continuation', () => {
  it.each(['HTTP', 'WEBSOCKET'] as const)(
    'preserves continuation when a child update is appended over %s',
    async (transport) => {
      const responses = [completedResponse('response-1'), completedResponse('response-2')];
      const server =
        transport === 'HTTP'
          ? await startHttpResponsesServer(responses)
          : await startResponsesWebSocketServer(responses);
      if ('server' in server) servers.push(server.server);
      const turn = createTurn(
        createAdapter(
          configuration(server.baseUrl, {
            responsesPreviousResponseId: true,
            responsesTransport:
              transport === 'HTTP'
                ? { transport: 'HTTP', httpVersion: '1.1' }
                : { transport: 'WEBSOCKET' }
          })
        )
      );
      await collect(
        turn.start(
          { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
          new AbortController().signal
        )
      );
      const update = renderSubagentUpdate({
        agentId: 'child',
        description: 'Review',
        status: 'completed',
        summary: 'verified'
      });
      await collect(
        turn.start(
          {
            system: 'Reply.',
            messages: [
              ...messagesAfterFirstResponse('response-1', 'Second'),
              { role: 'user', contextKind: 'contextual', content: update }
            ],
            tools: []
          },
          new AbortController().signal
        )
      );
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]).toMatchObject({
        previous_response_id: 'response-1',
        input: [
          { role: 'user', content: 'Second' },
          { role: 'user', content: update }
        ]
      });
    }
  );

  for (const transport of ['default', 'HTTP', 'WEBSOCKET'] as const) {
    it.each([undefined, false, true])(
      `derives store from continuation=%s and ${transport} for initial and follow-up requests`,
      async (continuation) => {
        const responses = [completedResponse('response-1'), completedResponse('response-2')];
        const server =
          transport === 'WEBSOCKET'
            ? await startResponsesWebSocketServer(responses)
            : await startHttpResponsesServer(responses);
        if ('server' in server) servers.push(server.server);
        const config = configuration(server.baseUrl, {
          responsesPreviousResponseId: continuation,
          responsesTransport:
            transport === 'WEBSOCKET'
              ? { transport: 'WEBSOCKET' }
              : { transport: 'HTTP', httpVersion: '1.1' }
        });
        if (transport === 'default') delete config.responsesTransport;
        if (continuation === undefined) delete config.responsesPreviousResponseId;
        const turn = createTurn(createAdapter(config));
        await collect(
          turn.start(
            { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
            new AbortController().signal
          )
        );
        await collect(
          turn.start(
            {
              system: 'Reply.',
              messages: messagesAfterFirstResponse('response-1', 'Second'),
              tools: []
            },
            new AbortController().signal
          )
        );
        const store = continuation === true && transport !== 'WEBSOCKET';
        expect(server.requests).toMatchObject([{ store }, { store }]);
        expect(server.requests[0]).not.toHaveProperty('previous_response_id');
        if (continuation === true)
          expect(server.requests[1]).toMatchObject({
            previous_response_id: 'response-1',
            input: [{ role: 'user', content: 'Second' }]
          });
        else expectFullReplay(server.requests[1] as ResponsesBody, 'Reply.');
      }
    );
  }

  it('continues with only a strict appended input suffix while keeping developer input in input', async () => {
    const server = await startHttpResponsesServer([
      completedResponse('response-1'),
      completedResponse('response-2')
    ]);
    const adapter = createAdapter(
      configuration(server.baseUrl, { responsesPreviousResponseId: true })
    );
    const turn = createTurn(adapter);

    await collect(
      turn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );
    await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: messagesAfterFirstResponse('response-1', 'Second'),
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(server.requests[0]).toMatchObject({
      store: true,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'Reply.' }] },
        { role: 'user', content: 'First' }
      ]
    });
    expect(server.requests[0]).not.toHaveProperty('instructions');
    expect(server.requests[1]).toMatchObject({
      store: true,
      previous_response_id: 'response-1',
      input: [{ role: 'user', content: 'Second' }]
    });
    expect(server.requests[1]).not.toHaveProperty('instructions');
  });

  it.each([
    { status: 404, error: { code: 'previous_response_not_found', message: 'Response expired.' } },
    { status: 400, error: { code: 'invalid_previous_response_id', message: 'Response expired.' } },
    {
      status: 410,
      error: { code: 'invalid_request_error', message: 'previous_response_id expired' }
    },
    {
      status: 400,
      error: { code: 'unsupported_parameter', message: 'previous_response_id is not supported' }
    },
    {
      status: 400,
      error: { code: 'api_error', message: 'gRPC error: Response with id=response-1 not found' }
    },
    { status: 404, error: 'Response with id=response-1 not found' }
  ])('replays once with HTTP storage after an expired response: $error.code', async (failure) => {
    const server = await startHttpResponsesServer([
      completedResponse('response-1'),
      failure,
      completedResponse('response-2'),
      completedResponse('response-3')
    ]);
    const turn = createTurn(
      createAdapter(configuration(server.baseUrl, { responsesPreviousResponseId: true }))
    );
    await collect(
      turn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );
    const history = messagesAfterFirstResponse('response-1', 'Second');
    const diagnostics: unknown[] = [];
    await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: history,
          tools: [],
          onAttemptDiagnostic: (value) => {
            diagnostics.push(value);
          }
        },
        new AbortController().signal
      )
    );
    expect(server.requests).toHaveLength(3);
    expect(server.requests[1]).toMatchObject({
      store: true,
      previous_response_id: 'response-1',
      input: [{ role: 'user', content: 'Second' }]
    });
    expectFullReplay(server.requests[2]!, 'Reply.');
    expect(server.requests[2]).toMatchObject({ store: true });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        state: 'FAILED',
        continuation: true,
        willRetry: true,
        retryReason: 'INVALID_CONTINUATION'
      })
    );
    await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: [
            ...history,
            {
              role: 'provider',
              content: '',
              provider: 'OPENAI_RESPONSES',
              providerModelId: 'responses-http',
              item: responseItem('response-2')
            },
            { role: 'user', content: 'Third' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
    expect(server.requests[3]).toMatchObject({
      store: true,
      previous_response_id: 'response-2',
      input: [{ role: 'user', content: 'Third' }]
    });
  });

  it.each([
    { status: 401, error: { code: 'previous_response_not_found', message: 'Unauthorized.' } },
    {
      status: 403,
      error: { code: 'api_error', message: 'gRPC error: Response with id=response-1 not found' }
    },
    { status: 429, error: { code: 'previous_response_not_found', message: 'Rate limited.' } },
    { status: 400, error: { code: 'api_error', message: 'Account not found' } },
    { status: 400, error: { code: 'api_error', message: 'Model not found' } }
  ])(
    'does not misclassify unrelated failures as expired continuation: $status $error.message',
    async (failure) => {
      const server = await startHttpResponsesServer([
        completedResponse('response-1'),
        failure,
        failure
      ]);
      const turn = createTurn(
        createAdapter(configuration(server.baseUrl, { responsesPreviousResponseId: true }))
      );
      await collect(
        turn.start(
          { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
          new AbortController().signal
        )
      );
      const diagnostics: unknown[] = [];
      await expect(
        collect(
          turn.start(
            {
              system: 'Reply.',
              messages: messagesAfterFirstResponse('response-1', 'Second'),
              tools: [],
              retryState: { attempts: 0, maxAttempts: 2 },
              onAttemptDiagnostic: (value) => {
                diagnostics.push(value);
              }
            },
            new AbortController().signal
          )
        )
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(failure.status === 429 ? 3 : 2);
      expect(server.requests[1]).toHaveProperty('previous_response_id', 'response-1');
      expect(diagnostics).not.toContainEqual(
        expect.objectContaining({ retryReason: 'INVALID_CONTINUATION' })
      );
    }
  );

  it.each(
    ['HTTP', 'WEBSOCKET'].flatMap((transport) =>
      ['unauthorized', 'rate_limit_error', 'permission_denied'].map((code) => ({
        transport,
        code
      }))
    )
  )(
    'preserves statusless $code over $transport instead of replaying an invalid reference',
    async ({ transport, code }) => {
      const failure = [
        {
          type: 'error',
          error: { code, message: 'previous_response_id unavailable for this request' }
        }
      ];
      const responses = [completedResponse('response-1'), failure, failure];
      const server =
        transport === 'HTTP'
          ? await startHttpResponsesServer(responses)
          : await startResponsesWebSocketServer([], { responsesByRequest: responses });
      if ('server' in server) servers.push(server.server);
      const turn = createTurn(
        createAdapter(
          configuration(server.baseUrl, {
            responsesPreviousResponseId: true,
            responsesTransport:
              transport === 'HTTP'
                ? { transport: 'HTTP', httpVersion: '1.1' }
                : { transport: 'WEBSOCKET' }
          })
        )
      );
      await collect(
        turn.start(
          { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
          new AbortController().signal
        )
      );
      const diagnostics: unknown[] = [];
      await expect(
        collect(
          turn.start(
            {
              system: 'Reply.',
              messages: messagesAfterFirstResponse('response-1', 'Second'),
              tools: [],
              retryState: { attempts: 0, maxAttempts: 2 },
              onAttemptDiagnostic: (value) => {
                diagnostics.push(value);
              }
            },
            new AbortController().signal
          )
        )
      ).rejects.toMatchObject({ code });
      expect(diagnostics).not.toContainEqual(
        expect.objectContaining({ retryReason: 'INVALID_CONTINUATION' })
      );
    }
  );

  it('does not repeat the invalid-reference replay when full replay also fails', async () => {
    const failure = { status: 404, error: 'Response with id=response-1 not found' };
    const server = await startHttpResponsesServer([
      completedResponse('response-1'),
      failure,
      failure,
      completedResponse('response-2')
    ]);
    const turn = createTurn(
      createAdapter(configuration(server.baseUrl, { responsesPreviousResponseId: true }))
    );
    await collect(
      turn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );
    const history = messagesAfterFirstResponse('response-1', 'Second');
    await expect(
      collect(
        turn.start({ system: 'Reply.', messages: history, tools: [] }, new AbortController().signal)
      )
    ).rejects.toThrow('Response with id=response-1 not found');
    expect(server.requests).toHaveLength(3);
    expectFullReplay(server.requests[2]!, 'Reply.');
    await collect(
      turn.start({ system: 'Reply.', messages: history, tools: [] }, new AbortController().signal)
    );
    expectFullReplay(server.requests[3]!, 'Reply.');
  });

  it('recovers a streamed Grok missing-reference error before any semantic output', async () => {
    const server = await startHttpResponsesServer([
      completedResponse('response-1'),
      [
        {
          type: 'error',
          error: { code: 'api_error', message: 'gRPC error: Response with id=response-1 not found' }
        }
      ],
      completedResponse('response-2')
    ]);
    const turn = createTurn(
      createAdapter(configuration(server.baseUrl, { responsesPreviousResponseId: true }))
    );
    await collect(
      turn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );
    await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: messagesAfterFirstResponse('response-1', 'Second'),
          tools: []
        },
        new AbortController().signal
      )
    );
    expect(server.requests).toHaveLength(3);
    expectFullReplay(server.requests[2]!, 'Reply.');
  });

  it('replays full history when core developer input changes', async () => {
    const server = await startHttpResponsesServer([
      completedResponse('response-1'),
      completedResponse('response-2')
    ]);
    const adapter = createAdapter(
      configuration(server.baseUrl, { responsesPreviousResponseId: true })
    );
    const turn = createTurn(adapter);

    await collect(
      turn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );
    await collect(
      turn.start(
        {
          system: 'Reply differently.',
          messages: messagesAfterFirstResponse('response-1', 'Second'),
          tools: []
        },
        new AbortController().signal
      )
    );

    expectFullReplay(server.requests[1]!, 'Reply differently.');
    expect(server.requests[1]).toMatchObject({ store: true });
  });

  it('replays full history when previous-response continuation is disabled', async () => {
    const server = await startHttpResponsesServer([
      completedResponse('response-1'),
      completedResponse('response-2')
    ]);
    const adapter = createAdapter(configuration(server.baseUrl));
    const turn = createTurn(adapter);

    await collect(
      turn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );
    await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: messagesAfterFirstResponse('response-1', 'Second'),
          tools: []
        },
        new AbortController().signal
      )
    );

    expectFullReplay(server.requests[1]!, 'Reply.');
    expect(server.requests[1]).toMatchObject({ store: false });
  });

  it('does not restore HTTP continuation state into a new adapter instance', async () => {
    const server = await startHttpResponsesServer([
      completedResponse('response-1'),
      completedResponse('response-2')
    ]);
    const firstAdapter = createAdapter(
      configuration(server.baseUrl, { responsesPreviousResponseId: true })
    );
    const firstTurn = createTurn(firstAdapter);

    await collect(
      firstTurn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );

    const restoredAdapter = createAdapter(
      configuration(server.baseUrl, { responsesPreviousResponseId: true })
    );
    const restoredTurn = createTurn(restoredAdapter);
    await collect(
      restoredTurn.start(
        {
          system: 'Reply.',
          messages: messagesAfterFirstResponse('response-1', 'Second'),
          tools: []
        },
        new AbortController().signal
      )
    );

    expectFullReplay(server.requests[1]!, 'Reply.');
  });

  it('recovers a Grok WebSocket missing reference without changing store:false', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        completedResponse('response-1'),
        [
          {
            type: 'error',
            error: {
              code: 'api_error',
              message: 'gRPC error: Response with id=response-1 not found'
            }
          }
        ],
        completedResponse('response-2')
      ]
    });
    servers.push(server.server);
    const turn = createTurn(
      createAdapter(
        configuration(server.baseUrl, {
          responsesTransport: { transport: 'WEBSOCKET' },
          responsesPreviousResponseId: true
        })
      )
    );
    await collect(
      turn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );
    await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: messagesAfterFirstResponse('response-1', 'Second'),
          tools: []
        },
        new AbortController().signal
      )
    );
    expect(server.requests).toHaveLength(3);
    expect(server.requests[1]).toMatchObject({ store: false, previous_response_id: 'response-1' });
    expect(server.requests[2]).toMatchObject({ store: false });
    expectFullReplay(server.requests[2] as ResponsesBody, 'Reply.');
  });

  it('keeps WebSocket storage false while allowing previous-response continuation', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [completedResponse('response-1'), completedResponse('response-2')]
    });
    servers.push(server.server);

    const adapter = createAdapter(
      configuration(server.baseUrl, {
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true
      })
    );
    const turn = createTurn(adapter);
    await collect(
      turn.start(
        { system: 'Reply.', messages: [{ role: 'user', content: 'First' }], tools: [] },
        new AbortController().signal
      )
    );
    await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: messagesAfterFirstResponse('response-1', 'Second'),
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(server.requests).toMatchObject([
      { store: false },
      {
        store: false,
        previous_response_id: 'response-1',
        input: [{ role: 'user', content: 'Second' }]
      }
    ]);
  });
});
