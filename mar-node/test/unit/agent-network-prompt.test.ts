import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionExtensionContext } from '@myagentroam/agent/extensions';
import { LocalAgentHost } from '../../../mar-agent/dist/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../../mar-agent/dist/index.js';
import { createAgentWithAdapter } from '../../../mar-agent/dist/sdk/agent.js';
import type { ModelEvent, ModelRequest } from '../../../mar-agent/dist/model/contracts.js';
import { agentNetworkExtension } from '../../src/runner/mar-agent/agent-network-extension.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture(codeMode = false, toolCall?: { name: string; input: unknown }) {
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
      models: [configuration],
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
  const events = (async () => {
    for await (const event of run)
      if (event.type === 'tool.failed')
        failures.push({ toolName: event.toolName, code: event.code });
  })();
  expect((await run.result()).status).toBe('completed');
  await events;
  return { session, context, requests, invoke, failures };
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
      expect(instructions).toContain('Keep simple or tightly coupled work local.');
      expect(instructions).toContain('Follow up through the direct delegate by default');
      expect(instructions).toContain('only when a concrete issue needs independent verification');
      expect(instructions).toContain('avoid unnecessary cross-Session coordination');
      expect(instructions).toContain('do not treat them as task-owned children');
      expect(instructions).toContain('Explicitly wait when you need progress or completion.');
      expect(instructions).toContain('Reuse known Session IDs rather than rediscovering them.');
      expect(instructions).toContain(
        'combine related updates and avoid acknowledgment-only exchanges'
      );
      expect(instructions).not.toContain('subscribe');
      expect(instructions).toContain(
        "selecting a child's model or effort at creation use native agent_* tools"
      );
      expect(instructions).toContain('Do not switch to marctl when a native operation fails.');
      expect(instructions).not.toContain('existing authorized Sessions');
      expect(instructions).not.toContain('never inside code_exec');
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
  }
  expect(test.requests).toHaveLength(1);
  expect(test.invoke).not.toHaveBeenCalled();
});

it.each([false, true])('defaults native messages to steer with Code Mode %s', async (codeMode) => {
  for (const message of [
    { content: 'Continue the task' },
    { attachments: [{ name: 'image.png', mime: 'image/png', dataBase64: 'aW1hZ2U=' }] },
    { attachmentIds: ['existing-image'] },
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

it.each([false, true])('preserves explicit send intents with Code Mode %s', async (codeMode) => {
  for (const deliveryIntent of ['SEND', 'QUEUE', 'REPLACE_CURRENT']) {
    const input = { agentId: 'child', content: 'Task update', deliveryIntent };
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
});

it.each([false, true])(
  'rejects malformed send input before invoking Node with Code Mode %s',
  async (codeMode) => {
    const test = await fixture(codeMode, { name: 'agent_send', input: null });
    expect(test.invoke).not.toHaveBeenCalled();
    expect(test.failures).toEqual(
      expect.arrayContaining([{ toolName: 'agent_send', code: 'MAR_AGENT_TOOL_INPUT_INVALID' }])
    );
  }
);

it.each([false, true])(
  'leaves non-message operations unchanged with Code Mode %s',
  async (codeMode) => {
    for (const change of [
      { goal: { objective: 'Finish the task' } },
      { goal: { clear: true }, content: '  ', attachments: [], attachmentIds: [] },
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

it.each([false, true])('forwards list scopes and roots with Code Mode %s', async (codeMode) => {
  for (const input of [
    {},
    { scope: 'children', agentId: 'delegate' },
    { scope: 'descendants', agentId: 'delegate' },
    { scope: 'workspace', query: 'Task', limit: 10, cursor: 'next' },
    { scope: 'profile', runner: 'mar-agent' }
  ]) {
    const test = await fixture(codeMode, { name: 'agent_list', input });
    expect(test.invoke).toHaveBeenCalledExactlyOnceWith(
      'execution',
      'list',
      input,
      expect.anything(),
      expect.any(Function)
    );
    expect(test.failures).toEqual([]);
  }
});
