import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SecretValue,
  generateModelText,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import type {
  ModelAttemptDiagnostic,
  ModelEvent,
  ModelRequest
} from '../../src/agent-core/model/contracts.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

const success = [
  { type: 'message_start', message: { id: 'summary', usage: { input_tokens: 42 } } },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: 'durable handoff' }
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' }
];
const overload = {
  type: 'error',
  error: { type: 'system_cpu_overloaded', message: 'PRIVATE_UPSTREAM_BODY' }
};

async function fixture(attempts: unknown[][] = [success]) {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const events = attempts[Math.min(requests++, attempts.length - 1)]!;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  const model: MarAgentModelConfiguration = {
    id: 'compact',
    name: 'Compact',
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: new SecretValue('fixture-secret'),
    modelId: 'coding',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    enabled: true
  };
  return { model, requestCount: () => requests };
}

async function drain(events: AsyncIterable<ModelEvent>) {
  for await (const event of events) void event;
}

function request(diagnostics: ModelAttemptDiagnostic[]): ModelRequest {
  return {
    system: 'system',
    messages: [{ role: 'user', content: 'compact evidence' }],
    tools: [],
    retryState: { attempts: 0, maxAttempts: 2 },
    onAttemptDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    }
  };
}

describe('Anthropic attempt diagnostics', () => {
  it('counts an actual tool-free Compact generation through generateModelText', async () => {
    const { model, requestCount } = await fixture();
    const diagnostics: ModelAttemptDiagnostic[] = [];
    const result = await generateModelText({
      model,
      system: 'compact contract',
      messages: [{ role: 'user', content: 'evidence' }],
      signal: new AbortController().signal,
      onAttemptDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    });
    expect(result?.text).toBe('durable handoff');
    expect(requestCount()).toBe(1);
    expect(diagnostics.map(({ state }) => state)).toEqual(['STARTED', 'SUCCEEDED']);
    expect(diagnostics[0]).toMatchObject({
      protocol: 'ANTHROPIC_MESSAGES',
      transport: 'HTTP',
      attempt: 1,
      maxAttempts: 1,
      continuation: false,
      credentialReason: 'REQUEST'
    });
    expect(diagnostics[1]).toMatchObject({
      semanticEventObserved: true,
      firstSemanticEventType: 'text.delta'
    });
    expect(diagnostics[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports every failed and successful attempt without copying the upstream body', async () => {
    const { model, requestCount } = await fixture([[overload], success]);
    const diagnostics: ModelAttemptDiagnostic[] = [];
    await drain(
      new AnthropicMessagesAdapter(model).start(request(diagnostics), new AbortController().signal)
    );
    expect(requestCount()).toBe(2);
    expect(diagnostics.map(({ state, attempt }) => [state, attempt])).toEqual([
      ['STARTED', 1],
      ['FAILED', 1],
      ['STARTED', 2],
      ['SUCCEEDED', 2]
    ]);
    expect(diagnostics[1]).toMatchObject({
      errorCode: 'system_cpu_overloaded',
      willRetry: true,
      retryDelayMs: 0,
      semanticEventObserved: false
    });
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_UPSTREAM_BODY');
    expect(JSON.stringify(diagnostics)).not.toContain('fixture-secret');
  });

  it.each(['STARTED', 'SUCCEEDED'] as const)(
    'isolates a failing %s observer from the generation result',
    async (failureState) => {
      const { model, requestCount } = await fixture();
      const diagnostics: ModelAttemptDiagnostic[] = [];
      const result = await generateModelText({
        model,
        system: 'compact',
        messages: [],
        signal: new AbortController().signal,
        onAttemptDiagnostic: async (diagnostic) => {
          diagnostics.push(diagnostic);
          if (diagnostic.state === failureState) throw new Error('Diagnostic storage unavailable');
        }
      });
      expect(result?.text).toBe('durable handoff');
      expect(requestCount()).toBe(1);
      expect(diagnostics.map(({ state }) => state)).toEqual(['STARTED', 'SUCCEEDED']);
    }
  );

  it('reports a terminal failure without replaying visible semantic output', async () => {
    const { model, requestCount } = await fixture([[...success.slice(0, 2), overload]]);
    const diagnostics: ModelAttemptDiagnostic[] = [];
    await expect(
      drain(
        new AnthropicMessagesAdapter(model).start(
          request(diagnostics),
          new AbortController().signal
        )
      )
    ).rejects.toMatchObject({ code: 'system_cpu_overloaded' });
    expect(requestCount()).toBe(1);
    expect(diagnostics.map(({ state }) => state)).toEqual(['STARTED', 'FAILED']);
    expect(diagnostics[1]).toMatchObject({ semanticEventObserved: true, willRetry: false });
  });

  it('does not report a request when cancelled before the first attempt', async () => {
    const { model, requestCount } = await fixture();
    const controller = new AbortController();
    const reason = new Error('Cancelled');
    controller.abort(reason);
    const diagnostics: ModelAttemptDiagnostic[] = [];
    await expect(
      drain(new AnthropicMessagesAdapter(model).start(request(diagnostics), controller.signal))
    ).rejects.toBe(reason);
    expect(requestCount()).toBe(0);
    expect(diagnostics).toEqual([]);
  });
});
