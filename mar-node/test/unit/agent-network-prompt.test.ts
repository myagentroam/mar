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

async function fixture(codeMode = false) {
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
  const invoke = vi.fn();
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
  await session.run({ prompt: 'Review the task' }).result();
  return { session, context, requests, invoke };
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
      expect(instructions).toContain('avoid unnecessary cross-Session coordination');
      expect(instructions).toContain('do not treat them as task-owned children');
      expect(instructions).toContain('Sending to a non-child does not subscribe to its updates');
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
