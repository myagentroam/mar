import { performance } from 'node:perf_hooks';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, createAgent, type AgentModelConfiguration } from '../../src/index.js';
import { LocalAgentHost } from '../../src/host.js';
import { startResponsesWebSocketServer } from '../unit/support/responses-transport-servers.js';

const EXECUTIONS = 20;
const SAMPLES = 5;
const CONTENT_CHARACTERS = 8 * 1024;
const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function completedResponse(index: number) {
  const responseId = `response-${index + 1}`;
  const text = `Answer ${index + 1} ${'y'.repeat(CONTENT_CHARACTERS)}`;
  const item = {
    type: 'message',
    id: `${responseId}-message`,
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text }]
  };
  return {
    text,
    events: [
      { type: 'response.created', response: { id: responseId } },
      { type: 'response.output_item.done', item },
      {
        type: 'response.completed',
        response: {
          id: responseId,
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            input_tokens_details: {}
          }
        }
      }
    ]
  };
}

function configuration(
  baseUrl: string,
  transport: AgentModelConfiguration['responsesTransport'],
  continuation: boolean,
  acquire: ReturnType<typeof vi.fn>
): AgentModelConfiguration {
  return {
    id: 'codex',
    name: 'Codex',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    credentialProvider: {
      acquire,
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    },
    modelId: 'gpt-codex',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesTransport: transport,
    responsesPreviousResponseId: continuation,
    enabled: true
  };
}

async function startHttpServer(responses: ReturnType<typeof completedResponse>[]) {
  const requests: Record<string, unknown>[] = [];
  let connections = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const index = requests.length;
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        responses[index]!.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
      );
    });
  });
  server.on('connection', () => connections++);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    connections: () => connections
  };
}

async function runScenario(kind: 'WEBSOCKET_CONTINUATION' | 'HTTP_FULL_HISTORY') {
  const responses = Array.from({ length: EXECUTIONS }, (_, index) => completedResponse(index));
  const webSocket =
    kind === 'WEBSOCKET_CONTINUATION'
      ? await startResponsesWebSocketServer([], {
          responsesByRequest: responses.map(({ events }) => events)
        })
      : undefined;
  if (webSocket !== undefined) servers.push(webSocket.server);
  const http = kind === 'HTTP_FULL_HISTORY' ? await startHttpServer(responses) : undefined;
  const requests = webSocket?.requests ?? http!.requests;
  const acquire = vi.fn(async () => ({
    revision: 1,
    expiresAt: Date.now() + 60_000,
    bearer: new SecretValue('benchmark-token'),
    headers: {}
  }));
  const home = await mkdtemp(join(tmpdir(), `mar-responses-${kind.toLowerCase()}-`));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const agent = await createAgent({
    mode: 'normal',
    host: new LocalAgentHost({ homeDirectory: home, workspace }),
    workspaceMapping: {
      logicalPath: '/workspace',
      physicalPath: workspace
    },
    models: [
      configuration(
        webSocket?.baseUrl ?? http!.baseUrl,
        kind === 'WEBSOCKET_CONTINUATION'
          ? { transport: 'WEBSOCKET' }
          : { transport: 'HTTP', httpVersion: '1.1' },
        kind === 'WEBSOCKET_CONTINUATION',
        acquire
      )
    ]
  });

  try {
    const session = await agent.createSession({ workspace, title: kind });
    const startedAt = performance.now();
    for (let index = 0; index < EXECUTIONS; index++) {
      const prompt = `Prompt ${index + 1} ${'x'.repeat(CONTENT_CHARACTERS)}`;
      await expect(session.run({ prompt }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: responses[index]!.text
      });
    }
    const elapsedMs = performance.now() - startedAt;
    const requestBodyBytes = requests.reduce(
      (total, request) => total + Buffer.byteLength(JSON.stringify(request)),
      0
    );
    return {
      elapsedMs,
      requestBodyBytes,
      requests: requests.length,
      connections: webSocket?.connections() ?? http!.connections(),
      continuationRequests: requests.filter((request) =>
        Object.hasOwn(request, 'previous_response_id')
      ).length,
      credentialAcquires: acquire.mock.calls.length,
      lastInputItems: Array.isArray(requests.at(-1)?.input) ? requests.at(-1)!.input.length : 0
    };
  } finally {
    await agent.dispose();
  }
}

type ScenarioMetrics = Awaited<ReturnType<typeof runScenario>>;

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}

function summarize(samples: readonly ScenarioMetrics[]) {
  const elapsedSamples = samples.map(({ elapsedMs }) => elapsedMs);
  return {
    ...samples[0]!,
    elapsedMs: median(elapsedSamples),
    elapsedRangeMs: {
      minimum: Math.min(...elapsedSamples),
      maximum: Math.max(...elapsedSamples)
    }
  };
}

describe('Responses transport performance', () => {
  it('compares WebSocket continuation with ordinary HTTP full-history executions', async () => {
    const webSocketSamples: ScenarioMetrics[] = [];
    const httpSamples: ScenarioMetrics[] = [];
    for (let sample = 0; sample < SAMPLES; sample++) {
      if (sample % 2 === 0) {
        webSocketSamples.push(await runScenario('WEBSOCKET_CONTINUATION'));
        httpSamples.push(await runScenario('HTTP_FULL_HISTORY'));
      } else {
        httpSamples.push(await runScenario('HTTP_FULL_HISTORY'));
        webSocketSamples.push(await runScenario('WEBSOCKET_CONTINUATION'));
      }
    }
    const webSocket = summarize(webSocketSamples);
    const http = summarize(httpSamples);

    for (const sample of webSocketSamples) {
      expect(sample.requests).toBe(EXECUTIONS);
      expect(sample.connections).toBe(1);
      expect(sample.continuationRequests).toBe(EXECUTIONS - 1);
      expect(sample.lastInputItems).toBe(1);
    }
    for (const sample of httpSamples) {
      expect(sample.requests).toBe(EXECUTIONS);
      expect(sample.continuationRequests).toBe(0);
      expect(sample.lastInputItems).toBeGreaterThan(EXECUTIONS);
    }
    expect(webSocket.requestBodyBytes).toBeLessThan(http.requestBodyBytes * 0.35);

    console.info(
      'RESPONSES_TRANSPORT_COMPARISON',
      JSON.stringify({
        executions: EXECUTIONS,
        samples: SAMPLES,
        webSocket: {
          ...webSocket,
          elapsedMs: Math.round(webSocket.elapsedMs * 100) / 100,
          elapsedRangeMs: {
            minimum: Math.round(webSocket.elapsedRangeMs.minimum * 100) / 100,
            maximum: Math.round(webSocket.elapsedRangeMs.maximum * 100) / 100
          }
        },
        http: {
          ...http,
          elapsedMs: Math.round(http.elapsedMs * 100) / 100,
          elapsedRangeMs: {
            minimum: Math.round(http.elapsedRangeMs.minimum * 100) / 100,
            maximum: Math.round(http.elapsedRangeMs.maximum * 100) / 100
          }
        },
        requestBodyReduction:
          Math.round((1 - webSocket.requestBodyBytes / http.requestBodyBytes) * 10_000) / 100,
        diagnosticMedianElapsedReduction:
          Math.round((1 - webSocket.elapsedMs / http.elapsedMs) * 10_000) / 100
      })
    );
  });
});
