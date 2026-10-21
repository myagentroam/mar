import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  LocalAgentHost,
  SecretValue,
  createMarAgent,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import * as modelHttp from '../../src/agent-core/model/http.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import { type ModelEvent } from '../../src/agent-core/model/contracts.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import {
  startHttp2ResponsesServer,
  startHttps1ResponsesServer,
  startSocks5Proxy,
  startResponsesWebSocketServer,
  type CloseableServer
} from './support/responses-transport-servers.js';

const servers: CloseableServer[] = [];
const homes: string[] = [];
const originalTlsRejection = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];

afterEach(async () => {
  if (originalTlsRejection === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = originalTlsRejection;
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
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function responseEvents(answer = 'Completed') {
  return [
    {
      type: 'response.created',
      response: { id: 'response-1' }
    },
    {
      type: 'response.output_text.done',
      item_id: 'message-1',
      phase: 'final_answer',
      text: answer
    },
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: {}
        }
      }
    }
  ];
}

function toolResponseEvents(callId = 'exec-1') {
  return [
    {
      type: 'response.metadata',
      headers: { 'x-codex-turn-state': 'turn-state-1' }
    },
    {
      type: 'response.created',
      response: { id: 'response-tool' }
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        id: 'function-call-1',
        call_id: callId,
        name: 'exec',
        arguments: JSON.stringify({ command: 'pwd', yieldMs: 1_000, timeoutMs: 10_000 })
      }
    },
    {
      type: 'response.completed',
      response: {
        id: 'response-tool',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: {}
        }
      }
    }
  ];
}

function finalResponseEvents(responseId = 'response-final', answer = 'Completed') {
  return [
    {
      type: 'response.created',
      response: { id: responseId }
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        id: `${responseId}-message`,
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        content: [{ type: 'output_text', text: answer }]
      }
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 12,
          output_tokens: 2,
          input_tokens_details: {}
        }
      }
    }
  ];
}

async function startServer(
  handler: Parameters<typeof createServer>[0]
): Promise<{ baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function dynamicConfiguration(
  baseUrl: string,
  provider: {
    acquire(reason: 'REQUEST' | 'UNAUTHORIZED' | 'RECONNECT'): Promise<{
      readonly revision: number;
      readonly expiresAt: number;
      readonly bearer: SecretValue;
      readonly headers: Readonly<Record<string, SecretValue | string>>;
      readonly socks5Url?: SecretValue;
    }>;
    invalidate(revision: number): void;
    close(): Promise<void>;
  },
  responsesTransport: MarAgentModelConfiguration['responsesTransport'] = {
    transport: 'HTTP',
    httpVersion: '1.1'
  }
): MarAgentModelConfiguration {
  return {
    id: 'codex',
    name: 'Codex',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    credentialProvider: provider,
    modelId: 'gpt-codex',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesTransport,
    responsesPreviousResponseId: true,
    enabled: true
  } as unknown as MarAgentModelConfiguration;
}

async function collect(source: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function expectWebSocketContinuationFallback(input: {
  readonly failedEvents: readonly unknown[];
  readonly closeAfterRequestIndexes: readonly number[];
  readonly credentialRevisionChanges: boolean;
  readonly continuationRequestSent: boolean;
  readonly expectedConnections?: number;
}): Promise<void> {
  const server = await startResponsesWebSocketServer([], {
    responsesByRequest: input.continuationRequestSent
      ? [
          toolResponseEvents(),
          input.failedEvents,
          finalResponseEvents('response-recovered', 'Recovered')
        ]
      : [toolResponseEvents(), finalResponseEvents('response-recovered', 'Recovered')],
    closeAfterRequestIndexes: input.closeAfterRequestIndexes
  });
  servers.push(server.server);
  let acquisitions = 0;
  const provider = {
    acquire: vi.fn(async () => {
      acquisitions++;
      const revision = input.credentialRevisionChanges && acquisitions >= 3 ? 2 : 1;
      return {
        revision,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue(`ws-token-${revision}`),
        headers: {}
      };
    }),
    invalidate: vi.fn(),
    close: vi.fn(async () => undefined)
  };
  const adapter = new OpenAiResponsesAdapter(
    dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
  );
  const turn = (
    adapter as unknown as {
      createTurnSession(): {
        start(
          request: Parameters<OpenAiResponsesAdapter['start']>[0],
          signal: AbortSignal
        ): AsyncIterable<ModelEvent>;
        close(): Promise<void>;
      };
    }
  ).createTurnSession();
  const callItem = {
    type: 'function_call',
    id: 'function-call-1',
    call_id: 'exec-1',
    name: 'exec',
    arguments: JSON.stringify({ command: 'pwd', yieldMs: 1_000, timeoutMs: 10_000 })
  };

  try {
    await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Run pwd' }],
          tools: []
        },
        new AbortController().signal
      )
    );
    const events = await collect(
      turn.start(
        {
          system: 'Reply.',
          messages: [
            { role: 'user', content: 'Run pwd' },
            {
              role: 'provider',
              provider: 'OPENAI_RESPONSES',
              providerModelId: 'codex',
              content: '',
              item: callItem
            },
            {
              role: 'tool',
              callId: 'exec-1',
              content: '/workspace'
            }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Recovered' })
    );
    expect(server.connections()).toBe(input.expectedConnections ?? 2);
    expect(server.requests).toHaveLength(input.continuationRequestSent ? 3 : 2);
    if (input.continuationRequestSent)
      expect(server.requests[1]).toHaveProperty('previous_response_id', 'response-tool');
    const fallbackRequest = server.requests[input.continuationRequestSent ? 2 : 1];
    expect(fallbackRequest).not.toHaveProperty('previous_response_id');
    expect(fallbackRequest).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Run pwd' }),
        expect.objectContaining({ type: 'function_call', call_id: 'exec-1' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'exec-1' })
      ])
    });
  } finally {
    await turn.close();
    await adapter.close();
  }
}

describe('MAR Agent runtime credentials', () => {
  it('uses the direct Codex Responses endpoint instead of inserting an OpenAI v1 segment', async () => {
    let requestPath: string | undefined;
    const server = await startServer((request, response) => {
      requestPath = request.url;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          responseEvents()
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(`${server.baseUrl}/backend-api/codex`, provider)
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Hello' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(requestPath).toBe('/backend-api/codex/responses');
  });

  it('acquires Bearer and extra headers per HTTP attempt and retries one prelude 401', async () => {
    const requests: Array<Record<string, string | string[] | undefined>> = [];
    const server = await startServer((request, response) => {
      requests.push(request.headers);
      request.resume();
      request.on('end', () => {
        if (requests.length === 1) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'expired' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          responseEvents()
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    const acquire = vi
      .fn()
      .mockResolvedValueOnce({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('first-token'),
        headers: {
          'ChatGPT-Account-ID': new SecretValue('account-1'),
          originator: 'myagentroam'
        }
      })
      .mockResolvedValueOnce({
        revision: 2,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('second-token'),
        headers: {
          'ChatGPT-Account-ID': new SecretValue('account-1'),
          originator: 'myagentroam'
        }
      });
    const invalidate = vi.fn();
    const provider = { acquire, invalidate, close: vi.fn(async () => undefined) };

    const events = await collect(
      new OpenAiResponsesAdapter(dynamicConfiguration(server.baseUrl, provider)).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Hello' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual({
      type: 'text.completed',
      itemId: 'message-1',
      phase: 'final_answer',
      text: 'Completed'
    });
    expect(acquire.mock.calls.map(([reason]) => reason)).toEqual(['REQUEST', 'UNAUTHORIZED']);
    expect(invalidate).toHaveBeenCalledWith(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      authorization: 'Bearer first-token',
      'chatgpt-account-id': 'account-1',
      originator: 'myagentroam'
    });
    expect(requests[1]).toMatchObject({ authorization: 'Bearer second-token' });
  });

  it('sends the product user agent by default and lets credential headers override it', async () => {
    const requests: Array<Record<string, string | string[] | undefined>> = [];
    const server = await startServer((request, response) => {
      requests.push(request.headers);
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          responseEvents()
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    const providerWith = (headers: Readonly<Record<string, SecretValue | string>>) => ({
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('token'),
        headers
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    });
    const run = (provider: ReturnType<typeof providerWith>) =>
      collect(
        new OpenAiResponsesAdapter(dynamicConfiguration(server.baseUrl, provider)).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Hello' }],
            tools: []
          },
          new AbortController().signal
        )
      );

    await run(providerWith({}));
    await run(providerWith({ 'user-agent': 'CredentialUA/9.9' }));

    expect(requests).toHaveLength(2);
    expect(requests[0]?.['user-agent']).toMatch(/^MyAgentRoam\/.+ \(.+; .+\)$/);
    expect(requests[1]?.['user-agent']).toBe('CredentialUA/9.9');
  });

  it('does not invalidate or replay a 401 after a semantic event was published', async () => {
    let requests = 0;
    const server = await startServer((request, response) => {
      requests++;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            ...responseEvents('Visible').slice(0, 2),
            { type: 'error', code: 'unauthorized', message: 'expired' }
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    const invalidate = vi.fn();
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('single-token'),
        headers: {}
      })),
      invalidate,
      close: vi.fn(async () => undefined)
    };
    const received: ModelEvent[] = [];

    await expect(
      (async () => {
        for await (const event of new OpenAiResponsesAdapter(
          dynamicConfiguration(server.baseUrl, provider)
        ).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Hello' }],
            tools: []
          },
          new AbortController().signal
        ))
          received.push(event);
      })()
    ).rejects.toMatchObject({ code: 'unauthorized' });

    expect(received).toContainEqual({
      type: 'text.completed',
      itemId: 'message-1',
      phase: 'final_answer',
      text: 'Visible'
    });
    expect(requests).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not invalidate credentials for an HTTP 403 response', async () => {
    let requests = 0;
    const server = await startServer((request, response) => {
      requests++;
      request.resume();
      request.on('end', () => {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'forbidden' } }));
      });
    });
    const invalidate = vi.fn();
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('single-token'),
        headers: {}
      })),
      invalidate,
      close: vi.fn(async () => undefined)
    };

    await expect(
      collect(
        new OpenAiResponsesAdapter(dynamicConfiguration(server.baseUrl, provider)).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Do not retry forbidden requests' }],
            tools: []
          },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_AUTH_FAILED',
      details: expect.objectContaining({ status: 403 })
    });

    expect(requests).toBe(1);
    expect(provider.acquire).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not forward dynamic credential headers across an HTTP redirect', async () => {
    let redirectedRequests = 0;
    const redirected = await startServer((request, response) => {
      redirectedRequests++;
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        responseEvents()
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      );
    });
    const source = await startServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(307, {
          location: `${redirected.baseUrl}/v1/responses`
        });
        response.end();
      });
    });
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('redirect-token'),
        headers: { 'ChatGPT-Account-ID': new SecretValue('redirect-account') }
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    await expect(
      collect(
        new OpenAiResponsesAdapter(dynamicConfiguration(source.baseUrl, provider)).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Do not follow redirects' }],
            tools: []
          },
          new AbortController().signal
        )
      )
    ).rejects.toBeDefined();
    expect(redirectedRequests).toBe(0);
  });

  it('uses an ALPN-negotiated HTTP/2 connection for explicit H2 transport', async () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const server = await startHttp2ResponsesServer(responseEvents());
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('h2-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    const events = await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(server.baseUrl, provider, {
          transport: 'HTTP',
          httpVersion: '2'
        })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Hello over H2' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Completed' })
    );
    expect(server.protocols).toEqual(['h2']);
    expect(server.requests).toHaveLength(1);
  });

  it('fails explicit HTTP/2 transport when ALPN does not negotiate H2', async () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const server = await startHttps1ResponsesServer(responseEvents());
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('h2-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    await expect(
      collect(
        new OpenAiResponsesAdapter(
          dynamicConfiguration(server.baseUrl, provider, {
            transport: 'HTTP',
            httpVersion: '2'
          })
        ).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Do not downgrade' }],
            tools: []
          },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_CONNECTION_FAILED' });
    expect(server.requests()).toBe(0);
  });

  it('sends full input on a new Responses WebSocket', async () => {
    const server = await startResponsesWebSocketServer(responseEvents());
    servers.push(server.server);
    const acquire = vi.fn(async () => ({
      revision: 1,
      expiresAt: Date.now() + 60_000,
      bearer: new SecretValue('ws-token'),
      headers: { originator: 'myagentroam' }
    }));
    const provider = {
      acquire,
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    const events = await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Hello over WebSocket' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Completed' })
    );
    expect(server.connections()).toBe(1);
    expect(server.handshakes[0]).toMatchObject({
      authorization: 'Bearer ws-token',
      originator: 'myagentroam',
      'openai-beta': 'responses_websockets=2026-02-06'
    });
    expect(server.requests).toEqual([
      expect.objectContaining({
        type: 'response.create',
        store: false,
        input: [
          { role: 'developer', content: [{ type: 'input_text', text: 'Reply.' }] },
          { role: 'user', content: 'Hello over WebSocket' }
        ],
        stream: true
      })
    ]);
    expect(server.requests[0]).not.toHaveProperty('previous_response_id');
    expect(server.requests[0]).not.toHaveProperty('instructions');
    expect(acquire.mock.calls.map(([reason]) => reason)).toEqual(['REQUEST', 'REQUEST']);
  });

  it('reuses one turn-scoped WebSocket for strict incremental continuation and sticky state', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByConnection: [[toolResponseEvents(), finalResponseEvents()]]
    });
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const adapter = new OpenAiResponsesAdapter(
      dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
    );
    const turn = (
      adapter as unknown as {
        createTurnSession(): {
          start(
            request: Parameters<OpenAiResponsesAdapter['start']>[0],
            signal: AbortSignal
          ): AsyncIterable<ModelEvent>;
          close(): Promise<void>;
        };
      }
    ).createTurnSession();
    const callItem = {
      type: 'function_call',
      id: 'function-call-1',
      call_id: 'exec-1',
      name: 'exec',
      arguments: JSON.stringify({ command: 'pwd', yieldMs: 1_000, timeoutMs: 10_000 })
    };

    try {
      await collect(
        turn.start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Run pwd' }],
            tools: []
          },
          new AbortController().signal
        )
      );
      const events = await collect(
        turn.start(
          {
            system: 'Reply.',
            messages: [
              { role: 'user', content: 'Run pwd' },
              {
                role: 'provider',
                provider: 'OPENAI_RESPONSES',
                providerModelId: 'codex',
                content: '',
                item: callItem
              },
              {
                role: 'tool_call',
                callId: 'exec-1',
                name: 'exec',
                arguments: { command: 'pwd', yieldMs: 1_000, timeoutMs: 10_000 },
                content: ''
              },
              {
                role: 'tool',
                callId: 'exec-1',
                content: '/workspace'
              }
            ],
            tools: []
          },
          new AbortController().signal
        )
      );

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Completed' })
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'unknown', nativeType: 'response.metadata' })
      );
      expect(server.connections()).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]).not.toHaveProperty('previous_response_id');
      expect(server.requests[1]).toMatchObject({
        previous_response_id: 'response-tool',
        input: [
          {
            type: 'function_call_output',
            call_id: 'exec-1',
            output: '/workspace'
          }
        ],
        client_metadata: {
          'x-codex-turn-state': 'turn-state-1'
        }
      });
    } finally {
      await turn.close();
      await adapter.close();
    }
  });

  it('reconnects and retries full history when a WebSocket continuation id is invalid', async () => {
    await expectWebSocketContinuationFallback({
      failedEvents: [
        {
          type: 'error',
          status: 400,
          error: {
            type: 'invalid_request_error',
            message: 'Invalid `previous_response_id`.'
          }
        }
      ],
      closeAfterRequestIndexes: [],
      credentialRevisionChanges: false,
      continuationRequestSent: true
    });
  });

  it('reconnects and retries full history when a WebSocket continuation closes before a semantic event', async () => {
    await expectWebSocketContinuationFallback({
      failedEvents: [
        {
          type: 'response.queued',
          response: { id: 'response-dropped', status: 'queued' }
        },
        {
          type: 'response.created',
          response: { id: 'response-dropped' }
        },
        {
          type: 'response.in_progress',
          response: { id: 'response-dropped', status: 'in_progress' }
        },
        {
          type: 'responsesapi.websocket_timing',
          response_id: 'response-dropped'
        }
      ],
      closeAfterRequestIndexes: [1],
      credentialRevisionChanges: false,
      continuationRequestSent: true
    });
  }, 30_000);

  it('replays full history after reconnecting for a credential revision change', async () => {
    await expectWebSocketContinuationFallback({
      failedEvents: [],
      closeAfterRequestIndexes: [],
      credentialRevisionChanges: true,
      continuationRequestSent: false,
      expectedConnections: 2
    });
  });

  it('keeps the MAR Agent tool continuation on one WebSocket turn session', async () => {
    const invalidContinuation = {
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: 'Invalid `previous_response_id`.'
      }
    };
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        toolResponseEvents(),
        finalResponseEvents('response-agent-final', 'Tool completed'),
        [invalidContinuation]
      ]
    });
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-websocket-turn-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [
        dynamicConfiguration(server.baseUrl, provider, {
          transport: 'WEBSOCKET'
        })
      ]
    });

    try {
      const session = await agent.createSession({ workspace, title: 'WebSocket continuation' });
      await expect(session.run({ prompt: 'Run pwd' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Tool completed'
      });
      expect(server.connections()).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]).toMatchObject({
        previous_response_id: 'response-tool',
        input: [
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'exec-1',
            output: expect.stringContaining(workspace)
          })
        ],
        client_metadata: {
          'x-codex-turn-state': 'turn-state-1'
        }
      });
    } finally {
      await agent.dispose();
    }
  });

  it('preserves structured top-level WebSocket errors', async () => {
    const server = await startResponsesWebSocketServer([
      {
        type: 'error',
        status: 400,
        error: {
          type: 'invalid_request_error',
          message: 'Store must be set to false'
        }
      }
    ]);
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    await expect(
      collect(
        new OpenAiResponsesAdapter(
          dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
        ).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Expose the structured error' }],
            tools: []
          },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: 'invalid_request_error',
      message: expect.stringContaining('Store must be set to false'),
      details: { status: 400 }
    });
  });

  it('invalidates and retries one WebSocket handshake 401 before semantic events', async () => {
    const server = await startResponsesWebSocketServer(responseEvents(), {
      handshakeStatuses: [401]
    });
    servers.push(server.server);
    const acquire = vi.fn(async (reason: 'REQUEST' | 'UNAUTHORIZED' | 'RECONNECT') => ({
      revision: reason === 'REQUEST' ? 1 : 2,
      expiresAt: Date.now() + 60_000,
      bearer: new SecretValue(reason === 'REQUEST' ? 'expired-token' : 'fresh-token'),
      headers: {}
    }));
    const invalidate = vi.fn();
    const provider = {
      acquire,
      invalidate,
      close: vi.fn(async () => undefined)
    };

    const events = await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Retry the handshake' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Completed' })
    );
    expect(invalidate).toHaveBeenCalledWith(1);
    expect(acquire.mock.calls.map(([reason]) => reason)).toEqual([
      'REQUEST',
      'UNAUTHORIZED',
      'UNAUTHORIZED'
    ]);
    expect(server.handshakes).toHaveLength(2);
    expect(server.connections()).toBe(1);
  });

  it('does not send a WebSocket request after cancellation during credential resolution', async () => {
    const server = await startResponsesWebSocketServer(responseEvents(), {
      closeWhenEmpty: false
    });
    servers.push(server.server);
    let resolveSecondAcquire!: () => void;
    let markSecondAcquireStarted!: () => void;
    const secondAcquireStarted = new Promise<void>(
      (resolve) => (markSecondAcquireStarted = resolve)
    );
    const secondAcquireRelease = new Promise<void>((resolve) => (resolveSecondAcquire = resolve));
    let acquisitions = 0;
    const provider = {
      acquire: vi.fn(async () => {
        acquisitions++;
        if (acquisitions === 2) {
          markSecondAcquireStarted();
          await secondAcquireRelease;
        }
        return {
          revision: acquisitions,
          expiresAt: Date.now() + 60_000,
          bearer: new SecretValue('ws-token'),
          headers: {}
        };
      }),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const controller = new AbortController();
    const reason = new Error('cancel during credential resolution');
    const pending = collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Do not send after cancellation' }],
          tools: []
        },
        controller.signal
      )
    );
    let settled = false;
    const completion = pending.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    try {
      await secondAcquireStarted;
      controller.abort(reason);
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
      await expect(completion).resolves.toBe(reason);
      expect(provider.close).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(0);
      await vi.waitFor(() => expect(server.closedConnections()).toBe(1));
    } finally {
      resolveSecondAcquire();
      await completion;
    }
  });

  it('does not retry a deterministic WebSocket protocol error', async () => {
    const server = await startResponsesWebSocketServer([], {
      rawResponseFrames: [Buffer.from([0x81, 0x02, 0xc3, 0x28])]
    });
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    await expect(
      collect(
        new OpenAiResponsesAdapter(
          dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
        ).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Reject invalid WebSocket data' }],
            tools: []
          },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR', retryable: false });

    expect(server.connections()).toBe(1);
    expect(provider.acquire).toHaveBeenCalledTimes(2);
  });

  it('rejects dynamic credential headers reserved by Responses transports', async () => {
    let httpRequests = 0;
    const httpServer = await startServer((request, response) => {
      httpRequests++;
      request.resume();
      response.end();
    });
    const httpProvider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('http-token'),
        headers: { 'session-id': 'credential-controlled-session' }
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    await expect(
      collect(
        new OpenAiResponsesAdapter(dynamicConfiguration(httpServer.baseUrl, httpProvider)).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Protect HTTP headers' }],
            tools: [],
            promptCacheKey: 'sdk-session'
          },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_CONFIG_INVALID' });
    expect(httpRequests).toBe(0);

    const webSocketServer = await startResponsesWebSocketServer(responseEvents());
    servers.push(webSocketServer.server);
    const webSocketProvider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: { 'sec-websocket-key': 'credential-controlled-key' }
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    await expect(
      collect(
        new OpenAiResponsesAdapter(
          dynamicConfiguration(webSocketServer.baseUrl, webSocketProvider, {
            transport: 'WEBSOCKET'
          })
        ).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Protect WebSocket headers' }],
            tools: []
          },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_CONFIG_INVALID' });
    expect(webSocketServer.handshakes).toHaveLength(0);
  });

  it('fails closed when a request-scoped SOCKS5 proxy is unavailable', async () => {
    let directRequests = 0;
    const direct = await startServer((request, response) => {
      directRequests++;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          responseEvents()
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('proxy-token'),
        headers: {},
        socks5Url: new SecretValue('socks5://127.0.0.1:1')
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    await expect(
      collect(
        new OpenAiResponsesAdapter(dynamicConfiguration(direct.baseUrl, provider)).start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Never connect directly' }],
            tools: [],
            retryState: { attempts: 0, maxAttempts: 1 }
          },
          new AbortController().signal
        )
      )
    ).rejects.toBeDefined();
    expect(directRequests).toBe(0);
  });

  it('routes HTTP/1.1 through authenticated SOCKS5 with proxy-side DNS', async () => {
    const target = await startServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          responseEvents()
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    const targetUrl = new URL(target.baseUrl);
    const proxy = await startSocks5Proxy({
      targetPort: Number(targetUrl.port),
      username: 'proxy-user',
      password: 'proxy-pass'
    });
    servers.push(proxy.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('proxy-token'),
        headers: {},
        socks5Url: new SecretValue(proxy.url)
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    const events = await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(`http://model.internal:${targetUrl.port}`, provider)
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Proxy this request' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Completed' })
    );
    expect(proxy.destinations).toEqual([{ host: 'model.internal', port: Number(targetUrl.port) }]);
    expect(proxy.authentications).toEqual([{ username: 'proxy-user', password: 'proxy-pass' }]);
  });

  it('keeps Host-provided web_fetch outside the request-scoped model SOCKS5 proxy', async () => {
    let webFetchRequests = 0;
    const webTarget = await startServer((request, response) => {
      webFetchRequests++;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('NODE_LOCAL_FETCH');
      });
    });
    let modelRequests = 0;
    const modelTarget = await startServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        modelRequests++;
        const events =
          modelRequests === 1
            ? [
                { type: 'response.created', response: { id: 'response-tool' } },
                {
                  type: 'response.output_item.done',
                  item: {
                    type: 'function_call',
                    id: 'web-fetch-item',
                    call_id: 'web-fetch-call',
                    name: 'web_fetch',
                    arguments: JSON.stringify({
                      url: `${webTarget.baseUrl}/resource`,
                      mode: 'http'
                    })
                  }
                },
                { type: 'response.completed', response: { usage: {} } }
              ]
            : responseEvents('Fetched locally');
        if (modelRequests === 2)
          expect(JSON.parse(body)).toMatchObject({
            input: expect.arrayContaining([
              expect.objectContaining({
                type: 'function_call_output',
                call_id: 'web-fetch-call',
                output: expect.stringContaining('NODE_LOCAL_FETCH')
              })
            ])
          });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    const modelUrl = new URL(modelTarget.baseUrl);
    const proxy = await startSocks5Proxy({ targetPort: Number(modelUrl.port) });
    servers.push(proxy.server);
    const acquire = vi.fn(async () => ({
      revision: 1,
      expiresAt: Date.now() + 60_000,
      bearer: new SecretValue('proxy-token'),
      headers: {},
      socks5Url: new SecretValue(proxy.url)
    }));
    const provider = {
      acquire,
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-web-fetch-proxy-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const configuration = dynamicConfiguration(`http://model.internal:${modelUrl.port}`, provider);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({
        homeDirectory: home,
        workspace,
        extensions: {
          tools: [
            {
              name: 'web_fetch',
              description: 'Fetch a web resource.',
              inputSchema: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  mode: { type: 'string', enum: ['http', 'browser'] }
                },
                required: ['url', 'mode']
              }
            }
          ],
          executeTool: async (call, context) => {
            const input = call.arguments as { url: string };
            const response = await fetch(input.url, { signal: context.signal });
            if (!response.ok) throw new Error(`WEB_FETCH_HTTP_${response.status}`);
            return { content: await response.text() };
          }
        }
      }),
      models: [configuration]
    });

    try {
      const session = await agent.createSession({ workspace, title: 'Proxy isolation' });
      await expect(session.run({ prompt: 'Fetch the resource.' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Fetched locally'
      });
      expect(modelRequests).toBe(2);
      expect(webFetchRequests).toBe(1);
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(proxy.destinations).toEqual([
        { host: 'model.internal', port: Number(modelUrl.port) },
        { host: 'model.internal', port: Number(modelUrl.port) }
      ]);
    } finally {
      await agent.dispose();
    }
  });

  it('routes explicit HTTP/2 through SOCKS5 without protocol downgrade', async () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const target = await startHttp2ResponsesServer(responseEvents());
    servers.push(target.server);
    const targetUrl = new URL(target.baseUrl);
    const proxy = await startSocks5Proxy({ targetPort: Number(targetUrl.port) });
    servers.push(proxy.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('proxy-h2-token'),
        headers: {},
        socks5Url: new SecretValue(proxy.url)
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    const events = await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(`https://model.internal:${targetUrl.port}`, provider, {
          transport: 'HTTP',
          httpVersion: '2'
        })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Proxy H2' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Completed' })
    );
    expect(target.protocols).toEqual(['h2']);
    expect(proxy.destinations).toEqual([{ host: 'model.internal', port: Number(targetUrl.port) }]);
  });

  it('routes Responses WebSocket through request-scoped SOCKS5', async () => {
    const target = await startResponsesWebSocketServer(responseEvents());
    servers.push(target.server);
    const targetUrl = new URL(target.baseUrl);
    const proxy = await startSocks5Proxy({ targetPort: Number(targetUrl.port) });
    servers.push(proxy.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('proxy-ws-token'),
        headers: {},
        socks5Url: new SecretValue(proxy.url)
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    const events = await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(`http://model.internal:${targetUrl.port}`, provider, {
          transport: 'WEBSOCKET'
        })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Proxy WebSocket' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Completed' })
    );
    expect(proxy.destinations).toEqual([{ host: 'model.internal', port: Number(targetUrl.port) }]);
  });

  it('reconnects a prelude WebSocket close with RECONNECT credentials', async () => {
    const server = await startResponsesWebSocketServer([[], responseEvents()]);
    servers.push(server.server);
    const acquire = vi.fn(async () => ({
      revision: 1,
      expiresAt: Date.now() + 60_000,
      bearer: new SecretValue('ws-token'),
      headers: {}
    }));
    const provider = {
      acquire,
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    const events = await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Reconnect' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Completed' })
    );
    expect(server.connections()).toBe(2);
    expect(acquire.mock.calls.map(([reason]) => reason)).toEqual([
      'REQUEST',
      'REQUEST',
      'RECONNECT',
      'RECONNECT'
    ]);
  }, 30_000);

  it('retries a WebSocket close after non-semantic response lifecycle events', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        [
          {
            type: 'response.queued',
            response: { id: 'response-dropped', status: 'queued' }
          },
          {
            type: 'response.created',
            response: { id: 'response-dropped' }
          },
          {
            type: 'response.in_progress',
            response: { id: 'response-dropped', status: 'in_progress' }
          },
          {
            type: 'responsesapi.websocket_timing',
            response_id: 'response-dropped'
          }
        ],
        responseEvents()
      ],
      closeAfterRequestIndexes: [0]
    });
    servers.push(server.server);
    const acquire = vi.fn(async () => ({
      revision: 1,
      expiresAt: Date.now() + 60_000,
      bearer: new SecretValue('ws-token'),
      headers: {}
    }));
    const provider = {
      acquire,
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    const events = await collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Retry after lifecycle events' }],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Completed' })
    );
    expect(events.filter((event) => event.type === 'response.started')).toEqual([
      { type: 'response.started', responseId: 'response-1' }
    ]);
    expect(events.some((event) => event.type === 'unknown')).toBe(false);
    expect(server.connections()).toBe(2);
    expect(server.requests).toHaveLength(2);
    expect(acquire.mock.calls.map(([reason]) => reason)).toEqual([
      'REQUEST',
      'REQUEST',
      'RECONNECT',
      'RECONNECT'
    ]);
  }, 30_000);

  it('cancels an active Responses WebSocket without replaying it', async () => {
    const server = await startResponsesWebSocketServer([], { closeWhenEmpty: false });
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const controller = new AbortController();
    const reason = new Error('cancel websocket');
    const pending = collect(
      new OpenAiResponsesAdapter(
        dynamicConfiguration(server.baseUrl, provider, { transport: 'WEBSOCKET' })
      ).start(
        {
          system: 'Reply.',
          messages: [{ role: 'user', content: 'Wait' }],
          tools: []
        },
        controller.signal
      )
    );
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(server.closedConnections()).toBe(1));
    expect(server.connections()).toBe(1);
  });

  it('records exhausted WebSocket EPIPE attempts before a later execution succeeds', async () => {
    const retryWait = vi.spyOn(modelHttp, 'waitForModelRetry').mockResolvedValue(undefined);
    const server = await startResponsesWebSocketServer(responseEvents('Recovered after continue'));
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const originalSend = WebSocket.prototype.send;
    let sendFailures = 0;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      ...args: unknown[]
    ) {
      if (sendFailures < 8) {
        sendFailures++;
        const callback = args.findLast(
          (value): value is (error?: Error) => void => typeof value === 'function'
        );
        if (callback === undefined) throw new Error('WebSocket send callback is required');
        queueMicrotask(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
        return;
      }
      Reflect.apply(originalSend, this, args);
    } as WebSocket['send']);
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-websocket-epipe-log-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [
        dynamicConfiguration(server.baseUrl, provider, {
          transport: 'WEBSOCKET'
        })
      ]
    });

    try {
      const session = await agent.createSession({ workspace, title: 'WebSocket EPIPE log' });
      const failed = session.run({ prompt: 'Fail the current execution' });
      const failedEvents = (async () => {
        const events = [];
        for await (const event of failed) events.push(event);
        return events;
      })();
      const failedResult = await failed.result();
      expect(failedResult).toMatchObject({
        status: 'failed',
        errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        errorMessage: expect.stringContaining('Model request failed after 8 attempts (7 retries).')
      });
      expect(failedResult.errorMessage).toContain('EPIPE');
      expect(await failedEvents).toContainEqual(
        expect.objectContaining({
          type: 'execution.failed',
          code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
          message: expect.stringMatching(
            /Model request failed after 8 attempts \(7 retries\)\.[\s\S]*EPIPE/u
          )
        })
      );

      const continued = session.run({ prompt: 'Continue' });
      await expect(continued.result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Recovered after continue'
      });

      const store = await JsonlSessionStore.open(home);
      const records = await store.read(session.id);
      await store.close();
      const failedAttempts = records
        .filter(
          (record) => record.type === 'model.attempt' && record.executionId === failed.executionId
        )
        .map((record) => record.payload);
      const continuedAttempts = records
        .filter(
          (record) =>
            record.type === 'model.attempt' && record.executionId === continued.executionId
        )
        .map((record) => record.payload);

      expect(failedAttempts).toEqual([
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'STARTED',
          protocol: 'OPENAI_RESPONSES',
          transport: 'WEBSOCKET',
          attempt: 1,
          maxAttempts: 8,
          continuation: false,
          credentialReason: 'REQUEST'
        }),
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'FAILED',
          attempt: 1,
          semanticEventObserved: false,
          errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
          errorMessage: expect.stringContaining('EPIPE'),
          causeCode: 'EPIPE',
          retryable: true,
          willRetry: true,
          retryDelayMs: expect.any(Number),
          durationMs: expect.any(Number)
        }),
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'STARTED',
          attempt: 2,
          credentialReason: 'RECONNECT'
        }),
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'FAILED',
          attempt: 2,
          causeCode: 'EPIPE',
          retryable: true,
          willRetry: true,
          retryDelayMs: expect.any(Number)
        }),
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'STARTED',
          attempt: 3,
          credentialReason: 'RECONNECT'
        }),
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'FAILED',
          attempt: 3,
          causeCode: 'EPIPE',
          retryable: true,
          willRetry: true,
          retryDelayMs: expect.any(Number)
        }),
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'STARTED',
          attempt: 4,
          credentialReason: 'RECONNECT'
        }),
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'FAILED',
          attempt: 4,
          causeCode: 'EPIPE',
          retryable: true,
          willRetry: true,
          retryDelayMs: expect.any(Number)
        }),
        ...[5, 6, 7, 8].flatMap((attempt) => [
          expect.objectContaining({
            purpose: 'EXECUTION',
            state: 'STARTED',
            attempt,
            credentialReason: 'RECONNECT'
          }),
          expect.objectContaining({
            purpose: 'EXECUTION',
            state: 'FAILED',
            attempt,
            causeCode: 'EPIPE',
            retryable: true,
            willRetry: attempt < 8,
            ...(attempt < 8 ? { retryDelayMs: expect.any(Number) } : {})
          })
        ])
      ]);
      const retryDelays = failedAttempts
        .filter(
          (attempt): attempt is typeof attempt & { retryDelayMs: number } =>
            attempt.state === 'FAILED' && typeof attempt.retryDelayMs === 'number'
        )
        .map((attempt) => attempt.retryDelayMs);
      expect(retryDelays).toHaveLength(7);
      for (const [index, delay] of retryDelays.entries()) {
        expect(delay).toBeGreaterThanOrEqual((index + 1) * 5_000);
        expect(delay).toBeLessThanOrEqual((index + 1) * 5_000 + 3_000);
      }
      expect(continuedAttempts).toEqual([
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'STARTED',
          attempt: 1,
          maxAttempts: 8,
          credentialReason: 'REQUEST'
        }),
        expect.objectContaining({
          purpose: 'EXECUTION',
          state: 'SUCCEEDED',
          attempt: 1,
          durationMs: expect.any(Number)
        })
      ]);
      expect(server.connections()).toBe(9);
      expect(server.requests).toHaveLength(1);
    } finally {
      retryWait.mockRestore();
      await agent.dispose();
    }
  });
});
