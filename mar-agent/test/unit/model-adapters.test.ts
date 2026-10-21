import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import { type ModelEvent } from '../../src/agent-core/model/contracts.js';
import { fetchModelResponse, modelRetryDelay } from '../../src/agent-core/model/http.js';
import { parseSse } from '../../src/agent-core/model/sse.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function sseServer(
  events: unknown[],
  inspect: (body: unknown, headers: Record<string, string | string[] | undefined>) => void
) {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      try {
        inspect(JSON.parse(body), request.headers);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const encoded = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
      for (let index = 0; index < encoded.length; index += 7)
        response.write(encoded.slice(index, index + 7));
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('server address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

async function errorServer(status: number, body: unknown) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('server address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

async function sequencedSseServer(
  attempts: readonly (readonly unknown[])[],
  options: {
    retryAfter?: string;
    afterResponse?: (requestCount: number) => void;
  } = {}
) {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const events = attempts[Math.min(requests, attempts.length - 1)] ?? [];
      requests++;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'retry-after': options.retryAfter ?? '0'
      });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      options.afterResponse?.(requests);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests
  };
}

function configuration(
  protocol: MarAgentModelConfiguration['protocol'],
  baseUrl: string
): MarAgentModelConfiguration {
  return {
    id: 'coding',
    name: 'Coding',
    protocol,
    baseUrl,
    apiKey: new SecretValue('test-key'),
    modelId: 'coding',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: true,
    responsesPreviousResponseId: false,
    enabled: true
  };
}

async function collect(source: AsyncIterable<ModelEvent>) {
  const result: ModelEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

async function drain(source: AsyncIterable<unknown>) {
  for await (const value of source) {
    // Consume the stream until it completes or fails.
    void value;
  }
}

describe('model adapters', () => {
  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'stabilizes final nested tool schemas without sorting arrays in %s',
    async (protocol) => {
      const bodies: Array<{ tools: Array<Record<string, unknown>> }> = [];
      const baseUrl = await sseServer(
        protocol === 'OPENAI_RESPONSES'
          ? [{ type: 'response.completed', response: { id: 'r', usage: {} } }]
          : [
              { type: 'message_start', message: { id: 'm', usage: {} } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
              { type: 'message_stop' }
            ],
        (body) => {
          bodies.push(body as (typeof bodies)[number]);
        }
      );
      const schemas = [
        {
          type: 'object',
          properties: {
            zeta: { type: 'string', enum: ['Z', 'A'] },
            alpha: { type: 'array', items: { type: 'object', additionalProperties: true } }
          },
          required: ['zeta', 'alpha'],
          additionalProperties: false
        },
        {
          additionalProperties: false,
          required: ['zeta', 'alpha'],
          properties: {
            alpha: { items: { additionalProperties: true, type: 'object' }, type: 'array' },
            zeta: { enum: ['Z', 'A'], type: 'string' }
          },
          type: 'object'
        }
      ];
      const original = JSON.stringify(schemas);
      const config = { ...configuration(protocol, baseUrl), hostedWebSearch: false };
      const adapter =
        protocol === 'OPENAI_RESPONSES'
          ? new OpenAiResponsesAdapter(config)
          : new AnthropicMessagesAdapter(config);
      try {
        for (const inputSchema of schemas)
          await drain(
            adapter.start(
              {
                system: 'Stable.',
                messages: [{ role: 'user', content: 'Stable.' }],
                tools: [{ name: 'lookup', description: 'Stable.', inputSchema }]
              },
              new AbortController().signal
            )
          );
        expect(JSON.stringify(bodies[0]!.tools)).toBe(JSON.stringify(bodies[1]!.tools));
        const schema = bodies[0]!.tools[0]![
          protocol === 'OPENAI_RESPONSES' ? 'parameters' : 'input_schema'
        ] as {
          properties: { zeta: { enum: string[] } };
          required: string[];
        };
        expect(schema.properties.zeta.enum).toEqual(['Z', 'A']);
        expect(schema.required).toEqual(['zeta', 'alpha']);
        expect(JSON.stringify(schemas)).toBe(original);
      } finally {
        await adapter.close?.();
      }
    }
  );

  it('lowers per-request output limits in both protocols without exceeding configuration', async () => {
    for (const protocol of ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const) {
      for (const outputLimit of [17, 5000]) {
        const baseUrl = await sseServer(
          protocol === 'OPENAI_RESPONSES'
            ? [{ type: 'response.completed', response: { id: 'r', usage: {} } }]
            : [
                { type: 'message_start', message: { id: 'm', usage: {} } },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
                { type: 'message_stop' }
              ],
          (body) =>
            expect(body).toMatchObject(
              protocol === 'OPENAI_RESPONSES'
                ? { max_output_tokens: Math.min(outputLimit, 4096) }
                : { max_tokens: Math.min(outputLimit, 4096) }
            )
        );
        const config = configuration(protocol, baseUrl);
        const adapter =
          protocol === 'OPENAI_RESPONSES'
            ? new OpenAiResponsesAdapter(config)
            : new AnthropicMessagesAdapter(config);
        try {
          const events = await collect(
            adapter.start(
              {
                system: '',
                messages: [{ role: 'user', content: 'limit' }],
                tools: [],
                outputLimit
              },
              new AbortController().signal
            )
          );
          expect(events).toContainEqual({ type: 'completed', reason: 'completed' });
        } finally {
          await adapter.close?.();
        }
      }
    }
  });

  it('bounds model connection wait with a retryable timeout error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const guard = setTimeout(() => reject(new Error('connection timeout guard')), 50);
          const requestSignal = init?.signal as AbortSignal;
          requestSignal.addEventListener(
            'abort',
            () => {
              clearTimeout(guard);
              reject(requestSignal.reason);
            },
            { once: true }
          );
        })
    );

    await expect(
      fetchModelResponse(
        'https://example.test/v1/responses',
        { method: 'POST' },
        new AbortController().signal,
        1,
        10
      )
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_TIMEOUT',
      details: { reason: 'MODEL_CONNECTION_TIMEOUT' },
      retryable: true
    });
  });

  it('forwards caller cancellation while waiting for a model connection', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const requestSignal = init?.signal as AbortSignal;
          requestSignal.addEventListener('abort', () => reject(requestSignal.reason), {
            once: true
          });
        })
    );
    const controller = new AbortController();
    const reason = new Error('caller cancelled connection wait');
    const pending = fetchModelResponse(
      'https://example.test/v1/responses',
      { method: 'POST' },
      controller.signal,
      1,
      1_000
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('bounds idle SSE reads with a retryable timeout error', async () => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          closeTimer = setTimeout(() => controller.close(), 50);
        },
        cancel() {
          if (closeTimer !== undefined) clearTimeout(closeTimer);
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );

    await expect(
      drain(parseSse(response, new AbortController().signal, 1024, 10))
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_TIMEOUT',
      details: { reason: 'MODEL_STREAM_IDLE_TIMEOUT' },
      retryable: true
    });
  });

  it('forwards caller cancellation while waiting for an SSE chunk', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
    const controller = new AbortController();
    const reason = new Error('caller cancelled stream wait');
    const pending = drain(parseSse(response, controller.signal, 1024, 1_000));

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancelled).toBe(true);
  });

  it('bounds idle reads while decoding an HTTP error body', async () => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          closeTimer = setTimeout(() => controller.close(), 50);
        },
        cancel() {
          if (closeTimer !== undefined) clearTimeout(closeTimer);
        }
      }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    );

    await expect(
      drain(parseSse(response, new AbortController().signal, 1024, 10))
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_TIMEOUT',
      details: { reason: 'MODEL_STREAM_IDLE_TIMEOUT' },
      retryable: true
    });
  });

  it('forwards caller cancellation while reading an HTTP error body', async () => {
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          closeTimer = setTimeout(() => controller.close(), 50);
        },
        cancel() {
          cancelled = true;
          if (closeTimer !== undefined) clearTimeout(closeTimer);
        }
      }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    );
    const controller = new AbortController();
    const reason = new Error('caller cancelled error body read');
    const pending = drain(parseSse(response, controller.signal, 1024, 1_000));

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancelled).toBe(true);
  });

  it('bounds HTTP error bodies by the response byte limit', async () => {
    const response = new Response('x'.repeat(2_048), {
      status: 403,
      headers: { 'content-type': 'text/plain' }
    });

    await expect(
      drain(parseSse(response, new AbortController().signal, 1_024, 1_000))
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      message: 'MAR_AGENT_MODEL_PROTOCOL_ERROR: Model response exceeded the size limit.'
    });
  });

  it('forwards reasoning effort through Anthropic output_config', async () => {
    const baseUrl = await sseServer(
      [
        {
          type: 'message_start',
          message: { id: 'msg_effort', usage: { input_tokens: 1 } }
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 }
        },
        { type: 'message_stop' }
      ],
      (body) => {
        expect(body).toMatchObject({ output_config: { effort: 'high' }, tools: [] });
      }
    );

    await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        {
          system: 'system',
          messages: [{ role: 'user', content: 'continue' }],
          tools: [
            {
              name: 'read',
              description: 'Read',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false }
            }
          ],
          reasoningEffort: 'high',
          allowTools: false
        },
        new AbortController().signal
      )
    );
  });

  it('preserves the Anthropic tool catalog while prohibiting all tool calls', async () => {
    const baseUrl = await sseServer(
      [
        {
          type: 'message_start',
          message: { id: 'msg_no_tools', usage: { input_tokens: 1 } }
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 }
        },
        { type: 'message_stop' }
      ],
      (body) => {
        expect(body).toMatchObject({
          tools: [expect.objectContaining({ name: 'read' })],
          tool_choice: { type: 'none' }
        });
      }
    );

    await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        {
          system: 'stable system',
          messages: [{ role: 'user', content: 'compact the native history' }],
          tools: [
            {
              name: 'read',
              description: 'Read',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false }
            }
          ],
          toolChoice: 'none'
        },
        new AbortController().signal
      )
    );
  });

  it('uses the model default when direct adapter requests omit or blank reasoning effort', async () => {
    const anthropicBaseUrl = await sseServer(
      [
        {
          type: 'message_start',
          message: { id: 'msg_default_effort', usage: { input_tokens: 1 } }
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 }
        },
        { type: 'message_stop' }
      ],
      (body) => {
        expect(body).toMatchObject({ output_config: { effort: 'high' } });
      }
    );
    await collect(
      new AnthropicMessagesAdapter({
        ...configuration('ANTHROPIC_MESSAGES', anthropicBaseUrl),
        defaultReasoningEffort: 'high'
      }).start(
        {
          system: 'system',
          messages: [{ role: 'user', content: 'continue' }],
          tools: [],
          reasoningEffort: '   ' as never
        },
        new AbortController().signal
      )
    );

    const responsesBaseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_default_effort' } },
        {
          type: 'response.completed',
          response: {
            usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: {} }
          }
        }
      ],
      (body) => {
        expect(body).toMatchObject({
          reasoning: { effort: 'high', summary: 'auto' },
          text: { verbosity: 'low' }
        });
      }
    );
    await collect(
      new OpenAiResponsesAdapter({
        ...configuration('OPENAI_RESPONSES', responsesBaseUrl),
        defaultReasoningEffort: 'high'
      }).start(
        {
          system: 'system',
          messages: [{ role: 'user', content: 'continue' }],
          tools: []
        },
        new AbortController().signal
      )
    );
  });

  it('follows an Anthropic-compatible redirect before reading the event stream', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      if (request.url === '/v1/messages') {
        request.resume();
        request.on('end', () => {
          response.writeHead(307, { location: '/redirected/messages' });
          response.end();
        });
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        expect(request.url).toBe('/redirected/messages');
        expect(request.headers['x-api-key']).toBe('test-key');
        expect(JSON.parse(body)).toMatchObject({ model: 'coding', stream: true });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            {
              type: 'message_start',
              message: { id: 'msg_redirect', usage: { input_tokens: 1 } }
            },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 }
            },
            { type: 'message_stop' }
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');

    await expect(
      collect(
        new AnthropicMessagesAdapter(
          configuration('ANTHROPIC_MESSAGES', `http://127.0.0.1:${address.port}`)
        ).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'response.started', responseId: 'msg_redirect' }),
        expect.objectContaining({ type: 'completed', reason: 'completed' })
      ])
    );
    expect(requests).toBe(2);
  });

  it('forwards structured upstream error codes and messages without classifying them', async () => {
    const baseUrl = await errorServer(403, {
      error: {
        code: 'insufficient_user_quota',
        message: 'subscription quota insufficient, need=431775',
        type: 'new_api_error'
      }
    });
    await expect(
      collect(
        new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: 'insufficient_user_quota',
      message: 'insufficient_user_quota: subscription quota insufficient, need=431775'
    });
  });

  it.each([408, 504])(
    'classifies an unstructured HTTP %s response as a model timeout after retries',
    async (status) => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(status, { 'content-type': 'text/plain', 'retry-after': '0' });
        response.end('gateway timeout');
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server unavailable');

      await expect(
        collect(
          new OpenAiResponsesAdapter(
            configuration('OPENAI_RESPONSES', `http://127.0.0.1:${address.port}`)
          ).start(
            { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
            new AbortController().signal
          )
        )
      ).rejects.toMatchObject({
        code: 'MAR_AGENT_MODEL_TIMEOUT',
        message: `MAR_AGENT_MODEL_TIMEOUT: Model endpoint returned HTTP ${status}.`,
        retryable: true
      });
      expect(requests).toBe(8);
    }
  );

  it('preserves the K3-compatible HTTP context error type when code is absent', async () => {
    const baseUrl = await errorServer(401, {
      error: {
        type: '<nil>',
        message: 'k3-256k supports only 256K context. (request id: test)'
      },
      type: 'error'
    });
    await expect(
      collect(
        new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: '<nil>',
      message: '<nil>: k3-256k supports only 256K context. (request id: test)'
    });
  });

  it('preserves bounded structured errors from an Anthropic SSE error event', async () => {
    const baseUrl = await sseServer(
      [
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long for the context window'
          }
        }
      ],
      () => undefined
    );
    await expect(
      collect(
        new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: 'invalid_request_error',
      message: 'invalid_request_error: prompt is too long for the context window'
    });
  });

  it.each([
    {
      type: 'error',
      code: 'context_length_exceeded',
      message: 'Input exceeds the context window.'
    },
    {
      type: 'response.failed',
      response: {
        error: {
          code: 'context_length_exceeded',
          message: 'Input exceeds the context window.'
        }
      }
    }
  ])('preserves structured Responses stream errors for $type', async (event) => {
    const baseUrl = await sseServer([event], () => undefined);
    await expect(
      collect(
        new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: 'context_length_exceeded',
      message: 'context_length_exceeded: Input exceeds the context window.'
    });
  });

  it('retains nonempty system text when explicit system blocks are empty', async () => {
    let wire: unknown;
    const baseUrl = await sseServer(
      [{ type: 'response.completed', response: { usage: {} } }],
      (body) => {
        wire = body;
      }
    );
    await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        {
          system: 'Keep this instruction.',
          systemBlocks: [],
          messages: [{ role: 'user', content: 'hello' }],
          tools: []
        },
        new AbortController().signal
      )
    );
    expect(wire).toMatchObject({
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'Keep this instruction.' }] },
        { role: 'user', content: 'hello' }
      ]
    });
    expect(wire).not.toHaveProperty('instructions');
  });

  it.each([true, false, undefined])(
    'serializes tool error marker %s and edited observation text in Anthropic',
    async (isError) => {
      let wire: unknown;
      const baseUrl = await sseServer(
        [
          { type: 'message_start', message: { id: 'm', usage: {} } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
          { type: 'message_stop' }
        ],
        (body) => {
          wire = body;
        }
      );
      await collect(
        new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
          {
            system: '',
            tools: [],
            messages: [
              { role: 'user', content: 'run probe' },
              { role: 'tool_call', callId: 'call', name: 'probe', content: '', arguments: {} },
              {
                role: 'tool',
                callId: 'call',
                content: 'edited observation',
                textBlocks: [{ text: 'edited observation' }],
                observations: [
                  { type: 'value', id: 'original', format: 'text', value: 'original observation' }
                ],
                ...(isError === undefined ? {} : { isError })
              }
            ]
          },
          new AbortController().signal
        )
      );
      const result = (
        wire as {
          messages: { content: { type: string; content?: unknown; is_error?: boolean }[] }[];
        }
      ).messages
        .at(-1)!
        .content.find((block) => block.type === 'tool_result')!;
      expect(result.content).toEqual([{ type: 'text', text: 'edited observation' }]);
      if (isError === undefined) expect(result).not.toHaveProperty('is_error');
      else expect(result.is_error).toBe(isError);
      expect(JSON.stringify(wire)).not.toContain('original observation');
    }
  );

  it('sends transient image blocks in OpenAI and Anthropic tool results', async () => {
    const image = { mimeType: 'image/png', dataBase64: 'aW1hZ2U=' };
    for (const protocol of ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const) {
      const baseUrl = await sseServer(
        protocol === 'OPENAI_RESPONSES'
          ? [{ type: 'response.completed', response: { usage: {} } }]
          : [
              { type: 'message_start', message: { id: 'm', usage: {} } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
              { type: 'message_stop' }
            ],
        (body) => {
          const request = body as { input?: unknown[]; messages?: Array<{ content: unknown }> };
          if (protocol === 'OPENAI_RESPONSES')
            expect(request.input).toContainEqual({
              type: 'function_call_output',
              call_id: 'call_1',
              output: [
                { type: 'input_text', text: 'Viewed image.' },
                { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }
              ]
            });
          else
            expect(request.messages?.at(-1)?.content).toContainEqual({
              type: 'tool_result',
              tool_use_id: 'call_1',
              cache_control: { type: 'ephemeral' },
              content: [
                { type: 'text', text: 'Viewed image.' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' }
                }
              ]
            });
        }
      );
      const adapter =
        protocol === 'OPENAI_RESPONSES'
          ? new OpenAiResponsesAdapter(configuration(protocol, baseUrl))
          : new AnthropicMessagesAdapter(configuration(protocol, baseUrl));
      await collect(
        adapter.start(
          {
            system: 'system',
            messages: [
              { role: 'user', content: 'view it' },
              { role: 'tool_call', callId: 'call_1', name: 'view_image', arguments: {} },
              { role: 'tool', callId: 'call_1', content: 'Viewed image.', images: [image] }
            ],
            tools: []
          },
          new AbortController().signal
        )
      );
    }
  });

  it('keeps restored images on their original user message in both protocols', async () => {
    const image = { mimeType: 'image/png', dataBase64: 'aW1hZ2U=' };
    for (const protocol of ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const) {
      const baseUrl = await sseServer(
        protocol === 'OPENAI_RESPONSES'
          ? [{ type: 'response.completed', response: { usage: {} } }]
          : [
              { type: 'message_start', message: { id: 'm', usage: {} } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
              { type: 'message_stop' }
            ],
        (body) => {
          if (protocol === 'OPENAI_RESPONSES') {
            const input = (body as { input?: Array<{ role?: string; content?: unknown }> }).input;
            const users = input?.filter((item) => item.role === 'user');
            expect(users?.[0]).toEqual({
              role: 'user',
              content: [
                { type: 'input_text', text: 'first image' },
                { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }
              ]
            });
            expect(users?.at(-1)).toEqual({ role: 'user', content: 'look again' });
          } else {
            const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })
              .messages;
            const users = messages?.filter((message) => message.role === 'user');
            expect(users?.[0]).toMatchObject({
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' }
                },
                { type: 'text', text: 'first image' }
              ]
            });
          }
        }
      );
      const adapter =
        protocol === 'OPENAI_RESPONSES'
          ? new OpenAiResponsesAdapter(configuration(protocol, baseUrl))
          : new AnthropicMessagesAdapter(configuration(protocol, baseUrl));
      await collect(
        adapter.start(
          {
            system: 'system',
            messages: [
              { role: 'user', content: 'first image', images: [image] },
              { role: 'assistant', content: 'seen' },
              { role: 'user', content: 'look again' }
            ],
            tools: []
          },
          new AbortController().signal
        )
      );
    }
  });

  it('retries a rate-limited request before streaming starts', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      if (requests < 3) {
        response.writeHead(429, { 'retry-after': '0' });
        response.end('limited');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        'data: {"type":"message_start","message":{"id":"m","usage":{}}}\n\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n' +
          'data: {"type":"message_stop"}\n\n'
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    const events = await collect(
      new AnthropicMessagesAdapter(
        configuration('ANTHROPIC_MESSAGES', `http://127.0.0.1:${address.port}`)
      ).start(
        { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );
    expect(requests).toBe(3);
    expect(events).toContainEqual({ type: 'completed', reason: 'completed' });
  });

  it('retries transient model transport failures before streaming starts', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      if (requests < 3) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        'data: {"type":"response.created","response":{"id":"resp_transport"}}\n\n' +
          'data: {"type":"response.completed","response":{"usage":{}}}\n\n'
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');

    const events = await collect(
      new OpenAiResponsesAdapter(
        configuration('OPENAI_RESPONSES', `http://127.0.0.1:${address.port}`)
      ).start(
        { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(requests).toBe(3);
    expect(events).toContainEqual({ type: 'completed', reason: 'completed' });
  }, 30_000);

  it('does not replay an OpenAI request when a non-success response body resets', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(403, {
        'content-type': 'application/json',
        'retry-after': '0'
      });
      response.write('{"error":');
      setImmediate(() => response.destroy());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');

    await expect(
      collect(
        new OpenAiResponsesAdapter(
          configuration('OPENAI_RESPONSES', `http://127.0.0.1:${address.port}`)
        ).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toBeTruthy();
    expect(requests).toBe(1);
  });

  it('retries a transient OpenAI SSE read failure before a semantic event', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' });
      if (requests === 1) {
        response.write('data: {"type":"response.created","response":{"id":"resp_reset"}}\n\n');
        setImmediate(() => response.destroy());
        return;
      }
      response.end(
        'data: {"type":"response.created","response":{"id":"resp_after_reset"}}\n\n' +
          'data: {"type":"response.completed","response":{"usage":{}}}\n\n'
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');

    const events = await collect(
      new OpenAiResponsesAdapter(
        configuration('OPENAI_RESPONSES', `http://127.0.0.1:${address.port}`)
      ).start(
        { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(requests).toBe(2);
    expect(events.filter((event) => event.type === 'response.started')).toEqual([
      { type: 'response.started', responseId: 'resp_after_reset' }
    ]);
    expect(events).toContainEqual({ type: 'completed', reason: 'completed' });
  });

  it('retries an OpenAI stream that ends before a semantic event and emits only the successful attempt', async () => {
    const patch = '*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch';
    const server = await sequencedSseServer([
      [
        { type: 'response.created', response: { id: 'resp_dropped' } },
        {
          type: 'response.output_item.added',
          item: {
            id: 'custom_patch_dropped',
            type: 'custom_tool_call',
            call_id: 'call_patch_dropped',
            name: 'apply_patch'
          }
        },
        {
          type: 'response.custom_tool_call_input.delta',
          item_id: 'custom_patch_dropped',
          delta: patch.slice(0, 24)
        }
      ],
      [
        { type: 'response.created', response: { id: 'resp_recovered' } },
        {
          type: 'response.output_item.added',
          item: {
            id: 'custom_patch_recovered',
            type: 'custom_tool_call',
            call_id: 'call_patch_recovered',
            name: 'apply_patch'
          }
        },
        {
          type: 'response.custom_tool_call_input.done',
          item_id: 'custom_patch_recovered',
          input: patch
        },
        {
          type: 'response.output_item.done',
          item: {
            id: 'custom_patch_recovered',
            type: 'custom_tool_call',
            call_id: 'call_patch_recovered',
            name: 'apply_patch',
            input: patch
          }
        },
        { type: 'response.completed', response: { id: 'resp_recovered', usage: {} } }
      ]
    ]);

    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', server.baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'write it' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(server.requestCount()).toBe(2);
    expect(events.filter((event) => event.type === 'response.started')).toEqual([
      { type: 'response.started', responseId: 'resp_recovered' }
    ]);
    expect(
      events.filter((event) => event.type === 'output.delta' || event.type === 'output.reset')
    ).toEqual([{ type: 'output.delta' }, { type: 'output.reset' }]);
    expect(events.filter((event) => event.type === 'client_tool.call')).toEqual([
      {
        type: 'client_tool.call',
        callId: 'call_patch_recovered',
        name: 'apply_patch',
        arguments: patch,
        inputMode: 'freeform'
      }
    ]);
    expect(events).toContainEqual({ type: 'completed', reason: 'completed' });
  });

  it('fails an OpenAI stream after the bounded early EOF retry budget is exhausted', async () => {
    const server = await sequencedSseServer([
      [{ type: 'response.created', response: { id: 'resp_incomplete' } }]
    ]);

    await expect(
      collect(
        new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', server.baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      retryable: true
    });
    expect(server.requestCount()).toBe(8);
  });

  it('does not replay an OpenAI stream after a semantic event was emitted', async () => {
    const server = await sequencedSseServer([
      [
        { type: 'response.created', response: { id: 'resp_visible' } },
        {
          type: 'response.output_item.added',
          item: { id: 'msg_visible', type: 'message', role: 'assistant' }
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_visible',
          phase: 'commentary',
          delta: 'visible'
        }
      ]
    ]);
    const emitted: ModelEvent[] = [];

    await expect(
      (async () => {
        for await (const event of new OpenAiResponsesAdapter(
          configuration('OPENAI_RESPONSES', server.baseUrl)
        ).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        ))
          emitted.push(event);
      })()
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR' });

    expect(server.requestCount()).toBe(1);
    expect(emitted).toContainEqual({
      type: 'text.delta',
      itemId: 'msg_visible',
      phase: 'commentary',
      delta: 'visible'
    });
  });

  it('keeps completed commentary once and drops unfinished Patch input before an early EOF', async () => {
    const server = await sequencedSseServer([
      [
        { type: 'response.created', response: { id: 'resp_commentary_patch' } },
        {
          type: 'response.output_item.added',
          item: {
            id: 'msg_commentary',
            type: 'message',
            role: 'assistant',
            phase: 'commentary'
          }
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_commentary',
          phase: 'commentary',
          delta: 'Preparing the document structure.'
        },
        {
          type: 'response.output_text.done',
          item_id: 'msg_commentary',
          phase: 'commentary',
          text: 'Preparing the document structure.'
        },
        {
          type: 'response.output_item.done',
          item: {
            id: 'msg_commentary',
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Preparing the document structure.' }]
          }
        },
        {
          type: 'response.output_item.added',
          item: {
            id: 'custom_patch_incomplete',
            type: 'custom_tool_call',
            call_id: 'call_patch_incomplete',
            name: 'apply_patch'
          }
        },
        {
          type: 'response.custom_tool_call_input.delta',
          item_id: 'custom_patch_incomplete',
          delta: '*** Begin Patch\n*** Add File: unfinished.txt'
        }
      ]
    ]);
    const emitted: ModelEvent[] = [];

    await expect(
      (async () => {
        for await (const event of new OpenAiResponsesAdapter(
          configuration('OPENAI_RESPONSES', server.baseUrl)
        ).start(
          { system: 'system', messages: [{ role: 'user', content: 'write it' }], tools: [] },
          new AbortController().signal
        ))
          emitted.push(event);
      })()
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      details: { reason: 'OPENAI_RESPONSES_EARLY_EOF' }
    });

    expect(server.requestCount()).toBe(1);
    expect(emitted.filter((event) => event.type === 'text.completed')).toEqual([
      {
        type: 'text.completed',
        itemId: 'msg_commentary',
        phase: 'commentary',
        text: 'Preparing the document structure.'
      }
    ]);
    expect(emitted.filter((event) => event.type === 'response.item')).toEqual([
      expect.objectContaining({
        type: 'response.item',
        provider: 'OPENAI_RESPONSES',
        item: expect.objectContaining({ id: 'msg_commentary', status: 'completed' })
      })
    ]);
    expect(emitted.some((event) => event.type === 'client_tool.call')).toBe(false);
  });

  it('cancels during OpenAI early EOF backoff without starting another request', async () => {
    const controller = new AbortController();
    const server = await sequencedSseServer(
      [[{ type: 'response.created', response: { id: 'resp_cancel' } }]],
      {
        retryAfter: '30',
        afterResponse: (requestCount) => {
          if (requestCount === 1)
            setImmediate(() => controller.abort(new Error('cancelled during retry backoff')));
        }
      }
    );

    await expect(
      collect(
        new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', server.baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          controller.signal
        )
      )
    ).rejects.toBeTruthy();
    expect(controller.signal.aborted).toBe(true);
    expect(server.requestCount()).toBe(1);
  });

  it('retries an OpenAI stream overload error before any semantic event', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(modelRetryDelay(null, 0)).toBe(6500);
    expect(modelRetryDelay('invalid', 1)).toBe(11500);
    expect(modelRetryDelay('0', 2)).toBe(0);
    expect(modelRetryDelay('5', 2)).toBe(5000);
    expect(modelRetryDelay('60', 2)).toBe(30000);
    const server = await sequencedSseServer([
      [
        { type: 'response.created', response: { id: 'resp_dropped' } },
        {
          type: 'error',
          code: 'server_is_overloaded',
          message: 'Our servers are currently overloaded. Please try again later.'
        }
      ],
      [
        { type: 'response.created', response: { id: 'resp_recovered' } },
        {
          type: 'response.output_item.added',
          item: { id: 'msg_recovered', type: 'message', role: 'assistant', phase: 'final_answer' }
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_recovered',
          phase: 'final_answer',
          delta: 'recovered'
        },
        { type: 'response.completed', response: { id: 'resp_recovered', usage: {} } }
      ]
    ]);

    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', server.baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'write it' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(server.requestCount()).toBe(2);
    expect(events.filter((event) => event.type === 'response.started')).toEqual([
      { type: 'response.started', responseId: 'resp_recovered' }
    ]);
    expect(events).toContainEqual({
      type: 'text.delta',
      itemId: 'msg_recovered',
      phase: 'final_answer',
      delta: 'recovered'
    });
    expect(events).toContainEqual({ type: 'completed', reason: 'completed' });
  });

  it('preserves an OpenAI stream overload error after the bounded retry budget is exhausted', async () => {
    const server = await sequencedSseServer([
      [
        {
          type: 'error',
          code: 'system_cpu_overloaded',
          message: 'system cpu overloaded (current: 91.6%, threshold: 90%)'
        }
      ]
    ]);

    await expect(
      collect(
        new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', server.baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: 'system_cpu_overloaded',
      message: 'system_cpu_overloaded: system cpu overloaded (current: 91.6%, threshold: 90%)',
      retryable: true
    });
    expect(server.requestCount()).toBe(8);
  });

  it('does not replay an OpenAI stream overload error after a semantic event was emitted', async () => {
    const server = await sequencedSseServer([
      [
        { type: 'response.created', response: { id: 'resp_visible' } },
        {
          type: 'response.output_item.added',
          item: { id: 'msg_visible', type: 'message', role: 'assistant', phase: 'commentary' }
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_visible',
          phase: 'commentary',
          delta: 'visible'
        },
        {
          type: 'error',
          code: 'system_cpu_overloaded',
          message: 'system cpu overloaded (current: 91.6%, threshold: 90%)'
        }
      ]
    ]);
    const emitted: ModelEvent[] = [];

    await expect(
      (async () => {
        for await (const event of new OpenAiResponsesAdapter(
          configuration('OPENAI_RESPONSES', server.baseUrl)
        ).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        ))
          emitted.push(event);
      })()
    ).rejects.toMatchObject({ code: 'system_cpu_overloaded' });

    expect(server.requestCount()).toBe(1);
    expect(emitted).toContainEqual({
      type: 'text.delta',
      itemId: 'msg_visible',
      phase: 'commentary',
      delta: 'visible'
    });
  });

  it('retries an Anthropic stream overload error before any semantic event', async () => {
    const server = await sequencedSseServer([
      [
        { type: 'message_start', message: { id: 'msg_dropped', usage: { input_tokens: 1 } } },
        {
          type: 'error',
          error: {
            type: 'system_cpu_overloaded',
            message: 'system cpu overloaded (current: 91.6%, threshold: 90%)'
          }
        }
      ],
      [
        { type: 'message_start', message: { id: 'msg_recovered', usage: { input_tokens: 1 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', id: 'blk_recovered', text: 'recovered' }
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 }
        },
        { type: 'message_stop' }
      ]
    ]);

    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', server.baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'write it' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(server.requestCount()).toBe(2);
    expect(events.filter((event) => event.type === 'response.started')).toEqual([
      { type: 'response.started', responseId: 'msg_recovered' }
    ]);
    expect(events).toContainEqual({
      type: 'text.delta',
      itemId: 'blk_recovered',
      phase: 'commentary',
      delta: 'recovered'
    });
    expect(events).toContainEqual({ type: 'completed', reason: 'completed' });
  });

  it('preserves an Anthropic stream overload error after the bounded retry budget is exhausted', async () => {
    const server = await sequencedSseServer([
      [
        {
          type: 'error',
          error: {
            type: 'system_cpu_overloaded',
            message: 'system cpu overloaded (current: 91.6%, threshold: 90%)'
          }
        }
      ]
    ]);

    await expect(
      collect(
        new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', server.baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({
      code: 'system_cpu_overloaded',
      message: 'system_cpu_overloaded: system cpu overloaded (current: 91.6%, threshold: 90%)',
      retryable: true
    });
    expect(server.requestCount()).toBe(8);
  });

  it('does not replay an Anthropic stream overload error after a semantic event was emitted', async () => {
    const server = await sequencedSseServer([
      [
        { type: 'message_start', message: { id: 'msg_visible', usage: { input_tokens: 1 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', id: 'blk_visible', text: 'visible' }
        },
        {
          type: 'error',
          error: {
            type: 'system_cpu_overloaded',
            message: 'system cpu overloaded (current: 91.6%, threshold: 90%)'
          }
        }
      ]
    ]);
    const emitted: ModelEvent[] = [];

    await expect(
      (async () => {
        for await (const event of new AnthropicMessagesAdapter(
          configuration('ANTHROPIC_MESSAGES', server.baseUrl)
        ).start(
          { system: 'system', messages: [{ role: 'user', content: 'continue' }], tools: [] },
          new AbortController().signal
        ))
          emitted.push(event);
      })()
    ).rejects.toMatchObject({ code: 'system_cpu_overloaded' });

    expect(server.requestCount()).toBe(1);
    expect(emitted).toContainEqual({
      type: 'text.delta',
      itemId: 'blk_visible',
      phase: 'commentary',
      delta: 'visible'
    });
  });

  it('sends Codex Fast only when enabled on the model', async () => {
    const tiers: unknown[] = [];
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_fast' } },
        {
          type: 'response.output_item.done',
          item: {
            id: 'msg_fast',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        },
        { type: 'response.completed', response: { id: 'resp_fast' } }
      ],
      (body) => {
        tiers.push((body as Record<string, unknown>).service_tier);
      }
    );
    const request = {
      system: 'system',
      messages: [{ role: 'user' as const, content: 'hello' }],
      tools: []
    };
    const modes = [
      {},
      { fastMode: false },
      { fastMode: true },
      ...(['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast'] as const).map(
        (serviceTier) => ({ serviceTier })
      ),
      { fastMode: true, serviceTier: 'default' as const }
    ];
    for (const mode of modes) {
      const model = { ...configuration('OPENAI_RESPONSES', baseUrl), ...mode };
      await collect(new OpenAiResponsesAdapter(model).start(request, new AbortController().signal));
    }
    expect(tiers).toEqual([
      undefined,
      undefined,
      'priority',
      'auto',
      'default',
      'flex',
      'priority',
      'fast',
      'ultrafast',
      'default'
    ]);
  });

  it('retains hosted web identity and search details through output-item completion', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_web' } },
        {
          type: 'response.output_item.added',
          item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' }
        },
        { type: 'response.web_search_call.searching', item_id: 'ws_1' },
        {
          type: 'response.output_item.done',
          item: {
            id: 'ws_1',
            type: 'web_search_call',
            status: 'completed',
            action: {
              type: 'search',
              queries: ['first query', 'second query'],
              sources: [
                { url: 'https://example.test/one', title: 'First source' },
                { url: 'https://example.test/two' }
              ]
            }
          }
        },
        { type: 'response.web_search_call.completed', item_id: 'ws_1' },
        {
          type: 'response.output_item.done',
          item: {
            id: 'ws_2',
            type: 'web_search_call',
            action: {
              type: 'search',
              query: 'another search',
              sources: Array.from({ length: 21 }, (_, index) => ({
                url: `https://example.test/${index}`
              }))
            }
          }
        },
        { type: 'response.completed', response: { id: 'resp_web' } }
      ],
      (body) => {
        expect(body).toMatchObject({
          include: ['reasoning.encrypted_content', 'web_search_call.action.sources']
        });
      }
    );
    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'Search' }], tools: [] },
        new AbortController().signal
      )
    );
    expect(
      events.filter((event) => event.type === 'hosted_tool' && event.itemId === 'ws_1')
    ).toEqual([
      expect.objectContaining({ itemId: 'ws_1', status: 'RUNNING' }),
      expect.objectContaining({ itemId: 'ws_1', status: 'RUNNING' }),
      expect.objectContaining({
        itemId: 'ws_1',
        status: 'COMPLETED',
        summary: {
          query: 'first query\nsecond query',
          sources: [
            { url: 'https://example.test/one', title: 'First source' },
            { url: 'https://example.test/two' }
          ]
        }
      }),
      expect.objectContaining({
        itemId: 'ws_1',
        status: 'COMPLETED',
        summary: {
          query: 'first query\nsecond query',
          sources: [
            { url: 'https://example.test/one', title: 'First source' },
            { url: 'https://example.test/two' }
          ]
        }
      })
    ]);
    const otherSearch = events.find(
      (event) => event.type === 'hosted_tool' && event.itemId === 'ws_2'
    );
    expect(otherSearch).toMatchObject({
      type: 'hosted_tool',
      itemId: 'ws_2',
      status: 'COMPLETED',
      summary: { query: 'another search', sourcesTruncated: true }
    });
    if (otherSearch?.type === 'hosted_tool') {
      expect(otherSearch.summary.sources).toHaveLength(20);
      expect(otherSearch.summary.sources?.at(-1)).toEqual({ url: 'https://example.test/19' });
    }
  });

  it('preserves native hosted web tool names and action parameters without exposing provider fields', async () => {
    const actions = [
      { type: 'search', query: 'single query' },
      { type: 'search', queries: ['first query', 'second query'] },
      { type: 'open_page', url: 'https://example.test/page' },
      { type: 'find_in_page', url: 'https://example.test/page', pattern: 'exact phrase' },
      { type: 'open_page' }
    ];
    const baseUrl = await sseServer(
      [
        ...actions.flatMap((action, index) => [
          {
            type: 'response.output_item.done',
            item: {
              id: `ws_native_${index}`,
              type: 'web_search_call',
              status: 'completed',
              action: { ...action, unknown_provider_field: 'not public' }
            }
          },
          { type: 'response.web_search_call.completed', item_id: `ws_native_${index}` }
        ]),
        { type: 'response.completed', response: { id: 'resp_native_web' } }
      ],
      () => {}
    );
    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'Search' }], tools: [] },
        new AbortController().signal
      )
    );
    for (const [index, action] of actions.entries()) {
      const hosted = events.filter(
        (event) => event.type === 'hosted_tool' && event.itemId === `ws_native_${index}`
      );
      expect(hosted).toHaveLength(2);
      for (const event of hosted) {
        expect(event).toMatchObject({ toolName: 'web_search', input: action, status: 'COMPLETED' });
        expect(event).not.toHaveProperty('input.unknown_provider_field');
      }
    }
  });

  it('bounds hosted web action input and marks truncation without losing native identity', async () => {
    const baseUrl = await sseServer(
      [
        {
          type: 'response.output_item.done',
          item: {
            id: 'ws_long',
            type: 'web_search_call',
            action: {
              type: 'find_in_page',
              url: 'https://example.test/' + 'x'.repeat(2_048),
              pattern: 'p'.repeat(10_001),
              queries: Array.from({ length: 11 }, () => 'q'.repeat(10_001))
            }
          }
        },
        { type: 'response.web_search_call.completed', item_id: 'ws_long' },
        { type: 'response.completed', response: { id: 'resp_long_web' } }
      ],
      () => {}
    );
    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'Search' }], tools: [] },
        new AbortController().signal
      )
    );
    const hosted = events.filter((event) => event.type === 'hosted_tool');
    expect(hosted).toHaveLength(2);
    for (const event of hosted) {
      expect(event).toMatchObject({ toolName: 'web_search', truncated: true });
      if (event.type !== 'hosted_tool') continue;
      expect(event.input?.type).toBe('find_in_page');
      expect((event.input?.url as string).length).toBe(2_048);
      expect((event.input?.pattern as string).length).toBe(10_000);
      expect(event.input?.queries).toHaveLength(10);
      expect((event.input?.queries as string[])[0]).toHaveLength(10_000);
      expect(event).not.toHaveProperty('output');
    }
  });

  it('updates Anthropic hosted search input while running and completes the same tool', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'msg_hosted', usage: { input_tokens: 1 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query":"current news"}' }
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_1',
            content: [{ type: 'web_search_result', url: 'https://example.test', title: 'Result' }]
          }
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }
      ],
      () => {}
    );
    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'Search' }], tools: [] },
        new AbortController().signal
      )
    );
    expect(events.filter((event) => event.type === 'hosted_tool')).toEqual([
      {
        type: 'hosted_tool',
        itemId: 'srv_1',
        kind: 'WEB_SEARCH',
        toolName: 'web_search',
        status: 'RUNNING',
        summary: {}
      },
      {
        type: 'hosted_tool',
        itemId: 'srv_1',
        kind: 'WEB_SEARCH',
        toolName: 'web_search',
        input: { query: 'current news' },
        status: 'RUNNING',
        summary: { query: 'current news' }
      },
      {
        type: 'hosted_tool',
        itemId: 'srv_1',
        kind: 'WEB_SEARCH',
        toolName: 'web_search',
        input: { query: 'current news' },
        output: { sources: [{ url: 'https://example.test', title: 'Result' }] },
        status: 'COMPLETED',
        summary: {
          query: 'current news',
          sources: [{ url: 'https://example.test', title: 'Result' }]
        }
      }
    ]);
  });

  it('shows initial Anthropic hosted input and marks a server tool error as failed', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'msg_failed', usage: { input_tokens: 1 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'server_tool_use',
            id: 'srv_failed',
            name: 'web_fetch',
            input: { url: 'https://example.test/page' }
          }
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'web_fetch_tool_result',
            tool_use_id: 'srv_failed',
            content: { type: 'web_fetch_tool_result_error', error_code: 'max_uses_exceeded' }
          }
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }
      ],
      () => {}
    );
    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'Fetch' }], tools: [] },
        new AbortController().signal
      )
    );
    expect(events.filter((event) => event.type === 'hosted_tool')).toEqual([
      {
        type: 'hosted_tool',
        itemId: 'srv_failed',
        kind: 'WEB_FETCH',
        toolName: 'web_fetch',
        input: { url: 'https://example.test/page' },
        status: 'RUNNING',
        summary: { url: 'https://example.test/page' }
      },
      {
        type: 'hosted_tool',
        itemId: 'srv_failed',
        kind: 'WEB_FETCH',
        toolName: 'web_fetch',
        input: { url: 'https://example.test/page' },
        status: 'FAILED',
        summary: { url: 'https://example.test/page' }
      }
    ]);
  });

  it('normalizes OpenAI text, function calls, hosted web and usage', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_1' } },
        {
          type: 'response.output_item.added',
          item: { id: 'msg_1', type: 'message', role: 'assistant' }
        },
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'hello' },
        { type: 'response.output_text.done', item_id: 'msg_1', text: 'hello' },
        {
          type: 'response.output_item.done',
          item: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'hello' }]
          }
        },
        { type: 'response.output_text.done', item_id: 'msg_1', text: 'hello' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'call_item_1',
            call_id: 'call_1',
            name: 'read',
            arguments: '{"path":"a"}'
          }
        },
        {
          type: 'response.output_item.done',
          item: {
            id: 'web_1',
            type: 'web_search_call',
            action: { type: 'open_page', url: 'https://example.test' }
          }
        },
        {
          type: 'response.output_text.annotation.added',
          item_id: 'msg_1',
          annotation_index: 0,
          annotation: { type: 'url_citation', url: 'https://example.test', title: 'Example' }
        },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              codex_rollout_budget_units: 17,
              input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 }
            }
          }
        }
      ],
      (body, headers) => {
        expect(headers.authorization).toBe('Bearer test-key');
        expect(headers['user-agent']).toMatch(/^MyAgentRoam\/.+ \(.+; .+\)$/);
        expect(headers['session-id']).toBe('session-cache-key');
        expect(headers['thread-id']).toBe('session-cache-key');
        expect(headers['x-client-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(headers['x-client-request-id']).not.toBe('session-cache-key');
        expect(headers.session_id).toBeUndefined();
        expect(body).toMatchObject({
          model: 'coding',
          stream: true,
          store: false,
          text: { verbosity: 'low' },
          prompt_cache_key: 'session-cache-key',
          include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
          parallel_tool_calls: true,
          reasoning: { effort: 'high', summary: 'auto' },
          tools: expect.arrayContaining([
            expect.objectContaining({
              type: 'function',
              name: 'read',
              strict: true,
              parameters: expect.objectContaining({
                required: ['offset', 'path'],
                properties: expect.objectContaining({
                  offset: expect.objectContaining({ type: ['integer', 'null'] })
                })
              })
            }),
            expect.objectContaining({ type: 'web_search' })
          ])
        });
        expect(body).not.toHaveProperty('max_output_tokens');
        expect(body).not.toHaveProperty('tools.0.parameters.propertyNames');
        expect(body).not.toHaveProperty('tools.0.parameters.properties.offset.propertyNames');
        const users = (
          body as { input?: Array<{ role?: string; content?: unknown }> }
        ).input?.filter((item) => item.role === 'user');
        expect(users).toHaveLength(1);
        expect(users?.[0]?.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'input_image',
              image_url: 'data:image/png;base64,aW1hZ2U='
            })
          ])
        );
      }
    );
    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        {
          system: 'system',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [
            {
              name: 'read',
              description: 'Read',
              inputSchema: {
                type: 'object',
                propertyNames: { pattern: '^[a-z]+$' },
                properties: {
                  path: { type: 'string' },
                  offset: { type: 'integer', propertyNames: { pattern: '^[a-z]+$' } }
                },
                required: ['path'],
                additionalProperties: false
              }
            }
          ],
          reasoningEffort: 'high',
          promptCacheKey: 'session-cache-key',
          images: [{ mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }]
        },
        new AbortController().signal
      )
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'response.started', responseId: 'resp_1' },
        { type: 'text.delta', itemId: 'msg_1', phase: 'commentary', delta: 'hello' },
        { type: 'text.completed', itemId: 'msg_1', phase: 'commentary', text: 'hello' },
        { type: 'client_tool.call', callId: 'call_1', name: 'read', arguments: { path: 'a' } },
        expect.objectContaining({
          type: 'hosted_tool',
          itemId: 'web_1',
          kind: 'WEB_FETCH',
          summary: { url: 'https://example.test' }
        }),
        expect.objectContaining({
          type: 'citation',
          citation: expect.objectContaining({ url: 'https://example.test' })
        }),
        expect.objectContaining({
          type: 'usage',
          usage: expect.objectContaining({
            inputTokens: 10,
            contextInputTokens: 10,
            outputTokens: 3,
            cacheReadTokens: 6,
            cacheWriteTokens: 2,
            rolloutBudgetUnits: 17
          })
        })
      ])
    );
    expect(
      events.filter((event) => event.type === 'text.completed' && event.itemId === 'msg_1')
    ).toHaveLength(1);

    const compactBaseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_compact' } },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 10, output_tokens: 3 } }
        }
      ],
      (body) => {
        expect(body).toMatchObject({ tools: [], include: ['reasoning.encrypted_content'] });
      }
    );
    await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', compactBaseUrl)).start(
        {
          system: '# Compaction contract',
          messages: [{ role: 'user', content: 'compact the current context' }],
          tools: [
            {
              name: 'read',
              description: 'Read',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false }
            }
          ],
          allowTools: false
        },
        new AbortController().signal
      )
    );
  });

  it('rejects invalid OpenAI rollout budget units', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_invalid_budget' } },
        {
          type: 'response.completed',
          response: { usage: { codex_rollout_budget_units: -1 } }
        }
      ],
      () => undefined
    );

    await expect(
      collect(
        new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
          { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR' });
  });

  it('preserves the Responses tool catalog while prohibiting all tool calls', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_no_tools' } },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 10, output_tokens: 3 } }
        }
      ],
      (body) => {
        expect(body).toMatchObject({
          tool_choice: 'none',
          include: ['reasoning.encrypted_content'],
          tools: [
            expect.objectContaining({ type: 'function', name: 'read' }),
            { type: 'web_search' }
          ]
        });
      }
    );
    await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        {
          system: 'stable system',
          messages: [{ role: 'user', content: 'compact the native history' }],
          tools: [
            {
              name: 'read',
              description: 'Read',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false }
            }
          ],
          toolChoice: 'none'
        },
        new AbortController().signal
      )
    );
  });

  it('uses a freeform custom apply_patch tool and normalizes its raw input', async () => {
    const patch = '*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch';
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_patch' } },
        {
          type: 'response.output_item.added',
          item: {
            id: 'custom_patch_1',
            type: 'custom_tool_call',
            call_id: 'call_patch_1',
            name: 'apply_patch'
          }
        },
        {
          type: 'response.custom_tool_call_input.delta',
          item_id: 'custom_patch_1',
          delta: patch.slice(0, 24)
        },
        {
          type: 'response.custom_tool_call_input.done',
          item_id: 'custom_patch_1',
          input: patch
        },
        {
          type: 'response.output_item.done',
          item: {
            id: 'custom_patch_1',
            type: 'custom_tool_call',
            call_id: 'call_patch_1',
            name: 'apply_patch',
            input: patch
          }
        },
        { type: 'response.completed', response: { usage: {} } }
      ],
      (body) => {
        expect(body.tools).toContainEqual({
          type: 'custom',
          name: 'apply_patch',
          description: 'Apply patch'
        });
        expect(body.tools).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'apply_patch', type: 'function' })
          ])
        );
      }
    );
    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        {
          system: 'system',
          messages: [{ role: 'user', content: 'edit' }],
          tools: [
            {
              name: 'apply_patch',
              description: 'Apply patch',
              inputSchema: {
                type: 'object',
                properties: { patch: { type: 'string' } },
                required: ['patch'],
                additionalProperties: false
              },
              inputMode: 'freeform'
            }
          ]
        },
        new AbortController().signal
      )
    );
    expect(events).toContainEqual({
      type: 'client_tool.call',
      callId: 'call_patch_1',
      name: 'apply_patch',
      arguments: patch,
      inputMode: 'freeform'
    });
  });

  it('replays custom apply_patch calls and outputs with their native item types', async () => {
    const patchItem = {
      id: 'custom_patch_2',
      type: 'custom_tool_call',
      call_id: 'call_patch_2',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** End Patch'
    };
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_patch_replay' } },
        { type: 'response.completed', response: { usage: {} } }
      ],
      (body) => {
        expect(body.input).toEqual([
          { role: 'developer', content: [{ type: 'input_text', text: 'system' }] },
          patchItem,
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch_2',
            output: '{"files":[]}'
          }
        ]);
      }
    );
    await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        {
          system: 'system',
          messages: [
            {
              role: 'provider',
              provider: 'OPENAI_RESPONSES',
              item: patchItem,
              content: ''
            },
            {
              role: 'tool_call',
              callId: 'call_patch_2',
              name: 'apply_patch',
              arguments: patchItem.input,
              inputMode: 'freeform',
              content: ''
            },
            { role: 'tool', callId: 'call_patch_2', content: '{"files":[]}' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
  });

  it('preserves Responses output items for stateless encrypted-history replay', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'reasoning_1',
      encrypted_content: 'opaque-value',
      summary: []
    };
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_items' } },
        { type: 'response.output_item.done', item: reasoning },
        { type: 'response.completed', response: { usage: {} } }
      ],
      (body) => {
        expect(body.input).toEqual([
          {
            role: 'developer',
            content: [{ type: 'input_text', text: 'system' }]
          },
          reasoning,
          { role: 'user', content: 'continue' }
        ]);
      }
    );
    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        {
          system: 'system',
          messages: [
            {
              role: 'provider',
              provider: 'OPENAI_RESPONSES',
              content: '',
              item: reasoning
            },
            { role: 'user', content: 'continue' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
    expect(events).toContainEqual({
      type: 'response.item',
      provider: 'OPENAI_RESPONSES',
      item: reasoning
    });
  });

  it('omits stateless reasoning history that has no encrypted state', async () => {
    const reasoning = { type: 'reasoning', id: 'reasoning_without_state', summary: [] };
    const baseUrl = await sseServer(
      [{ type: 'response.completed', response: { usage: {} } }],
      (body) => {
        expect(body).toMatchObject({ store: false });
        const input = body.input as Array<{ role?: string; content?: unknown }>;
        expect(input[0]).toEqual({
          role: 'developer',
          content: [{ type: 'input_text', text: 'system' }]
        });
        expect(input.filter((item) => item.role === 'user')).toEqual([
          { role: 'user', content: 'continue' }
        ]);
        expect(input).not.toContainEqual(reasoning);
      }
    );
    await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        {
          system: 'system',
          messages: [
            {
              role: 'provider',
              provider: 'OPENAI_RESPONSES',
              content: '',
              item: reasoning
            },
            { role: 'user', content: 'continue' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
  });

  it('sends full local history over Responses HTTP', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          'data: {"type":"response.created","response":{"id":"resp_new"}}\n\n' +
            'data: {"type":"response.completed","response":{"usage":{}}}\n\n'
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    const config = configuration('OPENAI_RESPONSES', `http://127.0.0.1:${address.port}`);
    config.responsesPreviousResponseId = true;

    await collect(
      new OpenAiResponsesAdapter(config).start(
        {
          system: 'system',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'answer' },
            { role: 'user', content: 'next' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );

    expect(bodies).toEqual([
      expect.objectContaining({
        store: true,
        input: [
          {
            role: 'developer',
            content: [{ type: 'input_text', text: 'system' }]
          },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'next' }
        ]
      })
    ]);
    expect(bodies[0]).not.toHaveProperty('previous_response_id');
  });

  it('normalizes Anthropic content blocks and pause_turn', async () => {
    const baseUrl = await sseServer(
      [
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            usage: {
              input_tokens: 8,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 2
            }
          }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'exec', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"action":"poll"}' }
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'pause_turn' },
          usage: {
            input_tokens: 3,
            cache_read_input_tokens: 11,
            cache_creation_input_tokens: 1,
            output_tokens: 4
          }
        },
        { type: 'message_stop' }
      ],
      (body, headers) => {
        expect(headers['x-api-key']).toBe('test-key');
        expect(headers['anthropic-version']).toBe('2023-06-01');
        expect(headers['user-agent']).toMatch(/^MyAgentRoam\/.+ \(.+; .+\)$/);
        expect(body).toMatchObject({ model: 'coding', stream: true });
        expect(JSON.stringify(body)).toContain('aW1hZ2U=');
        expect(JSON.stringify(body)).not.toContain('web_fetch_');
      }
    );
    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        {
          system: 'system',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          images: [{ mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }]
        },
        new AbortController().signal
      )
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'response.started', responseId: 'msg_1' },
        { type: 'text.delta', itemId: 'msg_1:content-0', phase: 'commentary', delta: 'done' },
        {
          type: 'text.completed',
          itemId: 'msg_1:content-0',
          phase: 'commentary',
          text: 'done'
        },
        { type: 'client_tool.call', callId: 'tool_1', name: 'exec', arguments: { action: 'poll' } },
        {
          type: 'usage',
          final: false,
          usage: {
            inputTokens: 8,
            contextInputTokens: 15,
            totalInputTokens: 15,
            cacheReadTokens: 5,
            cacheWriteTokens: 2
          }
        },
        {
          type: 'usage',
          final: true,
          usage: {
            inputTokens: 3,
            contextInputTokens: 15,
            totalInputTokens: 15,
            outputTokens: 4,
            cacheReadTokens: 11,
            cacheWriteTokens: 1
          }
        },
        expect.objectContaining({ type: 'completed', reason: 'pause' })
      ])
    );
    expect(events.findIndex((event) => event.type === 'text.completed')).toBeLessThan(
      events.findIndex((event) => event.type === 'client_tool.call')
    );
  });

  it('preserves Anthropic message_start input usage when message_delta reports zeros', async () => {
    const baseUrl = await sseServer(
      [
        {
          type: 'message_start',
          message: {
            id: 'msg_zero_delta_usage',
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 8,
              cache_creation_input_tokens: 2
            }
          }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 5
          }
        },
        { type: 'message_stop' }
      ],
      () => undefined
    );

    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'usage',
          final: true,
          usage: {
            inputTokens: 12,
            contextInputTokens: 22,
            totalInputTokens: 22,
            outputTokens: 5,
            cacheReadTokens: 8,
            cacheWriteTokens: 2
          }
        }
      ])
    );
  });

  it.each([
    {
      label: 'fresh input without cache fields',
      delta: { input_tokens: 130_000 },
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'null cache fields',
      delta: {
        input_tokens: 130_000,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null
      },
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'output-only usage',
      delta: {},
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'negative fresh input',
      delta: { input_tokens: -10 },
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'fractional cache-read input',
      delta: { cache_read_input_tokens: 0.5 },
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'unsafe fresh input',
      delta: { input_tokens: Number.MAX_SAFE_INTEGER + 1 },
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'nonnumeric cache-write input',
      delta: { cache_creation_input_tokens: '0' },
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'invalid fresh input with a valid cache-read update',
      delta: { input_tokens: -10, cache_read_input_tokens: 0 },
      expected: { inputTokens: 130_000, cacheReadTokens: 0, cacheWriteTokens: 3_000 }
    },
    {
      label: 'cache-read input without fresh or cache-write fields',
      delta: { cache_read_input_tokens: 80_000 },
      expected: { inputTokens: 130_000, cacheReadTokens: 80_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'cache-write input without fresh or cache-read fields',
      delta: { cache_creation_input_tokens: 9_000 },
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 9_000 }
    },
    {
      label: 'explicit zero fresh input',
      delta: { input_tokens: 0 },
      expected: { inputTokens: 0, cacheReadTokens: 120_000, cacheWriteTokens: 3_000 }
    },
    {
      label: 'explicit zero cache-read input',
      delta: { cache_read_input_tokens: 0 },
      expected: { inputTokens: 130_000, cacheReadTokens: 0, cacheWriteTokens: 3_000 }
    },
    {
      label: 'explicit zero cache-write input',
      delta: { cache_creation_input_tokens: 0 },
      expected: { inputTokens: 130_000, cacheReadTokens: 120_000, cacheWriteTokens: 0 }
    },
    {
      label: 'complete final fresh/cache split',
      delta: {
        input_tokens: 90_000,
        cache_read_input_tokens: 110_000,
        cache_creation_input_tokens: 2_000
      },
      expected: { inputTokens: 90_000, cacheReadTokens: 110_000, cacheWriteTokens: 2_000 }
    }
  ])('merges Anthropic input usage field updates: $label', async ({ delta, expected }) => {
    const baseUrl = await sseServer(
      [
        {
          type: 'message_start',
          message: {
            id: 'msg_partial_usage',
            usage: {
              input_tokens: 130_000,
              cache_read_input_tokens: 120_000,
              cache_creation_input_tokens: 3_000
            }
          }
        },
        { type: 'message_delta', delta: {}, usage: { ...delta, output_tokens: 3 } },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { ...delta, output_tokens: 5 }
        },
        { type: 'message_stop' }
      ],
      () => undefined
    );
    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );
    const usages = events.filter((event) => event.type === 'usage').map((event) => event.usage);
    const contextInputTokens =
      expected.inputTokens + expected.cacheReadTokens + expected.cacheWriteTokens;
    expect(usages).toEqual([
      {
        inputTokens: 130_000,
        contextInputTokens: 253_000,
        totalInputTokens: 253_000,
        cacheReadTokens: 120_000,
        cacheWriteTokens: 3_000
      },
      { ...expected, contextInputTokens, totalInputTokens: contextInputTokens, outputTokens: 3 },
      { ...expected, contextInputTokens, totalInputTokens: contextInputTokens, outputTokens: 5 }
    ]);
  });

  it('keeps malformed Anthropic input usage unknown when no valid count was reported', async () => {
    const baseUrl = await sseServer(
      [
        {
          type: 'message_start',
          message: {
            id: 'msg_invalid_usage',
            usage: {
              input_tokens: -1,
              cache_read_input_tokens: 0.5,
              cache_creation_input_tokens: Number.MAX_SAFE_INTEGER + 1
            }
          }
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 5 }
        },
        { type: 'message_stop' }
      ],
      () => undefined
    );
    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );
    const usages = events.filter((event) => event.type === 'usage').map((event) => event.usage);
    expect(usages).toHaveLength(2);
    for (const usage of usages) {
      expect(usage.inputTokens).toBeUndefined();
      expect(usage.contextInputTokens).toBeUndefined();
      expect(usage.cacheReadTokens).toBeUndefined();
      expect(usage.cacheWriteTokens).toBeUndefined();
    }
    expect(usages.at(-1)?.outputTokens).toBe(5);
  });

  it('maps Anthropic max_tokens to a commentary response requiring continuation', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'msg_max_tokens', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial response' }
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: {} },
        { type: 'message_stop' }
      ],
      () => undefined
    );

    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'text.completed',
          itemId: 'msg_max_tokens:content-0',
          phase: 'commentary',
          text: 'partial response'
        },
        { type: 'completed', reason: 'max_output' }
      ])
    );
  });

  it('preserves malformed Responses function calls for model-visible recovery', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_invalid_tool' } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'fc_invalid',
            call_id: 'call_invalid',
            name: 'read',
            arguments: '{"reads":['
          }
        },
        { type: 'response.completed', response: { id: 'resp_invalid_tool', usage: {} } }
      ],
      () => undefined
    );

    const events = await collect(
      new OpenAiResponsesAdapter(configuration('OPENAI_RESPONSES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'client_tool.call',
          callId: 'call_invalid',
          name: 'read',
          arguments: {},
          argumentError: 'Function arguments are invalid JSON.'
        },
        { type: 'completed', reason: 'completed' }
      ])
    );
  });

  it('preserves malformed Anthropic tool calls for model-visible recovery', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'msg_invalid_tool', usage: {} } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_invalid', name: 'read', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"reads":[' }
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
        { type: 'message_stop' }
      ],
      () => undefined
    );

    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'client_tool.call',
          callId: 'tool_invalid',
          name: 'read',
          arguments: {},
          argumentError: 'Tool arguments are invalid JSON.'
        },
        { type: 'completed', reason: 'tool_use' }
      ])
    );
  });

  it('uses the Anthropic response ID for text items and finalizes terminal text as the answer', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'msg_final', usage: {} } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'prefix ' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'answer' }
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' }
      ],
      () => undefined
    );
    const events = await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        { system: 'system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'text.delta',
          itemId: 'msg_final:content-0',
          phase: 'commentary',
          delta: 'prefix '
        },
        {
          type: 'text.delta',
          itemId: 'msg_final:content-0',
          phase: 'commentary',
          delta: 'answer'
        },
        {
          type: 'text.completed',
          itemId: 'msg_final:content-0',
          phase: 'final_answer',
          text: 'prefix answer'
        }
      ])
    );
  });

  it('declares Anthropic prompt caching for every Messages request', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'cached', usage: {} } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' }
      ],
      (body) => {
        expect(body.system).toEqual([
          { type: 'text', text: 'stable system', cache_control: { type: 'ephemeral' } }
        ]);
        expect(body.messages).toEqual([
          {
            role: 'user',
            content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]
          }
        ]);
      }
    );
    const config = configuration('ANTHROPIC_MESSAGES', baseUrl);
    config.hostedWebSearch = false;
    await collect(
      new AnthropicMessagesAdapter(config).start(
        { system: 'stable system', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        new AbortController().signal
      )
    );
  });

  it('moves Anthropic cache breakpoints to the latest complete tool exchange', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'cached-tools', usage: {} } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' }
      ],
      (body) => {
        expect(body.messages).toEqual([
          { role: 'user', content: 'inspect' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-1',
                name: 'read',
                input: { path: 'a' },
                cache_control: { type: 'ephemeral' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: 'content',
                cache_control: { type: 'ephemeral' }
              }
            ]
          }
        ]);
      }
    );
    const config = configuration('ANTHROPIC_MESSAGES', baseUrl);
    config.hostedWebSearch = false;
    await collect(
      new AnthropicMessagesAdapter(config).start(
        {
          system: 'stable system',
          messages: [
            { role: 'user', content: 'inspect' },
            { role: 'tool_call', callId: 'call-1', name: 'read', arguments: { path: 'a' } },
            { role: 'tool', callId: 'call-1', content: 'content' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
  });

  it('maps Anthropic tool calls and results back into the next request', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'msg_2', usage: {} } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' }
      ],
      (body) => {
        expect(body).toMatchObject({
          messages: [
            { role: 'user', content: 'change it' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'I will read it.' },
                { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }
              ]
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '1\tvalue' }]
            }
          ]
        });
      }
    );
    await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        {
          system: 'system',
          messages: [
            { role: 'user', content: 'change it' },
            { role: 'assistant', content: 'I will read it.' },
            {
              role: 'tool_call',
              content: '',
              callId: 'call-1',
              name: 'read',
              arguments: { path: 'a' }
            },
            { role: 'tool', content: '1\tvalue', callId: 'call-1' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
  });

  it('groups an Anthropic parallel tool batch by protocol role', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'msg_parallel', usage: {} } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' }
      ],
      (body) => {
        expect(body.messages).toEqual([
          { role: 'user', content: 'read both' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call-a', name: 'read', input: { path: 'a' } },
              {
                type: 'tool_use',
                id: 'call-b',
                name: 'read',
                input: { path: 'b' },
                cache_control: { type: 'ephemeral' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call-a', content: 'a' },
              {
                type: 'tool_result',
                tool_use_id: 'call-b',
                content: 'b',
                cache_control: { type: 'ephemeral' }
              }
            ]
          }
        ]);
      }
    );
    await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        {
          system: 'system',
          messages: [
            { role: 'user', content: 'read both' },
            {
              role: 'tool_call',
              content: '',
              callId: 'call-a',
              name: 'read',
              arguments: { path: 'a' }
            },
            {
              role: 'tool_call',
              content: '',
              callId: 'call-b',
              name: 'read',
              arguments: { path: 'b' }
            },
            { role: 'tool', content: 'a', callId: 'call-a' },
            { role: 'tool', content: 'b', callId: 'call-b' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
  });

  it('drops Responses-only provider context when switching to Anthropic', async () => {
    const baseUrl = await sseServer(
      [
        { type: 'message_start', message: { id: 'msg_switched', usage: {} } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' }
      ],
      (body) => {
        expect(body.messages).toEqual([
          { role: 'user', content: 'first' },
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'first answer',
                cache_control: { type: 'ephemeral' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'continue with Anthropic',
                cache_control: { type: 'ephemeral' }
              }
            ]
          }
        ]);
      }
    );
    await collect(
      new AnthropicMessagesAdapter(configuration('ANTHROPIC_MESSAGES', baseUrl)).start(
        {
          system: 'system',
          messages: [
            { role: 'user', content: 'first' },
            {
              role: 'provider',
              provider: 'OPENAI_RESPONSES',
              providerModelId: 'responses-a',
              content: '',
              item: { type: 'reasoning', id: 'reasoning-a', encrypted_content: 'opaque' }
            },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'continue with Anthropic' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
  });

  it('keeps only provider context owned by the selected Responses model', async () => {
    const own = { type: 'reasoning', id: 'own', encrypted_content: 'own-opaque', summary: [] };
    const foreign = {
      type: 'reasoning',
      id: 'foreign',
      encrypted_content: 'foreign-opaque',
      summary: []
    };
    const baseUrl = await sseServer(
      [
        { type: 'response.created', response: { id: 'resp_switched' } },
        { type: 'response.completed', response: { usage: {} } }
      ],
      (body) => {
        expect(body.input).toEqual([
          {
            role: 'developer',
            content: [{ type: 'input_text', text: 'system' }]
          },
          own,
          { role: 'user', content: 'continue' }
        ]);
      }
    );
    const selected = { ...configuration('OPENAI_RESPONSES', baseUrl), id: 'responses-b' };
    await collect(
      new OpenAiResponsesAdapter(selected).start(
        {
          system: 'system',
          messages: [
            {
              role: 'provider',
              provider: 'OPENAI_RESPONSES',
              providerModelId: 'responses-a',
              content: '',
              item: foreign
            },
            {
              role: 'provider',
              provider: 'OPENAI_RESPONSES',
              providerModelId: 'responses-b',
              content: '',
              item: own
            },
            { role: 'user', content: 'continue' }
          ],
          tools: []
        },
        new AbortController().signal
      )
    );
  });
});
