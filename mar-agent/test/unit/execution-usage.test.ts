import { effectiveInstructions } from './support/model-context.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForNewChild } from './support/subagent-wait.js';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentEvent, type AgentModelConfiguration } from '../../src/index.js';
import { type ExtensionAgentsApi } from '../../src/extensions.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

const homes: string[] = [];
afterEach(async () =>
  Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
);

const model: AgentModelConfiguration = {
  id: 'coding',
  name: 'Coding',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('secret'),
  modelId: 'coding',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

async function fixture(name: string) {
  const home = await mkdtemp(join(tmpdir(), `mar-rollout-${name}-`));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'input.txt'), 'content\n');
  return { home, workspace };
}

class LongExecutionAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  async *start(): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls <= 129) {
      yield {
        type: 'client_tool.call',
        callId: `read-${this.calls}`,
        name: 'read',
        arguments: { reads: [{ path: 'input.txt' }] }
      };
      yield { type: 'usage', usage: { contextInputTokens: 20_000, outputTokens: 10 } };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'final', text: 'finished after 129 tool rounds' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class FinalAtBudgetAdapter implements ModelAdapter {
  readonly configuration = model;
  async *start(): AsyncIterable<ModelEvent> {
    yield { type: 'text.completed', itemId: 'final', text: 'finished at the budget boundary' };
    yield {
      type: 'usage',
      usage: {
        rolloutBudgetUnits: 1_250_000,
        contextInputTokens: 100,
        cacheReadTokens: 40,
        outputTokens: 20
      }
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ToolAtBudgetAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  async *start(): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls > 1) {
      yield { type: 'text.completed', itemId: 'final', text: 'staged result after tools' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    for (const suffix of ['first', 'second'])
      yield {
        type: 'client_tool.call',
        callId: suffix,
        name: 'read',
        arguments: { reads: [{ path: 'input.txt' }] }
      };
    yield { type: 'usage', usage: { contextInputTokens: 101 } };
    yield { type: 'completed', reason: 'tool_use' };
  }
}

class StagedPromptAdapter implements ModelAdapter {
  readonly configuration: AgentModelConfiguration = {
    ...model,
    protocol: 'OPENAI_RESPONSES',
    responsesPreviousResponseId: true
  };
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const call = this.requests.length;
    yield { type: 'response.started', responseId: `response-${call}` };
    if (call < 5) {
      yield {
        type: 'client_tool.call',
        callId: `read-${call}`,
        name: 'read',
        arguments: { reads: [{ path: 'input.txt' }] }
      };
      yield {
        type: 'usage',
        usage: { contextInputTokens: [40, 10, 30, 21][call - 1] }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'final', text: 'staged completion' };
    yield { type: 'usage', usage: { outputTokens: 1 } };
    yield { type: 'completed', reason: 'completed' };
  }
}

class CompactBudgetAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  normalCalls = 0;
  constructor(
    readonly configuration: AgentModelConfiguration,
    readonly compactOutputTokens = 6_000
  ) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'budgeted compact summary' };
      yield { type: 'usage', usage: { outputTokens: this.compactOutputTokens } };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    this.normalCalls++;
    if (this.normalCalls === 1) {
      yield { type: 'text.completed', itemId: 'seed', text: 'seeded' };
      yield { type: 'usage', usage: { contextInputTokens: 8_200 } };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    if (this.normalCalls === 3) {
      yield {
        type: 'text.completed',
        itemId: 'final',
        text: 'staged result after compact budget'
      };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    yield {
      type: 'client_tool.call',
      callId: 'after-compact',
      name: 'read',
      arguments: { reads: [{ path: 'input.txt' }] }
    };
    yield { type: 'usage', usage: { outputTokens: 5_000 } };
    yield { type: 'completed', reason: 'tool_use' };
  }
}

class SubagentBudgetAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  childSessionId?: string;

  constructor(readonly role: 'general-purpose' | 'explore') {}

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (effectiveInstructions(request).includes('non-recursive subagent')) {
      const promptIndex = request.messages.findLastIndex(
        (message) => message.role === 'user' && message.content.startsWith('Inspect input.txt')
      );
      if (!request.messages.slice(promptIndex + 1).some((message) => message.role === 'tool')) {
        yield {
          type: 'client_tool.call',
          callId: 'child-read',
          name: 'read',
          arguments: { reads: [{ path: 'input.txt' }] }
        };
        yield { type: 'usage', usage: { outputTokens: 101 } };
        yield { type: 'completed', reason: 'tool_use' };
        return;
      }
      yield { type: 'text.completed', itemId: 'child-final', text: 'child done' };
      yield { type: 'usage', usage: { rolloutBudgetUnits: 101, outputTokens: 101 } };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    const promptIndex = request.messages.findLastIndex(
      (message) =>
        message.role === 'user' && ['delegate', 'continue child'].includes(message.content)
    );
    const toolResults = request.messages
      .slice(promptIndex + 1)
      .filter((message) => message.role === 'tool');
    if (request.messages[promptIndex]?.content === 'continue child' && toolResults.length < 2) {
      yield {
        type: 'client_tool.call',
        callId: toolResults.length === 0 ? 'continue-child' : 'wait-child',
        name: toolResults.length === 0 ? 'agent_message' : 'agent_wait',
        arguments:
          toolResults.length === 0
            ? { agentId: this.childSessionId, message: 'Inspect input.txt again' }
            : { agentId: this.childSessionId, waitMs: 10_000 }
      };
      if (toolResults.length === 0) yield { type: 'usage', usage: { outputTokens: 80 } };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    const wait = waitForNewChild(request);
    if (wait) {
      yield wait;
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (toolResults.length > 0) {
      yield { type: 'text.completed', itemId: 'parent-final', text: 'parent staged result' };
      yield { type: 'usage', usage: { outputTokens: 10 } };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    yield {
      type: 'client_tool.call',
      callId: 'parent-task',
      name: 'agent_start',
      arguments: {
        description: 'Inspect input',
        prompt: 'Inspect input.txt',
        role: this.role
      }
    };
    yield { type: 'usage', usage: { outputTokens: 80 } };
    yield { type: 'completed', reason: 'tool_use' };
  }
}

class DetachedBackgroundSubagentBudgetAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  readonly childFirstRequest: Promise<void>;
  readonly childSecondRequest: Promise<void>;
  #releaseChild!: () => void;
  #resolveChildFirstRequest!: () => void;
  #resolveChildSecondRequest!: () => void;

  constructor(readonly parentOutputTokens = 0) {
    this.childFirstRequest = new Promise<void>(
      (resolve) => (this.#resolveChildFirstRequest = resolve)
    );
    this.childSecondRequest = new Promise<void>(
      (resolve) => (this.#resolveChildSecondRequest = resolve)
    );
  }

  releaseChild(): void {
    this.#releaseChild();
  }

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const child = effectiveInstructions(request).includes('non-recursive subagent');
    if (child) {
      const childRequests = this.requests.filter((item) =>
        effectiveInstructions(item).includes('non-recursive subagent')
      );
      if (childRequests.length === 1) {
        this.#resolveChildFirstRequest();
        await new Promise<void>((resolve) => (this.#releaseChild = resolve));
        yield {
          type: 'client_tool.call',
          callId: 'background-child-read',
          name: 'read',
          arguments: { reads: [{ path: 'input.txt' }] }
        };
        yield { type: 'usage', usage: { outputTokens: 101 } };
        yield { type: 'completed', reason: 'tool_use' };
        return;
      }
      this.#resolveChildSecondRequest();
      yield {
        type: 'text.completed',
        itemId: 'background-child-final',
        text: 'background child done'
      };
      yield { type: 'completed', reason: 'completed' };
      return;
    }

    const currentPrompt = request.messages.findLast(
      (message) => message.role === 'user' && message.contextKind === undefined
    )?.content;
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (currentPrompt === 'delegate in background' && !hasToolResult) {
      yield {
        type: 'client_tool.call',
        callId: 'background-parent-task',
        name: 'agent_start',
        arguments: {
          description: 'Inspect input in background',
          prompt: 'Inspect input.txt after the parent completes.',
          role: 'general-purpose'
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (currentPrompt === 'delegate in background') await this.childFirstRequest;
    yield { type: 'text.completed', itemId: 'background-parent-final', text: 'parent done' };
    yield { type: 'usage', usage: { outputTokens: this.parentOutputTokens } };
    yield { type: 'completed', reason: 'completed' };
  }
}

class DisabledBudgetAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  async *start(): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls <= 3) {
      yield {
        type: 'client_tool.call',
        callId: `read-${this.calls}`,
        name: 'read',
        arguments: { reads: [{ path: 'input.txt' }] }
      };
      yield { type: 'usage', usage: { outputTokens: 1_000_000 } };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'final', text: 'budget disabled' };
    yield { type: 'completed', reason: 'completed' };
  }
}

describe('Execution usage without token limits', () => {
  it('completes more than 128 tool rounds above the former cumulative token limit', async () => {
    const { home, workspace } = await fixture('long-execution');
    const adapter = new LongExecutionAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );

    await expect(
      (await agent.createSession({ workspace, title: 'Long execution' }))
        .run({ prompt: 'continue' })
        .result()
    ).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'finished after 129 tool rounds'
    });
    expect(adapter.calls).toBe(130);
    await agent.dispose();
  });

  it('accepts final answers regardless of provider budget units', async () => {
    const { home, workspace } = await fixture('final-boundary');
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => new FinalAtBudgetAdapter()
    );

    const handle = (await agent.createSession({ workspace, title: 'Final boundary' })).run({
      prompt: 'finish'
    });
    const events: AgentEvent[] = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({
      status: 'completed'
    });
    expect(events.find((event) => event.type === 'usage.updated')).not.toHaveProperty(
      'rolloutBudgetUnits'
    );
    await agent.dispose();
  });

  it('persists every tool result and continues after the former configured token limit', async () => {
    const { home, workspace } = await fixture('tool-boundary');
    const adapter = new ToolAtBudgetAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );
    const session = await agent.createSession({ workspace, title: 'Tool boundary' });
    const handle = session.run({ prompt: 'read twice' });
    const events: AgentEvent[] = [];
    for await (const event of handle) events.push(event);

    expect(await handle.result()).toMatchObject({
      status: 'completed'
    });
    expect(adapter.calls).toBe(2);
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'execution.failed')).toHaveLength(0);

    const store = await JsonlSessionStore.open(home);
    const records = await store.read(session.id);
    await store.close();
    expect(
      records.filter(
        (record) =>
          record.type === 'model.context' &&
          (record.payload as Record<string, unknown>).role === 'tool'
      )
    ).toHaveLength(2);
    await expect(session.run({ prompt: 'continue' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'staged result after tools'
    });
    expect(adapter.calls).toBe(3);
    await agent.dispose();
  });

  it('keeps request prefixes and tools stable without forced finalization guidance', async () => {
    const { home, workspace } = await fixture('stages');
    const adapter = new StagedPromptAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [adapter.configuration]
      },
      () => adapter
    );

    await expect(
      (await agent.createSession({ workspace, title: 'Stages' })).run({ prompt: 'work' }).result()
    ).resolves.toMatchObject({
      status: 'completed'
    });

    expect(adapter.requests).toHaveLength(5);
    expect(adapter.requests.slice(0, 4).map((request) => request.system)).toEqual([
      adapter.requests[0]!.system,
      adapter.requests[0]!.system,
      adapter.requests[0]!.system,
      adapter.requests[0]!.system
    ]);
    for (const request of adapter.requests) {
      expect(request.system).not.toMatch(/Execution budget|rollout budget/iu);
      expect(request.tools).toEqual(adapter.requests[0]!.tools);
      expect(request.allowTools).toBeUndefined();
      expect(request.promptCacheKey).toBe(adapter.requests[0]!.promptCacheKey);
      expect(request.toolChoice).toBe(adapter.requests[0]!.toolChoice);
    }
    for (const request of adapter.requests)
      expect(JSON.stringify(request.messages)).not.toContain('execution_guidance');
    expect(adapter.requests.at(-1)?.tools).toEqual(adapter.requests[0]!.tools);
    await agent.dispose();
  });

  it.each([6_000, 10_000])(
    'continues after automatic Compact with %i output tokens',
    async (compactOutputTokens) => {
      const { home, workspace } = await fixture('compact');
      const compactModel = { ...model, contextWindowTokens: 9_000, maxOutputTokens: 1_000 };
      const adapter = new CompactBudgetAdapter(compactModel, compactOutputTokens);
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [compactModel]
        },
        () => adapter
      );
      const session = await agent.createSession({ workspace, title: 'Compact budget' });
      const events: AgentEvent[] = [];
      const seed = session.run({ prompt: 'seed' });
      for await (const event of seed) events.push(event);
      await expect(seed.result()).resolves.toMatchObject({
        status: 'completed'
      });
      const second = session.run({ prompt: 'continue' });
      for await (const event of second) events.push(event);

      expect(await second.result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'staged result after compact budget'
      });
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'context.compacted' })])
      );
      expect(adapter.normalCalls).toBe(3);
      expect(adapter.requests).toHaveLength(4);
      expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
      await agent.dispose();
    }
  );

  it('commits manual Compact regardless of cumulative usage', async () => {
    const { home, workspace } = await fixture('manual-compact');
    const adapter = new CompactBudgetAdapter(model, 10_000);
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );
    const session = await agent.createSession({ workspace, title: 'Manual compact budget' });
    await session.run({ prompt: 'seed' }).result();
    const handle = session.compact();
    const events: AgentEvent[] = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({
      status: 'completed'
    });
    expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
    expect(adapter.requests).toHaveLength(2);
    const store = await JsonlSessionStore.open(home);
    const records = await store.read(session.id);
    await store.close();
    expect(records.some((record) => record.type === 'compact.completed')).toBe(true);
    await agent.dispose();
  });

  it.each(['general-purpose', 'explore'] as const)(
    'does not budget %s child turns or charge their usage to the parent',
    async (role) => {
      const { home, workspace } = await fixture('subagent');
      const adapter = new SubagentBudgetAdapter(role);
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model]
        },
        () => adapter
      );
      const session = await agent.createSession({ workspace, title: 'Subagent budget' });
      const handle = session.run({
        prompt: 'delegate'
      });
      const events: AgentEvent[] = [];
      for await (const event of handle) events.push(event);

      expect(await handle.result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'parent staged result'
      });
      const childRequests = adapter.requests.filter((request) =>
        effectiveInstructions(request).includes('non-recursive subagent')
      );
      const parentRequests = adapter.requests.filter(
        (request) => !effectiveInstructions(request).includes('non-recursive subagent')
      );
      expect(childRequests).toHaveLength(2);
      expect(parentRequests).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'subagent.completed',
            status: 'completed'
          }),
          expect.objectContaining({ type: 'tool.completed', callId: 'parent-task' })
        ])
      );
      const childEvent = events.find((event) => event.type === 'subagent.completed');
      if (childEvent?.type !== 'subagent.completed') throw new Error('Missing child completion');
      adapter.childSessionId = childEvent.agentId;

      await expect(session.run({ prompt: 'continue child' }).result()).resolves.toMatchObject({
        status: 'completed',
        finalAnswer: 'parent staged result'
      });
      const allChildRequests = adapter.requests.filter((request) =>
        effectiveInstructions(request).includes('non-recursive subagent')
      );
      expect(allChildRequests).toHaveLength(4);
      for (const request of allChildRequests) {
        expect(request.system).not.toContain('rollout budget');
        expect(JSON.stringify(request.messages)).not.toContain('execution_guidance');
      }
      expect(
        adapter.requests
          .filter((request) => !effectiveInstructions(request).includes('non-recursive subagent'))
          .some((request) => JSON.stringify(request.messages).includes('execution_guidance'))
      ).toBe(false);

      const store = await JsonlSessionStore.open(home);
      try {
        const records = await store.read(childEvent.agentId);
        expect(records.filter((record) => record.type === 'usage.updated')).toHaveLength(4);
        expect(records.filter((record) => record.type === 'execution.completed')).toHaveLength(2);
        expect(records.filter((record) => record.type === 'execution.failed')).toHaveLength(0);
      } finally {
        await store.close();
      }
      await agent.dispose();
    }
  );

  it('does not budget native Extension child turns or follow-up messages', async () => {
    const { home, workspace } = await fixture('native-subagent');
    const childAdapter = new SubagentBudgetAdapter('general-purpose');
    let api: ExtensionAgentsApi | undefined;
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        extensions: [
          {
            id: 'native-budget-regression',
            apiVersion: '1.0',
            attachSession: (context) => {
              if (context.agents) api = context.agents;
            }
          }
        ]
      },
      () => ({
        configuration: model,
        async *start(request) {
          if (effectiveInstructions(request).includes('non-recursive subagent')) {
            yield* childAdapter.start(request);
            return;
          }
          yield { type: 'text.completed', itemId: 'parent-final', text: 'parent done' };
          yield { type: 'usage', usage: { outputTokens: 90 } };
          yield { type: 'completed', reason: 'completed' };
        }
      })
    );
    try {
      const session = await agent.createSession({ workspace, title: 'Native child budget' });
      await expect(session.run({ prompt: 'initialize' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      if (!api) throw new Error('Missing native Agent API');
      const child = await api.spawn({ prompt: 'Inspect input.txt', waitFor: 'completion' });
      if (!('agentId' in child)) throw new Error('Missing native child');
      expect(child).toMatchObject({ status: 'completed', summary: 'child done' });
      await api.message({ agentId: child.agentId, message: 'Inspect input.txt again' });
      await expect(api.wait({ agentId: child.agentId, untilSettled: true })).resolves.toMatchObject(
        { status: 'completed', summary: 'child done' }
      );
      expect(childAdapter.requests).toHaveLength(4);
      for (const request of childAdapter.requests)
        expect(JSON.stringify(request.messages)).not.toContain('execution_guidance');
      const store = await JsonlSessionStore.open(home);
      try {
        const records = await store.read(child.agentId);
        expect(records.filter((record) => record.type === 'usage.updated')).toHaveLength(4);
        expect(records.filter((record) => record.type === 'execution.completed')).toHaveLength(2);
        expect(records.filter((record) => record.type === 'execution.failed')).toHaveLength(0);
      } finally {
        await store.close();
      }
    } finally {
      await agent.dispose();
    }
  });

  it('does not budget reopened child runs or automatic and manual Compact', async () => {
    const { home, workspace } = await fixture('subagent-compact');
    let adapter: ModelAdapter = new SubagentBudgetAdapter('general-purpose');
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );
    try {
      const parent = await agent.createSession({ workspace, title: 'Child compact budget' });
      const handle = parent.run({ prompt: 'delegate' });
      const events: AgentEvent[] = [];
      for await (const event of handle) events.push(event);
      expect(await handle.result()).toMatchObject({ status: 'completed' });
      const childEvent = events.find((event) => event.type === 'subagent.completed');
      if (childEvent?.type !== 'subagent.completed') throw new Error('Missing child completion');

      const compactModel = { ...model, contextWindowTokens: 9_000, maxOutputTokens: 1_000 };
      const compactAdapter = new CompactBudgetAdapter(compactModel, 10_000);
      adapter = compactAdapter;
      agent.reconfigureModels({ models: [compactModel] });
      const child = await agent.openSession(childEvent.agentId);
      const childEvents: AgentEvent[] = [];
      const seed = child.run({ prompt: 'seed' });
      for await (const event of seed) childEvents.push(event);
      await expect(seed.result()).resolves.toMatchObject({
        status: 'completed'
      });
      const continuation = child.run({ prompt: 'continue' });
      for await (const event of continuation) childEvents.push(event);
      expect(await continuation.result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'staged result after compact budget'
      });
      expect(childEvents).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'context.compacted' })])
      );
      expect(compactAdapter.normalCalls).toBe(3);
      await expect(child.compact().result()).resolves.toMatchObject({ status: 'completed' });
      expect(
        compactAdapter.requests.filter((request) => request.toolChoice === 'none')
      ).toHaveLength(2);
      for (const request of compactAdapter.requests)
        expect(JSON.stringify(request.messages)).not.toContain('execution_guidance');
    } finally {
      await agent.dispose();
    }
  });

  it.each([0, 101])(
    'keeps a background child unbudgeted after the parent settles with %i tokens',
    async (parentOutputTokens) => {
      const { home, workspace } = await fixture('background-subagent-detached');
      const adapter = new DetachedBackgroundSubagentBudgetAdapter(parentOutputTokens);
      let api: ExtensionAgentsApi | undefined;
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model],
          extensions: [
            {
              id: 'background-budget-regression',
              apiVersion: '1.0',
              attachSession: (context) => {
                if (context.agents) api = context.agents;
              }
            }
          ]
        },
        () => adapter
      );
      try {
        const handle = (await agent.createSession({ workspace, title: 'Background budget' })).run({
          prompt: 'delegate in background'
        });
        await adapter.childFirstRequest;
        await expect(handle.result()).resolves.toMatchObject({
          status: 'completed',
          finalAnswer: 'parent done'
        });

        adapter.releaseChild();
        await adapter.childSecondRequest;
        if (!api) throw new Error('Missing native Agent API');
        const children = await api.list();
        expect(children).toHaveLength(1);
        await expect(
          api.wait({ agentId: children[0]!.agentId, untilSettled: true })
        ).resolves.toMatchObject({ status: 'completed', summary: 'background child done' });

        const childRequests = adapter.requests.filter((request) =>
          effectiveInstructions(request).includes('non-recursive subagent')
        );
        expect(childRequests).toHaveLength(2);
        expect(childRequests[0]!.system).not.toContain('rollout budget');
        expect(JSON.stringify(childRequests[0]!.messages)).not.toContain('execution_guidance');
        expect(childRequests[1]!.system).not.toContain('rollout budget');
        expect(JSON.stringify(childRequests[1]!.messages)).not.toContain('execution_guidance');
        expect(childRequests[1]!.tools.map((tool) => tool.name)).toContain('read');
        expect(childRequests[1]!.allowTools).not.toBe(false);
      } finally {
        adapter.releaseChild();
        await agent.dispose();
      }
    }
  );

  it('does not impose a cumulative budget during high-usage runs', async () => {
    const { home, workspace } = await fixture('disabled');
    const adapter = new DisabledBudgetAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );

    await expect(
      (await agent.createSession({ workspace, title: 'Budget disabled' }))
        .run({ prompt: 'continue' })
        .result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'budget disabled' });
    expect(adapter.calls).toBe(4);
    await agent.dispose();
  });

  it('completes a final answer without a cumulative budget', async () => {
    const { home, workspace } = await fixture('invalid');

    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => new FinalAtBudgetAdapter()
    );
    await expect(
      (await agent.createSession({ workspace })).run({ prompt: 'finish' }).result()
    ).resolves.toMatchObject({ status: 'completed' });
    await agent.dispose();
  });
});
