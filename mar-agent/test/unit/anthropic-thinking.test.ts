import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalAgentHost,
  SecretValue,
  createMarAgent,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import { type ModelEvent, type ModelMessage } from '../../src/agent-core/model/contracts.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { buildCompactionInput } from '../../src/agent-core/runtime/compaction/history.js';
import { projectCodeModeSearchResult } from '../../src/agent-core/tools/code-mode/index.js';
import {
  anthropicThinkingBlock,
  ANTHROPIC_THINKING_LIMITS
} from '../../src/agent-core/model/anthropic-thinking.js';

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const configuration = (baseUrl: string): MarAgentModelConfiguration => ({
  id: 'thinking',
  name: 'Thinking',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl,
  apiKey: new SecretValue('test-only'),
  modelId: 'test',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  defaultReasoningEffort: 'high',
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
});
const signed = {
  type: 'thinking',
  thinking: 'Public summary.',
  signature: 'SIGNATURE_PRIVATE_7319'
};
const redacted = { type: 'redacted_thinking', data: 'REDACTED_PRIVATE_7319' };
interface AnthropicRequestMessage {
  readonly role?: string;
  readonly content: readonly Record<string, unknown>[];
}

interface AnthropicRequest {
  readonly messages: readonly AnthropicRequestMessage[];
}

function events(blocks: Record<string, unknown>[], stop = 'end_turn'): unknown[] {
  return [
    { type: 'message_start', message: { id: 'message', usage: { input_tokens: 10 } } },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block },
      { type: 'content_block_stop', index }
    ]),
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
    { type: 'message_stop' }
  ];
}
async function serverFor(responses: unknown[][]) {
  const requests: AnthropicRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(body) as AnthropicRequest);
      const selected = responses[Math.min(requests.length - 1, responses.length - 1)]!;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(selected.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  return { requests, model: configuration(`http://127.0.0.1:${address.port}`) };
}
async function collect(adapter: AnthropicMessagesAdapter, messages: ModelMessage[] = []) {
  const result: ModelEvent[] = [];
  for await (const event of adapter.start(
    { system: 'Test', messages, tools: [] },
    new AbortController().signal
  ))
    result.push(event);
  return result;
}

describe('Anthropic native thinking context', () => {
  it('sends discovered Code Mode schemas in ordinary tool-result content', async () => {
    const { model, requests } = await serverFor([events([{ type: 'text', text: 'done' }])]);
    const definition = {
      name: 'mcp__records__read',
      description: 'Read a record.',
      inputMode: 'freeform' as const,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    };
    const result = projectCodeModeSearchResult(
      { role: 'tool', callId: 'search-1', content: '', toolSearchTools: [definition] },
      true
    );
    await collect(new AnthropicMessagesAdapter(model), [
      { role: 'user', content: 'Find records.' },
      {
        role: 'tool_call',
        callId: 'search-1',
        name: 'tool_search',
        arguments: { query: 'records' },
        content: ''
      },
      result
    ]);
    const block = requests[0]!.messages
      .flatMap((message) => message.content)
      .find((item) => item.type === 'tool_result');
    expect(block).toMatchObject({ tool_use_id: 'search-1' });
    expect(JSON.stringify(block)).toContain('Call only as tools.mcp__records__read');
    expect(JSON.stringify(block)).toContain('inputSchema');
    expect(JSON.stringify(block)).not.toContain('inputMode');
    expect(JSON.stringify(block)).not.toContain('freeform');
    expect(JSON.parse(result.content).tools[0]).toMatchObject({
      inputSchema: definition.inputSchema,
      caller: 'programmatic'
    });
  });

  it.each([
    { type: 'thinking', thinking: 'summary', signature: 42 },
    { type: 'thinking', thinking: 42, signature: 'signature' }
  ])('rejects invalid incoming thinking field types without exposing the block', async (block) => {
    const { model } = await serverFor([events([block])]);
    await expect(collect(new AnthropicMessagesAdapter(model))).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
    });
  });

  it('rejects malformed or oversized opaque state and bounds accumulated request state', async () => {
    for (const invalid of [
      null,
      { ...signed, signature: '' },
      { ...signed, extra: 'private' },
      { ...redacted, data: 42 },
      { ...signed, signature: 'x'.repeat(ANTHROPIC_THINKING_LIMITS.blockBytes) }
    ])
      expect(anthropicThinkingBlock(invalid)).toBeUndefined();
    const { model } = await serverFor([events([{ type: 'redacted_thinking', data: 42 }])]);
    await expect(collect(new AnthropicMessagesAdapter(model))).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
    });
    const messages: ModelMessage[] = Array.from({ length: 20 }, () => ({
      role: 'provider',
      content: '',
      provider: 'ANTHROPIC_MESSAGES',
      providerModelId: model.id,
      item: { ...signed, signature: 'x'.repeat(500_000) }
    }));
    await expect(collect(new AnthropicMessagesAdapter(model), messages)).rejects.toMatchObject({
      code: 'MAR_AGENT_CONTEXT_LIMIT'
    });
  });

  it('never forwards Anthropic private blocks through Responses even with the same configuration ID', async () => {
    const { model, requests } = await serverFor([
      [{ type: 'response.completed', response: { id: 'done', output: [] } }]
    ]);
    const adapter = new OpenAiResponsesAdapter({ ...model, protocol: 'OPENAI_RESPONSES' });
    try {
      for await (const event of adapter.start(
        {
          system: 'Test',
          tools: [],
          messages: [
            { role: 'user', content: 'Task' },
            {
              role: 'provider',
              content: '',
              provider: 'ANTHROPIC_MESSAGES',
              providerModelId: model.id,
              item: signed
            }
          ]
        },
        new AbortController().signal
      )) {
        void event;
        /* Drain the response. */
      }
      expect(JSON.stringify(requests[0])).not.toContain(signed.signature);
    } finally {
      await adapter.close();
    }
  });

  it('assembles signature deltas and preserves empty and redacted blocks without public leakage', async () => {
    const response = events([signed, redacted]);
    response.splice(
      1,
      2,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'SIGNATURE_' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'PRIVATE_7319' }
      },
      { type: 'content_block_stop', index: 0 }
    );
    const { model } = await serverFor([response]);
    const result = await collect(new AnthropicMessagesAdapter(model));
    expect(result.filter((e) => e.type === 'response.item')).toEqual([
      { type: 'response.item', provider: 'ANTHROPIC_MESSAGES', item: { ...signed, thinking: '' } },
      { type: 'response.item', provider: 'ANTHROPIC_MESSAGES', item: redacted }
    ]);
    expect(JSON.stringify(result.filter((e) => e.type !== 'response.item'))).not.toMatch(
      /SIGNATURE_PRIVATE|REDACTED_PRIVATE/
    );
  });

  it('replays only same-model native blocks unchanged and never adds a cache marker to them', async () => {
    const { model, requests } = await serverFor([events([{ type: 'text', text: 'done' }])]);
    const native = (item: Record<string, unknown>, providerModelId = model.id): ModelMessage => ({
      role: 'provider',
      provider: 'ANTHROPIC_MESSAGES',
      providerModelId,
      content: '',
      item
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Task' },
      native(signed),
      native(redacted),
      native({ ...signed, signature: 'FOREIGN' }, 'another-model')
    ];
    await collect(new AnthropicMessagesAdapter(model), messages);
    expect(requests[0].messages.at(-1)).toEqual({ role: 'assistant', content: [signed, redacted] });
    expect(buildCompactionInput(messages, { maxTokens: 2000 })).not.toContain('PRIVATE_7319');
  });

  it('preserves native order through tool use, restart and model isolation without leaking private data', async () => {
    const { model, requests } = await serverFor([
      events(
        [
          { type: 'text', text: 'Reading.' },
          signed,
          redacted,
          {
            type: 'tool_use',
            id: 'read-1',
            name: 'read',
            input: { reads: [{ path: 'missing.txt' }] }
          }
        ],
        'tool_use'
      ),
      events([{ type: 'text', text: 'done' }])
    ]);
    const home = await mkdtemp(join(tmpdir(), 'mar-anthropic-thinking-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const create = () =>
      createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model, { ...model, id: 'other', name: 'Other' }]
      });
    let agent = await create();
    let id = '';
    const publicEvents: unknown[] = [];
    try {
      const session = await agent.createSession({ workspace, title: 'Thinking' });
      id = session.id;
      const execution = session.run({ prompt: 'Read the file.' });
      for await (const event of execution) publicEvents.push(event);
      expect((await execution.result()).status).toBe('completed');
      const assistant = requests[1]!.messages.find(
        (message) =>
          message.role === 'assistant' && message.content.some((block) => block.type === 'tool_use')
      );
      expect(assistant).toBeDefined();
      if (assistant === undefined) throw new Error('Missing assistant request message');
      expect(assistant.content.map((block) => block.type)).toEqual([
        'text',
        'thinking',
        'redacted_thinking',
        'tool_use'
      ]);
      expect(assistant.content[1]).toEqual(signed);
      expect(assistant.content[2]).toEqual(redacted);
      const following = requests[1]!.messages[requests[1]!.messages.indexOf(assistant) + 1]!;
      expect(following.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'read-1' });
    } finally {
      await agent.dispose();
    }
    expect(JSON.stringify(publicEvents)).not.toMatch(/SIGNATURE_PRIVATE|REDACTED_PRIVATE/);
    agent = await create();
    try {
      const session = await agent.openSession(id);
      expect((await session.run({ prompt: 'Continue.' }).result()).status).toBe('completed');
      expect(JSON.stringify(requests.at(-1).messages)).toContain(signed.signature);
      expect((await session.run({ prompt: 'Switch.', modelId: 'other' }).result()).status).toBe(
        'completed'
      );
      expect(JSON.stringify(requests.at(-1).messages)).not.toContain(signed.signature);
      expect((await session.compact().result()).status).toBe('completed');
      expect(JSON.stringify(requests.at(-1))).not.toMatch(/SIGNATURE_PRIVATE|REDACTED_PRIVATE/);
      expect((await session.run({ prompt: 'After compact.' }).result()).status).toBe('completed');
      expect(JSON.stringify(requests.at(-1))).not.toMatch(/SIGNATURE_PRIVATE|REDACTED_PRIVATE/);
    } finally {
      await agent.dispose();
    }
    const store = await JsonlSessionStore.open(home);
    try {
      const records = await store.read(id);
      expect(
        records.filter(
          (record) =>
            record.type === 'model.context' &&
            (record.payload as { readonly provider?: unknown }).provider === 'ANTHROPIC_MESSAGES'
        )
      ).toHaveLength(2);
      expect(JSON.stringify(records.filter((r) => r.type !== 'model.context'))).not.toMatch(
        /SIGNATURE_PRIVATE|REDACTED_PRIVATE/
      );
    } finally {
      await store.close();
    }
  });
});
