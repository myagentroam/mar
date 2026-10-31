import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionExtensionContext } from '@myagentroam/agent/extensions';
import { LocalAgentHost } from '../../../mar-agent/dist/host.js';
import {
  SecretValue,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../../mar-agent/dist/index.js';
import { createAgentWithAdapter } from '../../../mar-agent/dist/sdk/agent.js';
import type { ModelEvent, ModelRequest } from '../../../mar-agent/dist/model/contracts.js';
import { agentNetworkExtension } from '../../src/runner/mar-agent/agent-network-extension.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture(
  codeMode = false,
  toolCall?: { name: string; input: unknown },
  additionalModels: readonly Partial<AgentModelConfiguration>[] = []
) {
  const directory = await mkdtemp(join(tmpdir(), 'mar-network-prompt-'));
  const configuration: AgentModelConfiguration = {
    id: 'fixture',
    name: 'Fixture',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://example.test',
    apiKey: new SecretValue('fixture'),
    modelId: 'fixture',
    contextWindowTokens: 200000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    titleGeneration: false,
    codeMode,
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  };
  const requests: ModelRequest[] = [];
  const invoke = vi.fn().mockResolvedValue({});
  let context!: SessionExtensionContext;
  const agent = await createAgentWithAdapter(
    {
      mode: 'node',
      host: new LocalAgentHost({ mode: 'node', homeDirectory: directory, workspace: directory }),
      models: [configuration, ...additionalModels.map((model) => ({ ...configuration, ...model }))],
      extensions: [
        agentNetworkExtension(invoke, () => 'execution'),
        {
          id: 'capture',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
          }
        }
      ]
    },
    () => ({
      configuration,
      async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
        requests.push(request);
        if (toolCall && requests.length === 1) {
          yield {
            type: 'client_tool.call',
            callId: 'operation',
            name: codeMode ? 'code_exec' : toolCall.name,
            arguments: codeMode
              ? {
                  code: `observe.result(await tools.${toolCall.name}(${JSON.stringify(toolCall.input)}));`
                }
              : toolCall.input
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      }
    })
  );
  cleanup.push(async () => {
    try {
      await agent.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const session = await agent.createSession({ workspace: directory });
  const run = session.run({ prompt: 'Review the task', permissionMode: 'full-access' });
  const failures: Array<{ toolName: string; code: string }> = [];
  const publicEvents: AgentEvent[] = [];
  const events = (async () => {
    for await (const event of run) {
      publicEvents.push(event);
      if (event.type === 'tool.failed')
        failures.push({ toolName: event.toolName, code: event.code });
    }
  })();
  expect((await run.result()).status).toBe('completed');
  await events;
  return { agent, configuration, session, context, requests, invoke, failures, publicEvents };
}

it.each([false, true])(
  'provides focused network and management guidance with Code Mode %s',
  async (codeMode) => {
    const test = await fixture(codeMode);
    expect(await test.session.run({ prompt: 'Continue' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    for (const request of test.requests) {
      const active = new Map<string, string>();
      for (const message of request.messages) {
        const block = message.contextualBlock;
        if (block?.authority !== 'instruction') continue;
        if (block.operation === 'remove') active.delete(block.id);
        else active.set(block.id, message.content);
      }
      const instructions = [request.system, ...active.values()].join('\n\n');
      for (const heading of [
        'Delegation and coordination',
        'Workspace collaboration',
        'Workspace management'
      ]) {
        expect(instructions.split(`# ${heading}`)).toHaveLength(2);
      }
      expect(instructions).toContain(
        [
          '# Delegation and coordination',
          'Prefer handling focused or tightly coupled work locally.',
          'Consider delegating a clearly separable subtask when parallel progress or context savings materially outweigh coordination overhead.',
          'Avoid splitting work merely because agents are available.'
        ].join('\n\n')
      );
      expect(instructions).toContain('Prefer following up through the direct delegate');
      expect(instructions).toContain('only when a concrete issue needs independent verification');
      expect(instructions).toContain('avoid unnecessary cross-Session coordination');
      expect(instructions).toContain('do not treat them as task-owned children');
      expect(instructions).not.toContain('Explicitly wait when you need progress or completion.');
      expect(instructions).toContain(
        'prefer advancing meaningful, non-overlapping task work rather than duplicating delegated work'
      );
      expect(instructions).toContain(
        'Waiting is generally useful once no meaningful local task work remains and a required result is needed to unblock or finish the task.'
      );
      expect(instructions).toContain(
        'Prefer reusing known Session IDs rather than rediscovering them.'
      );
      expect(instructions).toContain(
        'An accepted message normally needs no separate acknowledgment.'
      );
      expect(instructions).toContain(
        'Requests for receipt-only replies and immediate agent_view calls solely to confirm receipt are usually unnecessary.'
      );
      expect(instructions).toContain(
        'blockers, scope conflicts, or information needed for a decision'
      );
      expect(instructions).toContain(
        'prefer a concise final handoff over routine progress reports or duplicate completion messages'
      );
      expect(instructions).toContain(
        'Updates are most useful when requested or when the recipient needs to decide or change course'
      );
      expect(instructions).not.toContain('Send updates for meaningful progress');
      expect(instructions).toContain('prefer combining related updates');
      expect(instructions).not.toContain('subscribe');
      expect(instructions).toContain(
        "selecting a child's model or effort at creation use native agent_* tools"
      );
      expect(instructions).toContain('Do not switch to marctl when a native operation fails.');
      expect(instructions).not.toContain('existing authorized Sessions');
      expect(instructions).not.toContain('never inside code_exec');
      expect(JSON.stringify(request.tools)).toContain(
        'Model configuration ID; omit to use the target Runner default.'
      );
      expect(JSON.stringify(request.tools)).not.toContain('REPLACE_CURRENT');
      expect(JSON.stringify(request.tools)).not.toContain('deliveryIntent');
    }
    expect(test.invoke).not.toHaveBeenCalled();
  }
);

it('selects delegation and lateral guidance independently and omits both during Compact', async () => {
  const test = await fixture();
  for (const [mode, tools, expected] of [
    ['run', ['read'], [false, false, false]],
    ['run', ['agent_start'], [true, false, true]],
    ['run', ['agent_send'], [false, true, true]],
    ['plan', ['agent_start', 'agent_send'], [true, true, true]],
    ['compact', ['agent_start', 'agent_send'], [false, false, false]]
  ] as const) {
    const composed = await test.context.prompts.composeDefault({ mode, tools });
    const instructions = composed.sections.map((section) => section.text ?? '').join('\n\n');
    expect([
      instructions.includes('# Delegation and coordination'),
      instructions.includes('# Workspace collaboration'),
      instructions.includes('# Workspace management')
    ]).toEqual(expected);
    expect(instructions.includes('Available subagent models:')).toBe(expected[0]);
    for (const guidance of [
      'An accepted message normally needs no separate acknowledgment.',
      'Requests for receipt-only replies',
      'immediate agent_view calls solely to confirm receipt are usually unnecessary',
      'prefer a concise final handoff over routine progress reports or duplicate completion messages'
    ]) {
      expect(instructions.split(guidance)).toHaveLength(expected[1] ? 2 : 1);
    }
  }
  expect(test.requests).toHaveLength(1);
  expect(test.invoke).not.toHaveBeenCalled();
});

it.each([false, true])(
  'injects only eligible subagent models with Code Mode %s',
  async (codeMode) => {
    const test = await fixture(codeMode, undefined, [
      {
        id: 'child',
        name: 'Child model',
        modelId: 'private-upstream-model',
        baseUrl: 'https://private-provider.test',
        apiKey: new SecretValue('private-model-key'),
        subagentModel: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high'
      },
      { id: 'disabled', enabled: false, subagentModel: true },
      { id: 'auxiliary', conversationModel: false, subagentModel: true }
    ]);
    const composed = await test.context.prompts.composeDefault();
    const text = composed.sections.find(
      (section) => section.id === 'mar.node.agent-network:delegation'
    )!.text!;
    expect(JSON.parse(text.split('Available subagent models:\n')[1]!)).toEqual({
      runner: 'mar-agent',
      models: [
        {
          id: 'child',
          name: 'Child model',
          supportedEfforts: ['low', 'high'],
          defaultEffort: 'high'
        }
      ]
    });
    expect(JSON.stringify(test.requests[0])).toContain('Available subagent models:');
    expect(test.invoke).not.toHaveBeenCalled();
  }
);

it('refreshes the injected models after reconfiguration and represents an empty catalog', async () => {
  const test = await fixture();
  for (const models of [[{ ...test.configuration, id: 'next-child', subagentModel: true }], []]) {
    await test.agent.reconfigureModels({ models: [test.configuration, ...models] });
    const composed = await test.context.prompts.composeDefault();
    const text = composed.sections.find(
      (section) => section.id === 'mar.node.agent-network:delegation'
    )!.text!;
    const catalog = JSON.parse(text.split('Available subagent models:\n')[1]!);
    expect(catalog.models.map((model: { id: string }) => model.id)).toEqual(
      models.map((model) => model.id)
    );
  }
  expect(test.invoke).not.toHaveBeenCalled();
});

it.each([false, true])('defaults native messages to steer with Code Mode %s', async (codeMode) => {
  for (const message of [
    { content: 'Continue the task' },
    { content: 'Continue', goal: { objective: 'Finish the task' } },
    { content: 'Continue', approval: { approvalId: 'approval', decision: 'approve' } }
  ]) {
    const input = { agentId: 'child', ...message };
    const test = await fixture(codeMode, { name: 'agent_send', input });
    expect(test.invoke).toHaveBeenCalledExactlyOnceWith(
      'execution',
      'send',
      { ...input, deliveryIntent: 'REPLACE_CURRENT' },
      expect.anything(),
      expect.any(Function)
    );
    expect(input).not.toHaveProperty('deliveryIntent');
    expect(test.failures).toEqual([]);
  }
});

it.each([false, true])('maps public delivery choices with Code Mode %s', async (codeMode) => {
  for (const [delivery, deliveryIntent] of [
    ['STEER', 'REPLACE_CURRENT'],
    ['QUEUE', 'QUEUE']
  ]) {
    const input = { agentId: 'child', content: 'Task update', delivery };
    const test = await fixture(codeMode, { name: 'agent_send', input });
    expect(test.invoke).toHaveBeenCalledExactlyOnceWith(
      'execution',
      'send',
      { agentId: 'child', content: 'Task update', deliveryIntent },
      expect.anything(),
      expect.any(Function)
    );
    expect(input).not.toHaveProperty('deliveryIntent');
    expect(test.failures).toEqual([]);
  }
});

it.each([false, true])(
  'rejects malformed send input before invoking Node with Code Mode %s',
  async (codeMode) => {
    for (const input of [
      null,
      { agentId: 'child', content: 'Update', delivery: 'SEND' },
      { agentId: 'child', content: 'Update', delivery: 'REPLACE_CURRENT' }
    ]) {
      const test = await fixture(codeMode, { name: 'agent_send', input });
      expect(test.invoke).not.toHaveBeenCalled();
      expect(test.failures).toEqual(
        expect.arrayContaining([{ toolName: 'agent_send', code: 'MAR_AGENT_TOOL_INPUT_INVALID' }])
      );
    }
  }
);

it.each([false, true])(
  'requires a text task before invoking start with Code Mode %s',
  async (codeMode) => {
    for (const content of [undefined, '']) {
      const test = await fixture(codeMode, {
        name: 'agent_start',
        input: { title: 'Text task', ...(content === undefined ? {} : { content }) }
      });
      expect(test.invoke).not.toHaveBeenCalled();
      expect(test.failures).toEqual(
        expect.arrayContaining([{ toolName: 'agent_start', code: 'MAR_AGENT_TOOL_INPUT_INVALID' }])
      );
    }
  }
);

it.each([false, true])(
  'rejects retired attachment fields before invoking Node with Code Mode %s',
  async (codeMode) => {
    for (const name of ['agent_start', 'agent_send']) {
      for (const attachment of [
        { attachments: [] },
        { attachments: [{ name: 'image.png', mime: 'image/png', dataBase64: 'aW1hZ2U=' }] },
        { attachmentIds: [] },
        { attachmentIds: ['existing-image'] }
      ]) {
        const test = await fixture(codeMode, {
          name,
          input: {
            ...(name === 'agent_start' ? { title: 'Text task' } : { agentId: 'child' }),
            content: 'Valid text must not silently discard retired input',
            ...attachment
          }
        });
        expect(test.invoke).not.toHaveBeenCalled();
        expect(test.failures).toEqual(
          expect.arrayContaining([{ toolName: name, code: 'MAR_AGENT_TOOL_INPUT_INVALID' }])
        );
      }
    }
  }
);

it.each([false, true])(
  'does not interpret internal delivery fields supplied by a model with Code Mode %s',
  async (codeMode) => {
    const test = await fixture(codeMode, {
      name: 'agent_send',
      input: { agentId: 'child', content: 'Update', deliveryIntent: 'QUEUE' }
    });
    expect(test.invoke).toHaveBeenCalledExactlyOnceWith(
      'execution',
      'send',
      { agentId: 'child', content: 'Update', deliveryIntent: 'REPLACE_CURRENT' },
      expect.anything(),
      expect.any(Function)
    );
    expect(test.failures).toEqual([]);
  }
);

it.each([false, true])(
  'leaves non-message operations unchanged with Code Mode %s',
  async (codeMode) => {
    for (const change of [
      { goal: { objective: 'Finish the task' } },
      { goal: { clear: true }, content: '  ' },
      { approval: { approvalId: 'approval', decision: 'approve' } }
    ]) {
      const input = { agentId: 'child', ...change };
      const test = await fixture(codeMode, { name: 'agent_send', input });
      expect(test.invoke).toHaveBeenCalledExactlyOnceWith(
        'execution',
        'send',
        input,
        expect.anything(),
        expect.any(Function)
      );
      expect(test.failures).toEqual([]);
    }
  }
);

it.each([false, true])(
  'forwards compact list scopes and filters with Code Mode %s',
  async (codeMode) => {
    for (const input of [{}, { scope: 'tree' }, { scope: 'active', query: 'Task', limit: 10 }]) {
      const test = await fixture(codeMode, { name: 'agent_list', input });
      expect(test.invoke).toHaveBeenCalledExactlyOnceWith(
        'execution',
        'list',
        input,
        expect.anything(),
        expect.any(Function)
      );
      expect(test.failures).toEqual([]);
      if ('query' in input) {
        const normalizer = new MarAgentConversationNormalizer();
        const items = test.publicEvents.flatMap((event) => normalizer.normalize(event));
        expect(items).toContainEqual(
          expect.objectContaining({
            kind: 'tool_call',
            payload: expect.objectContaining({
              toolName: 'agent_list',
              inputSummary: JSON.stringify(input)
            })
          })
        );
      }
    }
  }
);

it.each([false, true])(
  'rejects unsupported list scopes and invalid limits with Code Mode %s',
  async (codeMode) => {
    for (const input of [
      { scope: 'children' },
      { scope: 'descendants' },
      { scope: 'workspace' },
      { scope: 'profile', runner: 'mar-agent' },
      { limit: 0 },
      { limit: 101 },
      { query: 'x'.repeat(161) }
    ]) {
      const test = await fixture(codeMode, { name: 'agent_list', input });
      expect(test.invoke).not.toHaveBeenCalled();
      expect(test.failures.length).toBeGreaterThan(0);
    }
  }
);

it.each([false, true])(
  'strips removed list fields before invoking Node with Code Mode %s',
  async (codeMode) => {
    const test = await fixture(codeMode, {
      name: 'agent_list',
      input: { agentId: 'delegate', runner: 'codex', cursor: 'next' }
    });
    expect(test.invoke).toHaveBeenCalledExactlyOnceWith(
      'execution',
      'list',
      {},
      expect.anything(),
      expect.any(Function)
    );
  }
);
