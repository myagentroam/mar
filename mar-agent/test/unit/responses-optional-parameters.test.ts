import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';

describe('Responses optional endpoint parameters', () => {
  it.each([true, false])(
    'honors explicit optional parameter capabilities (restricted=%s)',
    async (restricted) => {
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
          response.end(
            `data: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${bodies.length}`, output: [], usage: {} } })}\n\n`
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      const configuration: MarAgentModelConfiguration = {
        id: 'test',
        name: 'Test',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: new SecretValue('fake'),
        modelId: 'opaque-model',
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        hostedWebSearch: false,
        enabled: true,
        ...(restricted
          ? {
              responsesOptionalParameters: {
                reasoningEffort: false,
                reasoningSummary: false,
                textVerbosity: false,
                promptCacheKey: false,
                nativeTools: false
              }
            }
          : {})
      };
      const adapter = new OpenAiResponsesAdapter(configuration);
      try {
        const request = {
          system: 'Test',
          messages: [{ role: 'user' as const, content: 'Use lookup.' }],
          tools: [
            {
              name: 'lookup',
              description: 'Look up a value.',
              inputSchema: { type: 'object', properties: {} }
            },
            {
              name: 'apply_patch',
              description: 'Patch files.',
              inputMode: 'freeform' as const,
              inputSchema: {
                type: 'object',
                properties: { patch: { type: 'string' } },
                required: ['patch']
              }
            },
            {
              name: 'tool_search',
              description: 'Find tools.',
              nativeType: 'tool_search' as const,
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
            }
          ],
          promptCacheKey: 'stable-key',
          reasoningEffort: 'high'
        };
        for await (const event of adapter.start(request, new AbortController().signal)) void event;
        expect(bodies[0]?.tools).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'function', name: 'lookup' })])
        );
        expect(bodies[0]?.store).toBe(false);
        if (restricted) {
          expect(bodies[0]).not.toHaveProperty('text');
          expect(bodies[0]).not.toHaveProperty('reasoning');
          expect(bodies[0]).not.toHaveProperty('prompt_cache_key');
          expect(bodies[0]).not.toHaveProperty('service_tier');
          expect(
            (bodies[0]?.tools as { type: string }[]).every((tool) => tool.type === 'function')
          ).toBe(true);
          configuration.responsesOptionalParameters!.reasoningEffort = true;
          for await (const event of adapter.start(request, new AbortController().signal))
            void event;
          expect(bodies[1]?.reasoning).toEqual({ effort: 'high' });
          const replay = {
            ...request,
            messages: [
              ...request.messages,
              {
                role: 'tool_call' as const,
                content: '',
                callId: 'patch-1',
                name: 'apply_patch',
                inputMode: 'freeform' as const,
                arguments: 'patch text'
              },
              { role: 'tool' as const, content: 'patched', callId: 'patch-1', name: 'apply_patch' },
              {
                role: 'tool_call' as const,
                content: '',
                callId: 'search-1',
                name: 'tool_search',
                arguments: { query: 'lookup' }
              },
              {
                role: 'tool' as const,
                content: 'found lookup',
                callId: 'search-1',
                name: 'tool_search',
                toolSearchTools: [request.tools[0]!]
              }
            ]
          };
          for await (const event of adapter.start(replay, new AbortController().signal)) void event;
          expect(bodies[2]?.input).toEqual(
            expect.arrayContaining([
              {
                type: 'function_call',
                call_id: 'patch-1',
                name: 'apply_patch',
                arguments: JSON.stringify({ patch: 'patch text' })
              },
              {
                type: 'function_call',
                call_id: 'search-1',
                name: 'tool_search',
                arguments: JSON.stringify({ query: 'lookup' })
              },
              { type: 'function_call_output', call_id: 'patch-1', output: 'patched' },
              { type: 'function_call_output', call_id: 'search-1', output: 'found lookup' }
            ])
          );
        } else {
          expect(bodies[0]).toMatchObject({
            text: { verbosity: 'low' },
            reasoning: { effort: 'high', summary: 'auto' },
            prompt_cache_key: 'stable-key'
          });
        }
        for (const noToolsRequest of [
          { ...request, tools: [] },
          { ...request, allowTools: false },
          { ...request, tools: [], toolChoice: 'none' as const }
        ]) {
          for await (const event of adapter.start(noToolsRequest, new AbortController().signal))
            void event;
          expect(bodies.at(-1)?.tools).toEqual([]);
          expect(bodies.at(-1)).not.toHaveProperty('tool_choice');
          expect(bodies.at(-1)).not.toHaveProperty('parallel_tool_calls');
        }
      } finally {
        await adapter.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
});
