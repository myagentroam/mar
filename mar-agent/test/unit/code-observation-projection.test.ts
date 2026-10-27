import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import type { ModelAdapter } from '../../src/model/contracts.js';
import type { SessionModelMessage as ModelMessage } from '../../src/session/model-request.js';
import { projectModelRequest } from '../../src/sdk/model-input-projection.js';
import { boundObservations } from '../../src/tools/code-mode/observations.js';
import {
  observationModelParts,
  renderObservations,
  type CodeObservation
} from '../../src/session/code-observation-projection.js';
import { estimatedRequestTokens, stableJson } from '../../src/runtime/context/request-budget.js';
import { contextGcMessageTokens } from '../../src/runtime/context/gc-tokens.js';
import { countModelTokens } from '../../src/runtime/token-budget.js';
import { shouldUseNativeCompaction } from '../../src/runtime/context/usage.js';

const body = JSON.stringify({
  status: 'completed',
  stdout: 'first\n"quoted" \\path 中文\n',
  exitCode: 0
});
function fixture(): ModelMessage {
  const observations: CodeObservation[] = [
    {
      type: 'tool_result',
      id: 'original',
      source: { callId: 'nested', toolName: 'exec', input: { command: 'PRIVATE_COMMAND' } },
      outcome: 'completed',
      result: { content: body, data: { hidden: 'PRIVATE_PROGRAM_DATA'.repeat(200) } }
    },
    { type: 'value', id: 'derived', format: 'json', value: '{"derived":"\\"quoted\\""}' }
  ];
  return {
    role: 'tool',
    callId: 'cell',
    content: JSON.stringify({
      cellId: 'fixture-cell',
      status: 'completed',
      toolCalls: 1,
      outputBytes: 512,
      outputDroppedBytes: 0,
      truncated: false,
      cached: false,
      observations: JSON.parse(renderObservations(observations))
    }),
    observations
  };
}
function modelText(message: ModelMessage) {
  return (
    observationModelParts(message)
      ?.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n') ?? ''
  );
}

describe('Code Mode model observation projection', () => {
  it('projects ordered images and nested tool declarations without changing logical input', () => {
    const message = fixture();
    const first = message.observations![0] as Extract<CodeObservation, { type: 'tool_result' }>;
    first.result.imageIndices = [1, 0];
    message.images = [
      { mimeType: 'image/png', dataBase64: 'first' },
      { mimeType: 'image/png', dataBase64: 'second' }
    ];
    const declaration = {
      name: 'search_result',
      description: 'Search result',
      inputSchema: { type: 'object' },
      nativeType: 'tool_search' as const,
      inputMode: 'json' as const,
      allowedCallers: ['direct' as const],
      agentScope: 'ROOT_ONLY' as const
    };
    message.toolSearchTools = [declaration];
    const request = { system: 'test', messages: [message], tools: [declaration] };
    const before = structuredClone(request);
    const projected = projectModelRequest(request);
    expect(projected.messages[0]!.contentParts?.filter((part) => part.type === 'image')).toEqual([
      { type: 'image', image: message.images[1] },
      { type: 'image', image: message.images[0] }
    ]);
    expect(projected.messages[0]!.toolSearchTools).toEqual([
      {
        name: 'search_result',
        description: 'Search result',
        inputSchema: { type: 'object' },
        nativeType: 'tool_search',
        inputMode: 'json'
      }
    ]);
    expect(projected.tools).toEqual(projected.messages[0]!.toolSearchTools);
    expect(request).toEqual(before);

    const edited = projectModelRequest({
      ...request,
      messages: [{ ...message, textBlocks: [{ text: 'edited' }] }]
    });
    expect(edited.messages[0]!.contentParts).toBeUndefined();
    expect(edited.messages[0]!.textBlocks).toEqual([{ text: 'edited' }]);
  });

  it('uses an explicit edited text projection without changing observation facts', () => {
    const message = fixture();
    const before = structuredClone(message.observations);
    expect(
      observationModelParts({ ...message, content: 'edited', textBlocks: [{ text: 'edited' }] })
    ).toBeUndefined();
    expect(message.observations).toEqual(before);
  });
  it('preserves original bodies without an extra JSON-string layer or private data', () => {
    const message = fixture();
    const snapshot = JSON.stringify(message);
    const parts = observationModelParts(message)!;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({
      type: 'text',
      text: '{"cellId":"fixture-cell","status":"completed"}'
    });
    expect(parts[1]).toEqual({
      type: 'text',
      text: '{"type":"tool_result","toolName":"exec","outcome":"completed"}\n' + body
    });
    expect(parts[2]).toEqual({
      type: 'text',
      text:
        '{"type":"value","format":"json"}\n' +
        (message.observations![1] as Extract<CodeObservation, { type: 'value' }>).value
    });
    expect(modelText(message)).not.toContain('PRIVATE_');
    expect(JSON.stringify(message)).toBe(snapshot);
  });

  it('keeps malformed JSON-looking and control-character bodies opaque', () => {
    const value = '{broken: "\\\\"}\n\u0000literal \\n';
    const message: ModelMessage = {
      role: 'tool',
      content: '[]',
      observations: [{ type: 'value', id: 'opaque', format: 'text', value }]
    };
    expect(modelText(message)).toBe('{"type":"value","format":"text"}\n' + value);
  });

  it('keeps failed outcomes, truncation and each image beside its original record', () => {
    const message = fixture();
    const first = message.observations![0] as Extract<CodeObservation, { type: 'tool_result' }>;
    first.outcome = 'failed';
    first.result.truncated = true;
    first.result.imageIndices = [0];
    message.images = [{ mimeType: 'image/png', dataBase64: 'unchanged-pixels' }];
    const parts = observationModelParts(message)!;
    expect(parts.map((part) => part.type)).toEqual(['text', 'text', 'image', 'text']);
    expect(parts[1]).toEqual({
      type: 'text',
      text: '{"type":"tool_result","toolName":"exec","outcome":"failed","truncated":true}\n' + body
    });
    expect(parts[2]).toEqual({ type: 'image', image: message.images[0] });
  });

  it('leaves ordinary and empty-observation tool results on the existing path', () => {
    expect(observationModelParts({ content: body })).toBeUndefined();
    expect(observationModelParts({ content: body, observations: [] })).toBeUndefined();
  });

  it.each([
    { status: 'running', outputDroppedBytes: 0, truncated: false, cached: false },
    { status: 'completed', outputDroppedBytes: 0, truncated: false, cached: false },
    { status: 'failed', outputDroppedBytes: 96, truncated: true, cached: true },
    { status: 'cancelled', outputDroppedBytes: 0, truncated: true, cached: false }
  ])('keeps lifecycle and exceptional metadata for an unobserved $status cell', (state) => {
    const metadata = {
      cellId: 'retained-cell',
      ...state,
      toolCalls: 2,
      outputBytes: 4096,
      ...(state.status === 'failed' ? { error: { code: 'TEST_FAILED', message: 'Failed.' } } : {}),
      observations: []
    };
    const message: ModelMessage = {
      role: 'tool',
      content: JSON.stringify(metadata),
      observations: []
    };
    const snapshot = structuredClone(message);
    const parts = observationModelParts(message)!;
    expect(parts).toHaveLength(1);
    expect(JSON.parse((parts[0] as { text: string }).text)).toEqual({
      cellId: metadata.cellId,
      status: state.status,
      ...(state.outputDroppedBytes ? { outputDroppedBytes: state.outputDroppedBytes } : {}),
      ...(state.truncated ? { truncated: true } : {}),
      ...(state.cached ? { cached: true } : {}),
      ...('error' in metadata ? { error: metadata.error } : {})
    });
    expect(message).toEqual(snapshot);
    expect(estimatedRequestTokens('', [message], [])).toBe(
      countModelTokens(stableJson([{ role: 'tool', content: modelText(message) }]) + '[]')
    );
  });

  it('does not filter similarly named fields from tool bodies or ordinary results', () => {
    const message = fixture();
    const first = message.observations![0] as Extract<CodeObservation, { type: 'tool_result' }>;
    const original = JSON.stringify({ toolCalls: 2, outputBytes: 123, cached: false });
    first.result.content = original;
    expect(modelText(message)).toContain(original);
    expect(observationModelParts({ content: original, observations: [] })).toBeUndefined();
  });

  it('budgets only model-visible observation text rather than its private structured copy', () => {
    const message = fixture();
    const reference = { role: 'tool', callId: 'cell', content: modelText(message) };
    expect(estimatedRequestTokens('', [message], [])).toBe(
      countModelTokens(stableJson([reference]) + '[]')
    );
    const first = message.observations![0] as Extract<CodeObservation, { type: 'tool_result' }>;
    const before = estimatedRequestTokens('', [message], []);
    first.result.data = { hidden: 'DIFFERENT_PRIVATE_DATA'.repeat(1000) };
    first.source.input = { command: 'DIFFERENT_PRIVATE_INPUT'.repeat(1000) };
    message.content = JSON.stringify({
      ...JSON.parse(message.content!),
      toolCalls: 999999,
      outputBytes: 999999999
    });
    expect(estimatedRequestTokens('', [message], [])).toBe(before);
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'uses visible observation text for %s GC estimates',
    (modelProtocol) => {
      const message = fixture();
      const before = contextGcMessageTokens(
        { modelId: 'test', modelProtocol, system: '', tools: [] },
        [message]
      );
      const first = message.observations![0] as Extract<CodeObservation, { type: 'tool_result' }>;
      first.result.data = { hidden: 'EXTRA_PRIVATE_DATA'.repeat(1000) };
      message.content = JSON.stringify({
        ...JSON.parse(message.content!),
        toolCalls: 999999,
        outputBytes: 999999999
      });
      expect(
        contextGcMessageTokens({ modelId: 'test', modelProtocol, system: '', tools: [] }, [message])
      ).toBe(before);
      if (modelProtocol === 'ANTHROPIC_MESSAGES')
        expect(before).toBe(
          contextGcMessageTokens({ modelId: 'test', modelProtocol, system: '', tools: [] }, [
            { role: 'tool', callId: 'cell', content: modelText(message) }
          ])
        );
    }
  );

  it('uses the same visible append-only budget for native compaction decisions', () => {
    const message = fixture();
    const call: ModelMessage = {
      role: 'tool_call',
      callId: 'cell',
      name: 'code_exec',
      content: '',
      arguments: 'fixture'
    };
    const window = 95 + estimatedRequestTokens('', [message], []) + 10;
    expect(
      shouldUseNativeCompaction({
        estimatedRequestTokens: window + 1,
        contextWindowTokens: window,
        latestUsage: { contextInputTokens: 90, outputTokens: 5, historyMessages: [call] },
        historyMessages: [call, message],
        appendedMessages: []
      })
    ).toBe(true);
    const first = message.observations![0] as Extract<CodeObservation, { type: 'tool_result' }>;
    first.result.data = { hidden: 'PRIVATE_DATA'.repeat(10000) };
    expect(
      shouldUseNativeCompaction({
        estimatedRequestTokens: window + 1,
        contextWindowTokens: window,
        latestUsage: { contextInputTokens: 90, outputTokens: 5, historyMessages: [call] },
        historyMessages: [call, message],
        appendedMessages: []
      })
    ).toBe(true);
  });

  it('does not replace non-tool content with attached observation metadata', () => {
    const message = { ...fixture(), role: 'user' as const, content: 'Actual user content.' };
    const reference = { role: 'user' as const, callId: 'cell', content: message.content };
    expect(estimatedRequestTokens('', [message], [])).toBe(
      estimatedRequestTokens('', [reference], [])
    );
    expect(
      contextGcMessageTokens(
        { modelId: 'test', modelProtocol: 'ANTHROPIC_MESSAGES', system: '', tools: [] },
        [message]
      )
    ).toBe(
      contextGcMessageTokens(
        { modelId: 'test', modelProtocol: 'ANTHROPIC_MESSAGES', system: '', tools: [] },
        [reference]
      )
    );
  });

  it('does not prematurely truncate quote-heavy bodies to fit their storage encoding', () => {
    const value = '"\\\n'.repeat(120);
    const original: CodeObservation = { type: 'value', id: 'quoted', format: 'text', value };
    const budget = countModelTokens('{"type":"value","format":"text"}\n' + value) + 40;
    const bounded = boundObservations([original], budget);
    expect(bounded.truncated).toBe(false);
    expect((bounded.observations[0] as Extract<CodeObservation, { type: 'value' }>).value).toBe(
      value
    );
    expect(
      countModelTokens(
        modelText({ role: 'tool', content: bounded.content, observations: bounded.observations })
      )
    ).toBeLessThanOrEqual(budget);
    expect(() => JSON.parse(bounded.content)).not.toThrow();
  });

  it.each(
    (['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const).flatMap((protocol) =>
      [false, true].map((empty) => ({ protocol, empty }))
    )
  )(
    'sends native text blocks through the actual $protocol adapter with empty=$empty',
    async ({ protocol, empty }) => {
      const requests: {
        input: { type: string; output: { text: string }[] }[];
        messages: { role: string; content: { type: string; content: { text: string }[] }[] }[];
      }[] = [];
      const server = createServer((request, response) => {
        let text = '';
        request.setEncoding('utf8');
        request.on('data', (part) => {
          text += part;
        });
        request.on('end', () => {
          requests.push(JSON.parse(text));
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
      const adapter: ModelAdapter =
        protocol === 'OPENAI_RESPONSES'
          ? new OpenAiResponsesAdapter(configuration)
          : new AnthropicMessagesAdapter(configuration);
      const message = fixture();
      if (empty) {
        message.observations = [];
        message.content = JSON.stringify({ ...JSON.parse(message.content!), observations: [] });
      }
      try {
        for await (const event of adapter.start(
          projectModelRequest({
            system: 'Fixture.',
            tools: [],
            messages: [
              {
                role: 'tool_call',
                callId: 'cell',
                name: 'code_exec',
                inputMode: 'freeform',
                content: '',
                arguments: 'fixture'
              },
              message
            ]
          }),
          new AbortController().signal
        )) {
          void event;
        }
        expect(requests).toHaveLength(1);
        const blocks =
          protocol === 'OPENAI_RESPONSES'
            ? requests[0]!.input.find(
                (item: { type: string }) => item.type === 'custom_tool_call_output'
              )!.output
            : requests[0]!.messages
                .find((item: { role: string }) => item.role === 'user')!
                .content.find((item: { type: string }) => item.type === 'tool_result')!.content;
        expect(Array.isArray(blocks)).toBe(true);
        expect(blocks.map((block: { text: string }) => block.text)).toEqual(
          observationModelParts(message)!.map((part) => (part.type === 'text' ? part.text : ''))
        );
        if (empty) expect(blocks).toHaveLength(1);
        else expect(blocks[1]!.text).toContain(body);
        expect(blocks[0]!.text).toBe('{"cellId":"fixture-cell","status":"completed"}');
        expect(JSON.parse(message.content!)).toMatchObject({ toolCalls: 1, outputBytes: 512 });
      } finally {
        await adapter.close?.();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
});
