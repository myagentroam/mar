import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalAgentHost,
  SecretValue,
  type HostSessionResourceSnapshot,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import {
  OpenAiResponsesAdapter,
  openAiInput
} from '../../src/agent-core/model/openai-responses.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage
} from '../../src/agent-core/model/contracts.js';
import {
  startResponsesWebSocketServer,
  type CloseableServer
} from './support/responses-transport-servers.js';

const servers: CloseableServer[] = [];
const homes: string[] = [];

class ChangingResourceHost extends LocalAgentHost {
  #reads = 0;

  override async listSessionResources(): Promise<HostSessionResourceSnapshot> {
    const read = this.#reads++;
    if (read === 0 || read >= 3) return { processes: [] };
    return {
      processes: [
        {
          processId: 'ws-retained-process',
          status: 'running',
          command: 'long-running-ws-validation',
          cwd: '/workspace'
        }
      ]
    };
  }
}

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
  credentialProvider: MarAgentModelConfiguration['credentialProvider'],
  transport: MarAgentModelConfiguration['responsesTransport'] = { transport: 'WEBSOCKET' }
): MarAgentModelConfiguration {
  return {
    id: 'codex',
    name: 'Codex',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    credentialProvider,
    modelId: 'gpt-codex',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    hostedWebSearch: false,
    responsesTransport: transport,
    responsesPreviousResponseId: true,
    enabled: true
  };
}

function provider(revisionForCall: (call: number) => number = () => 1) {
  let calls = 0;
  return {
    acquire: vi.fn(async () => {
      const revision = revisionForCall(++calls);
      return {
        revision,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue(`token-${revision}`),
        headers: {}
      };
    }),
    invalidate: vi.fn(),
    close: vi.fn(async () => undefined)
  };
}

function messageItem(responseId: string, text: string) {
  return {
    type: 'message',
    id: `${responseId}-message`,
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text }]
  };
}

function completedResponse(responseId: string, text: string) {
  const item = messageItem(responseId, text);
  return {
    item,
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

function messagesAfterResponse(
  user: string,
  responseId: string,
  answer: string,
  nextUser: string
): ModelMessage[] {
  return [
    { role: 'user', content: user },
    {
      role: 'provider',
      provider: 'OPENAI_RESPONSES',
      providerModelId: 'codex',
      content: '',
      item: messageItem(responseId, answer)
    },
    { role: 'assistant', content: answer },
    { role: 'user', content: nextUser }
  ];
}

function contextualInstruction(content: string, revision = '1'): ModelMessage {
  return {
    role: 'user',
    content,
    contextKind: 'contextual',
    contextualBlock: {
      id: 'host-instruction',
      kind: 'host-policy',
      source: 'host',
      authority: 'instruction',
      revision,
      operation: 'replace'
    }
  };
}

async function collect(source: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

describe('OpenAI Responses turn sessions', () => {
  it('preserves a GPT-6 request effort across changes, replay, and Compact', async () => {
    const responses = Array.from({ length: 8 }, (_, index) =>
      completedResponse(`response-effort-${index}`, `Answer ${index}`)
    );
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses.map(({ events }) => events)
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-effort-update-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const model = {
      ...configuration(server.baseUrl, provider()),
      responsesConfigurationUpdates: true,
      modelId: 'gpt-6-sol',
      reasoningEfforts: ['high', 'low'] as const,
      defaultReasoningEffort: 'high' as const
    };
    let agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [{ ...model, reasoningEfforts: [...model.reasoningEfforts] }]
    });
    const session = await agent.createSession({ workspace, title: 'Effort updates' });
    try {
      for (const [index, effort] of (['high', 'low', 'low', 'high'] as const).entries())
        await expect(
          session.run({ prompt: `Prompt ${index}`, reasoningEffort: effort }).result()
        ).resolves.toMatchObject({ status: 'completed', finalAnswer: `Answer ${index}` });
      const expectedUpdate = (effort: 'high' | 'low') => ({
        type: 'configuration_update',
        reasoning: { effort }
      });
      expect(server.requests.map((request) => request.reasoning?.effort)).toEqual([
        'high',
        'high',
        'high',
        'high'
      ]);
      expect(server.requests[1]?.previous_response_id).toBe('response-effort-0');
      expect(server.requests[1]?.input).toContainEqual(expectedUpdate('low'));
      const updateIndex = server.requests[1]!.input.findIndex(
        (item: { type?: string }) => item.type === 'configuration_update'
      );
      const userIndex = server.requests[1]!.input.findIndex((item: unknown) =>
        JSON.stringify(item).includes('Prompt 1')
      );
      expect(updateIndex).toBeGreaterThanOrEqual(0);
      expect(userIndex).toBeGreaterThan(updateIndex);
      expect(server.requests[2]?.previous_response_id).toBe('response-effort-1');
      expect(server.requests[2]?.input).not.toContainEqual(expectedUpdate('low'));
      expect(server.requests[3]?.input).toContainEqual(expectedUpdate('high'));
      await agent.dispose();
      agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [{ ...model, reasoningEfforts: [...model.reasoningEfforts] }]
      });
      const restored = await agent.openSession(session.id);
      for (const index of [4, 5])
        await expect(
          restored.run({ prompt: `Restored ${index}`, reasoningEffort: 'low' }).result()
        ).resolves.toMatchObject({ status: 'completed', finalAnswer: `Answer ${index}` });
      expect(server.requests[4]?.reasoning?.effort).toBe('high');
      expect(
        server.requests[4]?.input.filter(
          (item: { type?: string }) => item.type === 'configuration_update'
        )
      ).toEqual([expectedUpdate('low'), expectedUpdate('high'), expectedUpdate('low')]);
      expect(server.requests[5]?.reasoning?.effort).toBe('high');
      expect(server.requests[5]?.input).not.toContainEqual(expectedUpdate('low'));
      await expect(restored.compact().result()).resolves.toMatchObject({ status: 'completed' });
      expect(server.requests[6]?.reasoning?.effort).toBe('high');
      expect(JSON.stringify(server.requests[6]?.input)).toContain('configuration_update');
      await expect(
        restored.run({ prompt: 'After compact', reasoningEffort: 'low' }).result()
      ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'Answer 7' });
      expect(server.requests[7]?.reasoning?.effort).toBe('low');
      expect(JSON.stringify(server.requests[7]?.input)).not.toContain('configuration_update');
    } finally {
      await agent.dispose();
    }
    const store = await JsonlSessionStore.open(home);
    try {
      const records = await store.read(session.id);
      const updates = records.filter(
        (record) =>
          record.type === 'model.context' &&
          (record.payload as ModelMessage).item?.type === 'configuration_update'
      );
      expect(updates.map((record) => record.payload)).toEqual(
        ['low', 'high', 'low'].map((effort) => ({
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          providerModelId: model.id,
          item: { type: 'configuration_update', reasoning: { effort } }
        }))
      );
      for (const update of updates) {
        const user = records.find(
          (record) => record.type === 'turn.user' && record.turnId === update.turnId
        )!;
        const header = records.find(
          (record) =>
            record.type === 'execution.header' && record.executionId === update.executionId
        )!;
        expect(update.sequence).toBeGreaterThan(user.sequence);
        expect(update.sequence).toBeLessThan(header.sequence);
      }
    } finally {
      await store.close();
    }
  });

  it('replays the effort update before the user without previous_response_id', async () => {
    const responses = [
      completedResponse('effort-full-1', 'First'),
      completedResponse('effort-full-2', 'Second')
    ];
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses.map(({ events }) => events)
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-effort-full-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const model = {
      ...configuration(server.baseUrl, provider()),
      responsesConfigurationUpdates: true,
      modelId: 'gpt-6-sol',
      responsesPreviousResponseId: false,
      reasoningEfforts: ['high', 'low'] as ('high' | 'low')[]
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model]
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Full effort replay' });
      await expect(
        session.run({ prompt: 'First user', reasoningEffort: 'high' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      await expect(
        session.run({ prompt: 'Second user', reasoningEffort: 'low' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(server.requests[1]?.reasoning?.effort).toBe('high');
      const input = server.requests[1]!.input;
      const updateIndex = input.findIndex(
        (item: { type?: string }) => item.type === 'configuration_update'
      );
      expect(updateIndex).toBeGreaterThan(0);
      expect(
        input.findIndex((item: unknown) => JSON.stringify(item).includes('Second user'))
      ).toBeGreaterThan(updateIndex);
      expect(input.some((item: unknown) => JSON.stringify(item).includes('First user'))).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('keeps effort changes on request parameters without a Codex credential', async () => {
    const responses = [
      completedResponse('effort-api-0', 'First'),
      completedResponse('effort-api-1', 'Second')
    ];
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses.map(({ events }) => events)
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-effort-api-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [{ ...configuration(server.baseUrl, provider()), modelId: 'gpt-6-sol' }]
    });
    try {
      const session = await agent.createSession({ workspace, title: 'API effort' });
      for (const effort of ['high', 'low'] as const)
        await expect(
          session.run({ prompt: 'Continue', reasoningEffort: effort }).result()
        ).resolves.toMatchObject({ status: 'completed' });
      expect(server.requests.map((request) => request.reasoning?.effort)).toEqual(['high', 'low']);
      expect(JSON.stringify(server.requests[1]?.input)).not.toContain('configuration_update');
    } finally {
      await agent.dispose();
    }
  });

  it('uses request effort and drops persisted configuration updates when unsupported', async () => {
    const modelId = 'gpt-6-sol';
    const input = openAiInput(
      [
        { role: 'user', content: 'Earlier prompt' },
        {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'codex',
          item: { type: 'configuration_update', reasoning: { effort: 'high' } }
        },
        { role: 'user', content: 'Continue' }
      ],
      undefined,
      'codex',
      true,
      false
    );
    expect(JSON.stringify(input)).not.toContain('configuration_update');

    const responses = [
      completedResponse('effort-shared-0', 'First'),
      completedResponse('effort-shared-1', 'Second')
    ];
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses.map(({ events }) => events)
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-effort-shared-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [
        {
          ...configuration(server.baseUrl, provider()),
          modelId,
          responsesConfigurationUpdates: false
        }
      ]
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Shared plan effort' });
      for (const effort of ['high', 'low'] as const)
        await expect(
          session.run({ prompt: 'Continue', reasoningEffort: effort }).result()
        ).resolves.toMatchObject({ status: 'completed' });
      expect(server.requests.map((request) => request.reasoning?.effort)).toEqual(['high', 'low']);
      expect(JSON.stringify(server.requests)).not.toContain('configuration_update');
    } finally {
      await agent.dispose();
    }
  });

  it('starts a fresh effort baseline when switching away and back to a Codex credential', async () => {
    const responses = Array.from({ length: 5 }, (_, index) =>
      completedResponse(`effort-switch-${index}`, `Answer ${index}`)
    );
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses.map(({ events }) => events)
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-effort-switch-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const base = {
      ...configuration(server.baseUrl, provider()),
      responsesConfigurationUpdates: true
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [
        { ...base, id: 'model-six', modelId: 'gpt-6-sol' },
        { ...base, id: 'model-five', modelId: 'gpt-5.6-sol' }
      ]
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Switch effort' });
      for (const [modelId, effort] of [
        ['model-six', 'high'],
        ['model-six', 'low'],
        ['model-five', 'low'],
        ['model-five', 'high'],
        ['model-six', 'low']
      ] as const) {
        await expect(
          session.run({ prompt: 'Continue', modelId, reasoningEffort: effort }).result()
        ).resolves.toMatchObject({ status: 'completed' });
      }
      expect(server.requests.map((request) => request.reasoning?.effort)).toEqual([
        'high',
        'high',
        'low',
        'low',
        'low'
      ]);
      expect(
        server.requests[3]!.input.filter(
          (item: { type?: string }) => item.type === 'configuration_update'
        )
      ).toHaveLength(1);
      expect(
        server.requests[4]!.input.filter(
          (item: { type?: string }) => item.type === 'configuration_update'
        )
      ).toHaveLength(1);
    } finally {
      await agent.dispose();
    }
  });

  it('continues append-only world-state patches over one WebSocket connection', async () => {
    const responses = Array.from({ length: 4 }, (_, index) =>
      completedResponse(`response-${index + 1}`, `Answer ${index + 1}`)
    );
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses.map(({ events }) => events)
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-world-state-ws-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new ChangingResourceHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider())]
    });

    try {
      const session = await agent.createSession({ workspace, title: 'World-state WebSocket' });
      for (let index = 0; index < responses.length; index++)
        await expect(
          session.run({ prompt: `Prompt ${index + 1}` }).result()
        ).resolves.toMatchObject({
          status: 'completed',
          finalAnswer: `Answer ${index + 1}`
        });

      expect(server.connections()).toBe(1);
      expect(server.requests).toHaveLength(4);
      expect(server.requests[0]).not.toHaveProperty('previous_response_id');
      expect(server.requests[1]).toMatchObject({ previous_response_id: 'response-1' });
      expect(JSON.stringify(server.requests[1]?.input)).not.toContain(
        'processId: ws-retained-process'
      );
      expect(JSON.stringify(server.requests[1]?.input)).toContain('Prompt 2');
      expect(server.requests[2]).toMatchObject({
        previous_response_id: 'response-2',
        input: [{ role: 'user', content: 'Prompt 3' }]
      });
      expect(server.requests[3]).toMatchObject({ previous_response_id: 'response-3' });
      expect(JSON.stringify(server.requests[3]?.input)).not.toContain(
        'previously provided retained Session resources no longer apply'
      );
      expect(JSON.stringify(server.requests[3]?.input)).toContain('Prompt 4');
    } finally {
      await agent.dispose();
    }
  });

  it('reuses one default SDK WebSocket across five executions with an 80% connection cache hit rate', async () => {
    const executions = Array.from({ length: 5 }, (_, index) => ({
      prompt: `Prompt ${index + 1}`,
      response: completedResponse(`response-${index + 1}`, `Answer ${index + 1}`)
    }));
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: executions.map(({ response }, index) => [
        ...(index < executions.length - 1
          ? [
              {
                type: 'response.metadata',
                headers: { 'x-codex-turn-state': `turn-state-${index + 1}` }
              }
            ]
          : []),
        ...response.events
      ])
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-turn-session-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider())]
    });

    try {
      const session = await agent.createSession({ workspace, title: 'Turn session' });
      for (const { prompt, response } of executions)
        await expect(session.run({ prompt }).result()).resolves.toMatchObject({
          status: 'completed',
          finalAnswer: response.item.content[0]?.text
        });

      expect(server.connections()).toBe(1);
      expect(server.requests).toHaveLength(executions.length);
      expect((server.requests.length - server.connections()) / server.requests.length).toBe(0.8);
      for (const [index, request] of server.requests.entries()) {
        expect(request).not.toHaveProperty('client_metadata.x-codex-turn-state');
        if (index === 0) {
          expect(request).not.toHaveProperty('previous_response_id');
          continue;
        }
        expect(request).toMatchObject({
          previous_response_id: `response-${index}`,
          input: [{ role: 'user', content: `Prompt ${index + 1}` }]
        });
      }
    } finally {
      await agent.dispose();
    }
  });

  it('preserves the WebSocket continuation when dynamic credentials are rebound', async () => {
    const first = completedResponse('response-1', 'First');
    const second = completedResponse('response-2', 'Second');
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [first.events, second.events]
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-rebound-credentials-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const firstProvider = provider();
    const secondProvider = provider();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, firstProvider)]
    });

    try {
      const session = await agent.createSession({ workspace, title: 'Rebound credentials' });
      await expect(session.run({ prompt: 'First' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'First'
      });
      await agent.reconfigureModels({
        models: [configuration(server.baseUrl, secondProvider)],
        defaultModelId: 'codex'
      });
      await expect(session.run({ prompt: 'Second' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Second'
      });

      expect(server.connections()).toBe(1);
      expect(server.requests[1]).toMatchObject({
        previous_response_id: 'response-1',
        input: [{ role: 'user', content: 'Second' }]
      });
      expect(firstProvider.acquire).toHaveBeenCalled();
      expect(secondProvider.acquire).toHaveBeenCalled();
      expect(firstProvider.close).toHaveBeenCalledOnce();
      expect(secondProvider.close).not.toHaveBeenCalled();
    } finally {
      await agent.dispose();
    }
  });

  it('does not restore a persisted continuation across Compact replacement', async () => {
    const first = completedResponse('response-1', 'First');
    const compact = completedResponse('response-compact', 'Current task remains active.');
    const second = completedResponse('response-2', 'Second');
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [first.events, compact.events, second.events]
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-compact-reset-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    let agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider())]
    });
    const session = await agent.createSession({ workspace, title: 'Compact reset' });

    try {
      await expect(session.run({ prompt: 'First' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'First'
      });
      await expect(session.compact().result()).resolves.toMatchObject({ status: 'completed' });
      await agent.dispose();
      agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [configuration(server.baseUrl, provider())]
      });
      const restored = await agent.openSession(session.id);
      await expect(restored.run({ prompt: 'Second' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Second'
      });

      expect(server.requests).toHaveLength(3);
      expect(server.requests[2]).not.toHaveProperty('previous_response_id');
    } finally {
      await agent.dispose();
    }
  });

  it('caches a stateful custom adapter across executions and closes it once on deletion', async () => {
    const responses = Array.from({ length: 3 }, (_, index) =>
      completedResponse(`response-${index + 1}`, `Answer ${index + 1}`)
    );
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses.map(({ events }) => events)
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-stateful-factory-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    class CountingResponsesAdapter extends OpenAiResponsesAdapter {
      closeCalls = 0;

      override async close(): Promise<void> {
        this.closeCalls++;
        await super.close();
      }
    }
    const adapters: CountingResponsesAdapter[] = [];
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider())],
      adapterFactory: (modelConfiguration) => {
        const adapter = new CountingResponsesAdapter(modelConfiguration);
        adapters.push(adapter);
        return adapter;
      }
    });
    let disposed = false;

    try {
      const session = await agent.createSession({ workspace, title: 'Stateful factory' });
      for (let index = 0; index < responses.length; index++)
        await expect(
          session.run({ prompt: `Prompt ${index + 1}` }).result()
        ).resolves.toMatchObject({
          status: 'completed',
          finalAnswer: `Answer ${index + 1}`
        });

      expect(adapters).toHaveLength(1);
      expect(server.connections()).toBe(1);
      await agent.deleteSession(session.id);
      expect(adapters[0]?.closeCalls).toBe(1);
      await agent.dispose();
      disposed = true;
      expect(adapters[0]?.closeCalls).toBe(1);
    } finally {
      if (!disposed) await agent.dispose();
    }
  });

  it('keeps a stateless custom adapter factory execution-scoped', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-stateless-factory-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    let factoryCalls = 0;
    const closeCalls: Array<ReturnType<typeof vi.fn>> = [];
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration('http://127.0.0.1:1', provider())],
      adapterFactory: (modelConfiguration): ModelAdapter => {
        const adapterNumber = ++factoryCalls;
        const close = vi.fn(async () => undefined);
        closeCalls.push(close);
        return {
          configuration: modelConfiguration,
          async *start() {
            yield {
              type: 'text.completed',
              itemId: `answer-${adapterNumber}`,
              text: `Answer ${adapterNumber}`
            };
            yield { type: 'completed', reason: 'completed' };
          },
          close
        };
      }
    });

    try {
      const session = await agent.createSession({ workspace, title: 'Stateless factory' });
      for (let index = 1; index <= 3; index++)
        await expect(session.run({ prompt: `Prompt ${index}` }).result()).resolves.toMatchObject({
          status: 'completed',
          finalAnswer: `Answer ${index}`
        });
      expect(factoryCalls).toBe(3);
      expect(closeCalls).toHaveLength(3);
      for (const close of closeCalls) expect(close).toHaveBeenCalledOnce();
    } finally {
      await agent.dispose();
    }
  });

  it('creates only the stateless execution adapter and closes it once', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-title-adapter-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const closeCalls: Array<ReturnType<typeof vi.fn>> = [];
    let factoryCalls = 0;
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration('http://127.0.0.1:1', provider())],
      adapterFactory: (modelConfiguration): ModelAdapter => {
        const adapterNumber = ++factoryCalls;
        const close = vi.fn(async () => undefined);
        closeCalls.push(close);
        return {
          configuration: modelConfiguration,
          async *start() {
            yield {
              type: 'text.completed',
              itemId: `answer-${adapterNumber}`,
              text: 'Execution answer'
            };
            yield { type: 'completed', reason: 'completed' };
          },
          close
        };
      }
    });

    try {
      const session = await agent.createSession({ workspace });
      await expect(session.run({ prompt: 'Answer the request' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Execution answer'
      });
      expect(factoryCalls).toBe(1);
      expect(closeCalls).toHaveLength(1);
      for (const close of closeCalls) expect(close).toHaveBeenCalledOnce();
    } finally {
      await agent.dispose();
    }
  });

  it('replays full history after a completed WebSocket closes between executions', async () => {
    const first = completedResponse('response-1', 'First');
    const second = completedResponse('response-2', 'Second');
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [first.events, second.events],
      closeAfterRequestIndexes: [0]
    });
    servers.push(server.server);
    const home = await mkdtemp(join(tmpdir(), 'mar-responses-closed-between-turns-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [configuration(server.baseUrl, provider())]
    });

    try {
      const session = await agent.createSession({ workspace, title: 'Closed connection' });
      await expect(session.run({ prompt: 'First' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'First'
      });
      await expect.poll(server.closedConnections).toBe(1);
      await expect(session.run({ prompt: 'Second' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'Second'
      });

      expect(server.connections()).toBe(2);
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify(server.requests[1]?.input)).toContain('First');
      expect(JSON.stringify(server.requests[1]?.input)).toContain('Second');
    } finally {
      await agent.dispose();
    }
  });

  it('reuses the physical WebSocket across turns while resetting sticky turn state', async () => {
    const first = completedResponse('response-1', 'First');
    const second = completedResponse('response-2', 'Second');
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        [
          {
            type: 'response.metadata',
            headers: { 'x-codex-turn-state': 'turn-state-1' }
          },
          ...first.events
        ],
        second.events
      ]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, provider()));
    const firstTurn = adapter.createTurnSession();

    try {
      await collect(
        firstTurn.start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'First' }],
            tools: [],
            promptCacheKey: 'session-cache-key'
          },
          new AbortController().signal
        )
      );
      await firstTurn.close();

      const secondTurn = adapter.createTurnSession();
      try {
        await collect(
          secondTurn.start(
            {
              system: 'Reply.',
              messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
              tools: [],
              promptCacheKey: 'session-cache-key'
            },
            new AbortController().signal
          )
        );
      } finally {
        await secondTurn.close();
      }

      expect(server.connections()).toBe(1);
      expect(server.handshakes).toHaveLength(1);
      expect(server.handshakes[0]?.['x-client-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(server.handshakes[0]?.['session-id']).toBe('session-cache-key');
      expect(server.handshakes[0]?.['thread-id']).toBe('session-cache-key');
      expect(server.requests).toHaveLength(2);
      for (const request of server.requests)
        expect(request).toHaveProperty('prompt_cache_key', 'session-cache-key');
      expect(server.requests[1]).toMatchObject({
        previous_response_id: 'response-1',
        input: [{ role: 'user', content: 'Second' }]
      });
      expect(server.requests[1]).not.toHaveProperty('client_metadata.x-codex-turn-state');
    } finally {
      await firstTurn.close();
      await adapter.close();
    }
  });

  it.each([
    ['missing', undefined],
    ['different', 'response-created']
  ])(
    'uses the terminal Response ID when the created Response ID is %s',
    async (_label, createdResponseId) => {
      const first = completedResponse('response-1', 'First');
      first.events[0] = {
        type: 'response.created',
        response: createdResponseId === undefined ? {} : { id: createdResponseId }
      };
      const second = completedResponse('response-2', 'Second');
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [first.events, second.events]
      });
      servers.push(server.server);
      const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, provider()));
      const turn = adapter.createTurnSession();

      try {
        await collect(
          turn.start(
            {
              system: 'Reply.',
              messages: [{ role: 'user', content: 'First' }],
              tools: []
            },
            new AbortController().signal
          )
        );
        await collect(
          turn.start(
            {
              system: 'Reply.',
              messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
              tools: []
            },
            new AbortController().signal
          )
        );

        expect(server.connections()).toBe(1);
        expect(server.requests[1]).toMatchObject({
          previous_response_id: 'response-1',
          input: [{ role: 'user', content: 'Second' }]
        });
      } finally {
        await turn.close();
        await adapter.close();
      }
    }
  );

  it.each([
    ['missing', undefined],
    ['malformed', 42]
  ])('replays full history when all Response IDs are %s', async (_label, terminalId) => {
    const first = completedResponse('response-1', 'First');
    first.events[0] = { type: 'response.created', response: {} };
    first.events[2] = {
      type: 'response.completed',
      response: {
        ...(terminalId === undefined ? {} : { id: terminalId }),
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: {}
        }
      }
    };
    const second = completedResponse('response-2', 'Second');
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [first.events, second.events]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, provider()));
    const turn = adapter.createTurnSession();

    try {
      await collect(
        turn.start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'First' }],
            tools: []
          },
          new AbortController().signal
        )
      );
      await collect(
        turn.start(
          {
            system: 'Reply.',
            messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
            tools: []
          },
          new AbortController().signal
        )
      );

      expect(server.connections()).toBe(1);
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify(server.requests[1]?.input)).toContain('First');
      expect(JSON.stringify(server.requests[1]?.input)).toContain('Second');
    } finally {
      await turn.close();
      await adapter.close();
    }
  });

  it.each(['default', 'priority', 'ultrafast'] as const)(
    'sends standard service tier %s on every WebSocket continuation and replays after a change',
    async (serviceTier) => {
      const responses = [
        completedResponse('response-1', 'First'),
        completedResponse('response-2', 'Second'),
        completedResponse('response-3', 'Third')
      ];
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: responses.map(({ events }) => events)
      });
      servers.push(server.server);
      const model = { ...configuration(server.baseUrl, provider()), serviceTier };
      const adapter = new OpenAiResponsesAdapter(model);
      const turn = adapter.createTurnSession();
      try {
        await collect(
          turn.start(
            { system: 'system', messages: [{ role: 'user', content: 'First' }], tools: [] },
            new AbortController().signal
          )
        );
        await collect(
          turn.start(
            {
              system: 'system',
              messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
              tools: []
            },
            new AbortController().signal
          )
        );
        expect(server.requests[0]).toMatchObject({ service_tier: serviceTier });
        expect(server.requests[1]).toMatchObject({
          service_tier: serviceTier,
          previous_response_id: 'response-1'
        });
        model.serviceTier = serviceTier === 'default' ? 'ultrafast' : 'default';
        await collect(
          turn.start(
            {
              system: 'system',
              messages: messagesAfterResponse('First', 'response-1', 'First', 'Third'),
              tools: []
            },
            new AbortController().signal
          )
        );
        expect(server.requests[2]).toMatchObject({ service_tier: model.serviceTier });
        expect(server.requests[2]).not.toHaveProperty('previous_response_id');
        expect(JSON.stringify(server.requests[2]?.input)).toContain('First');
      } finally {
        await turn.close();
        await adapter.close();
      }
    }
  );

  it('replays full input on the same WebSocket when continuation properties change', async () => {
    const first = completedResponse('response-1', 'First');
    const second = completedResponse('response-2', 'Second');
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [first.events, second.events]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, provider()));
    const turn = adapter.createTurnSession();

    try {
      await collect(
        turn.start(
          {
            system: 'First instructions.',
            messages: [{ role: 'user', content: 'First' }],
            tools: []
          },
          new AbortController().signal
        )
      );
      await collect(
        turn.start(
          {
            system: 'Changed instructions.',
            messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
            tools: []
          },
          new AbortController().signal
        )
      );

      expect(server.connections()).toBe(1);
      expect(server.requests[1]).not.toHaveProperty('instructions');
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(server.requests[1]?.input[0]).toEqual({
        role: 'developer',
        content: [{ type: 'input_text', text: 'Changed instructions.' }]
      });
      expect(JSON.stringify(server.requests[1]?.input)).toContain('First');
      expect(JSON.stringify(server.requests[1]?.input)).toContain('Second');
    } finally {
      await turn.close();
      await adapter.close();
    }
  });

  it('continues unchanged contextual instructions, appends dynamic blocks, and fully replays changed core on the healthy WebSocket', async () => {
    const responses = [
      completedResponse('context-1', 'Answer 1'),
      completedResponse('context-2', 'Answer 2'),
      completedResponse('context-3', 'Answer 3'),
      completedResponse('context-4', 'Answer 4')
    ];
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: responses.map(({ events }) => events)
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, provider()));
    const turn = adapter.createTurnSession();
    const firstInstruction = contextualInstruction('Keep policy A.');
    const appendedInstruction = contextualInstruction('New policy B.');

    const firstMessages: ModelMessage[] = [firstInstruction, { role: 'user', content: 'First' }];
    const secondMessages: ModelMessage[] = [
      firstInstruction,
      ...messagesAfterResponse('First', 'context-1', 'Answer 1', 'Second')
    ];
    const thirdMessages: ModelMessage[] = [
      ...secondMessages,
      {
        role: 'provider',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'codex',
        content: '',
        item: messageItem('context-2', 'Answer 2')
      },
      { role: 'assistant', content: 'Answer 2' },
      appendedInstruction,
      { role: 'user', content: 'Third' }
    ];
    const fourthMessages: ModelMessage[] = [
      contextualInstruction('Keep policy A, revised.', '2'),
      ...thirdMessages.slice(1),
      {
        role: 'provider',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'codex',
        content: '',
        item: messageItem('context-3', 'Answer 3')
      },
      { role: 'assistant', content: 'Answer 3' },
      { role: 'user', content: 'Fourth' }
    ];

    try {
      for (const messages of [firstMessages, secondMessages, thirdMessages, fourthMessages]) {
        if (messages === fourthMessages) turn.resetContinuation();
        await collect(
          turn.start(
            { system: 'Stable SDK system.', messages, tools: [] },
            new AbortController().signal
          )
        );
      }

      expect(server.connections()).toBe(1);
      expect(server.requests[0]).not.toHaveProperty('instructions');
      expect(server.requests[1]).toMatchObject({
        previous_response_id: 'context-1',
        input: [{ role: 'user', content: 'Second' }]
      });
      expect(server.requests[2]).toMatchObject({
        previous_response_id: 'context-2',
        input: [
          { role: 'developer', content: 'New policy B.' },
          { role: 'user', content: 'Third' }
        ]
      });
      expect(server.requests[3]).not.toHaveProperty('previous_response_id');
      expect(server.requests[3]?.input).toEqual([
        {
          role: 'developer',
          content: [{ type: 'input_text', text: 'Stable SDK system.' }]
        },
        { role: 'developer', content: 'Keep policy A, revised.' },
        { role: 'user', content: 'First' },
        messageItem('context-1', 'Answer 1'),
        { role: 'user', content: 'Second' },
        messageItem('context-2', 'Answer 2'),
        { role: 'developer', content: 'New policy B.' },
        { role: 'user', content: 'Third' },
        messageItem('context-3', 'Answer 3'),
        { role: 'user', content: 'Fourth' }
      ]);
    } finally {
      await turn.close();
      await adapter.close();
    }
  });

  it.each(['STANDARD'] as const)(
    'replays full %s input when compaction disables tools',
    async (_responsesEncoding) => {
      const first = completedResponse('response-1', 'First');
      const second = completedResponse('response-2', 'Compacted');
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [first.events, second.events]
      });
      servers.push(server.server);
      const adapter = new OpenAiResponsesAdapter({
        ...configuration(server.baseUrl, provider())
      });
      const turn = adapter.createTurnSession();
      const tools = [
        {
          name: 'read',
          description: 'Read a file.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ];

      try {
        await collect(
          turn.start(
            {
              system: 'Stable instructions.',
              messages: [{ role: 'user', content: 'First' }],
              tools
            },
            new AbortController().signal
          )
        );
        await collect(
          turn.start(
            {
              system: 'Stable instructions.',
              messages: messagesAfterResponse(
                'First',
                'response-1',
                'First',
                'Create a compact handoff.'
              ),
              tools,
              toolChoice: 'none'
            },
            new AbortController().signal
          )
        );

        expect(server.requests[1]).toMatchObject({ tool_choice: 'none' });
        expect(server.requests[1]).not.toHaveProperty('previous_response_id');
        expect(JSON.stringify(server.requests[1]?.input)).toContain('First');
        expect(JSON.stringify(server.requests[1]?.input)).toContain('Create a compact handoff.');
      } finally {
        await turn.close();
        await adapter.close();
      }
    }
  );

  it('keeps Responses continuation only in memory and replays full input after Adapter recreation', async () => {
    const first = completedResponse('response-1', 'First');
    const second = completedResponse('response-2', 'Second');
    const third = completedResponse('response-3', 'After recreation');
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [first.events, second.events, third.events]
    });
    servers.push(server.server);
    const responsesConfiguration = {
      ...configuration(server.baseUrl, provider())
    };
    const adapter = new OpenAiResponsesAdapter(responsesConfiguration);
    const turn = adapter.createTurnSession();
    try {
      await collect(
        turn.start(
          {
            system: 'Instructions.',
            messages: [{ role: 'user', content: 'First' }],
            tools: []
          },
          new AbortController().signal
        )
      );
      await collect(
        turn.start(
          {
            system: 'Instructions.',
            messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
            tools: []
          },
          new AbortController().signal
        )
      );
      expect(server.requests[1]).toMatchObject({
        previous_response_id: 'response-1'
      });
    } finally {
      await turn.close();
      await adapter.close();
    }

    const restoredAdapter = new OpenAiResponsesAdapter(responsesConfiguration);
    const restoredTurn = restoredAdapter.createTurnSession();
    try {
      await collect(
        restoredTurn.start(
          {
            system: 'Instructions.',
            messages: messagesAfterResponse('First', 'response-1', 'First', 'After recreation'),
            tools: []
          },
          new AbortController().signal
        )
      );
      expect(server.requests[2]).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify(server.requests[2]?.input)).toContain('First');
      expect(JSON.stringify(server.requests[2]?.input)).toContain('After recreation');
    } finally {
      await restoredTurn.close();
      await restoredAdapter.close();
    }
  });

  it.each(['STANDARD'] as const)(
    'resets the internal continuation without closing the %s WebSocket',
    async (_responsesEncoding) => {
      const first = completedResponse('response-1', 'First');
      const second = completedResponse('response-2', 'Second');
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [first.events, second.events]
      });
      servers.push(server.server);
      const adapter = new OpenAiResponsesAdapter({
        ...configuration(server.baseUrl, provider())
      });
      const turn = adapter.createTurnSession();
      try {
        await collect(
          turn.start(
            {
              system: 'Instructions.',
              messages: [{ role: 'user', content: 'First' }],
              tools: []
            },
            new AbortController().signal
          )
        );
        expect(turn.resetContinuation).toBeTypeOf('function');
        turn.resetContinuation?.();
        await collect(
          turn.start(
            {
              system: 'Instructions.',
              messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
              tools: []
            },
            new AbortController().signal
          )
        );
        expect(server.connections()).toBe(1);
        expect(server.requests[1]).not.toHaveProperty('previous_response_id');
        expect(JSON.stringify(server.requests[1]?.input)).toContain('First');
      } finally {
        await turn.close();
        await adapter.close();
      }
    }
  );

  it('drops a failed WebSocket and sends the next turn as full history', async () => {
    const first = completedResponse('response-1', 'First');
    const third = completedResponse('response-3', 'Recovered');
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        first.events,
        [
          {
            type: 'response.failed',
            response: {
              error: {
                code: 'invalid_prompt',
                message: 'Synthetic terminal failure'
              }
            }
          }
        ],
        third.events
      ]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, provider()));
    const firstTurn = adapter.createTurnSession();

    try {
      await collect(
        firstTurn.start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'First' }],
            tools: []
          },
          new AbortController().signal
        )
      );
      await firstTurn.close();

      const failedTurn = adapter.createTurnSession();
      const failedMessages = messagesAfterResponse('First', 'response-1', 'First', 'Second');
      try {
        await expect(
          collect(
            failedTurn.start(
              {
                system: 'Reply.',
                messages: failedMessages,
                tools: []
              },
              new AbortController().signal
            )
          )
        ).rejects.toMatchObject({ code: 'invalid_prompt' });
      } finally {
        await failedTurn.close();
      }

      const recoveredTurn = adapter.createTurnSession();
      try {
        await collect(
          recoveredTurn.start(
            {
              system: 'Reply.',
              messages: [...failedMessages, { role: 'user', content: 'Third' }],
              tools: []
            },
            new AbortController().signal
          )
        );
      } finally {
        await recoveredTurn.close();
      }

      expect(server.connections()).toBe(2);
      expect(server.requests[1]).toHaveProperty('previous_response_id', 'response-1');
      expect(server.requests[2]).not.toHaveProperty('previous_response_id');
      expect(server.requests[2]).toMatchObject({
        input: expect.arrayContaining([
          { role: 'user', content: 'First' },
          { role: 'user', content: 'Second' },
          { role: 'user', content: 'Third' }
        ])
      });
    } finally {
      await firstTurn.close();
      await adapter.close();
    }
  });

  it('replays full history when the credential revision changes the WebSocket', async () => {
    const first = completedResponse('response-1', 'First');
    const second = completedResponse('response-2', 'Second');
    const credentials = provider((call) => (call <= 2 ? 1 : 2));
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [first.events, second.events]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl, credentials));
    const firstTurn = adapter.createTurnSession();

    try {
      await collect(
        firstTurn.start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'First' }],
            tools: []
          },
          new AbortController().signal
        )
      );
      await firstTurn.close();

      const secondTurn = adapter.createTurnSession();
      try {
        await collect(
          secondTurn.start(
            {
              retryState: { attempts: 0, maxAttempts: 1 },
              system: 'Reply.',
              messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
              tools: []
            },
            new AbortController().signal
          )
        );
      } finally {
        await secondTurn.close();
      }

      expect(server.connections()).toBe(2);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify(server.requests[1]?.input)).toContain('First');
      expect(JSON.stringify(server.requests[1]?.input)).toContain('Second');
      expect(credentials.acquire.mock.calls.map(([reason]) => reason)).toEqual([
        'REQUEST',
        'REQUEST',
        'REQUEST',
        'RECONNECT',
        'RECONNECT'
      ]);
    } finally {
      await firstTurn.close();
      await adapter.close();
    }
  });

  it('replays full history while preserving sticky turn state over HTTP', async () => {
    const first = completedResponse('response-1', 'First');
    const second = completedResponse('response-2', 'Second');
    const bodies: Record<string, unknown>[] = [];
    const headers: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const index = bodies.length;
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        headers.push(request.headers);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          ...(index === 0 ? { 'x-codex-turn-state': 'turn-state-http' } : {})
        });
        response.end(
          (index === 0 ? first.events : second.events)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    const adapter = new OpenAiResponsesAdapter({
      ...configuration(`http://127.0.0.1:${address.port}`, provider(), {
        transport: 'HTTP',
        httpVersion: '1.1'
      }),
      responsesPreviousResponseId: false
    });
    const turn = adapter.createTurnSession();

    try {
      await collect(
        turn.start(
          {
            system: 'Reply.',
            messages: [{ role: 'user', content: 'First' }],
            tools: []
          },
          new AbortController().signal
        )
      );
      await collect(
        turn.start(
          {
            system: 'Reply.',
            messages: messagesAfterResponse('First', 'response-1', 'First', 'Second'),
            tools: []
          },
          new AbortController().signal
        )
      );

      expect(bodies[1]).not.toHaveProperty('previous_response_id');
      expect(bodies[1]).not.toHaveProperty('instructions');
      expect(bodies[1]?.input).toEqual([
        {
          role: 'developer',
          content: [{ type: 'input_text', text: 'Reply.' }]
        },
        { role: 'user', content: 'First' },
        expect.objectContaining({ type: 'message', id: 'response-1-message' }),
        { role: 'user', content: 'Second' }
      ]);
      expect(headers[0]?.['x-codex-turn-state']).toBeUndefined();
      expect(headers[1]?.['x-codex-turn-state']).toBe('turn-state-http');
      const requestIds = headers.map((header) => header['x-client-request-id']);
      for (const requestId of requestIds)
        expect(requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
      expect(new Set(requestIds).size).toBe(2);
    } finally {
      await turn.close();
      await adapter.close();
    }
  });
});
