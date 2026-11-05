import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { assertInlineMediaBudget } from '../../src/model/inline-media-budget.js';
import type { ModelMessage, ModelRequest } from '../../src/model/contracts.js';
import { projectModelRequest } from '../../src/sdk/model-input-projection.js';
import type { SessionModelMessage } from '../../src/session/model-request.js';

const image = { mimeType: 'image/png', dataBase64: 'A'.repeat(7 * 1_048_576) };
const request = (messages: ModelMessage[]): ModelRequest => ({ system: '', tools: [], messages });
const part = { type: 'image' as const, image };

describe('inline media protocol budget', () => {
  it('counts each projected observation image, without also counting its source array', () => {
    const logical: SessionModelMessage = {
      role: 'tool',
      content: '{}',
      images: [image],
      observations: [{ type: 'value', id: 'first', format: 'image', value: '', imageIndices: [0] }]
    };
    const one = projectModelRequest(request([logical]));
    expect(() => assertInlineMediaBudget(one)).not.toThrow();
    const two = projectModelRequest(
      request([
        {
          ...logical,
          observations: [
            ...logical.observations!,
            { type: 'value', id: 'second', format: 'image', value: '', imageIndices: [0] }
          ]
        }
      ])
    );
    expect(() => assertInlineMediaBudget(two)).toThrowError(
      expect.objectContaining({ code: 'MAR_AGENT_INLINE_MEDIA_LIMIT' })
    );
  });

  it('respects textBlocks precedence, URL-only images, and the real user-image merge', () => {
    const tool: ModelMessage = {
      role: 'tool',
      content: '',
      textBlocks: [{ text: 'first' }],
      images: [image],
      contentParts: [part, part]
    };
    expect(() => assertInlineMediaBudget(request([tool]))).not.toThrow();
    expect(() => assertInlineMediaBudget(request([{ ...tool, images: [image, image] }]))).toThrow();
    expect(() =>
      assertInlineMediaBudget(
        request([
          {
            role: 'tool',
            content: '',
            contentParts: [
              {
                type: 'image',
                image: { mimeType: 'image/png', url: 'https://example.test/image' }
              },
              part
            ]
          }
        ])
      )
    ).not.toThrow();
    expect(() =>
      assertInlineMediaBudget({
        ...request([{ role: 'user', content: 'hello', images: [image] }]),
        images: [image]
      })
    ).not.toThrow();
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'rejects a repeated protocol image before transport for %s',
    async (protocol) => {
      const configuration: AgentModelConfiguration = {
        id: 'test',
        name: 'Test',
        protocol,
        baseUrl: 'http://127.0.0.1:1',
        apiKey: new SecretValue('fixture-key'),
        modelId: 'test',
        contextWindowTokens: 100_000,
        maxOutputTokens: 1024,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        defaultReasoningEffort: undefined,
        hostedWebSearch: false,
        titleGeneration: false,
        codeMode: true,
        enabled: true
      };
      const adapter =
        protocol === 'OPENAI_RESPONSES'
          ? new OpenAiResponsesAdapter(configuration)
          : new AnthropicMessagesAdapter(configuration);
      const run = async () => {
        for await (const event of adapter.start(
          request([
            {
              role: 'tool',
              callId: 'cell',
              content: '',
              contentParts: [part, part]
            }
          ]),
          new AbortController().signal
        )) {
          expect(event).toBeDefined();
        }
      };
      await expect(run()).rejects.toMatchObject({ code: 'MAR_AGENT_INLINE_MEDIA_LIMIT' });
    }
  );

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'counts the selected URL or inline representation for %s',
    async (protocol) => {
      let body = '';
      const server = createServer((incoming, response) => {
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => (body += chunk));
        incoming.on('end', () => {
          const events =
            protocol === 'OPENAI_RESPONSES'
              ? [
                  {
                    type: 'response.completed',
                    response: { id: 'fixture', status: 'completed', output: [] }
                  }
                ]
              : [
                  {
                    type: 'message_start',
                    message: {
                      id: 'fixture',
                      role: 'assistant',
                      content: [],
                      usage: { input_tokens: 1, output_tokens: 0 }
                    }
                  },
                  {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: 0 }
                  },
                  { type: 'message_stop' }
                ];
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const configuration: AgentModelConfiguration = {
        id: 'test',
        name: 'Test',
        protocol,
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: new SecretValue('fixture-key'),
        modelId: 'test',
        contextWindowTokens: 100_000,
        maxOutputTokens: 1024,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        defaultReasoningEffort: undefined,
        hostedWebSearch: false,
        titleGeneration: false,
        codeMode: true,
        enabled: true
      };
      const adapter =
        protocol === 'OPENAI_RESPONSES'
          ? new OpenAiResponsesAdapter(configuration)
          : new AnthropicMessagesAdapter(configuration);
      const run = async (url: string) => {
        const imagePart = { type: 'image' as const, image: { ...image, url } };
        for await (const event of adapter.start(
          request([
            {
              role: 'tool',
              callId: 'cell',
              content: '',
              contentParts: [imagePart, imagePart]
            }
          ]),
          new AbortController().signal
        )) {
          expect(event).toBeDefined();
        }
      };
      try {
        await run('https://example.test/image');
        expect(body.match(/https:\/\/example\.test\/image/g)).toHaveLength(2);
        expect(body).not.toContain(image.dataBase64);
        body = '';
        await expect(run('file:///invalid')).rejects.toMatchObject({
          code: 'MAR_AGENT_INLINE_MEDIA_LIMIT'
        });
        expect(body).toBe('');
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
});
