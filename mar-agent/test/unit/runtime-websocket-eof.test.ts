import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalAgentHost,
  MarAgentError,
  SecretValue,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/agent-core/model/contracts.js';
import {
  startResponsesWebSocketServer,
  type CloseableServer
} from './support/responses-transport-servers.js';

const servers: CloseableServer[] = [];
const homes: string[] = [];

afterEach(async () => {
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

function configuration(
  baseUrl: string,
  provider: {
    acquire(reason: 'REQUEST' | 'UNAUTHORIZED' | 'RECONNECT'): Promise<{
      readonly revision: number;
      readonly expiresAt: number;
      readonly bearer: SecretValue;
      readonly headers: Readonly<Record<string, SecretValue | string>>;
    }>;
    invalidate(revision: number): void;
    close(): Promise<void>;
  }
): MarAgentModelConfiguration {
  return {
    id: 'codex',
    name: 'Codex',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    credentialProvider: provider,
    modelId: 'gpt-codex',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true,
    enabled: true
  };
}

function completedCommentaryEvents(responseId: string, itemId: string, text: string) {
  return [
    {
      type: 'response.created',
      response: { id: responseId }
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        id: itemId,
        role: 'assistant',
        phase: 'commentary',
        status: 'completed',
        content: [{ type: 'output_text', text }]
      }
    }
  ];
}

function toolResponseEvents() {
  return [
    {
      type: 'response.metadata',
      headers: { 'x-codex-turn-state': 'turn-state-1' }
    },
    {
      type: 'response.created',
      response: { id: 'response-tool' }
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        id: 'function-call-1',
        call_id: 'exec-1',
        name: 'exec',
        arguments: JSON.stringify({
          action: 'start',
          command: 'pwd',
          yieldMs: 1_000,
          timeoutMs: 10_000
        })
      }
    },
    {
      type: 'response.completed',
      response: {
        id: 'response-tool',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: {}
        }
      }
    }
  ];
}

function finalResponseEvents() {
  return [
    {
      type: 'response.created',
      response: { id: 'response-final' }
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        id: 'response-final-message',
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Tool completed after reconnect' }]
      }
    },
    {
      type: 'response.completed',
      response: {
        id: 'response-final',
        usage: {
          input_tokens: 12,
          output_tokens: 2,
          input_tokens_details: {}
        }
      }
    }
  ];
}

class PreludeEarlyEofAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly configuration: MarAgentModelConfiguration = {
    id: 'codex',
    name: 'Codex',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'http://unused.test',
    apiKey: new SecretValue('unused'),
    modelId: 'gpt-codex',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true,
    enabled: true
  };

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.retryState !== undefined)
      request.retryState.attempts = request.retryState.maxAttempts ?? 8;
    yield* [] as ModelEvent[];
    throw new MarAgentError(
      'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      'OpenAI Responses stream ended without a terminal event.',
      {
        details: { reason: 'OPENAI_RESPONSES_EARLY_EOF', retryAfter: '0' },
        retryable: true
      }
    );
  }
}

describe('MAR Agent WebSocket EOF recovery', () => {
  it('does not stack runtime recovery after a prelude retry budget is exhausted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-prelude-eof-limit-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new PreludeEarlyEofAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [adapter.configuration],
      adapterFactory: () => adapter
    });

    try {
      const session = await agent.createSession({ workspace, title: 'Prelude EOF boundary' });
      await expect(session.run({ prompt: 'fail before output' }).result()).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
      });
      expect(adapter.requests).toHaveLength(1);
    } finally {
      await agent.dispose();
    }
  });

  it('automatically recovers an interrupted Compact execution', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        finalResponseEvents(),
        [
          {
            type: 'response.created',
            response: { id: 'response-compact-partial' }
          },
          {
            type: 'response.output_item.added',
            item: {
              type: 'message',
              id: 'compact-partial-message',
              role: 'assistant',
              phase: 'final_answer'
            }
          },
          {
            type: 'response.output_text.delta',
            item_id: 'compact-partial-message',
            phase: 'final_answer',
            delta: 'Partial compact summary'
          }
        ],
        finalResponseEvents()
      ],
      closeAfterRequestIndexes: [1]
    });
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-websocket-eof-compact-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider)]
    });

    try {
      const session = await agent.createSession({
        workspace,
        title: 'WebSocket Compact recovery'
      });
      await expect(session.run({ prompt: 'Create context' }).result()).resolves.toMatchObject({
        status: 'completed'
      });

      const handle = session.compact();
      const events: Array<{ type: string; [key: string]: unknown }> = [];
      for await (const event of handle) events.push(event);

      await expect(handle.result()).resolves.toMatchObject({ status: 'completed' });
      expect(server.requests).toHaveLength(3);
      expect(events.some((event) => event.type === 'execution.failed')).toBe(false);
      expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('reconnects with full history after the Responses WebSocket connection limit', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        finalResponseEvents(),
        [
          {
            type: 'response.failed',
            response: {
              error: {
                code: 'websocket_connection_limit_reached',
                message: 'Responses websocket connection limit reached (60 minutes).'
              }
            }
          }
        ],
        finalResponseEvents()
      ]
    });
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-websocket-connection-limit-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider)]
    });

    try {
      const session = await agent.createSession({
        workspace,
        title: 'WebSocket connection limit recovery'
      });
      await expect(
        session.run({ prompt: 'Establish the connection' }).result()
      ).resolves.toMatchObject({
        status: 'completed'
      });

      await expect(
        session.run({ prompt: 'Recover after the connection limit' }).result()
      ).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Tool completed after reconnect'
      });
      expect(server.connections()).toBe(2);
      expect(server.requests).toHaveLength(3);
      expect(server.requests[1]).toHaveProperty('previous_response_id', 'response-final');
      expect(server.requests[2]).not.toHaveProperty('previous_response_id');
      expect(server.requests[2]).toMatchObject({
        input: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: 'Establish the connection'
          }),
          expect.objectContaining({
            role: 'user',
            content: 'Recover after the connection limit'
          })
        ])
      });
    } finally {
      await agent.dispose();
    }
  }, 30_000);

  it('recovers after partial text, hosted tool, and citation events', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        [
          {
            type: 'response.created',
            response: { id: 'response-partial' }
          },
          {
            type: 'response.output_item.added',
            item: {
              type: 'message',
              id: 'partial-message',
              role: 'assistant',
              phase: 'commentary'
            }
          },
          {
            type: 'response.output_text.delta',
            item_id: 'partial-message',
            phase: 'commentary',
            delta: 'Partially generated'
          },
          {
            type: 'response.output_item.done',
            item_id: 'hosted-search',
            item: {
              type: 'web_search_call',
              id: 'hosted-search',
              action: { type: 'search', query: 'recovery evidence' }
            }
          },
          {
            type: 'response.output_text.annotation.added',
            item_id: 'partial-message',
            annotation_index: 0,
            annotation: {
              id: 'citation-1',
              url: 'https://example.test/evidence',
              title: 'Evidence'
            }
          }
        ],
        finalResponseEvents()
      ],
      closeAfterRequestIndexes: [0]
    });
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-websocket-eof-semantic-events-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider)]
    });

    try {
      const session = await agent.createSession({
        workspace,
        title: 'WebSocket semantic event recovery'
      });
      const handle = session.run({ prompt: 'Recover every event type' });
      const events: Array<{ type: string; [key: string]: unknown }> = [];
      for await (const event of handle) events.push(event);

      await expect(handle.result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Tool completed after reconnect'
      });
      expect(server.requests).toHaveLength(2);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'message.delta',
            itemId: 'partial-message',
            delta: 'Partially generated'
          }),
          expect.objectContaining({
            type: 'tool.started',
            toolName: 'web_search',
            callId: 'hosted-search'
          }),
          expect.objectContaining({
            type: 'citation.added',
            id: 'citation-1'
          })
        ])
      );
      expect(events.some((event) => event.type === 'execution.failed')).toBe(false);
    } finally {
      await agent.dispose();
    }
  });

  it('resets completed-output recovery after a completed tool round', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        completedCommentaryEvents(
          'response-commentary-1',
          'commentary-1',
          'Preparing the first section.'
        ),
        completedCommentaryEvents(
          'response-commentary-2',
          'commentary-2',
          'Preparing the second section.'
        ),
        toolResponseEvents(),
        completedCommentaryEvents(
          'response-commentary-3',
          'commentary-3',
          'Checking the tool result.'
        ),
        finalResponseEvents()
      ],
      closeAfterRequestIndexes: [0, 1, 3]
    });
    servers.push(server.server);
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('ws-token'),
        headers: {}
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-websocket-eof-tool-reset-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider)]
    });

    try {
      const session = await agent.createSession({
        workspace,
        title: 'WebSocket EOF tool reset'
      });
      const handle = session.run({ prompt: 'Run pwd' });
      const events: Array<{ type: string; [key: string]: unknown }> = [];
      for await (const event of handle) events.push(event);

      await expect(handle.result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Tool completed after reconnect'
      });
      expect(server.connections()).toBe(4);
      expect(server.requests).toHaveLength(5);
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(server.requests[2]).not.toHaveProperty('previous_response_id');
      expect(server.requests[3]).toHaveProperty('previous_response_id', 'response-tool');
      expect(server.requests[4]).not.toHaveProperty('previous_response_id');
      expect(server.requests[4]).toMatchObject({
        input: expect.arrayContaining([
          expect.objectContaining({ type: 'message', id: 'commentary-1' }),
          expect.objectContaining({ type: 'message', id: 'commentary-2' }),
          expect.objectContaining({ type: 'function_call', call_id: 'exec-1' }),
          expect.objectContaining({ type: 'function_call_output', call_id: 'exec-1' }),
          expect.objectContaining({ type: 'message', id: 'commentary-3' })
        ])
      });
      expect(
        events.filter(
          (event) =>
            event.type === 'message.completed' &&
            event.phase === 'commentary' &&
            typeof event.text === 'string'
        )
      ).toEqual([
        expect.objectContaining({ text: 'Preparing the first section.' }),
        expect.objectContaining({ text: 'Preparing the second section.' }),
        expect.objectContaining({ text: 'Checking the tool result.' })
      ]);
    } finally {
      await agent.dispose();
    }
  }, 45_000);
});
