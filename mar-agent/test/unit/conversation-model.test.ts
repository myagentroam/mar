import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import {
  SecretValue,
  type Agent,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../src/index.js';
import { type AgentExtension } from '../../src/extensions.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { resolveAgentModels } from '../../src/sdk/model-runtime.js';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import {
  createSubagentExtension,
  SUBAGENT_NATIVE_SERVICE,
  type NativeSubagentClient
} from '../../extensions/subagent/src/index.js';

const roots: string[] = [];
const agents: Agent[] = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('conversation model eligibility', () => {
  it('retains enabled auxiliary models while selecting only a conversation model by default', () => {
    const auxiliary = model('helper', false);
    const conversation = model('chat');

    const resolved = resolveAgentModels([auxiliary, conversation]);

    expect([...resolved.models.keys()]).toEqual(['helper', 'chat']);
    expect(resolved.defaultModelId).toBe('chat');
    expect(() => resolveAgentModels([auxiliary, conversation], 'helper')).toThrow(
      expect.objectContaining({ code: 'MAR_AGENT_MODEL_CONFIG_INVALID' })
    );
  });

  it('preserves the admitted execution and rejects the former model after reconfiguration', async () => {
    let reportStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (reportStarted = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const requests: string[] = [];
    const f = await fixture([model('chat'), model('replacement')], (configuration) => ({
      configuration,
      async *start(): AsyncIterable<ModelEvent> {
        requests.push(configuration.id);
        reportStarted();
        await blocked;
        yield { type: 'text.completed', itemId: 'final', text: 'Finished safely.' };
        yield { type: 'completed', reason: 'completed' };
      }
    }));
    const handle = f.session.run({ prompt: 'Finish the admitted execution.', modelId: 'chat' });
    await started;
    const next = { models: [model('chat', false), model('replacement')] };
    try {
      await expect(f.agent.reconfigureModels(next)).rejects.toMatchObject({
        code: 'MAR_AGENT_EXECUTION_ACTIVE'
      });
    } finally {
      release();
    }
    expect(await handle.result()).toMatchObject({ status: 'completed' });
    await f.agent.reconfigureModels(next);
    expect(() => f.session.run({ prompt: 'Do not switch silently.', modelId: 'chat' })).toThrow(
      expect.objectContaining({ code: 'MAR_AGENT_MODEL_DISABLED' })
    );
    expect(requests).toEqual(['chat']);
  });

  it.each(['run', 'plan'] as const)(
    'rejects an auxiliary model for a main %s without starting a model request',
    async (mode) => {
      const adapters = new Map<string, FakeAdapter>();
      const f = await fixture([model('chat'), model('helper', false)], (configuration) => {
        const adapter = new FakeAdapter(configuration);
        adapters.set(configuration.id, adapter);
        return adapter;
      });

      expect(() =>
        f.session[mode]({ prompt: 'Do not run on an auxiliary model.', modelId: 'helper' })
      ).toThrow(expect.objectContaining({ code: 'MAR_AGENT_MODEL_DISABLED' }));
      expect(adapters.size).toBe(0);
    }
  );

  it('lists eligible subagent models and rejects an unavailable explicit agent_start', async () => {
    const configs = [
      { ...model('chat'), conversationModel: true, subagentModel: true },
      model('helper', false)
    ];
    const adapters = new Map<string, FakeAdapter>();
    let agent!: Agent;
    const f = await fixture(
      configs,
      (configuration) => {
        const adapter = new FakeAdapter(configuration, (_request, call) => {
          if (call === 1)
            return [
              {
                type: 'client_tool.call',
                callId: 'list-profile',
                name: 'agent_list',
                arguments: { scope: 'profile' }
              },
              { type: 'completed', reason: 'tool_use' }
            ];
          if (call === 2)
            return [
              {
                type: 'client_tool.call',
                callId: 'start-helper',
                name: 'agent_start',
                arguments: {
                  title: 'Use the helper model',
                  description: 'Use the helper model',
                  prompt: 'Run this bounded task.',
                  role: 'general-purpose',
                  modelId: 'helper'
                }
              },
              { type: 'completed', reason: 'tool_use' }
            ];
          return [
            { type: 'text.completed', itemId: 'final', text: 'Rejected safely.' },
            { type: 'completed', reason: 'completed' }
          ];
        });
        adapters.set(configuration.id, adapter);
        return adapter;
      },
      [createSubagentExtension({ agent: () => agent })]
    );
    agent = f.agent;

    const handle = f.session.run({ prompt: 'Try the helper.' });
    const events: AgentEvent[] = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({ status: 'completed' });

    const profile = JSON.parse(
      adapters
        .get('chat')
        ?.requests[1]?.messages.findLast(
          (message) => message.role === 'tool' && message.name === 'agent_list'
        )?.content ?? '{}'
    );
    expect(profile.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'chat' })])
    );
    expect(profile.models).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'helper' })])
    );
    expect(JSON.stringify(profile)).not.toContain('apiKey');
    expect(
      events.find((event) => event.type === 'tool.failed' && event.toolName === 'agent_start')
    ).toMatchObject({ type: 'tool.failed', code: 'MAR_AGENT_MODEL_DISABLED' });
    expect(adapters.has('helper')).toBe(false);

    const store = await JsonlSessionStore.open(f.home);
    try {
      expect(await store.listSubagentChildren(f.session.id)).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it('rejects an auxiliary model requested by a native Extension Agent without creating a child Session', async () => {
    let client!: NativeSubagentClient;
    let agent!: Agent;
    const consumer: AgentExtension = {
      id: 'conversation-model-native-agent',
      apiVersion: '1.0',
      serviceDependencies: [{ key: SUBAGENT_NATIVE_SERVICE }],
      attachSession: (context) => {
        client = context.services.consume(SUBAGENT_NATIVE_SERVICE)!.open();
      }
    };
    const f = await fixture([model('chat'), model('helper', false)], undefined, [
      createSubagentExtension({ agent: () => agent }),
      consumer
    ]);
    agent = f.agent;
    expect(
      await f.session.run({ prompt: 'Initialize the native Agent API.' }).result()
    ).toMatchObject({
      status: 'completed'
    });

    await expect(
      client.spawn({ prompt: 'Try the helper.', modelId: 'helper' })
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_DISABLED'
    });
    expect(await client.list()).toHaveLength(0);
    const store = await JsonlSessionStore.open(f.home);
    try {
      expect(await store.listSubagentChildren(f.session.id)).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});

class FakeAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];

  constructor(
    readonly configuration: AgentModelConfiguration,
    private readonly respond: (
      request: ModelRequest,
      call: number
    ) => readonly ModelEvent[] = () => [
      { type: 'text.completed', itemId: 'answer', text: 'done' },
      { type: 'completed', reason: 'completed' }
    ]
  ) {}

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield* this.respond(request, this.requests.length);
  }
}

async function fixture(
  models: readonly AgentModelConfiguration[],
  adapterFactory?: (configuration: AgentModelConfiguration) => ModelAdapter,
  extensions?: readonly AgentExtension[]
) {
  const root = await mkdtemp(join(tmpdir(), 'mar-agent-conversation-model-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models,
      ...(extensions === undefined ? {} : { extensions })
    },
    adapterFactory ?? ((configuration) => new FakeAdapter(configuration))
  );
  agents.push(agent);
  const session = await agent.createSession({ workspace, title: 'Conversation model tests' });
  return { agent, session, home, workspace };
}

function model(id: string, conversationModel?: boolean): AgentModelConfiguration {
  return {
    id,
    name: id,
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: 'https://example.test',
    apiKey: new SecretValue(`fake-${id}`),
    modelId: id,
    contextWindowTokens: 20_000,
    maxOutputTokens: 2_000,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    titleGeneration: false,
    hostedWebSearch: false,
    enabled: true,
    ...(conversationModel === undefined ? {} : { conversationModel })
  };
}
