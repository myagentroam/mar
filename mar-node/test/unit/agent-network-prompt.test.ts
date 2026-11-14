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
import { marAgentRuntimeExtensionSource } from '../../src/runner/mar-agent/runtime-extensions.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture(
  codeMode = false,
  toolCall?: { name: string; input: unknown },
  additionalModels: readonly Partial<AgentModelConfiguration>[] = [],
  receipt?: { result: unknown; resolved: readonly unknown[] },
  networkEnabled = true,
  observeData = false
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
  const invoke = vi.fn(async (...args: unknown[]) => {
    if (receipt && typeof args[4] === 'function') await args[4](receipt.resolved);
    return receipt?.result ?? {};
  });
  let context!: SessionExtensionContext;
  const runtimeSource = marAgentRuntimeExtensionSource({ revision: 0 });
  const agent = await createAgentWithAdapter(
    {
      mode: 'node',
      host: new LocalAgentHost({ mode: 'node', homeDirectory: directory, workspace: directory }),
      models: [configuration, ...additionalModels.map((model) => ({ ...configuration, ...model }))],
      extensions: {
        async resolve(request) {
          const snapshot = await runtimeSource.resolve(request);
          return {
            ...snapshot,
            extensions: [
              ...snapshot.extensions,
              ...(networkEnabled ? [agentNetworkExtension(invoke, () => 'execution')] : []),
              {
                id: 'capture',
                apiVersion: '1.0' as const,
                attachSession(value: SessionExtensionContext) {
                  context = value;
                }
              }
            ]
          };
        }
      }
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
                  code: observeData
                    ? `observe.text((await tools.${toolCall.name}(${JSON.stringify(toolCall.input)})).data);`
                    : `observe.result(await tools.${toolCall.name}(${JSON.stringify(toolCall.input)}));`
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
  'provides file preview guidance independently of Agent Network (%s)',
  async (networkEnabled) => {
    const test = await fixture(false, undefined, [], undefined, networkEnabled);
    const guidance =
      'When mentioning key files changed in this task, prefer Markdown links to their absolute paths for easy preview.';
    for (const mode of ['run', 'plan', 'compact'] as const) {
      const composed = await test.context.prompts.composeDefault({ mode, tools: ['read'] });
      expect(composed.sections.filter((section) => section.id === 'mar.node.file-links')).toEqual([
        { id: 'mar.node.file-links', text: mode === 'compact' ? null : guidance }
      ]);
    }
    expect(await test.session.run({ prompt: 'Continue' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    for (const request of test.requests) {
      const blocks = request.messages.filter(
        (message) => message.contextualBlock?.id === 'mar.node.file-links'
      );
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.content).toContain(guidance);
    }
  }
);

it('exposes a state-only Agent view schema to the model', async () => {
  const test = await fixture();
  const view = test.requests[0]!.tools.find((tool) => tool.name === 'agent_view');
  expect(view).toBeDefined();
  expect(view!.inputSchema.properties).toEqual({ agentId: { type: 'string', minLength: 1 } });
  expect(view!.description).toBe("View an Agent's state, Goal and recent activity.");
});

it.each([false, true])('views state by identity with Code Mode %s', async (codeMode) => {
  const test = await fixture(codeMode, { name: 'agent_view', input: { agentId: 'child' } });
  expect(test.failures).toEqual([]);
  expect(test.invoke).toHaveBeenCalledOnce();
  expect(test.invoke.mock.calls[0]![2]).toEqual({ agentId: 'child' });
});

it.each([false, true])('stops by Session identity with Code Mode %s', async (codeMode) => {
  const test = await fixture(codeMode, { name: 'agent_stop', input: { agentId: 'child' } });
  expect(test.failures).toEqual([]);
  expect(test.invoke).toHaveBeenCalledOnce();
  expect(test.invoke.mock.calls[0]![2]).toEqual({ agentId: 'child' });
});

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
        'The parent automatically collects the latest unread public reply and terminal state from each observed direct child before its next natural model request.'
      );
      expect(instructions).toContain(
        'Usually reply in the child Session itself rather than sending duplicate progress or completion reports with agent_send.'
      );
      expect(instructions).toContain('when timely action or a decision is needed');
      expect(instructions).toContain('a blocker, scope conflict or major risk');
      expect(instructions).toContain('or when explicitly asked to report');
      expect(instructions).toContain('Routine child updates usually need no reply');
      expect(instructions).toContain(
        'Updates are most useful when requested or when the recipient needs to decide or change course'
      );
      expect(instructions).not.toContain('Send updates for meaningful progress');
      expect(instructions).toContain('prefer combining related updates');
      expect(instructions).toContain(
        'Sending to a non-child Agent does not subscribe to future updates; waiting for a non-child observes it only for that call.'
      );
      expect(instructions).toContain(
        'Before final delivery, resolve any outstanding child work required for the task.'
      );
      expect(instructions).toContain(
        'Results already available in context usually need no additional wait or view.'
      );
      expect(instructions).not.toContain('Join or stop task-required child work');
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
      'The parent automatically collects the latest unread public reply and terminal state from each observed direct child',
      'rather than sending duplicate progress or completion reports with agent_send',
      'Sending to a non-child Agent does not subscribe to future updates',
      'Contact the parent proactively when timely action or a decision is needed',
      'Routine child updates usually need no reply'
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

it.each([false, true])(
  'preserves bounded agent details through SDK events with Code Mode %s',
  async (codeMode) => {
    const text = '初始内容😀'.repeat(200);
    const test = await fixture(
      codeMode,
      { name: 'agent_send', input: { agentId: 'child', content: text } },
      [],
      {
        resolved: [{ id: 'child', customTitle: 'Resolved task' }],
        result: {
          agentId: 'child',
          message: {
            status: 'accepted',
            result: { auditReceipt: { inputMode: 'REPLACE_CURRENT' } }
          }
        }
      }
    );
    const normalizer = new MarAgentConversationNormalizer();
    const items = test.publicEvents
      .flatMap((entry) => normalizer.normalize(entry))
      .filter((item) => item.kind === 'tool_call' && item.payload.toolName === 'agent_send');
    expect(items.at(-1)?.payload.agentOperation).toMatchObject({
      targets: [{ title: 'Resolved task' }],
      detail: { message: text, delivery: 'STEER' }
    });
    const metadata = test.publicEvents.flatMap((entry) =>
      'data' in entry &&
      entry.data &&
      typeof entry.data === 'object' &&
      'agentOperation' in entry.data
        ? [entry.data]
        : []
    );
    expect(metadata.length).toBeGreaterThan(0);
    expect(metadata.every((value) => Buffer.byteLength(JSON.stringify(value)) <= 8192)).toBe(true);
  }
);

it.each([false, true])(
  'publishes effective wait facts while running and completed in Code Mode %s',
  async (codeMode) => {
    for (const options of [
      {},
      { waitFor: 'message', waitMs: 0 },
      { waitFor: 'completion', waitMs: 300000, mode: 'all' }
    ] as const) {
      const input = { agentIds: ['child'], ...options };
      const test = await fixture(codeMode, { name: 'agent_wait', input }, [], {
        resolved: [{ id: 'child', customTitle: 'Resolved task' }],
        result: { agents: [{ agentId: 'child', title: 'Resolved task' }] }
      });
      const effective = { waitFor: 'completion', waitMs: 30000, mode: 'any', ...options };
      expect(test.invoke.mock.calls[0]![2]).toEqual({ ...input, ...effective });
      const normalizer = new MarAgentConversationNormalizer();
      const items = test.publicEvents
        .flatMap((entry) => normalizer.normalize(entry))
        .filter((item) => item.kind === 'tool_call' && item.payload.toolName === 'agent_wait');
      expect(
        items.some(
          (item) =>
            item.status === 'IN_PROGRESS' &&
            (item.payload.agentOperation as { detail?: { wait?: unknown } })?.detail?.wait !==
              undefined
        )
      ).toBe(true);
      expect(items.at(-1)?.payload.agentOperation).toMatchObject({ detail: { wait: effective } });
      expect(items.at(-1)?.payload.inputSummary).toBe(JSON.stringify(input));
    }
  }
);

it('describes array-only waits and distinguishes Goal updates from messages and stopping', async () => {
  const test = await fixture();
  const definitions = test.requests[0]!.tools;
  const wait = definitions.find((tool) => tool.name === 'agent_wait')!;
  const properties = wait.inputSchema.properties as Record<string, unknown>;
  expect(properties).not.toHaveProperty('agentId');
  expect(properties.agentIds).toMatchObject({
    type: 'array',
    minItems: 1,
    maxItems: 8,
    description: expect.stringContaining('single')
  });
  expect(properties.waitMs).toMatchObject({
    minimum: 0,
    maximum: 300000,
    description: expect.stringContaining('snapshot')
  });
  for (const name of ['agent_start', 'agent_send']) {
    expect(
      (
        definitions.find((tool) => tool.name === name)!.inputSchema.properties as Record<
          string,
          unknown
        >
      ).goal
    ).toHaveProperty('description', expect.stringContaining('does not stop'));
  }
});

it.each([false, true])(
  'rejects the retired wait agentId before invoking Node (nested=%s)',
  async (nested) => {
    const test = await fixture(nested, { name: 'agent_wait', input: { agentId: 'child' } });
    expect(test.invoke).not.toHaveBeenCalled();
    expect(test.failures).toContainEqual({
      toolName: 'agent_wait',
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
  }
);

it.each([false, true])(
  'projects receipts for both model content and programmatic data (nested=%s)',
  async (nested) => {
    for (const entry of [
      {
        name: 'agent_start',
        input: { title: 'Task', content: 'Review' },
        result: {
          agentId: 'child',
          start: {
            run: { id: 'internal-run', status: 'STARTING' },
            auditReceipt: { inputMode: 'REPLACE_CURRENT' },
            idempotent: false
          },
          observation: { status: 'failed', code: 'OBSERVATION_FAILED' }
        },
        expected: {
          agentId: 'child',
          start: { executionStatus: 'STARTING', idempotent: false },
          observation: { status: 'failed', code: 'OBSERVATION_FAILED' }
        }
      },
      {
        name: 'agent_send',
        input: { agentId: 'child', content: 'Review' },
        result: {
          agentId: 'child',
          message: {
            status: 'accepted',
            result: {
              delivery: 'QUEUED',
              queueItemId: 'internal-queue',
              auditReceipt: { inputMode: 'QUEUE' },
              idempotent: false
            }
          }
        },
        expected: {
          agentId: 'child',
          message: { status: 'accepted', delivery: 'QUEUED', idempotent: false }
        }
      },
      {
        name: 'agent_stop',
        input: { agentId: 'child' },
        result: {
          agentId: 'child',
          cancel: {
            status: 'idle',
            result: { status: 'IDLE', auditReceipt: { runId: 'internal-run' } }
          },
          goal: { status: 'cleared' }
        },
        expected: { agentId: 'child', cancel: { status: 'idle' }, goal: { status: 'cleared' } }
      },
      {
        name: 'agent_wait',
        input: { agentIds: ['child'], waitMs: 0 },
        result: {
          waitFor: 'completion',
          mode: 'any',
          waitOutcome: 'snapshot',
          pendingAgentIds: ['child'],
          agents: [
            {
              agentId: 'child',
              runId: 'internal-run',
              executionId: 'internal-execution',
              status: 'RUNNING',
              waitOutcome: 'snapshot'
            }
          ]
        },
        expected: {
          waitFor: 'completion',
          mode: 'any',
          waitOutcome: 'snapshot',
          pendingAgentIds: ['child'],
          agents: [{ agentId: 'child', status: 'RUNNING', waitOutcome: 'snapshot' }]
        }
      },
      {
        name: 'agent_wait',
        input: { waitMs: 0 },
        result: {
          agentId: 'child',
          runId: 'internal-run',
          executionId: 'internal-execution',
          status: 'RUNNING',
          waitOutcome: 'snapshot',
          waitFor: 'completion'
        },
        expected: {
          waitFor: 'completion',
          waitOutcome: 'snapshot',
          agents: [{ agentId: 'child', status: 'RUNNING', waitOutcome: 'snapshot' }]
        }
      }
    ]) {
      const original = structuredClone(entry.result);
      const test = await fixture(
        nested,
        { name: entry.name, input: entry.input },
        [],
        { result: entry.result, resolved: [] },
        true,
        nested
      );
      expect(test.failures).toEqual([]);
      const context = test.requests[1]?.messages.findLast((item) => item.role === 'tool');
      expect(context).toBeDefined();
      const serialized = JSON.stringify(context);
      for (const internal of [
        'internal-run',
        'internal-queue',
        'internal-execution',
        'auditReceipt',
        'REPLACE_CURRENT'
      ])
        expect(serialized).not.toContain(internal);
      expect(serialized).toContain('child');
      const envelope = JSON.parse(context!.content);
      expect(nested ? JSON.parse(envelope.observations[0].value) : envelope).toEqual(
        entry.expected
      );
      expect(entry.result).toEqual(original);
    }
  }
);

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
    const normalizer = new MarAgentConversationNormalizer();
    expect(test.publicEvents.flatMap((event) => normalizer.normalize(event))).toContainEqual(
      expect.objectContaining({
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: expect.objectContaining({
          toolName: 'agent_send',
          inputSummary: JSON.stringify(input)
        })
      })
    );
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
      expect(test.publicEvents).toContainEqual(
        expect.objectContaining({ type: 'tool.started', toolName: 'agent_send', input })
      );
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
