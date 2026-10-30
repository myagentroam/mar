import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { LocalAgentHost } from '../../src/host.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import type { ModelEvent, ModelMessage, ModelRequest } from '../../src/model/contracts.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import {
  startResponsesWebSocketServer,
  type CloseableServer
} from './support/responses-transport-servers.js';

vi.mock('../../src/model/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/model/http.js')>();
  return { ...actual, waitForModelRetry: vi.fn(async () => undefined) };
});

const servers: CloseableServer[] = [];
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function completed(id: string, text: string) {
  const item = {
    id,
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text }]
  };
  return {
    item,
    events: [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      {
        type: 'response.completed',
        response: { id, output: [item], usage: { input_tokens: 10, output_tokens: 2 } }
      }
    ]
  };
}

interface Script {
  events: readonly unknown[];
  state: string;
  status?: number;
  error?: { code: string; message: string };
}

async function fixture(transport: 'HTTP' | 'WEBSOCKET', scripts: readonly Script[]) {
  const bodies: Record<string, unknown>[] = [];
  const states: Array<string | null> = [];
  let baseUrl = 'https://responses.test';
  let websocket: Awaited<ReturnType<typeof startResponsesWebSocketServer>> | undefined;
  if (transport === 'HTTP') {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const script = scripts[bodies.length]!;
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      states.push(new Headers(init?.headers).get('x-codex-turn-state'));
      return new Response(
        script.error
          ? JSON.stringify({ error: script.error })
          : script.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        {
          status: script.status ?? 200,
          headers: {
            'content-type': script.error ? 'application/json' : 'text/event-stream',
            'x-codex-turn-state': script.state
          }
        }
      );
    });
  } else {
    websocket = await startResponsesWebSocketServer([], {
      responsesByRequest: scripts.map((script) => [
        { type: 'response.metadata', headers: { 'x-codex-turn-state': script.state } },
        ...script.events
      ])
    });
    servers.push(websocket.server);
    baseUrl = websocket.baseUrl;
  }
  const credentials = {
    acquire: vi.fn(async () => ({
      revision: 1,
      expiresAt: Date.now() + 60_000,
      bearer: new SecretValue('fixture-token'),
      headers: {}
    })),
    invalidate: vi.fn(),
    close: vi.fn(async () => undefined)
  };
  const model: AgentModelConfiguration = {
    id: 'responses',
    name: 'Responses',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    credentialProvider: credentials,
    modelId: 'responses-test',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    responsesTransport: transport === 'HTTP' ? { transport, httpVersion: '1.1' } : { transport },
    responsesPreviousResponseId: true,
    enabled: true
  };
  return {
    model,
    credentials,
    websocket,
    bodies: websocket ? (websocket.requests as Record<string, unknown>[]) : bodies,
    state(index: number) {
      if (!websocket) return states[index];
      const body = websocket.requests[index] as { client_metadata?: Record<string, string> };
      return body.client_metadata?.['x-codex-turn-state'] ?? null;
    }
  };
}

async function collect(stream: AsyncIterable<ModelEvent>) {
  for await (const event of stream) void event;
}

describe.each(['HTTP', 'WEBSOCKET'] as const)('%s retry Provider Turns', (transport) => {
  it.each(['overload', 'invalid continuation', 'unauthorized'] as const)(
    'restarts a failed %s with fresh routing and full history, then keeps the new routing',
    async (failure) => {
      const seed = completed('seed', 'Seed');
      const recovered = completed('recovered', 'Recovered');
      const error = {
        code:
          failure === 'overload'
            ? 'server_is_overloaded'
            : failure === 'unauthorized'
              ? 'unauthorized'
              : 'invalid_previous_response_id',
        message: 'Synthetic request failure.'
      };
      const status = failure === 'unauthorized' ? 401 : 400;
      const f = await fixture(transport, [
        { state: 'old-turn', events: seed.events },
        {
          state: 'ignored-old-turn-update',
          events: [{ type: 'error', ...(failure === 'overload' ? {} : { status }), error }],
          ...(failure === 'overload' ? {} : { status, error })
        },
        { state: 'new-turn', events: recovered.events },
        { state: 'ignored-new-turn-update', events: completed('final', 'Final').events }
      ]);
      const adapter = new OpenAiResponsesAdapter(f.model);
      const turn = adapter.createTurnSession();
      const request = (messages: ModelMessage[]): ModelRequest => ({
        system: 'Reply.',
        messages,
        tools: [],
        promptCacheKey: 'stable-session',
        retryState: { attempts: 0, maxAttempts: 2 }
      });
      const firstUser: ModelMessage = { role: 'user', content: 'First' };
      const history: ModelMessage[] = [
        firstUser,
        { role: 'provider', provider: 'OPENAI_RESPONSES', content: '', item: seed.item },
        { role: 'assistant', content: 'Seed' },
        { role: 'user', content: 'Second' }
      ];
      try {
        await collect(turn.start(request([firstUser]), new AbortController().signal));
        const retry = request(history);
        await collect(turn.start(retry, new AbortController().signal));
        expect(retry.retryState?.attempts).toBe(2);
        expect(f.bodies[1]).toHaveProperty('previous_response_id', 'seed');
        expect(f.state(1)).toBe('old-turn');
        expect(f.bodies[2]).not.toHaveProperty('previous_response_id');
        expect(f.state(2)).toBeNull();
        expect(f.bodies[2]?.input).toEqual([
          { role: 'developer', content: [{ type: 'input_text', text: 'Reply.' }] },
          { role: 'user', content: 'First' },
          seed.item,
          { role: 'user', content: 'Second' }
        ]);
        await collect(
          turn.start(
            request([
              ...history,
              { role: 'provider', provider: 'OPENAI_RESPONSES', content: '', item: recovered.item },
              { role: 'assistant', content: 'Recovered' },
              { role: 'user', content: 'Third' }
            ]),
            new AbortController().signal
          )
        );
        expect(f.state(3)).toBe('new-turn');
        expect(f.bodies[3]).toHaveProperty('previous_response_id', 'recovered');
        expect(f.bodies).toHaveLength(4);
        for (const body of f.bodies)
          expect(body).toHaveProperty('prompt_cache_key', 'stable-session');
        if (f.websocket) expect(f.websocket.connections()).toBe(2);
        if (failure === 'unauthorized') expect(f.credentials.invalidate).toHaveBeenCalledWith(1);
      } finally {
        await turn.close();
        await adapter.close();
      }
    }
  );

  it.each(['partial output', 'empty completion'] as const)(
    'starts a fresh Provider Turn when the Runtime recovers %s without replacing the Execution',
    async (failure) => {
      const f = await fixture(transport, [
        {
          state: 'failed-turn',
          events:
            failure === 'partial output'
              ? [
                  { type: 'response.output_text.delta', item_id: 'partial', delta: 'Working' },
                  { type: 'error', error: { code: 'server_error', message: 'Synthetic failure.' } }
                ]
              : [{ type: 'response.completed', response: { id: 'empty', output: [] } }]
        },
        { state: 'recovered-turn', events: completed('recovered', 'Recovered').events }
      ]);
      const home = await mkdtemp(join(tmpdir(), 'mar-retry-turn-'));
      homes.push(home);
      const agent = await createAgentWithAdapter({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
        models: [f.model]
      });
      try {
        const session = await agent.createSession({ workspace: home, title: 'Retry Turn' });
        const handle = session.run({ prompt: 'Continue.' });
        expect(await handle.result()).toMatchObject({
          status: 'completed',
          finalAnswer: 'Recovered'
        });
        expect(f.bodies).toHaveLength(2);
        expect(f.state(1)).toBeNull();
        expect(f.bodies[1]).not.toHaveProperty('previous_response_id');
        expect(JSON.stringify(f.bodies[1]?.input)).toContain('Continue.');
        if (f.websocket) expect(f.websocket.connections()).toBe(2);
        const store = await JsonlSessionStore.open(home);
        try {
          const attempts = (await store.read(session.id)).filter(
            (record) => record.type === 'model.attempt'
          );
          expect(new Set(attempts.map((record) => record.executionId)).size).toBe(1);
          expect(
            attempts
              .filter((record) => record.payload.state === 'STARTED')
              .map((record) => record.payload.attempt)
          ).toEqual([1, 2]);
        } finally {
          await store.close();
        }
      } finally {
        await agent.dispose();
      }
    }
  );
});
