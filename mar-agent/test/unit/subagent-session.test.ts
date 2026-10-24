import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalAgentHost,
  SecretValue,
  openMarAgentSessionCatalog,
  type MarAgentEvent,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import { createSubagentBackend } from '../../src/agent-core/sdk/subagent-backend.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest
} from '../../src/agent-core/model/contracts.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { effectiveInstructions } from './support/model-context.js';
import {
  SubagentSessionController,
  type SubagentTurnHandle
} from '../../src/agent-core/subagent/session-controller.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

const model: MarAgentModelConfiguration = {
  id: 'review',
  name: 'Review Agent',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'review-provider',
  contextWindowTokens: 10_000,
  maxOutputTokens: 1_000,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'low',
  hostedWebSearch: false,
  enabled: true
};

interface SharedAdapterState {
  requests: ModelRequest[];
  delivery?: 'append' | 'replace';
  childStarted?: Promise<void>;
  resolveChildStarted?: () => void;
  releaseChild?: Promise<void>;
  resolveReleaseChild?: () => void;
}

class PersistentSubagentAdapter implements ModelAdapter {
  readonly configuration = model;

  constructor(
    private readonly state: SharedAdapterState,
    private readonly blockFirstChildResponse = false
  ) {}

  async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.state.requests.push(request);
    const child = effectiveInstructions(request).includes('non-recursive subagent');
    const currentPrompt = currentPromptFrom(request.messages);
    const toolResultAfterPrompt = request.messages
      .slice(lastPromptIndex(request.messages, currentPrompt) + 1)
      .some((message) => message.role === 'tool');

    if (child) {
      if (
        this.blockFirstChildResponse &&
        currentPrompt === 'Inspect alpha without inheriting parent history.' &&
        !request.messages.some(
          (message) => message.role === 'user' && message.content === 'Injected guidance.'
        )
      ) {
        this.state.resolveChildStarted?.();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          void this.state.releaseChild?.then(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          });
          if (signal.aborted) abort();
        });
        yield {
          type: 'text.completed',
          itemId: 'child-before-mailbox',
          phase: 'final_answer',
          text: 'first response before mailbox'
        };
        yield { type: 'completed', reason: 'completed' };
        return;
      }
      const followUp = request.messages.findLast(
        (message) =>
          message.role === 'user' &&
          (message.content === 'Continue with beta.' || message.content === 'Injected guidance.')
      )?.content;
      yield {
        type: 'text.completed',
        itemId: followUp ? 'child-follow-up' : 'child-first',
        phase: 'final_answer',
        text:
          followUp === 'Injected guidance.'
            ? 'mailbox applied'
            : followUp === 'Continue with beta.'
              ? 'child second'
              : 'child first'
      };
      yield { type: 'completed', reason: 'completed' };
      return;
    }

    if (!toolResultAfterPrompt) {
      if (currentPrompt === 'start child') {
        yield {
          type: 'client_tool.call',
          callId: 'start-child',
          name: 'agent_start',
          arguments: {
            description: 'Inspect alpha',
            prompt: 'Inspect alpha without inheriting parent history.',
            role: 'explore',
            modelId: 'review',
            reasoningEffort: 'high'
          }
        };
        yield { type: 'completed', reason: 'tool_use' };
        return;
      }
      if (currentPrompt === 'continue child' || currentPrompt === 'inject child') {
        yield {
          type: 'client_tool.call',
          callId: currentPrompt === 'inject child' ? 'inject-child' : 'continue-child',
          name: 'agent_message',
          arguments: {
            agentId: latestAgentId(request.messages),
            message:
              currentPrompt === 'inject child' ? 'Injected guidance.' : 'Continue with beta.',
            ...(this.state.delivery ? { delivery: this.state.delivery } : {})
          }
        };
        yield { type: 'completed', reason: 'tool_use' };
        return;
      }
      if (currentPrompt === 'wait child') {
        yield {
          type: 'client_tool.call',
          callId: 'wait-child',
          name: 'agent_wait',
          arguments: { waitMs: 10_000 }
        };
        yield { type: 'completed', reason: 'tool_use' };
        return;
      }
    }
    yield {
      type: 'text.completed',
      itemId: `parent-${currentPrompt}`,
      phase: 'final_answer',
      text: 'parent done'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class InterruptedSubagentAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly agentId: string) {}

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (effectiveInstructions(request).includes('non-recursive subagent')) {
      yield {
        type: 'text.completed',
        itemId: 'resumed-child',
        phase: 'final_answer',
        text: 'resumed child done'
      };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    const currentPrompt =
      request.messages.findLast(
        (message) => message.role === 'user' && message.contextKind === undefined
      )?.content ?? '';
    const toolResultAfterPrompt = request.messages
      .slice(lastPromptIndex(request.messages, currentPrompt) + 1)
      .some((message) => message.role === 'tool');
    if (!toolResultAfterPrompt && currentPrompt === 'resume interrupted child') {
      yield {
        type: 'client_tool.call',
        callId: 'resume-interrupted-child',
        name: 'agent_message',
        arguments: { agentId: this.agentId, message: 'Continue after interruption.' }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (!toolResultAfterPrompt && currentPrompt === 'wait interrupted child') {
      yield {
        type: 'client_tool.call',
        callId: 'wait-interrupted-child',
        name: 'agent_wait',
        arguments: { agentId: this.agentId, waitMs: 10_000 }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield {
      type: 'text.completed',
      itemId: `parent-${currentPrompt}`,
      phase: 'final_answer',
      text: 'parent done'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ForeignSubagentControlAdapter implements ModelAdapter {
  readonly configuration = model;

  constructor(private readonly agentId: string) {}

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    const currentPrompt =
      request.messages.findLast(
        (message) => message.role === 'user' && message.contextKind === undefined
      )?.content ?? '';
    const toolResultAfterPrompt = request.messages
      .slice(lastPromptIndex(request.messages, currentPrompt) + 1)
      .some((message) => message.role === 'tool');
    if (!toolResultAfterPrompt) {
      const toolName = currentPrompt.replace('try foreign ', '');
      yield {
        type: 'client_tool.call',
        callId: `foreign-${toolName}`,
        name: `agent_${toolName}`,
        arguments:
          toolName === 'message'
            ? { agentId: this.agentId, message: 'Cross-session injection.' }
            : toolName === 'wait'
              ? { agentId: this.agentId, waitMs: 0 }
              : { agentId: this.agentId }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield {
      type: 'text.completed',
      itemId: `foreign-${currentPrompt}`,
      phase: 'final_answer',
      text: 'foreign control rejected'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class FailingSubagentAdapter implements ModelAdapter {
  readonly configuration = model;

  // eslint-disable-next-line require-yield -- This fixture fails or waits for cancellation without emitting model events.
  async *start(): AsyncIterable<ModelEvent> {
    throw new Error('Simulated child model failure.');
  }
}

class FailureBoundaryHost extends LocalAgentHost {
  readonly failureObserved: Promise<void>;
  readonly #releaseFailure: Promise<void>;
  #resolveFailureObserved!: () => void;
  #resolveReleaseFailure!: () => void;

  constructor(homeDirectory: string, workspace: string) {
    super({ homeDirectory, workspace });
    this.failureObserved = new Promise<void>((resolve) => {
      this.#resolveFailureObserved = resolve;
    });
    this.#releaseFailure = new Promise<void>((resolve) => {
      this.#resolveReleaseFailure = resolve;
    });
  }

  override async emit(event: MarAgentEvent): Promise<void> {
    super.emit(event);
    if (event.type !== 'execution.failed') return;
    this.#resolveFailureObserved();
    await this.#releaseFailure;
  }

  releaseFailure(): void {
    this.#resolveReleaseFailure();
  }
}

describe('persistent subagent sessions', () => {
  it.each(['deleted', 'corrupt', 'unreadable'] as const)(
    'handles %s child history after reading its metadata',
    async (scenario) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-subagent-lazy-race-'));
      roots.push(home);
      const store = await JsonlSessionStore.open(home);
      const parent = await store.createSession({ workspace: home });
      const backend = createSubagentBackend(store, home);
      const child = await backend.createSession({
        title: 'Historical child',
        source: {
          type: 'subagent',
          parentSessionId: parent.id,
          rootSessionId: parent.id,
          parentExecutionId: 'origin',
          role: 'explore',
          description: 'Historical child'
        }
      });
      const controller = await SubagentSessionController.open({
        parentSessionId: parent.id,
        rootSessionId: parent.id,
        backend
      });
      const getSession = store.getSession.bind(store);
      const metadata = vi.spyOn(store, 'getSession').mockImplementationOnce(async (id) => {
        const snapshot = await getSession(id);
        if (scenario === 'deleted') await store.delete(id);
        if (scenario === 'corrupt')
          await writeFile(
            join(home, '.mar', 'agent', 'sessions', id, 'events-000001.jsonl'),
            '{broken}\n{}\n'
          );
        if (scenario === 'unreadable') {
          const path = join(home, '.mar', 'agent', 'sessions', id, 'events-000001.jsonl');
          await rm(path);
          await mkdir(path);
        }
        return snapshot;
      });
      try {
        const pending = controller.prepareSessionResources();
        if (scenario === 'deleted') {
          await expect(pending).resolves.toBeUndefined();
          expect(controller.listSessionResources()).toEqual([]);
          await expect(controller.inspect(child.id)).rejects.toMatchObject({
            code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
          });
        } else if (scenario === 'corrupt')
          await expect(pending).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
        else
          await expect(pending).rejects.toMatchObject({
            code: 'MAR_AGENT_SESSION_NOT_FOUND',
            cause: { code: 'EISDIR' }
          });
      } finally {
        metadata.mockRestore();
        await controller.dispose();
        await store.close();
      }
    }
  );

  it('projects every active Subagent before a bounded set of recent terminal Sessions', async () => {
    const terminalChildren = Array.from({ length: 20 }, (_, index) => ({
      id: `terminal-${index}`,
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      lastActivityAt:
        index === 0
          ? '2026-01-01T00:00:59.000Z'
          : `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      source: {
        type: 'subagent' as const,
        parentSessionId: 'parent',
        rootSessionId: 'parent',
        parentExecutionId: `parent-${index}`,
        role: 'explore' as const,
        description: `Terminal ${index}`
      },
      records: [
        {
          type: 'event',
          sequence: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: `terminal-${index}`,
          executionId: `execution-${index}`,
          payload: { type: 'execution.completed' }
        }
      ]
    }));
    let resolveActive!: () => void;
    const activeResult = new Promise<void>((resolve) => (resolveActive = resolve));
    const controller = await SubagentSessionController.open({
      parentSessionId: 'parent',
      rootSessionId: 'parent',
      backend: {
        createSession: async () => ({ id: 'active-agent' }),
        deleteSession: async () => undefined,
        listChildren: async () => terminalChildren as never,
        loadChild: async (_parent, id) => terminalChildren.find((child) => child.id === id) as never
      }
    });
    await controller.beginParentExecution({
      executionId: 'parent-execution',
      modelId: 'review',
      reasoningEffort: 'low',
      models: new Map([
        [
          'review',
          {
            id: 'review',
            name: 'Review Agent',
            reasoningEfforts: ['low'],
            defaultReasoningEffort: 'low'
          }
        ]
      ]),
      emitTerminal: async () => undefined,
      startTurn: async () => ({
        executionId: 'child-execution',
        turnId: 'child-turn',
        async *[Symbol.asyncIterator]() {},
        result: async () => {
          await activeResult;
          return {
            executionId: 'child-execution',
            status: 'completed' as const,
            finalAnswer: 'done'
          };
        },
        cancel: resolveActive,
        enqueueMessage: () => false
      })
    });
    await controller.run({
      description: 'Active work',
      prompt: 'Keep working.',
      role: 'explore',
      background: true
    });

    await controller.prepareSessionResources();
    expect(controller.listSessionResources()).toEqual([
      { agentId: 'active-agent', status: 'running', description: 'Active work' },
      ...[0, ...Array.from({ length: 15 }, (_, i) => 19 - i)].map((index) => {
        return {
          agentId: `terminal-${index}`,
          status: 'completed',
          description: `Terminal ${index}`
        };
      })
    ]);

    resolveActive();
    await controller.dispose();
  });

  it('persists an independent child Session and reuses it for a later idle Turn', async () => {
    const { home, workspace } = await fixture('persistent');
    let resolveChildStarted!: () => void;
    let resolveReleaseChild!: () => void;
    const state: SharedAdapterState = {
      requests: [],
      childStarted: new Promise<void>((resolve) => (resolveChildStarted = resolve)),
      releaseChild: new Promise<void>((resolve) => (resolveReleaseChild = resolve)),
      resolveChildStarted,
      resolveReleaseChild
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => new PersistentSubagentAdapter(state, true)
    });
    const root = await agent.createSession({ workspace, title: 'Root' });

    const started = await runAndCollect(root.run({ prompt: 'start child' }));
    const startTool = started.events.find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_start'
    );
    expect(startTool).toMatchObject({
      type: 'tool.completed',
      data: {
        description: 'Inspect alpha',
        modelId: 'review',
        modelName: 'Review Agent',
        reasoningEffort: 'high'
      }
    });
    const agentId =
      startTool?.type === 'tool.completed' &&
      startTool.data &&
      'agentId' in startTool.data &&
      typeof startTool.data.agentId === 'string'
        ? startTool.data.agentId
        : '';
    expect(agentId).not.toBe('');

    await state.childStarted;
    state.resolveReleaseChild?.();
    const firstWait = await runAndCollect(root.run({ prompt: 'wait child' }));
    const completionIndex = firstWait.events.findIndex(
      (event) => event.type === 'subagent.completed' && event.agentId === agentId
    );
    const waitResultIndex = firstWait.events.findIndex(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
    );
    expect(completionIndex).toBeGreaterThanOrEqual(0);
    expect(waitResultIndex).toBeGreaterThan(completionIndex);
    expect(firstWait.events[completionIndex]).toMatchObject({
      type: 'subagent.completed',
      latestActivity: {
        kind: 'message',
        phase: 'final_answer'
      }
    });
    const repeatedWait = await runAndCollect(root.run({ prompt: 'wait child' }));
    expect(repeatedWait.events.filter((event) => event.type === 'subagent.completed')).toEqual([]);
    expect(
      repeatedWait.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      )
    ).toMatchObject({ type: 'tool.completed', data: { agentId, status: 'completed' } });
    expect(
      repeatedWait.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      )
    ).not.toHaveProperty('data.latestMessage');
    expect(
      repeatedWait.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      )
    ).not.toHaveProperty('data.summary');
    expect(
      repeatedWait.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      )
    ).not.toHaveProperty('data.verification');
    const continued = await runAndCollect(root.run({ prompt: 'continue child' }));
    expect(
      continued.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_message'
      )
    ).toMatchObject({
      type: 'tool.completed',
      data: {
        agentId,
        status: expect.stringMatching(/queued|running|completed/u)
      }
    });
    expect(
      continued.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_message'
      )
    ).not.toHaveProperty('data.latestMessage');
    const waited = await runAndCollect(root.run({ prompt: 'wait child' }));
    expect(
      waited.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      )
    ).toMatchObject({
      type: 'tool.completed',
      data: {
        agentId,
        status: 'completed',
        modelId: 'review',
        modelName: 'Review Agent',
        reasoningEffort: 'high'
      }
    });

    await expect(agent.listSessions()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: root.id, source: { type: 'user' } })]
    });
    await expect(
      agent.listSessions({ source: 'subagent', parentSessionId: root.id })
    ).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          id: agentId,
          source: expect.objectContaining({
            type: 'subagent',
            parentSessionId: root.id,
            rootSessionId: root.id,
            description: 'Inspect alpha'
          })
        })
      ]
    });

    expect(parentEvidence(state.requests)).toContain('child second');
    const childRequests = state.requests.filter((request) =>
      effectiveInstructions(request).includes('non-recursive subagent')
    );
    expect(childRequests).toHaveLength(2);
    expect(effectiveInstructions(childRequests[0]!)).toContain('preserve their changes');
    expect(effectiveInstructions(childRequests[0]!)).toContain(
      'report an exact conflict or blocker'
    );
    expect(effectiveInstructions(childRequests[0]!)).toContain('useful evidence paths');
    expect(effectiveInstructions(childRequests[0]!)).toContain(
      'tests actually run and their outcomes'
    );
    expect(childRequests[0]?.messages.some((message) => message.content === 'start child')).toBe(
      false
    );
    expect(childRequests[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['todo_read', 'todo_write'])
    );
    const childToolNames = childRequests[0]?.tools.map((tool) => tool.name) ?? [];
    for (const forbidden of [
      'agent_start',
      'agent_wait',
      'agent_message',
      'agent_cancel',
      'question',
      'codex_image_gen',
      'byted_ark_image_gen'
    ])
      expect(childToolNames).not.toContain(forbidden);
    expect(childRequests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'Inspect alpha without inheriting parent history.'
        }),
        expect.objectContaining({ role: 'assistant', content: 'first response before mailbox' }),
        expect.objectContaining({ role: 'user', content: 'Continue with beta.' })
      ])
    );

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(catalog.history(agentId)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          kind: 'user',
          text: 'Inspect alpha without inheriting parent history.'
        }),
        expect.objectContaining({ kind: 'user', text: 'Continue with beta.' }),
        expect.objectContaining({
          kind: 'event',
          event: expect.objectContaining({ type: 'message.completed', text: 'child second' })
        })
      ])
    });
    await catalog.close();

    const store = await JsonlSessionStore.open(home);
    const child = await store.getSession(agentId);
    expect(child.source).toMatchObject({ type: 'subagent', parentSessionId: root.id });
    expect(
      (await store.read(agentId)).findLast((record) => record.type === 'execution.header')?.payload
    ).toMatchObject({
      modelId: 'review',
      modelName: 'Review Agent',
      reasoningEffort: 'high'
    });
    await store.close();
    await agent.dispose();
  });

  it('restores a persisted child Session and continues it after the Agent restarts', async () => {
    const { home, workspace } = await fixture('restart');
    await writeFile(join(workspace, 'AGENTS.md'), 'SUBAGENT_RESTART_RULE');
    const state: SharedAdapterState = { requests: [] };
    let agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => new PersistentSubagentAdapter(state)
    });
    const root = await agent.createSession({ workspace, title: 'Root' });

    const started = await runAndCollect(root.run({ prompt: 'start child' }));
    const startTool = started.events.find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_start'
    );
    const agentId =
      startTool?.type === 'tool.completed' &&
      startTool.data &&
      'agentId' in startTool.data &&
      typeof startTool.data.agentId === 'string'
        ? startTool.data.agentId
        : '';
    expect(agentId).not.toBe('');
    await runAndCollect(root.run({ prompt: 'wait child' }));
    await agent.dispose();

    agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => new PersistentSubagentAdapter(state)
    });
    const read = vi.spyOn(JsonlSessionStore.prototype, 'read');
    let reopened;
    try {
      reopened = await agent.openSession(root.id);
      expect(read.mock.calls.filter(([id]) => id === agentId)).toEqual([]);
    } finally {
      read.mockRestore();
    }
    await runAndCollect(reopened.run({ prompt: 'continue child' }));
    const waited = await runAndCollect(reopened.run({ prompt: 'wait child' }));

    expect(
      waited.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      )
    ).toMatchObject({
      type: 'tool.completed',
      data: {
        agentId,
        status: 'completed'
      }
    });
    expect(parentEvidence(state.requests)).toContain('child second');
    const childRequests = state.requests.filter((request) =>
      effectiveInstructions(request).includes('non-recursive subagent')
    );
    expect(childRequests).toHaveLength(2);
    expect(
      childRequests[0]?.messages.some((message) =>
        message.content.includes('SUBAGENT_RESTART_RULE')
      )
    ).toBe(true);
    expect(childRequests[1]?.messages.slice(0, childRequests[0]!.messages.length)).toEqual(
      childRequests[0]?.messages
    );
    expect(
      childRequests[1]?.messages.filter((message) =>
        message.content.includes('SUBAGENT_RESTART_RULE')
      )
    ).toHaveLength(1);
    expect(childRequests.at(-1)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'Inspect alpha without inheriting parent history.'
        }),
        expect.objectContaining({ role: 'assistant', content: 'child first' }),
        expect.objectContaining({ role: 'user', content: 'Continue with beta.' })
      ])
    );
    await agent.dispose();
  });

  it('continues an interrupted child Turn through agent_message after restart', async () => {
    const { home, workspace } = await fixture('interrupted-restart');
    const store = await JsonlSessionStore.open(home);
    const root = await store.createSession({ workspace, title: 'Root' });
    const child = await store.createSession({
      workspace,
      title: 'Interrupted child',
      source: {
        type: 'subagent',
        parentSessionId: root.id,
        rootSessionId: root.id,
        parentExecutionId: 'previous-parent-execution',
        role: 'general-purpose',
        description: 'Interrupted child'
      }
    });
    await store.append(child.id, {
      type: 'execution.header',
      payload: {
        modelId: 'review',
        modelName: 'Review Agent',
        reasoningEffort: 'high'
      },
      executionId: 'interrupted-execution',
      turnId: 'interrupted-turn'
    });
    await store.append(child.id, {
      type: 'turn.user',
      payload: { prompt: 'Original interrupted work.', inputSource: 'parent_agent' },
      executionId: 'interrupted-execution',
      turnId: 'interrupted-turn'
    });
    await store.append(child.id, {
      type: 'execution.started',
      payload: { type: 'execution.started' },
      executionId: 'interrupted-execution',
      turnId: 'interrupted-turn'
    });
    await store.close();

    const adapter = new InterruptedSubagentAdapter(child.id);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const reopened = await agent.openSession(root.id);

    const resumed = await runAndCollect(reopened.run({ prompt: 'resume interrupted child' }));
    expect(
      resumed.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_message'
      )
    ).toMatchObject({
      type: 'tool.completed',
      data: {
        agentId: child.id,
        status: expect.stringMatching(/running|completed/u),
        modelId: 'review',
        modelName: 'Review Agent',
        reasoningEffort: 'high'
      }
    });
    const waited = await runAndCollect(reopened.run({ prompt: 'wait interrupted child' }));
    expect(
      waited.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      )
    ).toMatchObject({
      type: 'tool.completed',
      data: {
        agentId: child.id,
        status: 'completed'
      }
    });
    expect(parentEvidence(adapter.requests)).toContain('resumed child done');
    const childRequest = adapter.requests.find((request) =>
      effectiveInstructions(request).includes('non-recursive subagent')
    );
    expect(childRequest?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Original interrupted work.' }),
        expect.objectContaining({ role: 'user', content: 'Continue after interruption.' })
      ])
    );
    await agent.dispose();
  });

  it('rejects wait, message, and cancel from a non-parent Session', async () => {
    const { home, workspace } = await fixture('foreign-parent');
    const store = await JsonlSessionStore.open(home);
    const owner = await store.createSession({ workspace, title: 'Owner' });
    const foreignParent = await store.createSession({ workspace, title: 'Foreign parent' });
    const child = await store.createSession({
      workspace,
      title: 'Owned child',
      source: {
        type: 'subagent',
        parentSessionId: owner.id,
        rootSessionId: owner.id,
        parentExecutionId: 'owner-execution',
        role: 'general-purpose',
        description: 'Owned child'
      }
    });
    await store.close();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => new ForeignSubagentControlAdapter(child.id)
    });
    const foreign = await agent.openSession(foreignParent.id);

    for (const operation of ['wait', 'message', 'cancel']) {
      const result = await runAndCollect(foreign.run({ prompt: `try foreign ${operation}` }));
      expect(
        result.events.find(
          (event) => event.type === 'tool.failed' && event.toolName === `agent_${operation}`
        )
      ).toMatchObject({
        type: 'tool.failed',
        code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
      });
    }
    await agent.dispose();
  });

  it.each(['append', 'replace'] as const)(
    'delivers %s guidance with a verifiable receipt',
    async (delivery) => {
      const { home, workspace } = await fixture(`mailbox-${delivery}`);
      let resolveChildStarted!: () => void;
      let resolveReleaseChild!: () => void;
      const state: SharedAdapterState = {
        requests: [],
        delivery,
        childStarted: new Promise<void>((resolve) => (resolveChildStarted = resolve)),
        releaseChild: new Promise<void>((resolve) => (resolveReleaseChild = resolve)),
        resolveChildStarted,
        resolveReleaseChild
      };
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        adapterFactory: () => new PersistentSubagentAdapter(state, true)
      });
      const root = await agent.createSession({ workspace, title: 'Root' });

      await runAndCollect(root.run({ prompt: 'start child' }));
      await state.childStarted;
      const injected = await runAndCollect(root.run({ prompt: 'inject child' }));
      const injection = injected.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_message'
      );
      expect(injection).toMatchObject({
        type: 'tool.completed',
        data: {
          status: expect.stringMatching(/running|completed/u),
          messageId: expect.any(String),
          turnId: expect.any(String),
          deliveryStatus: expect.stringMatching(/accepted|applied/u)
        }
      });
      expect(injection).not.toHaveProperty('data.latestMessage');
      expect(injection).not.toHaveProperty('data.latestActivity');
      expect(injection).not.toHaveProperty('data.summary');
      if (delivery === 'append')
        expect(injection).toMatchObject({ data: { deliveryStatus: 'accepted' } });
      state.resolveReleaseChild?.();

      const waited = await runAndCollect(root.run({ prompt: 'wait child' }));
      const waitTool = waited.events.find(
        (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
      );
      expect(waitTool).toMatchObject({
        type: 'tool.completed',
        data: {
          status: 'completed',
          deliveryStatus: 'applied',
          messageId: expect.any(String),
          turnId: expect.any(String)
        }
      });
      expect(parentEvidence(state.requests)).toContain('mailbox applied');
      const agentId =
        waitTool?.type === 'tool.completed' &&
        waitTool.data &&
        'agentId' in waitTool.data &&
        typeof waitTool.data.agentId === 'string'
          ? waitTool.data.agentId
          : '';
      const store = await JsonlSessionStore.open(home);
      const userRecords = (await store.read(agentId)).filter(
        (record) => record.type === 'turn.user'
      );
      expect(userRecords).toHaveLength(2);
      expect(new Set(userRecords.map((record) => record.turnId)).size).toBe(
        delivery === 'replace' ? 2 : 1
      );
      expect(userRecords[1]?.payload).toMatchObject({
        prompt: 'Injected guidance.',
        messageId: expect.any(String),
        inputSource: 'parent_agent'
      });
      const receipt = injection?.type === 'tool.completed' ? injection.data : undefined;
      expect(waitTool).toMatchObject({
        data: {
          messageId: (receipt as Record<string, unknown>).messageId,
          turnId: userRecords[1]?.turnId
        }
      });
      await store.close();
      await agent.dispose();
      const restarted = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        adapterFactory: () => new PersistentSubagentAdapter(state)
      });
      try {
        const parent = await restarted.openSession(root.id);
        const restored = await runAndCollect(parent.run({ prompt: 'wait child' }));
        expect(
          restored.events.find(
            (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
          )
        ).toMatchObject({
          data: {
            messageId: (receipt as Record<string, unknown>).messageId,
            turnId: userRecords[1]?.turnId,
            deliveryStatus: 'applied'
          }
        });
      } finally {
        await restarted.dispose();
      }
    }
  );

  it('does not replace a child Turn while its execution handle is still opening', async () => {
    const { controller, releaseStart, releaseResult, startEntered, starts, enqueued } =
      await openingControllerFixture();
    const started = await controller.run(
      {
        description: 'Inspect startup',
        prompt: 'Inspect while the child Session opens.',
        role: 'explore',
        background: true
      },
      {}
    );
    await startEntered;

    let messageSettled = false;
    const messaging = controller.message(started.agentId, 'Apply this guidance.').finally(() => {
      messageSettled = true;
    });
    await Promise.resolve();

    expect(starts()).toBe(1);
    expect(messageSettled).toBe(false);
    releaseStart();
    await expect(messaging).resolves.toMatchObject({ status: 'running' });
    expect(enqueued()).toEqual(['Apply this guidance.']);
    releaseResult('completed');
    await expect(controller.output(started.agentId, { waitMs: 10_000 })).resolves.toMatchObject({
      status: 'completed'
    });
    await controller.dispose();
  });

  it('returns immediately for zero wait and marks unapplied queued guidance cancelled', async () => {
    const { controller } = await openingControllerFixture(0);
    const started = await controller.run({
      description: 'Queued child',
      prompt: 'Wait for a slot.',
      role: 'general-purpose',
      background: true
    });
    const receipt = await controller.message(started.agentId, 'Queued guidance.');
    expect(receipt).toMatchObject({
      status: 'queued',
      messageId: expect.any(String),
      turnId: expect.any(String),
      deliveryStatus: 'accepted'
    });
    expect(receipt).not.toHaveProperty('latestMessage');
    expect(receipt).not.toHaveProperty('latestActivity');
    let observed = false;
    const reading = controller.output(started.agentId, { waitMs: 0 }).then((value) => {
      observed = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const immediate = observed;
    const cancelled = await controller.cancel(started.agentId);
    await reading;
    expect(immediate).toBe(true);
    expect(cancelled).toMatchObject({
      messageId: receipt.messageId,
      turnId: receipt.turnId,
      deliveryStatus: 'cancelled'
    });
    await controller.dispose();
  });

  it('observes public messages separately from completion and ignores tool activity', async () => {
    const source = controlledEventSource();
    const { controller, releaseStart, releaseResult, startEntered } =
      await openingControllerFixture(4, source.events);
    const started = await controller.run({
      description: 'Observe progress',
      prompt: 'Report progress before completion.',
      role: 'explore',
      background: true
    });
    await startEntered;
    releaseStart();
    await new Promise<void>((resolve) => setImmediate(resolve));

    let messageSettled = false;
    let completionSettled = false;
    const messageWait = controller
      .output(started.agentId, { waitFor: 'message', waitMs: 10_000 })
      .then((snapshot) => {
        messageSettled = true;
        return snapshot;
      });
    const completionWait = controller
      .output(started.agentId, { waitFor: 'completion', waitMs: 10_000 })
      .then((snapshot) => {
        completionSettled = true;
        return snapshot;
      });

    source.emit({
      type: 'tool.completed',
      callId: 'still-working',
      toolName: 'read',
      summary: 'read source',
      timestamp: '2026-09-14T08:00:00.000Z'
    } as MarAgentEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({ messageSettled, completionSettled }).toEqual({
      messageSettled: false,
      completionSettled: false
    });

    source.emit({
      type: 'message.completed',
      itemId: 'progress-one',
      turnId: 'child-turn',
      phase: 'commentary',
      text: 'Protocol analysis completed.',
      timestamp: '2026-09-14T08:00:01.000Z'
    } as MarAgentEvent);
    await expect(messageWait).resolves.toMatchObject({
      status: 'running',
      waitOutcome: 'message',
      latestMessage: { itemId: 'progress-one', phase: 'commentary' }
    });
    expect(completionSettled).toBe(false);

    source.close();
    releaseResult('completed');
    await expect(completionWait).resolves.toMatchObject({
      status: 'completed',
      waitOutcome: 'completion'
    });
    await controller.dispose();
  });

  it('returns unread public progress when a completion wait times out', async () => {
    const source = controlledEventSource();
    const { controller, releaseStart, releaseResult, startEntered } =
      await openingControllerFixture(4, source.events);
    const started = await controller.run({
      description: 'Inspect timed out progress',
      prompt: 'Report progress while continuing.',
      role: 'explore',
      background: true
    });
    await startEntered;
    releaseStart();
    await new Promise<void>((resolve) => setImmediate(resolve));

    vi.useFakeTimers();
    try {
      const completion = controller.output(started.agentId, {
        waitFor: 'completion',
        waitMs: 10_000
      });
      source.emit({
        type: 'message.completed',
        itemId: 'progress-before-timeout',
        turnId: 'child-turn',
        phase: 'commentary',
        text: 'The child is still running after finding a useful result.',
        timestamp: '2026-09-16T08:00:00.000Z'
      } as MarAgentEvent);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(completion).resolves.toMatchObject({
        status: 'running',
        waitOutcome: 'timeout',
        latestMessage: {
          itemId: 'progress-before-timeout',
          phase: 'commentary',
          text: 'The child is still running after finding a useful result.'
        }
      });
      const untargetedCompletion = controller.outputAny({
        waitFor: 'completion',
        waitMs: 10_000
      });
      source.emit({
        type: 'message.completed',
        itemId: 'untargeted-progress-before-timeout',
        turnId: 'child-turn',
        phase: 'commentary',
        text: 'Untargeted waits also expose the latest useful result.',
        timestamp: '2026-09-16T08:00:01.000Z'
      } as MarAgentEvent);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(untargetedCompletion).resolves.toMatchObject({
        agentId: started.agentId,
        status: 'running',
        waitOutcome: 'timeout',
        latestMessage: {
          itemId: 'untargeted-progress-before-timeout',
          text: 'Untargeted waits also expose the latest useful result.'
        }
      });
      expect(
        await controller.output(started.agentId, { waitFor: 'completion', waitMs: 0 })
      ).not.toHaveProperty('latestMessage');
    } finally {
      vi.useRealTimers();
      source.close();
      releaseResult('completed');
      await controller.output(started.agentId, { waitFor: 'completion', waitMs: 10_000 });
      await controller.dispose();
    }
  });

  it('preserves unread public progress when a parent wait is cancelled', async () => {
    const source = controlledEventSource();
    const { controller, releaseStart, releaseResult, startEntered } =
      await openingControllerFixture(4, source.events);
    const started = await controller.run({
      description: 'Resume progress observation',
      prompt: 'Continue in the background.',
      role: 'explore',
      background: true
    });
    await startEntered;
    releaseStart();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const parent = new AbortController();
    const interrupted = controller.output(started.agentId, {
      waitFor: 'message',
      waitMs: 10_000,
      signal: parent.signal
    });
    parent.abort(new Error('parent Run stopped'));
    await expect(interrupted).rejects.toThrow('parent Run stopped');

    source.emit({
      type: 'message.completed',
      itemId: 'progress-after-stop',
      turnId: 'child-turn',
      phase: 'commentary',
      text: 'Progress remains available.',
      timestamp: '2026-09-14T08:01:00.000Z'
    } as MarAgentEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      controller.output(started.agentId, { waitFor: 'message', waitMs: 10_000 })
    ).resolves.toMatchObject({
      status: 'running',
      waitOutcome: 'message',
      latestMessage: { itemId: 'progress-after-stop' }
    });

    source.emit({
      type: 'message.completed',
      itemId: 'progress-before-followup',
      turnId: 'child-turn',
      phase: 'commentary',
      text: 'Old progress before the new guidance.',
      timestamp: '2026-09-15T09:00:01.000Z'
    } as MarAgentEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const receipt = await controller.message(started.agentId, 'Use the new direction.');
    expect(receipt).not.toHaveProperty('latestMessage');
    let followupSettled = false;
    const followupWait = controller
      .output(started.agentId, { waitFor: 'message', waitMs: 10_000 })
      .finally(() => {
        followupSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(followupSettled).toBe(false);
    source.emit({
      type: 'message.completed',
      itemId: 'progress-after-followup',
      turnId: 'child-turn',
      phase: 'commentary',
      text: 'Fresh progress after the new guidance.',
      timestamp: '2026-09-15T09:00:02.000Z'
    } as MarAgentEvent);
    await expect(followupWait).resolves.toMatchObject({
      waitOutcome: 'message',
      latestMessage: { itemId: 'progress-after-followup' }
    });

    source.close();
    releaseResult('completed');
    await controller.output(started.agentId, { waitFor: 'completion', waitMs: 10_000 });
    await controller.dispose();
  });

  it('keeps a foreground child running when its parent wait is cancelled', async () => {
    const { controller, releaseStart, releaseResult, startEntered, cancelled } =
      await openingControllerFixture();
    const parent = new AbortController();
    const foreground = controller.run(
      {
        description: 'Retain foreground work',
        prompt: 'Continue after the parent stops.',
        role: 'explore'
      },
      { signal: parent.signal }
    );
    await startEntered;
    releaseStart();
    await new Promise<void>((resolve) => setImmediate(resolve));

    parent.abort(new Error('parent execution replaced'));
    await expect(foreground).rejects.toThrow('parent execution replaced');
    expect(cancelled()).toBe(false);
    await expect(controller.outputAny({ waitMs: 0 })).resolves.toMatchObject({
      status: 'running',
      waitOutcome: 'snapshot'
    });

    releaseResult('completed');
    await expect(
      controller.outputAny({ waitFor: 'completion', waitMs: 10_000 })
    ).resolves.toMatchObject({
      status: 'completed',
      waitOutcome: 'completion'
    });
    await controller.dispose();
  });

  it('returns terminal completion instead of replaying unread progress', async () => {
    const progress = {
      type: 'message.completed',
      itemId: 'progress-before-completion',
      turnId: 'child-turn',
      phase: 'commentary',
      text: 'Intermediate progress.',
      timestamp: '2026-09-14T08:02:00.000Z'
    } as MarAgentEvent;
    const { controller, releaseStart, releaseResult } = await openingControllerFixture(4, [
      progress
    ]);
    const started = await controller.run({
      description: 'Prefer completion',
      prompt: 'Finish after progress.',
      role: 'explore',
      background: true
    });
    releaseStart();
    const completion = controller.output(started.agentId, {
      waitFor: 'completion',
      waitMs: 10_000
    });
    releaseResult('completed');
    await expect(completion).resolves.toMatchObject({
      status: 'completed',
      waitOutcome: 'completion'
    });
    await expect(
      controller.output(started.agentId, { waitFor: 'message', waitMs: 10_000 })
    ).resolves.toMatchObject({ status: 'completed', waitOutcome: 'completion' });
    await controller.dispose();
  });

  it('keeps model observations compact while preserving automatic records for native inspection', async () => {
    const commentary = 'progress '.repeat(2_000);
    const { controller, releaseStart, releaseResult, startEntered } =
      await openingControllerFixture(4, [
        {
          type: 'message.completed',
          itemId: 'progress-message',
          turnId: 'child-turn',
          phase: 'commentary',
          text: commentary,
          timestamp: '2026-09-13T08:00:00.000Z'
        } as MarAgentEvent,
        {
          type: 'tool.completed',
          callId: 'verification-exec',
          toolName: 'exec',
          summary: 'verification passed',
          timestamp: '2026-09-13T08:00:01.000Z'
        } as MarAgentEvent,
        {
          type: 'tool.completed',
          callId: 'evidence-read',
          toolName: 'read',
          summary: 'read source',
          timestamp: '2026-09-13T08:00:02.000Z',
          data: {
            results: [{ path: 'src/a.ts', startLine: 1, endLine: 20 }]
          }
        } as MarAgentEvent
      ]);
    const started = await controller.run({
      description: 'Compact running observation',
      prompt: 'Report progress.',
      role: 'explore',
      background: true
    });
    await startEntered;
    releaseStart();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const running = await controller.output(started.agentId, { waitMs: 0 });
    expect(running.status).toBe('running');
    expect(running).not.toHaveProperty('latestMessage');
    expect(running.latestActivity).toEqual({
      kind: 'tool',
      timestamp: '2026-09-13T08:00:02.000Z',
      toolName: 'read',
      status: 'completed'
    });
    expect(JSON.stringify(running.latestActivity)).not.toContain('read source');
    expect(running).not.toHaveProperty('verification');
    expect(running).not.toHaveProperty('evidence');
    expect(running).not.toHaveProperty('changedFiles');

    releaseResult('completed');
    const terminal = await controller.output(started.agentId, { waitMs: 10_000 });
    expect(terminal.status).toBe('completed');
    expect(terminal).not.toHaveProperty('verification');
    expect(terminal).not.toHaveProperty('evidence');
    expect(await controller.inspect(started.agentId)).toMatchObject({
      status: 'completed',
      verification: ['verification passed'],
      evidence: [{ path: 'src/a.ts', startLine: 1, endLine: 20 }]
    });
    expect(terminal.latestMessage?.text.length).toBe(10_000);
    expect(await controller.output(started.agentId, { waitMs: 0 })).not.toHaveProperty('summary');
    await controller.dispose();
  });

  it('retains the originating Execution binding for a background cell after its parent ends', async () => {
    const { controller, startEntered, releaseStart, starts, releaseResult } =
      await openingControllerFixture();
    const retained = controller.captureExecution();
    controller.endParentExecution('parent-execution');
    try {
      await expect(
        controller.run({
          description: 'No execution',
          prompt: 'No execution',
          role: 'explore',
          background: true
        })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_SUBAGENT_FAILED' });
      const task = await retained.run({
        description: 'Retained cell',
        prompt: 'Continue background work.',
        role: 'explore',
        background: true
      });
      await startEntered;
      releaseStart();
      expect(starts()).toBe(1);
      releaseResult('completed');
      expect((await retained.output(task.agentId, { waitMs: 10000 })).status).toBe('completed');
    } finally {
      releaseStart();
      releaseResult('completed');
      await controller.dispose();
    }
  });

  it('replaces queued work and associates the new guidance with a fresh Turn', async () => {
    const { controller } = await openingControllerFixture(0);
    const started = await controller.run({
      description: 'Queued replacement',
      prompt: 'Old direction.',
      role: 'general-purpose',
      background: true
    });
    const first = await controller.message(started.agentId, 'Old guidance.');
    const replacement = await controller.message(started.agentId, 'New direction.', {
      delivery: 'replace'
    });
    expect(replacement).toMatchObject({
      agentId: started.agentId,
      status: 'queued',
      deliveryStatus: 'accepted'
    });
    expect(replacement.messageId).not.toBe(first.messageId);
    expect(replacement.turnId).not.toBe(first.turnId);
    await controller.dispose();
  });

  it('does not start replacement work after its parent signal is aborted', async () => {
    const { controller, startEntered, releaseStart, starts } = await openingControllerFixture();
    const started = await controller.run({
      description: 'Cancel replacement admission',
      prompt: 'Opening child.',
      role: 'general-purpose',
      background: true
    });
    await startEntered;
    const parent = new AbortController();
    const replacing = controller.message(started.agentId, 'Do not start this.', {
      delivery: 'replace',
      signal: parent.signal
    });
    const rejected = expect(replacing).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    parent.abort();
    releaseStart();
    await rejected;
    expect(starts()).toBe(1);
    await expect(controller.output(started.agentId, { waitMs: 0 })).resolves.toMatchObject({
      status: 'cancelled'
    });
    await controller.dispose();
  });

  it('serializes concurrent messages without starting competing Turns', async () => {
    const { controller, startEntered, releaseStart, releaseResult, starts, enqueued } =
      await openingControllerFixture();
    const started = await controller.run({
      description: 'Serialize messages',
      prompt: 'Initial work.',
      role: 'general-purpose',
      background: true
    });
    await startEntered;
    releaseStart();
    const receipts = await Promise.all([
      controller.message(started.agentId, 'First guidance.'),
      controller.message(started.agentId, 'Second guidance.')
    ]);
    expect(receipts[0]?.turnId).toBe(receipts[1]?.turnId);
    expect(receipts[0]?.messageId).not.toBe(receipts[1]?.messageId);
    expect(enqueued()).toEqual(['First guidance.', 'Second guidance.']);
    expect(starts()).toBe(1);
    releaseResult('completed');
    await controller.dispose();
  });

  it('marks accepted guidance failed when the child closes before applying it', async () => {
    const { controller, releaseStart, releaseResult } = await openingControllerFixture();
    const child = await controller.run({
      description: 'Fail before guidance',
      prompt: 'Initial work.',
      role: 'general-purpose',
      background: true
    });
    releaseStart();
    const receipt = await controller.message(child.agentId, 'Pending guidance.');
    releaseResult('failed');
    const result = await controller.output(child.agentId, { waitMs: 10_000 });
    expect(result).toMatchObject({
      status: 'failed',
      messageId: receipt.messageId,
      turnId: receipt.turnId,
      deliveryStatus: 'failed'
    });
    await controller.dispose();
  });

  it('cancels a child Turn after an opening execution handle becomes available', async () => {
    const { controller, releaseStart, releaseResult, startEntered, cancelled } =
      await openingControllerFixture();
    const started = await controller.run({
      description: 'Inspect cancellation',
      prompt: 'Wait while the child Session opens.',
      role: 'general-purpose',
      background: true
    });
    await startEntered;

    const cancelling = controller.cancel(started.agentId);
    releaseStart();
    for (let attempt = 0; attempt < 10 && !cancelled(); attempt++) await Promise.resolve();
    const cancellationObserved = cancelled();
    if (!cancellationObserved) releaseResult('completed');

    expect(cancellationObserved).toBe(true);
    await expect(cancelling).resolves.toMatchObject({ status: 'cancelled' });
    await controller.dispose();
  });

  it('deletes a child Session created after the controller was disposed', async () => {
    const { controller, createEntered, deleted, releaseCreate } = await creatingControllerFixture();
    const running = controller.run({
      description: 'Inspect disposal race',
      prompt: 'Do not leave an unstarted child Session.',
      role: 'general-purpose',
      background: true
    });
    await createEntered;

    await controller.dispose();
    releaseCreate();

    await expect(running).rejects.toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
    expect(deleted()).toEqual(['child-session']);
    expect(controller.listSessionResources()).toEqual([]);
  });

  it('deletes a child Session created after the parent signal was aborted', async () => {
    const { controller, createEntered, deleted, releaseCreate } = await creatingControllerFixture();
    const parent = new AbortController();
    const running = controller.run(
      {
        description: 'Inspect parent cancellation race',
        prompt: 'Do not leave an unstarted child Session.',
        role: 'general-purpose',
        background: true
      },
      { signal: parent.signal }
    );
    await createEntered;

    parent.abort();
    releaseCreate();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(deleted()).toEqual(['child-session']);
    expect(controller.listSessionResources()).toEqual([]);
    await controller.dispose();
  });

  it('deletes an unstarted child Session when disposal races with the started event', async () => {
    const { controller, createEntered, deleted, releaseCreate } = await creatingControllerFixture();
    let releaseCreatedEvent!: () => void;
    let markCreatedEventEntered!: () => void;
    const createdEventEntered = new Promise<void>((resolve) => (markCreatedEventEntered = resolve));
    const createdEventGate = new Promise<void>((resolve) => (releaseCreatedEvent = resolve));
    const running = controller.run(
      {
        description: 'Inspect started event race',
        prompt: 'Do not leave an unstarted child Session.',
        role: 'general-purpose',
        background: true
      },
      {
        onCreated: async () => {
          markCreatedEventEntered();
          await createdEventGate;
        }
      }
    );
    await createEntered;
    releaseCreate();
    await createdEventEntered;

    await controller.dispose();
    releaseCreatedEvent();

    await expect(running).rejects.toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
    expect(deleted()).toEqual(['child-session']);
    expect(controller.listSessionResources()).toEqual([]);
  });

  it('rejects mailbox insertion once a failed child Turn starts closing', async () => {
    const { home, workspace } = await fixture('failure-boundary');
    const store = await JsonlSessionStore.open(home);
    const root = await store.createSession({ workspace, title: 'Root' });
    const child = await store.createSession({
      workspace,
      title: 'Failing child',
      source: {
        type: 'subagent',
        parentSessionId: root.id,
        rootSessionId: root.id,
        parentExecutionId: 'parent-execution',
        role: 'general-purpose',
        description: 'Failing child'
      }
    });
    await store.close();
    const host = new FailureBoundaryHost(home, workspace);
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => new FailingSubagentAdapter()
    });
    const session = await agent.openSession(child.id);
    const handle = session.run({ prompt: 'Fail now.' }) as ReturnType<typeof session.run> & {
      enqueueMessage(message: string): boolean;
    };

    await host.failureObserved;
    expect(handle.enqueueMessage('Do not lose this message.')).toBe(false);
    host.releaseFailure();
    await expect(handle.result()).resolves.toMatchObject({ status: 'failed' });
    await agent.dispose();
  });
});

async function fixture(name: string) {
  const home = await mkdtemp(join(tmpdir(), `mar-agent-subagent-session-${name}-`));
  roots.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  return { home, workspace };
}

async function runAndCollect(
  handle: ReturnType<import('../../src/index.js').MarAgentSession['run']>
) {
  const events: MarAgentEvent[] = [];
  for await (const event of handle) events.push(event);
  const result = await handle.result();
  expect(result.status).toBe('completed');
  return { events, result };
}

function parentEvidence(requests: readonly ModelRequest[]): string {
  return requests
    .filter((request) => !effectiveInstructions(request).includes('non-recursive subagent'))
    .flatMap((request) => request.messages)
    .filter(
      (message) =>
        message.role === 'tool' ||
        (message.contextKind === 'contextual' &&
          message.content.startsWith('<mar_subagent_update '))
    )
    .map((message) => message.content)
    .join('\n');
}

function currentPromptFrom(messages: readonly ModelMessage[]): string {
  return (
    messages.findLast(
      (message) =>
        message.role === 'user' &&
        [
          'start child',
          'continue child',
          'inject child',
          'wait child',
          'Inspect alpha without inheriting parent history.',
          'Continue with beta.',
          'Injected guidance.'
        ].includes(message.content)
    )?.content ?? ''
  );
}

function lastPromptIndex(messages: readonly ModelMessage[], prompt: string): number {
  return messages.findLastIndex((message) => message.role === 'user' && message.content === prompt);
}

function latestAgentId(messages: readonly ModelMessage[]): string {
  for (const message of messages.toReversed()) {
    if (message.role !== 'tool') continue;
    try {
      const value = JSON.parse(message.content) as { agentId?: unknown };
      if (typeof value.agentId === 'string') return value.agentId;
    } catch {
      // Ignore unrelated tool output.
    }
  }
  throw new Error('Subagent id is missing from parent history.');
}

async function openingControllerFixture(
  maxConcurrent = 4,
  events: readonly MarAgentEvent[] | AsyncIterable<MarAgentEvent> = []
) {
  let releaseStart!: () => void;
  let releaseResult!: (status: 'completed' | 'cancelled' | 'failed') => void;
  let markStartEntered!: () => void;
  let startCount = 0;
  let cancelObserved = false;
  const enqueuedMessages: string[] = [];
  const startGate = new Promise<void>((resolve) => (releaseStart = resolve));
  const startEntered = new Promise<void>((resolve) => (markStartEntered = resolve));
  const result = new Promise<'completed' | 'cancelled' | 'failed'>(
    (resolve) => (releaseResult = resolve)
  );
  const handle: SubagentTurnHandle = {
    executionId: 'child-execution',
    turnId: 'child-turn',
    async *[Symbol.asyncIterator]() {
      for await (const event of events) yield event;
    },
    result: async () => ({
      executionId: 'child-execution',
      status: await result,
      finalAnswer: 'done'
    }),
    cancel: () => {
      cancelObserved = true;
      releaseResult('cancelled');
    },
    enqueueMessage: (message) => {
      enqueuedMessages.push(message);
      return true;
    }
  };
  const controller = await SubagentSessionController.open({
    parentSessionId: 'root-session',
    rootSessionId: 'root-session',
    limits: { maxTasks: 8, maxConcurrent },
    backend: {
      createSession: async () => ({ id: 'child-session' }),
      deleteSession: async () => undefined,
      listChildren: async () => [],
      loadChild: async () => undefined
    }
  });
  await controller.beginParentExecution({
    executionId: 'parent-execution',
    modelId: 'review',
    reasoningEffort: 'low',
    models: new Map([
      [
        'review',
        {
          id: 'review',
          name: 'Review Agent',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'low'
        }
      ]
    ]),
    emitTerminal: async () => undefined,
    startTurn: async () => {
      startCount++;
      markStartEntered();
      await startGate;
      return handle;
    }
  });
  return {
    controller,
    releaseStart,
    releaseResult,
    startEntered,
    starts: () => startCount,
    cancelled: () => cancelObserved,
    enqueued: () => [...enqueuedMessages]
  };
}

function controlledEventSource() {
  const queued: MarAgentEvent[] = [];
  const waiters: Array<(value: IteratorResult<MarAgentEvent>) => void> = [];
  let closed = false;
  return {
    events: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<MarAgentEvent>> {
            const event = queued.shift();
            if (event) return Promise.resolve({ value: event, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          }
        };
      }
    } as AsyncIterable<MarAgentEvent>,
    emit(event: MarAgentEvent) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else queued.push(event);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    }
  };
}

async function creatingControllerFixture() {
  let markCreateEntered!: () => void;
  let releaseCreate!: () => void;
  const createEntered = new Promise<void>((resolve) => (markCreateEntered = resolve));
  const createGate = new Promise<void>((resolve) => (releaseCreate = resolve));
  const deletedSessions: string[] = [];
  const controller = await SubagentSessionController.open({
    parentSessionId: 'root-session',
    rootSessionId: 'root-session',
    backend: {
      createSession: async () => {
        markCreateEntered();
        await createGate;
        return { id: 'child-session' };
      },
      deleteSession: async (sessionId) => {
        deletedSessions.push(sessionId);
      },
      listChildren: async () => [],
      loadChild: async () => undefined
    }
  });
  await controller.beginParentExecution({
    executionId: 'parent-execution',
    modelId: 'review',
    reasoningEffort: 'low',
    models: new Map([
      [
        'review',
        {
          id: 'review',
          name: 'Review Agent',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'low'
        }
      ]
    ]),
    emitTerminal: async () => undefined,
    startTurn: async () => {
      throw new Error('The child Turn must not start.');
    }
  });
  return {
    controller,
    createEntered,
    releaseCreate,
    deleted: () => [...deletedSessions]
  };
}
