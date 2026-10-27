import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import type { ModelEvent } from '../../src/model/contracts.js';
import { publicHostedToolEvents } from '../../src/runtime/event-projection.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function sseServer(events: readonly unknown[]): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('server address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

function configuration(
  protocol: AgentModelConfiguration['protocol'],
  baseUrl: string
): AgentModelConfiguration {
  return {
    id: 'test-model',
    name: 'Test model',
    protocol,
    baseUrl,
    apiKey: new SecretValue('test-key'),
    modelId: 'test-model',
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

async function latestHosted(
  protocol: 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES',
  events: readonly unknown[],
  itemId: string
): Promise<Extract<ModelEvent, { type: 'hosted_tool' }>> {
  const baseUrl = await sseServer(events);
  const config = configuration(protocol, baseUrl);
  const adapter =
    protocol === 'OPENAI_RESPONSES'
      ? new OpenAiResponsesAdapter(config)
      : new AnthropicMessagesAdapter(config);
  const output: ModelEvent[] = [];
  for await (const event of adapter.start(
    { system: 'system', messages: [{ role: 'user', content: 'Search' }], tools: [] },
    new AbortController().signal
  ))
    output.push(event);
  const hosted = output
    .filter(
      (event): event is Extract<ModelEvent, { type: 'hosted_tool' }> =>
        event.type === 'hosted_tool' && event.itemId === itemId
    )
    .at(-1);
  if (hosted === undefined) throw new Error(`No hosted ModelEvent for ${itemId}`);
  return hosted;
}

function completedProjection(event: Extract<ModelEvent, { type: 'hosted_tool' }>) {
  const completed = publicHostedToolEvents(event).find((entry) => entry.type === 'tool.completed');
  if (completed?.type !== 'tool.completed')
    throw new Error('Hosted call did not project a completion.');
  return completed;
}

describe('hosted web tool presentation metadata', () => {
  it('distinguishes OpenAI explicit empty sources from omitted sources', async () => {
    const empty = await latestHosted(
      'OPENAI_RESPONSES',
      [
        {
          type: 'response.output_item.done',
          item: {
            id: 'empty',
            type: 'web_search_call',
            action: { type: 'search', query: 'empty query', sources: [] }
          }
        },
        { type: 'response.completed', response: { id: 'response' } }
      ],
      'empty'
    );
    const unknown = await latestHosted(
      'OPENAI_RESPONSES',
      [
        {
          type: 'response.output_item.done',
          item: {
            id: 'unknown',
            type: 'web_search_call',
            action: { type: 'search', query: 'unknown query' }
          }
        },
        { type: 'response.completed', response: { id: 'response' } }
      ],
      'unknown'
    );
    expect(empty.summary).toHaveProperty('sources', []);
    expect(unknown.summary).not.toHaveProperty('sources');
    expect(completedProjection(empty).data).toMatchObject({
      hostedToolKind: 'WEB_SEARCH',
      query: 'empty query',
      sources: [],
      sourceCount: 0
    });
    const unknownData = completedProjection(unknown).data;
    expect(unknownData).toMatchObject({ hostedToolKind: 'WEB_SEARCH', query: 'unknown query' });
    expect(unknownData).not.toHaveProperty('sourceCount');
  });

  it('bounds OpenAI snippets and excludes encrypted provider fields', async () => {
    const snippet = 's'.repeat(2_500);
    const event = await latestHosted(
      'OPENAI_RESPONSES',
      [
        {
          type: 'response.output_item.done',
          item: {
            id: 'search',
            type: 'web_search_call',
            action: {
              type: 'search',
              query: 'query',
              sources: [
                {
                  url: 'https://example.test/',
                  title: 'Source',
                  snippet,
                  encrypted_content: 'opaque-provider-payload'
                }
              ]
            }
          }
        },
        { type: 'response.completed', response: { id: 'response' } }
      ],
      'search'
    );
    expect(event.summary.sources?.[0]?.snippet).toHaveLength(2_000);
    const projected = completedProjection(event);
    expect(projected.data).toMatchObject({
      hostedToolKind: 'WEB_SEARCH',
      sources: [{ url: 'https://example.test/', snippet: snippet.slice(0, 2_000) }]
    });
    expect(JSON.stringify({ summary: event.summary, projected })).not.toContain(
      'encrypted_content'
    );
    expect(JSON.stringify({ summary: event.summary, projected })).not.toContain(
      'opaque-provider-payload'
    );
  });

  it('preserves Anthropic empty result content as an explicit zero-source result', async () => {
    const event = await latestHosted(
      'ANTHROPIC_MESSAGES',
      [
        { type: 'message_start', message: { id: 'message', usage: { input_tokens: 1 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'server_tool_use', id: 'empty', name: 'web_search' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ query: 'empty query' })
          }
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'web_search_tool_result', tool_use_id: 'empty', content: [] }
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }
      ],
      'empty'
    );
    expect(event.summary).toHaveProperty('sources', []);
    expect(completedProjection(event).data).toMatchObject({
      hostedToolKind: 'WEB_SEARCH',
      query: 'empty query',
      sources: [],
      sourceCount: 0
    });
  });

  it('bounds Anthropic snippets and never projects encrypted_content', async () => {
    const snippet = 'a'.repeat(2_500);
    const event = await latestHosted(
      'ANTHROPIC_MESSAGES',
      [
        { type: 'message_start', message: { id: 'message', usage: { input_tokens: 1 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'server_tool_use', id: 'search', name: 'web_search' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ query: 'snippet query' })
          }
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'search',
            content: [
              {
                type: 'web_search_result',
                url: 'https://example.test/',
                title: 'Source',
                snippet,
                encrypted_content: 'opaque-provider-payload'
              }
            ]
          }
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }
      ],
      'search'
    );
    expect(event.summary.sources?.[0]?.snippet).toHaveLength(2_000);
    const projected = completedProjection(event);
    expect(projected.data).toMatchObject({
      hostedToolKind: 'WEB_SEARCH',
      sources: [{ url: 'https://example.test/', snippet: snippet.slice(0, 2_000) }]
    });
    expect(JSON.stringify({ summary: event.summary, projected })).not.toContain(
      'encrypted_content'
    );
    expect(JSON.stringify({ summary: event.summary, projected })).not.toContain(
      'opaque-provider-payload'
    );
  });
});
