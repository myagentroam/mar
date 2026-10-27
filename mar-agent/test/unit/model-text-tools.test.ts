import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { generateModelText, SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';

afterEach(() => vi.restoreAllMocks());
const tool = {
  name: 'result',
  description: 'Return data only.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: ['string', 'null'] } },
    required: ['value'],
    additionalProperties: false
  }
};
const call: ModelEvent = {
  type: 'client_tool.call',
  name: 'result',
  callId: 'call-1',
  arguments: { value: 'ok' }
};
function fixture(protocol: AgentModelConfiguration['protocol'], events: readonly ModelEvent[]) {
  const requests: ModelRequest[] = [];
  let closed = false;
  const adapter =
    protocol === 'OPENAI_RESPONSES' ? OpenAiResponsesAdapter : AnthropicMessagesAdapter;
  vi.spyOn(adapter.prototype, 'start').mockImplementation(async function* (request) {
    requests.push(request);
    try {
      yield* events;
    } finally {
      closed = true;
    }
  });
  const model: AgentModelConfiguration = {
    id: 'test',
    name: 'Test',
    protocol,
    modelId: 'test',
    baseUrl: 'https://example.test',
    apiKey: new SecretValue('test-key'),
    contextWindowTokens: 32_000,
    maxOutputTokens: 1_024,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    titleGeneration: false,
    codeMode: false,
    hostedWebSearch: true,
    enabled: true
  };
  return {
    input: {
      model,
      system: 'Return through the result tool.',
      messages: [{ role: 'user' as const, content: 'Request' }],
      signal: new AbortController().signal
    },
    requests,
    closed: () => closed
  };
}

describe('standalone declarative tools', () => {
  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'sends only the declared schema and collects real SSE tool data for %s',
    async (protocol) => {
      const events =
        protocol === 'OPENAI_RESPONSES'
          ? [
              { type: 'response.created', response: { id: 'response-1' } },
              {
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  id: 'item-1',
                  call_id: 'call-1',
                  name: 'result',
                  arguments: '{"value":"ok"}'
                }
              },
              {
                type: 'response.completed',
                response: { usage: { input_tokens: 8, output_tokens: 4 } }
              }
            ]
          : [
              { type: 'message_start', message: { id: 'message-1', usage: { input_tokens: 8 } } },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'call-1', name: 'result', input: {} }
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '{"value":"ok"}' }
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 4 }
              },
              { type: 'message_stop' }
            ];
      const bodies: Record<string, unknown>[] = [];
      const server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          bodies.push(JSON.parse(body));
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        const model: AgentModelConfiguration = {
          id: 'wire-test',
          name: 'Wire test',
          protocol,
          modelId: 'test',
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: new SecretValue('test-key'),
          contextWindowTokens: 32_000,
          maxOutputTokens: 1_024,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: [],
          titleGeneration: false,
          codeMode: false,
          hostedWebSearch: true,
          enabled: true
        };
        const usage = vi.fn();
        const result = await generateModelText({
          model,
          tools: [tool],
          system: 'Return data.',
          messages: [{ role: 'user', content: 'Request' }],
          signal: AbortSignal.timeout(5_000),
          onModelUsage: usage
        });
        expect(result?.toolCalls).toEqual([
          { name: 'result', callId: 'call-1', arguments: { value: 'ok' } }
        ]);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]!.tools).toEqual([
          expect.objectContaining(
            protocol === 'OPENAI_RESPONSES'
              ? { type: 'function', name: 'result', parameters: tool.inputSchema, strict: true }
              : { name: 'result', input_schema: tool.inputSchema }
          )
        ]);
        expect(usage).toHaveBeenCalledWith(
          expect.objectContaining({ state: 'succeeded', inputTokens: '8', outputTokens: '4' })
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'returns tool data without continuation for %s',
    async (protocol) => {
      const f = fixture(protocol, [
        call,
        { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
        { type: 'completed', reason: protocol === 'OPENAI_RESPONSES' ? 'completed' : 'tool_use' }
      ]);
      const onModelUsage = vi.fn();
      const result = await generateModelText({
        ...f.input,
        tools: [tool],
        onModelUsage,
        promptCacheKey: 'stable',
        cachePrefixMessages: 1
      });
      expect(result).toEqual({
        text: '',
        toolCalls: [{ name: 'result', callId: 'call-1', arguments: { value: 'ok' } }],
        usage: { inputTokens: 8, outputTokens: 4 }
      });
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]).toMatchObject({
        tools: [tool],
        allowTools: true,
        toolChoice: 'auto',
        onModelUsage,
        promptCacheKey: 'stable',
        cachePrefixMessages: 1,
        retryState: { maxAttempts: 1 }
      });
      expect(f.closed()).toBe(true);
    }
  );

  it.each(['max_output', 'pause', 'cancelled', undefined] as const)(
    'discards partial tool data at %s',
    async (reason) => {
      const f = fixture('ANTHROPIC_MESSAGES', [
        call,
        ...(reason ? [{ type: 'completed' as const, reason }] : [])
      ]);
      expect(await generateModelText({ ...f.input, tools: [tool] })).toBeUndefined();
      expect(f.closed()).toBe(true);
    }
  );

  it.each(['disabled', 'unknown', 'invalid_arguments'] as const)(
    'rejects %s tool output and closes the stream',
    async (kind) => {
      const f = fixture('OPENAI_RESPONSES', [
        {
          ...call,
          ...(kind === 'unknown' ? { name: 'undeclared' } : {}),
          ...(kind === 'invalid_arguments' ? { argumentError: 'malformed JSON' } : {})
        },
        { type: 'completed', reason: 'completed' }
      ]);
      await expect(
        generateModelText({ ...f.input, ...(kind === 'disabled' ? {} : { tools: [tool] }) })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR' });
      expect(f.closed()).toBe(true);
    }
  );

  it('does not convert a tool-use terminal without a call into a result', async () => {
    const f = fixture('ANTHROPIC_MESSAGES', [
      { type: 'text.completed', itemId: 'text', text: 'partial' },
      { type: 'completed', reason: 'tool_use' }
    ]);
    expect(await generateModelText({ ...f.input, tools: [tool] })).toBeUndefined();
  });

  it('does not return collected tool data after caller cancellation', async () => {
    const f = fixture('OPENAI_RESPONSES', []);
    const controller = new AbortController();
    vi.spyOn(OpenAiResponsesAdapter.prototype, 'start').mockImplementation(async function* () {
      yield call;
      controller.abort(new Error('cancelled'));
      yield { type: 'completed', reason: 'completed' };
    });
    await expect(
      generateModelText({ ...f.input, tools: [tool], signal: controller.signal })
    ).rejects.toThrow('cancelled');
  });
});
