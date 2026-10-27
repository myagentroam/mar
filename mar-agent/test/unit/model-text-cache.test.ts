import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateModelText, SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import type { ModelRequest } from '../../src/model/contracts.js';

afterEach(() => vi.restoreAllMocks());

describe('standalone text cache parameters', () => {
  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'forwards neutral cache fields without enabling tools for %s',
    async (protocol) => {
      const requests: ModelRequest[] = [];
      const adapter =
        protocol === 'OPENAI_RESPONSES' ? OpenAiResponsesAdapter : AnthropicMessagesAdapter;
      vi.spyOn(adapter.prototype, 'start').mockImplementation(async function* (request) {
        requests.push(request);
        yield { type: 'text.completed', itemId: 'text', text: 'result' };
        yield { type: 'completed', reason: 'completed' };
      });
      const model: AgentModelConfiguration = {
        id: 'text-test',
        name: 'Text test',
        protocol,
        modelId: 'text-test',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test-key'),
        contextWindowTokens: 32_000,
        maxOutputTokens: 1_024,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        titleGeneration: false,
        codeMode: false,
        enabled: true
      };
      const input = {
        model,
        system: 'Return text.',
        messages: [{ role: 'user' as const, content: 'Request' }],
        signal: new AbortController().signal
      };
      expect(
        await generateModelText({ ...input, promptCacheKey: 'stable-key', cachePrefixMessages: 1 })
      ).toEqual({ text: 'result' });
      expect(requests[0]).toMatchObject({
        promptCacheKey: 'stable-key',
        cachePrefixMessages: 1,
        tools: [],
        allowTools: false,
        toolChoice: 'none'
      });
      await generateModelText(input);
      expect(requests[1]).not.toHaveProperty('promptCacheKey');
      expect(requests[1]).not.toHaveProperty('cachePrefixMessages');
    }
  );
});
