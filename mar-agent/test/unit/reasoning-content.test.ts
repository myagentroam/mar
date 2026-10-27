import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import {
  SecretValue,
  createAgent,
  openAgentSessionCatalog,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../src/index.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

const servers: Server[] = [];
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

async function startFakeSseServer(responses: readonly (readonly unknown[])[]) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const events = responses[requestCount] ?? [];
      requestCount++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get requestCount() {
      return requestCount;
    }
  };
}

function modelConfiguration(
  baseUrl: string,
  protocol: AgentModelConfiguration['protocol']
): AgentModelConfiguration {
  return {
    id: protocol === 'OPENAI_RESPONSES' ? 'responses' : 'anthropic',
    name: protocol === 'OPENAI_RESPONSES' ? 'Responses' : 'Anthropic',
    protocol,
    baseUrl,
    apiKey: new SecretValue('fake-test-key'),
    modelId: 'test-model',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium',
    titleGeneration: false,
    codeMode: false,
    ...(protocol === 'OPENAI_RESPONSES'
      ? { responsesTransport: { transport: 'HTTP' as const, httpVersion: '1.1' as const } }
      : {}),
    responsesPreviousResponseId: false,
    hostedWebSearch: false,
    enabled: true
  };
}

async function isolatedWorkspace() {
  const home = await mkdtemp(join(tmpdir(), 'mar-reasoning-content-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  return { home, workspace };
}

function reasoningEvents(events: readonly AgentEvent[]) {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: 'reasoning.completed' }> =>
      event.type === 'reasoning.completed'
  );
}

function responseTurn(responseId: string, summaries: readonly unknown[]) {
  const message = {
    type: 'message',
    id: `${responseId}-answer`,
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Finished.' }]
  };
  return [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_text.delta', item_id: message.id, delta: 'Fin' },
    ...summaries,
    { type: 'response.output_item.done', item: message },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        output: [message],
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: {} }
      }
    }
  ];
}

async function collectRun(
  session: Awaited<ReturnType<Awaited<ReturnType<typeof createAgent>>['createSession']>>,
  prompt: string
) {
  const execution = session.run({ prompt });
  const events: AgentEvent[] = [];
  for await (const event of execution) events.push(event);
  await expect(execution.result()).resolves.toMatchObject({ status: 'completed' });
  return events;
}

describe('reasoning content identity and projection', () => {
  it('holds leading whitespace until the first visible message so live and stored ordering agree', async () => {
    const message = {
      type: 'message',
      id: 'answer',
      role: 'assistant',
      phase: 'final_answer',
      status: 'completed',
      content: [{ type: 'output_text', text: ' \nFinished. ' }]
    };
    const server = await startFakeSseServer([
      [
        { type: 'response.created', response: { id: 'leading-space' } },
        { type: 'response.output_text.delta', item_id: message.id, delta: ' \n' },
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning',
          summary_index: 0,
          text: 'Check first.'
        },
        { type: 'response.output_text.delta', item_id: message.id, delta: 'Finished.' },
        { type: 'response.output_text.delta', item_id: message.id, delta: ' ' },
        { type: 'response.output_item.done', item: message },
        {
          type: 'response.completed',
          response: {
            id: 'leading-space',
            output: [message],
            usage: { input_tokens: 10, output_tokens: 3 }
          }
        }
      ]
    ]);
    const { home, workspace } = await isolatedWorkspace();
    const agent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [modelConfiguration(server.baseUrl, 'OPENAI_RESPONSES')]
    });
    let sessionId = '';
    let events: AgentEvent[] = [];
    try {
      const session = await agent.createSession({ workspace, title: 'Leading whitespace' });
      sessionId = session.id;
      events = await collectRun(session, 'Check and finish.');
    } finally {
      await agent.dispose();
    }
    const reasoningAt = events.findIndex((event) => event.type === 'reasoning.completed');
    const startAt = events.findIndex((event) => event.type === 'message.started');
    const deltaAt = events.findIndex((event) => event.type === 'message.delta');
    expect(reasoningAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(reasoningAt);
    expect(deltaAt).toBeGreaterThan(startAt);
    expect(
      events.flatMap((event) => (event.type === 'message.delta' ? [event.delta] : [])).join('')
    ).toBe(' \nFinished. ');
    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      const history = await catalog.history(sessionId);
      const visibleTypes = new Set(['reasoning.completed', 'message.started', 'message.completed']);
      expect(
        history.entries.flatMap((entry) =>
          entry.kind === 'event' && visibleTypes.has(entry.event.type) ? [entry.event.type] : []
        )
      ).toEqual(events.filter((event) => visibleTypes.has(event.type)).map((event) => event.type));
    } finally {
      await catalog.close();
    }
  });

  it('keeps Responses summary parts distinct, deduplicates done events, and scopes identities per request', async () => {
    const server = await startFakeSseServer([
      responseTurn('response-one', [
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reasoning-one',
          summary_index: 0,
          delta: 'First plan'
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reasoning-one',
          summary_index: 1,
          delta: 'Second plan'
        },
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning-one',
          summary_index: 0,
          text: 'First plan'
        },
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning-one',
          summary_index: 0,
          text: 'First plan'
        },
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning-one',
          summary_index: 1,
          text: 'Second plan'
        },
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning-two',
          summary_index: 0,
          text: 'Separate item'
        },
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning-one',
          summary_index: 2,
          text: ' \n\t '
        }
      ]),
      responseTurn('response-two', [
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning-one',
          summary_index: 0,
          text: 'Next request'
        }
      ])
    ]);
    const { home, workspace } = await isolatedWorkspace();
    const agent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [modelConfiguration(server.baseUrl, 'OPENAI_RESPONSES')]
    });
    let sessionId = '';
    const publicEvents: AgentEvent[] = [];
    try {
      const session = await agent.createSession({ workspace, title: 'Reasoning parts' });
      sessionId = session.id;
      publicEvents.push(...(await collectRun(session, 'First request.')));
      publicEvents.push(...(await collectRun(session, 'Second request.')));
    } finally {
      await agent.dispose();
    }

    expect(server.requestCount).toBe(2);
    const reasoning = reasoningEvents(publicEvents);
    expect(reasoning.map((event) => event.text)).toEqual([
      'First plan',
      'Second plan',
      'Separate item',
      'Next request'
    ]);
    expect(reasoning.map((event) => event.representation)).toEqual([
      'summary',
      'summary',
      'summary',
      'summary'
    ]);
    expect(new Set(reasoning.map((event) => event.itemId)).size).toBe(4);

    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      const history = await catalog.history(sessionId);
      const persisted = history.entries.flatMap((entry) =>
        entry.kind === 'event' && entry.event.type === 'reasoning.completed' ? [entry.event] : []
      );
      expect(
        persisted.map(({ itemId, representation, text }) => ({
          itemId,
          representation,
          text
        }))
      ).toEqual(
        reasoning.map(({ itemId, representation, text }) => ({
          itemId,
          representation,
          text
        }))
      );
    } finally {
      await catalog.close();
    }
  });

  it('publishes only visible Anthropic thinking blocks and omits signatures, redacted data, and whitespace', async () => {
    const server = await startFakeSseServer([
      [
        {
          type: 'message_start',
          message: { id: 'anthropic-response', usage: { input_tokens: 8 } }
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', id: 'thinking-one', thinking: '' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Visible first thought' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE_SENTINEL' }
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'redacted_thinking', data: 'PRIVATE_REDACTED_SENTINEL' }
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'thinking', id: 'thinking-blank', thinking: '' }
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'thinking_delta', thinking: ' \n\t ' }
        },
        { type: 'content_block_stop', index: 2 },
        {
          type: 'content_block_start',
          index: 3,
          content_block: { type: 'thinking', id: 'thinking-two', thinking: '' }
        },
        {
          type: 'content_block_delta',
          index: 3,
          delta: { type: 'thinking_delta', thinking: 'Visible second thought' }
        },
        { type: 'content_block_stop', index: 3 },
        {
          type: 'content_block_start',
          index: 4,
          content_block: { type: 'text', id: 'answer', text: '' }
        },
        {
          type: 'content_block_delta',
          index: 4,
          delta: { type: 'text_delta', text: 'Finished.' }
        },
        { type: 'content_block_stop', index: 4 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 }
        },
        { type: 'message_stop' }
      ]
    ]);
    const { home, workspace } = await isolatedWorkspace();
    const agent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [modelConfiguration(server.baseUrl, 'ANTHROPIC_MESSAGES')]
    });
    let sessionId = '';
    let publicEvents: AgentEvent[] = [];
    try {
      const session = await agent.createSession({ workspace, title: 'Visible thinking' });
      sessionId = session.id;
      publicEvents = await collectRun(session, 'Explain briefly.');
    } finally {
      await agent.dispose();
    }

    const reasoning = reasoningEvents(publicEvents);
    expect(reasoning.map((event) => event.text)).toEqual([
      'Visible first thought',
      'Visible second thought'
    ]);
    expect(reasoning.map((event) => event.representation)).toEqual([
      'visible_thinking',
      'visible_thinking'
    ]);
    expect(new Set(reasoning.map((event) => event.itemId)).size).toBe(2);

    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      const history = await catalog.history(sessionId);
      const persisted = history.entries.flatMap((entry) =>
        entry.kind === 'event' ? [entry.event] : []
      );
      const starts = persisted.filter((event) => event.type === 'message.started');
      expect(starts).toHaveLength(1);
      expect(persisted.some((event) => event.type === 'message.delta')).toBe(false);
      expect(persisted.findIndex((event) => event.type === 'message.started')).toBeGreaterThan(
        persisted.findIndex((event) => event.type === 'reasoning.completed')
      );
      expect(persisted.findIndex((event) => event.type === 'message.started')).toBeLessThan(
        persisted.findIndex((event) => event.type === 'message.completed')
      );
      expect(persisted.findIndex((event) => event.type === 'message.completed')).toBeGreaterThan(
        persisted.findIndex((event) => event.type === 'reasoning.completed')
      );
      expect(JSON.stringify([...publicEvents, ...persisted])).not.toMatch(
        /PRIVATE_SIGNATURE_SENTINEL|PRIVATE_REDACTED_SENTINEL/
      );
      expect(reasoningEvents(persisted).map((event) => event.text)).toEqual([
        'Visible first thought',
        'Visible second thought'
      ]);
    } finally {
      await catalog.close();
    }
  });

  it('ignores retired reasoning events without blocking new history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-reasoning-legacy-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home, title: 'Legacy reasoning' });
    const timestamp = '2026-10-22T12:00:00.000Z';
    const stored = [
      {
        type: 'reasoning.summary',
        eventId: 'legacy-with-item',
        sequence: 14,
        timestamp,
        sessionId: session.id,
        executionId: 'execution-one',
        turnId: 'turn-one',
        itemId: 'legacy-provider-item',
        text: 'A stored legacy summary.'
      },
      {
        type: 'reasoning.summary',
        eventId: 'legacy-without-item',
        sequence: 15,
        timestamp,
        sessionId: session.id,
        executionId: 'execution-two',
        turnId: 'turn-two',
        text: 'A legacy summary without item identity.'
      },
      {
        type: 'reasoning.completed',
        representation: 'summary',
        itemId: 'new-item',
        eventId: 'new-event',
        sequence: 16,
        timestamp,
        sessionId: session.id,
        executionId: 'execution-three',
        turnId: 'turn-three',
        text: 'New reasoning content.'
      }
    ];
    try {
      for (const event of stored)
        await store.append(session.id, {
          type: event.type,
          executionId: event.executionId,
          turnId: event.turnId,
          payload: event
        });
    } finally {
      await store.close();
    }

    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      const history = await catalog.history(session.id);
      const projected = history.entries.flatMap((entry) =>
        entry.kind === 'event' && entry.event.type === 'reasoning.completed' ? [entry.event] : []
      );
      expect(projected).toEqual([stored[2]]);
      expect(history.entries.filter((entry) => entry.kind === 'event')).toHaveLength(1);
    } finally {
      await catalog.close();
    }
  });
});
