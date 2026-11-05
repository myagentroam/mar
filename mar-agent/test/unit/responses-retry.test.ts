import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForNewChild } from './support/subagent-wait.js';
import { LocalAgentHost } from '../../src/host.js';
import {
  AgentError,
  SecretValue,
  type Agent,
  type AgentModelConfiguration
} from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { createSubagentExtension } from '../../extensions/subagent/src/index.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import {
  type ModelEvent,
  type ModelAdapter,
  type ModelRequest
} from '../../src/model/contracts.js';
import type { ModelAttemptDiagnostic } from '../../src/model/contracts.js';
import { waitForModelRetry } from '../../src/model/http.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { buildContextGcProtection } from '../../src/session/context-gc-protection.js';
import {
  startResponsesWebSocketServer,
  startSocks5Proxy,
  type CloseableServer
} from './support/responses-transport-servers.js';

vi.mock('../../src/model/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/model/http.js')>();
  return {
    ...actual,
    waitForModelRetry: vi.fn(async (_value: unknown, _attempt: number, signal: AbortSignal) => {
      if (signal.aborted) throw signal.reason;
    })
  };
});

const servers: CloseableServer[] = [];
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(waitForModelRetry)
    .mockReset()
    .mockImplementation(async (_value: unknown, _attempt: number, signal: AbortSignal) => {
      if (signal.aborted) throw signal.reason;
    });
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

function configuration(baseUrl: string): AgentModelConfiguration {
  return {
    id: 'responses',
    name: 'Responses',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    apiKey: new SecretValue('local-test-key'),
    modelId: 'gpt-test',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium',
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true,
    hostedWebSearch: false,
    enabled: true
  };
}

function isolatedCompactSeedFactory() {
  let needsSeed = true;
  return (configuration: ModelAdapter['configuration']): ModelAdapter => {
    if (!needsSeed) return new OpenAiResponsesAdapter(configuration);
    needsSeed = false;
    // History setup must not contribute a cached socket or lease to recovery counts.
    return {
      configuration,
      async *start() {
        yield { type: 'text.completed', itemId: 'seed', text: 'Seed state' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
  };
}

function messageItem(id: string, text: string) {
  return {
    type: 'message',
    id: `${id}-message`,
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text }]
  };
}

function completed(id = 'recovered', text = 'Recovered', inputTokens = 10) {
  const item = messageItem(id, text);
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item },
    {
      type: 'response.completed',
      response: {
        id,
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 2, input_tokens_details: {} }
      }
    }
  ];
}

const overload = {
  type: 'error',
  code: 'server_is_overloaded',
  message: 'Transient test overload.'
};

const serverError = {
  type: 'error',
  code: 'server_error',
  message: 'The upstream response could not be processed.'
};

const accessVerificationFailure = {
  type: 'error',
  code: 'invalid_request_error',
  message: 'Unable to verify Daybreak Blue access. Please try again.'
};

async function collect(events: AsyncIterable<ModelEvent>) {
  const result: ModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function workspace() {
  const home = await mkdtemp(join(tmpdir(), 'mar-responses-retry-'));
  homes.push(home);
  const directory = join(home, 'workspace');
  await mkdir(directory);
  return { home, directory };
}

const internalPrefixes = [
  {
    name: 'reasoning item added',
    events: [
      {
        type: 'response.output_item.added',
        item: { id: 'failed-reasoning', type: 'reasoning', summary: [] }
      }
    ]
  },
  {
    name: 'completed private reasoning without visible content',
    events: [
      {
        type: 'response.output_item.done',
        item: {
          id: 'failed-reasoning',
          type: 'reasoning',
          encrypted_content: 'synthetic-private-envelope',
          summary: []
        }
      }
    ]
  },
  {
    name: 'empty reasoning summary',
    events: [{ type: 'response.reasoning_summary_text.done', item_id: 'failed', text: '' }]
  },
  {
    name: 'empty text delta',
    events: [{ type: 'response.output_text.delta', item_id: 'failed', delta: '' }]
  },
  {
    name: 'empty completed text',
    events: [
      { type: 'response.output_text.done', item_id: 'failed', phase: 'final_answer', text: '' }
    ]
  }
];

describe('Responses retry boundaries', () => {
  it.each(
    [
      { name: 'transient verification', message: accessVerificationFailure.message, attempts: 2 },
      { name: 'exhausted verification', message: accessVerificationFailure.message, attempts: 8 },
      { name: 'other access failure', message: 'Access denied. Please try again.', attempts: 1 },
      { name: 'parameter failure', message: 'Invalid model parameter.', attempts: 1 },
      {
        name: 'different error code',
        code: 'authentication_error',
        message: accessVerificationFailure.message,
        attempts: 1
      }
    ].flatMap((scenario) =>
      (['HTTP', 'STANDARD', 'LITE'] as const).map((transport) => ({ ...scenario, transport }))
    )
  )('bounds $transport retries for $name and preserves the upstream error', async (scenario) => {
    const failure = {
      ...accessVerificationFailure,
      code: scenario.code ?? accessVerificationFailure.code,
      message: scenario.message
    };
    const succeeds = scenario.attempts === 2;
    const responses = succeeds
      ? [[failure], completed()]
      : Array(scenario.attempts).fill([failure]);
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses
    });
    servers.push(server.server);
    const model = configuration(
      server.baseUrl,
      scenario.transport === 'LITE' ? 'LITE' : 'STANDARD'
    );
    let httpRequests = 0;
    const fetch =
      scenario.transport === 'HTTP'
        ? vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(
              async () =>
                new Response(
                  responses[httpRequests++]!.map(
                    (event) => `data: ${JSON.stringify(event)}\n\n`
                  ).join(''),
                  { headers: { 'content-type': 'text/event-stream' } }
                )
            )
        : undefined;
    if (scenario.transport === 'HTTP')
      model.responsesTransport = { transport: 'HTTP', httpVersion: '1.1' };
    const adapter = new OpenAiResponsesAdapter(model);
    try {
      const result = collect(
        adapter.start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Continue.' }],
            tools: [],
            promptCacheKey: 'session-cache-key'
          },
          new AbortController().signal
        )
      );
      if (succeeds)
        expect(await result).toContainEqual(
          expect.objectContaining({ type: 'text.completed', text: 'Recovered' })
        );
      else
        await expect(result).rejects.toMatchObject({
          code: failure.code,
          message: `${failure.code}: ${failure.message}`,
          retryable: scenario.attempts === 8
        });
      expect(fetch?.mock.calls ?? server.requests).toHaveLength(scenario.attempts);
      const requestIds = fetch
        ? fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-client-request-id'))
        : server.handshakes.map((headers) => headers['x-client-request-id']);
      expect(new Set(requestIds).size).toBe(requestIds.length);
      for (const requestId of requestIds)
        expect(requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
      const bodies = fetch
        ? fetch.mock.calls.map(([, init]) => JSON.parse(init?.body as string))
        : server.requests;
      for (const body of bodies)
        expect(body).toHaveProperty('prompt_cache_key', 'session-cache-key');
    } finally {
      await adapter.close();
    }
  });

  it.each([
    { kind: 'cancel', code: overload.code },
    { kind: 'cancel', code: serverError.code },
    { kind: 'deterministic', code: 'invalid_request_error' }
  ])('does not continue $code recovery after $kind', async ({ kind, code }) => {
    const { home, directory } = await workspace();
    const host = new LocalAgentHost({ homeDirectory: home, workspace: directory });
    const model = configuration('http://localhost:1');
    let requests = 0;
    let cancel = () => {};
    if (kind === 'cancel')
      vi.mocked(waitForModelRetry).mockImplementationOnce(async (_value, _attempt, signal) => {
        cancel();
        expect(signal.aborted).toBe(true);
        throw signal.reason;
      });
    const adapter: ModelAdapter = {
      configuration: model,
      async *start() {
        requests++;
        yield { type: 'text.delta', itemId: 'partial', phase: 'commentary', delta: 'Partial' };
        throw new AgentError(code, 'Local test failure.', { retryable: kind === 'cancel' });
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({
        workspace: directory,
        title: 'Recovery boundary'
      });
      const handle = session.run({ prompt: 'Continue.' });
      cancel = () => {
        void handle.cancel();
      };
      expect((await handle.result()).status).toBe(kind === 'cancel' ? 'cancelled' : 'failed');
      expect(requests).toBe(1);
    } finally {
      await agent.dispose();
    }
  });
  it.each([false, true])(
    'recovers bounded subagent overloads (persistent=%s)',
    async (persistent) => {
      const { home, directory } = await workspace();
      const host = new LocalAgentHost({ homeDirectory: home, workspace: directory });
      const model = {
        ...configuration('http://localhost:1'),
        conversationModel: true,
        subagentModel: true
      };
      let childRequests = 0;
      const adapter: ModelAdapter = {
        configuration: model,
        async *start(request) {
          if (
            request.system.includes('delegated subagent') ||
            request.messages.some(
              (message) =>
                message.contextualBlock?.authority === 'instruction' &&
                message.content.includes('delegated subagent')
            )
          ) {
            childRequests++;
            yield {
              type: 'text.delta',
              itemId: 'child-partial',
              phase: 'commentary',
              delta: 'Partial'
            };
            if (persistent || childRequests === 1)
              throw new AgentError('server_is_overloaded', 'Transient overload.', {
                retryable: true
              });
            yield { type: 'text.completed', itemId: 'child-final', text: 'Recovered child' };
          } else if (!request.messages.some((message) => message.role === 'tool')) {
            yield {
              type: 'client_tool.call',
              callId: 'task-retry',
              name: 'agent_start',
              arguments: {
                title: 'Inspect',
                description: 'Inspect',
                prompt: 'Inspect only.',
                role: 'explore'
              }
            };
            yield { type: 'completed', reason: 'tool_use' };
            return;
          } else {
            const wait = waitForNewChild(request);
            if (wait) {
              yield wait;
              yield { type: 'completed', reason: 'tool_use' };
              return;
            }
            yield { type: 'text.completed', itemId: 'parent-final', text: 'Done' };
          }
          yield { type: 'completed', reason: 'completed' };
        }
      };
      const agent: Agent = await createMarAgent(
        {
          mode: 'normal',
          host,
          models: [model],
          extensions: [createSubagentExtension({ agent: () => agent })]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({
          workspace: directory,
          title: 'Subagent retry'
        });
        expect((await session.run({ prompt: 'Inspect.' }).result()).status).toBe('completed');
        expect(childRequests).toBe(persistent ? 8 : 2);
        const waitResult = host.events.find(
          (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
        );
        if (waitResult?.type !== 'tool.completed')
          throw new Error('Missing external subagent wait result.');
        expect(JSON.parse(waitResult.summary)).toMatchObject(
          persistent
            ? { status: 'failed', errorCode: 'server_is_overloaded' }
            : { status: 'completed', summary: 'Recovered child' }
        );
      } finally {
        await agent.dispose();
      }
    }
  );
  for (const encoding of ['STANDARD'] as const) {
    it.each(internalPrefixes)(
      `${encoding} retries overload after $name without exposing a failed attempt`,
      async ({ events: prefix }) => {
        const server = await startResponsesWebSocketServer([], {
          responsesByRequest: [
            [
              { type: 'response.created', response: { id: 'failed-response' } },
              ...prefix,
              overload
            ],
            completed()
          ]
        });
        servers.push(server.server);
        const diagnostics: ModelAttemptDiagnostic[] = [];
        const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
        try {
          const events = await collect(
            adapter.start(
              {
                system: 'Reply.',
                messages: [{ role: 'user', content: 'Retry the prelude.' }],
                tools: [],
                allowTools: false,
                onAttemptDiagnostic: (diagnostic) => {
                  diagnostics.push(diagnostic);
                }
              },
              new AbortController().signal
            )
          );
          expect(events.filter((event) => event.type === 'response.started')).toEqual([
            { type: 'response.started', responseId: 'recovered' }
          ]);
          expect(JSON.stringify(events)).not.toContain('failed');
          expect(events.some((event) => event.type === 'unknown')).toBe(false);
          expect(events).toContainEqual(
            expect.objectContaining({ type: 'text.completed', text: 'Recovered' })
          );
          expect(server.connections()).toBe(2);
          expect(server.requests).toHaveLength(2);
          expect(diagnostics).toContainEqual(
            expect.objectContaining({
              state: 'FAILED',
              attempt: 1,
              semanticEventObserved: false,
              retryable: true,
              willRetry: true
            })
          );
        } finally {
          await adapter.close();
        }
      }
    );
  }

  it('does not count or replay an unpersisted failed-prelude native item', async () => {
    const item = {
      type: 'reasoning',
      id: 'failed-reasoning',
      encrypted_content: 'synthetic-private-envelope',
      summary: []
    };
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        [
          { type: 'response.created', response: { id: 'failed-response' } },
          { type: 'response.output_item.done', item },
          overload
        ],
        completed()
      ]
    });
    servers.push(server.server);
    const { home, directory } = await workspace();
    const host = new LocalAgentHost({ homeDirectory: home, workspace: directory });
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [configuration(server.baseUrl)]
    });
    try {
      const session = await agent.createSession({
        workspace: directory,
        title: 'Native completion evidence'
      });
      expect(await session.run({ prompt: 'Continue.' }).result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'Recovered'
      });
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[1])).not.toContain('synthetic-private-envelope');
      expect(JSON.stringify(host.events)).not.toContain('synthetic-private-envelope');
      const store = await JsonlSessionStore.open(home);
      try {
        const records = await store.read(session.id);
        const firstAttempt = records.find(
          (record) =>
            record.type === 'model.attempt' &&
            (record.payload as { state?: string }).state === 'STARTED'
        )!;
        expect(
          buildContextGcProtection(records, 'responses', 200_000).after(firstAttempt.sequence - 1)
        ).toEqual({ rollouts: 1, thinking: 0 });
        expect(
          records.filter(
            (record) =>
              record.type === 'model.context' &&
              JSON.stringify(record.payload).includes('synthetic-private-envelope')
          )
        ).toEqual([]);
      } finally {
        await store.close();
      }
    } finally {
      await agent.dispose();
    }
  });

  it('preserves successful private reasoning in order without exposing an unknown placeholder', async () => {
    const item = {
      id: 'private-reasoning',
      type: 'reasoning',
      encrypted_content: 'synthetic-envelope',
      summary: []
    };
    const server = await startResponsesWebSocketServer([
      { type: 'response.created', response: { id: 'recovered' } },
      { type: 'response.output_item.added', item: { ...item, encrypted_content: undefined } },
      { type: 'response.output_item.done', item },
      ...completed().slice(1)
    ]);
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    try {
      const events = await collect(
        adapter.start(
          { system: 'Reply.', messages: [{ role: 'user', content: 'Keep context.' }], tools: [] },
          new AbortController().signal
        )
      );
      expect(events.filter((event) => !event.type.startsWith('output.')).slice(0, 3)).toEqual([
        { type: 'response.started', responseId: 'recovered' },
        { type: 'response.item', provider: 'OPENAI_RESPONSES', item },
        {
          type: 'response.item',
          provider: 'OPENAI_RESPONSES',
          item: messageItem('recovered', 'Recovered')
        }
      ]);
      expect(events.some((event) => event.type === 'unknown')).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it('retries a transient WebSocket handshake failure before semantic output', async () => {
    const server = await startResponsesWebSocketServer(completed('recovered', 'Recovered'), {
      handshakeStatuses: [503]
    });
    servers.push(server.server);
    const diagnostics: ModelAttemptDiagnostic[] = [];
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    try {
      const events = await collect(
        adapter.start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'Retry the connection.' }],
            tools: [],
            onAttemptDiagnostic: (diagnostic) => {
              diagnostics.push(diagnostic);
            }
          },
          new AbortController().signal
        )
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Recovered' })
      );
      expect(server.handshakes).toHaveLength(2);
      const requestIds = server.handshakes.map((headers) => headers['x-client-request-id']);
      for (const requestId of requestIds)
        expect(requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
      expect(new Set(requestIds).size).toBe(2);
      expect(server.connections()).toBe(1);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          state: 'FAILED',
          attempt: 1,
          errorCode: 'MAR_AGENT_MODEL_CONNECTION_FAILED',
          retryable: true,
          willRetry: true
        })
      );
    } finally {
      await adapter.close();
    }
  });

  it.each(
    (['run', 'plan', 'compact'] as const).flatMap((mode) =>
      [overload, accessVerificationFailure, serverError].map((failure) => ({ mode, failure }))
    )
  )(
    'recovers a post-semantic $failure.code in $mode without changing the adapter replay boundary',
    async ({ mode, failure }) => {
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [
          ...(mode === 'compact' ? [] : [completed('seed', 'Seed state')]),
          [
            { type: 'response.created', response: { id: 'failed' } },
            { type: 'response.output_text.delta', item_id: 'partial', delta: 'Partial' },
            failure
          ],
          completed()
        ]
      });
      servers.push(server.server);
      const { home, directory } = await workspace();
      const host = new LocalAgentHost({ homeDirectory: home, workspace: directory });
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host,
          models: [configuration(server.baseUrl)]
        },
        mode === 'compact' ? isolatedCompactSeedFactory() : undefined
      );
      try {
        const session = await agent.createSession({ workspace: directory, title: 'Retry' });
        expect((await session.run({ prompt: 'Seed state.' }).result()).status).toBe('completed');
        expect(server.requests).toHaveLength(mode === 'compact' ? 0 : 1);
        expect(server.connections()).toBe(mode === 'compact' ? 0 : 1);
        const result = await session[mode]({ prompt: 'Continue.' }).result();
        expect(result).toMatchObject({
          status: 'completed',
          finalAnswer: mode === 'compact' ? '' : 'Recovered'
        });
        expect(server.requests).toHaveLength(mode === 'compact' ? 2 : 3);
        expect(server.connections()).toBe(2);
        const [failedRequest, recoveredRequest] = server.requests.slice(-2);
        expect(recoveredRequest).not.toHaveProperty('previous_response_id');
        if (mode === 'compact') {
          expect(failedRequest).toMatchObject({ tool_choice: 'none' });
          expect(recoveredRequest).toMatchObject({ tool_choice: 'none' });
          expect(failedRequest?.tools).not.toHaveLength(0);
          expect(recoveredRequest?.tools).not.toHaveLength(0);
          expect(JSON.stringify(failedRequest?.input)).toContain('Seed state');
          expect(JSON.stringify(recoveredRequest?.input)).toContain('Seed state');
          expect(recoveredRequest?.input).toEqual(failedRequest?.input);
          expect(host.events.filter((event) => event.type === 'context.compacted')).toHaveLength(1);
          const store = await JsonlSessionStore.open(home);
          try {
            expect(
              (await store.read(session.id)).filter((record) => record.type === 'compact.completed')
            ).toMatchObject([{ payload: { summary: 'Recovered' } }]);
          } finally {
            await store.close();
          }
          expect(
            host.events.some(
              (event) =>
                event.type === 'message.delta' &&
                event.executionId === result.executionId &&
                event.delta === 'Partial'
            )
          ).toBe(false);
        }
      } finally {
        await agent.dispose();
      }
    }
  );

  it.each([overload, serverError])(
    'bounds post-semantic $code recovery and never commits a failed compact checkpoint',
    async (failure) => {
      const failed = [
        { type: 'response.created', response: { id: 'failed' } },
        { type: 'response.reasoning_summary_text.done', item_id: 'r', text: 'A visible summary.' },
        failure
      ];
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: Array(8).fill(failed)
      });
      servers.push(server.server);
      const { home, directory } = await workspace();
      const host = new LocalAgentHost({ homeDirectory: home, workspace: directory });
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host,
          models: [configuration(server.baseUrl)]
        },
        isolatedCompactSeedFactory()
      );
      try {
        const session = await agent.createSession({ workspace: directory, title: 'Bounded retry' });
        expect((await session.run({ prompt: 'Seed.' }).result()).status).toBe('completed');
        expect(server.requests).toHaveLength(0);
        expect(server.connections()).toBe(0);
        expect(await session.compact().result()).toMatchObject({
          status: 'failed',
          errorCode: failure.code
        });
        expect(server.requests).toHaveLength(8);
        expect(server.connections()).toBe(8);
        for (const request of server.requests) {
          expect(request).not.toHaveProperty('previous_response_id');
          expect(request).toMatchObject({ tool_choice: 'none' });
          expect(request.tools).not.toHaveLength(0);
          expect(JSON.stringify(request.input)).toContain('Seed state');
          expect(request.input).toEqual(server.requests[0]?.input);
        }
        expect(host.events.some((event) => event.type === 'context.compacted')).toBe(false);
        const store = await JsonlSessionStore.open(home);
        try {
          expect(
            (await store.read(session.id)).some((record) => record.type === 'compact.completed')
          ).toBe(false);
        } finally {
          await store.close();
        }
      } finally {
        await agent.dispose();
      }
    }
  );

  it.each([overload, serverError])(
    'executes a completed client tool exactly once after $code and continues with its result',
    async (failure) => {
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [
          [
            { type: 'response.metadata', headers: { 'x-codex-turn-state': 'failed-tool-turn' } },
            { type: 'response.created', response: { id: 'failed' } },
            {
              type: 'response.output_item.done',
              item: {
                type: 'custom_tool_call',
                id: 'patch-item',
                call_id: 'patch-call',
                name: 'apply_patch',
                input: '*** Begin Patch\n*** Add File: marker.txt\n+created once\n*** End Patch'
              }
            },
            failure
          ],
          completed()
        ]
      });
      servers.push(server.server);
      const { home, directory } = await workspace();
      const host = new LocalAgentHost({ homeDirectory: home, workspace: directory });
      const executed = vi.spyOn(host, 'executeTool');
      const agent = await createMarAgent({
        mode: 'normal',
        host,
        models: [configuration(server.baseUrl)]
      });
      try {
        const session = await agent.createSession({ workspace: directory, title: 'Tool retry' });
        expect(await session.run({ prompt: 'Write the marker.' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(await readFile(join(directory, 'marker.txt'), 'utf8')).toBe('created once\n');
        expect(executed.mock.calls.filter(([call]) => call.name === 'apply_patch')).toHaveLength(1);
        expect(server.requests).toHaveLength(2);
        expect(server.connections()).toBe(2);
        expect(server.requests[1]).not.toHaveProperty('client_metadata.x-codex-turn-state');
        expect(server.requests[1]).not.toHaveProperty('previous_response_id');
        expect(server.requests[1]).toMatchObject({
          input: expect.arrayContaining([
            expect.objectContaining({ type: 'custom_tool_call_output', call_id: 'patch-call' })
          ])
        });
      } finally {
        await agent.dispose();
      }
    }
  );

  it('retries automatic compaction without retaining the failed summary', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        completed('seed', 'Seed task state', 190_000),
        [...completed('incomplete', 'Discard this incomplete summary.').slice(0, 2), overload],
        completed('summary', 'Verified compact state.'),
        completed('final', 'Continued after compact.')
      ]
    });
    servers.push(server.server);
    const { home, directory } = await workspace();
    const host = new LocalAgentHost({ homeDirectory: home, workspace: directory });
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [configuration(server.baseUrl)]
    });
    try {
      const session = await agent.createSession({ workspace: directory, title: 'Automatic retry' });
      await session.run({ prompt: 'Seed task.' }).result();
      expect(await session.run({ prompt: 'Continue task.' }).result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'Continued after compact.'
      });
      expect(server.requests).toHaveLength(4);
      expect(server.requests[1]).toMatchObject({ tool_choice: 'none' });
      expect(server.requests[2]).toMatchObject({ tool_choice: 'none' });
      expect(server.requests[1]?.tools).not.toHaveLength(0);
      expect(server.requests[2]?.tools).not.toHaveLength(0);
      expect(JSON.stringify(server.requests[2])).not.toContain('Discard this incomplete summary.');
      expect(JSON.stringify(server.requests[3])).not.toContain('Discard this incomplete summary.');
      expect(JSON.stringify(server.requests[3])).toContain('Verified compact state.');
      expect(host.events.filter((event) => event.type === 'context.compacted')).toHaveLength(1);
    } finally {
      await agent.dispose();
    }
  });

  it.each(['DIRECT', 'SOCKS5'] as const)(
    'recovers on the fifth EPIPE attempt with fresh %s sockets and progressive jittered retry delays',
    async (proxyType) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      vi.mocked(waitForModelRetry).mockClear();
      const target = await startResponsesWebSocketServer([], {
        responsesByRequest: [completed('first', 'First'), completed('second', 'Recovered')]
      });
      servers.push(target.server);
      const targetPort = Number(new URL(target.baseUrl).port);
      const proxy =
        proxyType === 'SOCKS5'
          ? await startSocks5Proxy({
              targetPort,
              username: 'test-proxy-user',
              password: 'test-proxy-password'
            })
          : undefined;
      if (proxy) servers.push(proxy.server);
      const provider = {
        acquire: vi.fn(async () => ({
          revision: 1,
          expiresAt: Date.now() + 60_000,
          bearer: new SecretValue('private-test-bearer'),
          headers: {},
          ...(proxy ? { socks5Url: new SecretValue(proxy.url) } : {})
        })),
        invalidate: vi.fn(),
        close: vi.fn(async () => undefined)
      };
      const configuredModel = configuration(
        proxy ? `http://model.internal:${targetPort}` : target.baseUrl
      );
      const { apiKey, ...baseModel } = configuredModel;
      void apiKey;
      const model: AgentModelConfiguration = { ...baseModel, credentialProvider: provider };
      const adapter = new OpenAiResponsesAdapter(model);
      const turn = adapter.createTurnSession();
      const bodies: Record<string, unknown>[] = [];
      const sockets: WebSocket[] = [];
      const diagnostics: ModelAttemptDiagnostic[] = [];
      const originalSend = WebSocket.prototype.send;
      vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
        this: WebSocket,
        ...args: unknown[]
      ) {
        bodies.push(JSON.parse(String(args[0])) as Record<string, unknown>);
        sockets.push(this);
        if (bodies.length >= 2 && bodies.length <= 5) {
          const callback = args.findLast(
            (value): value is (error: Error) => void => typeof value === 'function'
          );
          if (!callback) throw new Error('Send callback missing.');
          queueMicrotask(() =>
            callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
          );
          return;
        }
        Reflect.apply(originalSend, this, args);
      } as WebSocket['send']);
      const first: ModelRequest = {
        system: 'Stable system.',
        messages: [{ role: 'user', content: 'First request.' }],
        tools: [],
        promptCacheKey: 'test-session',
        onAttemptDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        }
      };
      try {
        await collect(turn.start(first, new AbortController().signal));
        expect(
          await collect(
            turn.start(
              {
                ...first,
                messages: [
                  ...first.messages,
                  {
                    role: 'provider',
                    provider: 'OPENAI_RESPONSES',
                    providerModelId: model.id,
                    item: messageItem('first', 'First'),
                    content: ''
                  },
                  { role: 'assistant', content: 'First' },
                  { role: 'user', content: 'Second request.' }
                ]
              },
              new AbortController().signal
            )
          )
        ).toContainEqual(expect.objectContaining({ type: 'text.completed', text: 'Recovered' }));
        expect(bodies).toHaveLength(6);
        expect(bodies[1]).toHaveProperty('previous_response_id', 'first');
        expect(bodies[2]).not.toHaveProperty('previous_response_id');
        expect(bodies[3]).not.toHaveProperty('previous_response_id');
        expect(bodies[2]?.input).toEqual(bodies[3]?.input);
        expect(new Set(sockets).size).toBe(5);
        expect(sockets[0]).toBe(sockets[1]);
        expect(target.connections()).toBe(5);
        if (proxy) {
          expect(proxy.destinations).toHaveLength(5);
          expect(proxy.authentications).toHaveLength(5);
          expect(
            proxy.destinations.every((destination) => destination.host === 'model.internal')
          ).toBe(true);
        }
        expect(
          provider.acquire.mock.calls.filter(([reason]) => reason === 'RECONNECT')
        ).toHaveLength(8);
        const terminal = diagnostics.filter((diagnostic) => diagnostic.state !== 'STARTED');
        expect(terminal).toHaveLength(6);
        expect(terminal.map((diagnostic) => diagnostic.connectionReused)).toEqual([
          false,
          true,
          false,
          false,
          false,
          false
        ]);
        expect(terminal.map((diagnostic) => diagnostic.proxyType)).toEqual(
          Array(6).fill(proxyType)
        );
        const ids = terminal.map((diagnostic) => diagnostic.connectionId);
        expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(ids[0]).toBe(ids[1]);
        expect(new Set(ids).size).toBe(5);
        expect(terminal[1]).toMatchObject({ causeCode: 'EPIPE', willRetry: true });
        expect(terminal[2]).toMatchObject({ causeCode: 'EPIPE', willRetry: true });
        expect(terminal.slice(1, 5)).toEqual(
          Array(4).fill(
            expect.objectContaining({
              maxAttempts: 8,
              causeCode: 'EPIPE',
              willRetry: true
            })
          )
        );
        expect(terminal.slice(1, 5).map((entry) => entry.retryDelayMs)).toEqual([
          6500, 11500, 16500, 21500
        ]);
        expect(vi.mocked(waitForModelRetry).mock.calls.map((call) => call[3])).toEqual([
          6500, 11500, 16500, 21500
        ]);
        expect(terminal[5]).toMatchObject({ attempt: 5, maxAttempts: 8, state: 'SUCCEEDED' });
        for (const body of bodies.slice(2)) {
          expect(body).not.toHaveProperty('previous_response_id');
          expect(body.input).toEqual(bodies[2]?.input);
        }
        const encoded = JSON.stringify(diagnostics);
        expect(encoded).not.toContain('private-test-bearer');
        expect(encoded).not.toContain('test-proxy-password');
        expect(encoded).not.toContain('First request.');
      } finally {
        await turn.close();
        await adapter.close();
      }
    }
  );

  it.each([
    { random: 0, maxAttempts: 8 },
    { random: 0.999999, maxAttempts: 8 },
    { random: 0, maxAttempts: 1 }
  ])(
    'stops EPIPE retries at $maxAttempts attempts with jitter boundary $random',
    async ({ random, maxAttempts }) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const target = await startResponsesWebSocketServer([]);
      servers.push(target.server);
      const adapter = new OpenAiResponsesAdapter(configuration(target.baseUrl));
      const diagnostics: ModelAttemptDiagnostic[] = [];
      vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (...args: unknown[]) {
        const callback = args.findLast(
          (value): value is (error: Error) => void => typeof value === 'function'
        );
        if (!callback) throw new Error('Send callback missing.');
        queueMicrotask(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      } as WebSocket['send']);
      try {
        await expect(
          collect(
            adapter.start(
              {
                retryState: { attempts: 0, maxAttempts },
                system: 'Test retry exhaustion.',
                messages: [{ role: 'user', content: 'Test.' }],
                tools: [],
                onAttemptDiagnostic: (diagnostic) => {
                  diagnostics.push(diagnostic);
                }
              },
              new AbortController().signal
            )
          )
        ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR' });
        const failures = diagnostics.filter((diagnostic) => diagnostic.state === 'FAILED');
        expect(failures).toHaveLength(maxAttempts);
        expect(failures.map((diagnostic) => diagnostic.attempt)).toEqual(
          Array.from({ length: maxAttempts }, (_, index) => index + 1)
        );
        expect(failures.map((diagnostic) => diagnostic.maxAttempts)).toEqual(
          Array(maxAttempts).fill(maxAttempts)
        );
        expect(failures.map((diagnostic) => diagnostic.willRetry)).toEqual(
          Array.from({ length: maxAttempts }, (_, index) => index + 1 < maxAttempts)
        );
        expect(
          failures.slice(0, maxAttempts - 1).map((diagnostic) => diagnostic.retryDelayMs)
        ).toEqual([
          ...Array.from(
            { length: maxAttempts - 1 },
            (_, index) => (index + 1) * 5000 + Math.floor(random * 3001)
          )
        ]);
        expect(new Set(failures.map((diagnostic) => diagnostic.connectionId)).size).toBe(
          maxAttempts
        );
        expect(target.connections()).toBe(maxAttempts);
      } finally {
        await adapter.close();
      }
    }
  );

  it('recovers SDK generation silence on a fresh Provider Turn despite empty text traffic', async () => {
    const server = await startResponsesWebSocketServer([], {
      closeWhenEmpty: false,
      responsesByRequest: [
        [
          { type: 'response.metadata', headers: { 'x-codex-turn-state': 'stalled-turn' } },
          ...Array.from({ length: 4 }, () => ({
            type: 'response.output_text.delta',
            item_id: 'empty',
            delta: ''
          }))
        ],
        completed('recovered', 'Recovered after generation silence')
      ],
      responseFrameDelaysByRequest: [[0, 40_000, 80_000, 120_000, 160_000]]
    });
    servers.push(server.server);
    const { home, directory } = await workspace();
    const host = new LocalAgentHost({ homeDirectory: home, workspace: directory });
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [configuration(server.baseUrl)]
    });
    try {
      const session = await agent.createSession({
        workspace: directory,
        title: 'Progress timeout'
      });
      vi.useFakeTimers({ toFake: ['Date', 'performance', 'clearTimeout', 'setTimeout'] });
      const result = session.run({ prompt: 'Continue.' }).result();
      await vi.waitFor(() => expect(server.requests).toHaveLength(1));
      for (let minute = 0; minute < 3; minute++) {
        await vi.advanceTimersByTimeAsync(60_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({
        status: 'completed',
        finalAnswer: 'Recovered after generation silence'
      });
      expect(server.requests).toHaveLength(2);
      expect(server.connections()).toBe(2);
      expect(server.closedConnections()).toBeGreaterThanOrEqual(1);
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(server.requests[1]).not.toHaveProperty('client_metadata.x-codex-turn-state');
      expect(JSON.stringify(server.requests[1])).toContain('Continue.');
      expect(waitForModelRetry).toHaveBeenCalledTimes(1);
      const store = await JsonlSessionStore.open(home);
      try {
        const attempts = (await store.read(session.id)).filter(
          (record) => record.type === 'model.attempt'
        );
        expect(attempts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              payload: expect.objectContaining({
                state: 'FAILED',
                attempt: 1,
                errorCode: 'MAR_AGENT_MODEL_TIMEOUT',
                retryable: true
              })
            }),
            expect.objectContaining({
              payload: expect.objectContaining({ state: 'SUCCEEDED', attempt: 2 })
            })
          ])
        );
      } finally {
        await store.close();
      }
    } finally {
      vi.useRealTimers();
      await agent.dispose();
    }
  });

  it.each([
    'response.metadata',
    'codex.response.metadata',
    'responsesapi.websocket_timing',
    'response.queued',
    'response.in_progress'
  ])('does not let %s postpone a WebSocket stream idle timeout', async (metadataType) => {
    vi.useFakeTimers({ toFake: ['Date', 'clearTimeout', 'setTimeout'] });
    const server = await startResponsesWebSocketServer([], {
      closeWhenEmpty: false,
      responsesByRequest: [
        Array.from({ length: 4 }, () => ({ type: metadataType })),
        completed('recovered', 'Recovered after metadata timeout')
      ],
      responseFrameDelaysByRequest: [[40_000, 80_000, 120_000, 160_000]]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    const diagnostics: ModelAttemptDiagnostic[] = [];
    const controller = new AbortController();
    const outcome = collect(
      adapter.start(
        {
          system: 'Compact this history.',
          messages: [{ role: 'user', content: 'History.' }],
          tools: [],
          promptCacheKey: 'metadata-timeout',
          onAttemptDiagnostic: (diagnostic) => {
            diagnostics.push(diagnostic);
          }
        },
        controller.signal
      )
    );
    try {
      for (let attempt = 0; server.requests.length === 0 && attempt < 100; attempt++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.requests).toHaveLength(1);
      for (let minute = 0; minute < 2; minute++) {
        await vi.advanceTimersByTimeAsync(60_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(59_999);
      expect(server.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(server.requests).toHaveLength(2));
      await expect(outcome).resolves.toContainEqual(
        expect.objectContaining({
          type: 'text.completed',
          text: 'Recovered after metadata timeout'
        })
      );
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: 'FAILED',
            attempt: 1,
            willRetry: true,
            errorCode: 'MAR_AGENT_MODEL_TIMEOUT'
          }),
          expect.objectContaining({ state: 'SUCCEEDED', attempt: 2 })
        ])
      );
    } finally {
      controller.abort();
      await outcome.catch(() => undefined);
      vi.useRealTimers();
      await adapter.close();
    }
  });
});
