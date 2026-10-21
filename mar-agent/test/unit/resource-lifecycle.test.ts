import { effectiveInstructions } from './support/model-context.js';
import { access, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForNewChild } from './support/subagent-wait.js';
import {
  LocalAgentHost,
  SecretValue,
  type MarAgentModelConfiguration,
  type MarAgentEvent,
  type McpToolCatalogContext
} from '../../src/index.js';
import { LocalWorkspaceTools } from '../../src/agent-core/tools/local/workspace-tools.js';
import { SubagentScheduler } from '../../src/agent-core/subagent/scheduler.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/agent-core/model/contracts.js';
import { AsyncQueue } from '../../src/agent-core/runtime/async-queue.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

const model: MarAgentModelConfiguration = {
  id: 'coding',
  name: 'Coding',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'coding',
  contextWindowTokens: 10000,
  maxOutputTokens: 1000,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  enabled: true
};

class ImmediateAdapter implements ModelAdapter {
  readonly configuration = model;
  async *start(): AsyncIterable<ModelEvent> {
    yield { type: 'text.completed', itemId: 'answer', text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class McpScopeTrackingHost extends LocalAgentHost {
  readonly catalogContexts: McpToolCatalogContext[] = [];

  override listMcpTools(context?: McpToolCatalogContext) {
    if (context !== undefined) this.catalogContexts.push({ ...context });
    return super.listMcpTools(context);
  }
}

class WarmResourceAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  readonly #rounds = new Map<string, number>();
  readonly childStarted: Promise<void>;
  #resolveChildStarted!: () => void;

  constructor() {
    this.childStarted = new Promise<void>((resolve) => (this.#resolveChildStarted = resolve));
  }

  async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (effectiveInstructions(request).includes('non-recursive subagent')) {
      this.#resolveChildStarted();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return;
    }

    const prompt =
      [...request.messages]
        .reverse()
        .find((message) => message.role === 'user' && message.contextKind === undefined)?.content ??
      '';
    if (prompt === 'start subagent and wait') {
      const wait = waitForNewChild(request);
      if (wait) {
        yield wait;
        yield { type: 'completed', reason: 'tool_use' };
        return;
      }
    }
    const round = this.#rounds.get(prompt) ?? 0;
    this.#rounds.set(prompt, round + 1);
    if (
      (prompt === 'start warm resources' || prompt === 'interrupt warm resources') &&
      round === 0
    ) {
      yield {
        type: 'client_tool.call',
        callId: 'warm-exec-start',
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "console.log('READY'); setInterval(() => {}, 1000)"`,
          yieldMs: 100,
          timeoutMs: 10_000
        }
      };
      yield {
        type: 'client_tool.call',
        callId: 'warm-task-start',
        name: 'agent_start',
        arguments: {
          description: 'Keep inspecting',
          prompt: 'Wait until the parent resumes.',
          role: 'explore'
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (prompt === 'interrupt warm resources') {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return;
    }
    if (prompt === 'start subagent and wait' && round === 0) {
      yield {
        type: 'client_tool.call',
        callId: 'foreground-task-start',
        name: 'agent_start',
        arguments: {
          description: 'Wait for disposal',
          prompt: 'Wait until the parent is disposed.',
          role: 'explore'
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (prompt === 'inspect retained waiting subagent' && round === 0) {
      const retainedContext = request.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n');
      const agentId = /agentId: ([0-9a-f-]+)/u.exec(retainedContext)?.[1];
      if (!agentId) throw new Error('retained foreground agent ID missing from context');
      yield {
        type: 'client_tool.call',
        callId: 'retained-foreground-wait',
        name: 'agent_wait',
        arguments: { agentId, waitMs: 0 }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (prompt === 'inspect retained waiting subagent') {
      yield { type: 'text.completed', itemId: 'retained-foreground-answer', text: 'done' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    if (
      (prompt === 'resume warm resources' || prompt === 'reuse interrupted resources') &&
      round === 0
    ) {
      const retained = request.messages
        .filter((message) => message.role === 'tool')
        .flatMap((message) => {
          try {
            return [JSON.parse(message.content) as { processId?: string; agentId?: string }];
          } catch {
            return [];
          }
        });
      const processId = retained.find((value) => value.processId)?.processId;
      const agentId = retained.find((value) => value.agentId)?.agentId;
      if (!processId || !agentId) throw new Error('retained resource IDs missing from history');
      yield {
        type: 'client_tool.call',
        callId: 'warm-exec-poll',
        name: 'exec_wait',
        arguments: { processId }
      };
      yield prompt === 'resume warm resources'
        ? {
            type: 'client_tool.call',
            callId: 'warm-task-cancel',
            name: 'agent_cancel',
            arguments: { agentId }
          }
        : {
            type: 'client_tool.call',
            callId: 'warm-task-message',
            name: 'agent_message',
            arguments: { agentId, message: 'Continue the retained task.' }
          };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: `answer-${prompt}`, text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ReconfigurableBackgroundAdapter implements ModelAdapter {
  readonly close = vi.fn(async () => undefined);

  constructor(
    readonly configuration: MarAgentModelConfiguration,
    private readonly state: {
      childStarted: Promise<void>;
      resolveChildStarted(): void;
    }
  ) {}

  async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (effectiveInstructions(request).includes('non-recursive subagent')) {
      this.state.resolveChildStarted();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return;
    }
    const prompt =
      [...request.messages]
        .reverse()
        .find((message) => message.role === 'user' && message.contextKind === undefined)?.content ??
      '';
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (prompt === 'start background task' && !hasToolResult) {
      yield {
        type: 'client_tool.call',
        callId: 'background-task',
        name: 'agent_start',
        arguments: {
          description: 'Keep working',
          prompt: 'Keep working until cancelled.',
          role: 'explore'
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: `answer-${prompt}`, text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class BlockingExecutionAdapter implements ModelAdapter {
  constructor(
    readonly configuration: MarAgentModelConfiguration,
    private readonly started: () => void
  ) {}

  createTurnSession() {
    return {
      start: (request: ModelRequest, signal: AbortSignal) => this.start(request, signal),
      close: async () => undefined
    };
  }

  // eslint-disable-next-line require-yield -- This fixture fails or waits for cancellation without emitting model events.
  async *start(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.started();
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

describe('resource lifecycle', () => {
  it('drops buffered execution events when callers select the result-only API', async () => {
    const queue = new AsyncQueue<{ payload: string }>();
    for (let index = 0; index < 10_000; index++) queue.push({ payload: `event-${index}` });
    expect(queue.bufferedSize).toBe(10_000);
    expect(queue.discardIfUnobserved()).toBe(true);
    expect(queue.bufferedSize).toBe(0);
    queue.push({ payload: 'late' });
    expect(queue.bufferedSize).toBe(0);
    expect((await queue[Symbol.asyncIterator]().next()).done).toBe(true);
  });

  it('does not discard a stream after an event consumer subscribes', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    queue.push(1);
    expect(queue.discardIfUnobserved()).toBe(false);
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    queue.close();
    expect((await iterator.next()).done).toBe(true);
  });

  it.each([1, 2, 1024, 1025, 2051])(
    'delivers live events after draining a buffered burst of %i events',
    async (count) => {
      const queue = new AsyncQueue<number>();
      const iterator = queue[Symbol.asyncIterator]();
      for (let index = 0; index < count; index++) queue.push(index);
      for (let index = 0; index < count; index++)
        expect(await iterator.next()).toEqual({ value: index, done: false });

      const delivered: IteratorResult<number>[] = [];
      const first = iterator.next().then((result) => delivered.push(result));
      const second = iterator.next().then((result) => delivered.push(result));
      queue.push(count);
      queue.push(count + 1);
      await Promise.resolve();
      expect(delivered).toEqual([
        { value: count, done: false },
        { value: count + 1, done: false }
      ]);
      await Promise.all([first, second]);
      expect(queue.bufferedSize).toBe(0);
      queue.close();
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
    }
  );

  it('closes every pending waiter after a buffered burst without accepting late events', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    queue.push(1);
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    const delivered: IteratorResult<number>[] = [];
    const first = iterator.next().then((result) => delivered.push(result));
    const second = iterator.next().then((result) => delivered.push(result));
    queue.close();
    queue.close();
    queue.push(2);
    await Promise.resolve();
    expect(delivered).toEqual([
      { value: undefined, done: true },
      { value: undefined, done: true }
    ]);
    await Promise.all([first, second]);
    expect(queue.bufferedSize).toBe(0);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('preserves FIFO delivery across waiter compaction and later buffered events', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    for (let index = 0; index < 2051; index++) {
      const pending = iterator.next();
      queue.push(index);
      expect(await pending).toEqual({ value: index, done: false });
    }
    queue.push(2051);
    expect(await iterator.next()).toEqual({ value: 2051, done: false });
    let delivered: IteratorResult<number> | undefined;
    const pending = iterator.next().then((result) => {
      delivered = result;
    });
    queue.push(2052);
    await Promise.resolve();
    expect(delivered).toEqual({ value: 2052, done: false });
    await pending;
    queue.push(2053);
    queue.close();
    expect(await iterator.next()).toEqual({ value: 2053, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('releases session locks and process listeners across repeated Agent lifecycles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-lifecycle-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const baseline = {
      warning: process.listenerCount('warning'),
      rejection: process.listenerCount('unhandledRejection')
    };
    for (let index = 0; index < 20; index++) {
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        adapterFactory: () => new ImmediateAdapter()
      });
      const session = await agent.createSession({ workspace });
      await expect(session.run({ prompt: `turn-${index}` }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      await agent.dispose();
    }
    const sessionRoot = join(home, '.mar', 'agent', 'sessions');
    const entries = await readdir(sessionRoot, { withFileTypes: true });
    for (const entry of entries.filter((value) => value.isDirectory()))
      await expect(access(join(sessionRoot, entry.name, 'lock'))).rejects.toThrow();
    expect(process.listenerCount('warning')).toBe(baseline.warning);
    expect(process.listenerCount('unhandledRejection')).toBe(baseline.rejection);
  });

  it('closes each shared dynamic model credential provider exactly once on Agent disposal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-credential-lifecycle-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const close = vi.fn(async () => undefined);
    const credentialProvider = {
      acquire: vi.fn(),
      invalidate: vi.fn(),
      close
    };
    const dynamicModel = {
      ...model,
      apiKey: undefined,
      credentialProvider
    } as unknown as MarAgentModelConfiguration;
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [dynamicModel, { ...dynamicModel, id: 'review', name: 'Review' }],
      adapterFactory: () => new ImmediateAdapter()
    });

    await agent.dispose();
    await agent.dispose();

    expect(close).toHaveBeenCalledOnce();
  });

  it('rebinds dynamic model providers without disposing retained Session resources', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-model-reconfiguration-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstProvider = {
      acquire: vi.fn(),
      invalidate: vi.fn(),
      close: firstClose
    };
    const secondProvider = {
      acquire: vi.fn(),
      invalidate: vi.fn(),
      close: secondClose
    };
    const firstModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: firstProvider
    } as MarAgentModelConfiguration;
    const secondModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: secondProvider
    } as MarAgentModelConfiguration;
    const configurations: MarAgentModelConfiguration[] = [];
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [firstModel],
      adapterFactory: (configuration) => {
        configurations.push(configuration);
        return new ImmediateAdapter();
      }
    });
    const session = await agent.createSession({ workspace, title: 'Reconfigured models' });

    await expect(session.run({ prompt: 'first' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    await agent.reconfigureModels({ models: [secondModel], defaultModelId: 'coding' });
    await expect(session.run({ prompt: 'second' }).result()).resolves.toMatchObject({
      status: 'completed'
    });

    expect(configurations.map((configuration) => configuration.credentialProvider)).toEqual([
      firstProvider,
      secondProvider
    ]);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).not.toHaveBeenCalled();
    await agent.dispose();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('updates and clears system instructions without changing an active execution snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-instruction-reconfiguration-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const disposeResources = vi.spyOn(host, 'disposeSessionResources');
    const systems: string[] = [];
    let started!: () => void;
    let resume!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const firstResumed = new Promise<void>((resolve) => (resume = resolve));
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      systemInstruction: 'ORIGINAL_HOST_INSTRUCTION',
      adapterFactory: (configuration) => ({
        configuration,
        async *start(request) {
          systems.push(effectiveInstructions(request));
          if (systems.length === 1) {
            started();
            await firstResumed;
            yield {
              type: 'client_tool.call',
              callId: 'snapshot',
              name: 'todo_read',
              arguments: {}
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      })
    });
    try {
      const session = await agent.createSession({ workspace });
      const first = session.run({ prompt: 'first' });
      await firstStarted;
      agent.setSystemInstruction('REPLACEMENT_HOST_INSTRUCTION');
      resume();
      await expect(first.result()).resolves.toMatchObject({ status: 'completed' });
      expect(systems).toHaveLength(2);
      for (const system of systems) {
        expect(system).toContain('ORIGINAL_HOST_INSTRUCTION');
        expect(system).not.toContain('REPLACEMENT_HOST_INSTRUCTION');
      }
      await expect(session.run({ prompt: 'second' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      expect(systems[2]).toContain('REPLACEMENT_HOST_INSTRUCTION');
      expect(systems[2]).not.toContain('ORIGINAL_HOST_INSTRUCTION');
      agent.setSystemInstruction();
      await expect(session.run({ prompt: 'third' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      expect(systems[3]).not.toContain('HOST_INSTRUCTION');
      expect(disposeResources).not.toHaveBeenCalled();
    } finally {
      resume();
      await agent.dispose();
    }
    expect(() => agent.setSystemInstruction('after disposal')).toThrow('MAR_AGENT_DISPOSED');
  });

  it('keeps active background subagent instructions when the parent instructions change', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-child-instruction-snapshot-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const childSystems: string[] = [];
    const parentSystems: string[] = [];
    let started!: () => void;
    let resume!: () => void;
    let finished!: () => void;
    const childStarted = new Promise<void>((resolve) => (started = resolve));
    const childResumed = new Promise<void>((resolve) => (resume = resolve));
    const childFinished = new Promise<void>((resolve) => (finished = resolve));
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      systemInstruction: 'ORIGINAL_HOST_INSTRUCTION',
      adapterFactory: (configuration) => ({
        configuration,
        async *start(request) {
          if (effectiveInstructions(request).includes('non-recursive subagent')) {
            childSystems.push(effectiveInstructions(request));
            if (childSystems.length === 1) {
              started();
              await childResumed;
              yield {
                type: 'client_tool.call',
                callId: 'child-read',
                name: 'todo_read',
                arguments: {}
              };
              yield { type: 'completed', reason: 'tool_use' };
              return;
            }
            yield { type: 'text.completed', itemId: 'child-answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
            finished();
            return;
          }
          parentSystems.push(effectiveInstructions(request));
          if (parentSystems.length === 1) {
            yield {
              type: 'client_tool.call',
              callId: 'start-child',
              name: 'agent_start',
              arguments: {
                description: 'Keep working',
                prompt: 'Work',
                role: 'explore'
              }
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      })
    });
    try {
      const session = await agent.createSession({ workspace });
      await expect(session.run({ prompt: 'start child' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      await childStarted;
      agent.setSystemInstruction('REPLACEMENT_HOST_INSTRUCTION');
      await expect(session.run({ prompt: 'continue parent' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      expect(parentSystems.at(-1)).toContain('REPLACEMENT_HOST_INSTRUCTION');
      resume();
      await childFinished;
      expect(childSystems).toHaveLength(2);
      for (const system of childSystems) {
        expect(system).toContain('ORIGINAL_HOST_INSTRUCTION');
        expect(system).not.toContain('REPLACEMENT_HOST_INSTRUCTION');
      }
    } finally {
      resume();
      await agent.dispose();
    }
  });

  it('retries an obsolete credential provider close during Agent disposal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-provider-close-retry-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const firstClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary close failure'))
      .mockResolvedValue(undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: {
        acquire: vi.fn(),
        invalidate: vi.fn(),
        close: firstClose
      }
    } as MarAgentModelConfiguration;
    const secondModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: {
        acquire: vi.fn(),
        invalidate: vi.fn(),
        close: secondClose
      }
    } as MarAgentModelConfiguration;
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [firstModel],
      adapterFactory: () => new ImmediateAdapter()
    });
    const session = await agent.createSession({ workspace, title: 'Provider close retry' });

    await expect(session.run({ prompt: 'first' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    await expect(
      agent.reconfigureModels({ models: [secondModel], defaultModelId: 'coding' })
    ).resolves.toBeUndefined();
    expect(firstClose).toHaveBeenCalledOnce();

    await agent.dispose();
    expect(firstClose).toHaveBeenCalledTimes(2);
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('rebinds an idle parent Session without interrupting an active background subagent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-active-subagent-reconfiguration-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const firstProvider = {
      acquire: vi.fn(),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const secondProvider = {
      acquire: vi.fn(),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const firstModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: firstProvider
    } as MarAgentModelConfiguration;
    const secondModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: secondProvider
    } as MarAgentModelConfiguration;
    let resolveChildStarted!: () => void;
    const state = {
      childStarted: new Promise<void>((resolve) => (resolveChildStarted = resolve)),
      resolveChildStarted
    };
    const adapters: ReconfigurableBackgroundAdapter[] = [];
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [firstModel],
      adapterFactory: (configuration) => {
        const adapter = new ReconfigurableBackgroundAdapter(configuration, state);
        adapters.push(adapter);
        return adapter;
      }
    });
    const session = await agent.createSession({ workspace, title: 'Active background task' });

    await expect(session.run({ prompt: 'start background task' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    await state.childStarted;
    expect(adapters).toHaveLength(2);

    await expect(
      agent.reconfigureModels({ models: [secondModel], defaultModelId: 'coding' })
    ).resolves.toBeUndefined();
    expect(adapters[0]!.close).toHaveBeenCalledOnce();
    expect(adapters[1]!.close).not.toHaveBeenCalled();
    expect(firstProvider.close).not.toHaveBeenCalled();

    await expect(
      session.run({ prompt: 'continue after rebinding' }).result()
    ).resolves.toMatchObject({ status: 'completed' });
    expect(adapters).toHaveLength(3);
    expect(adapters[2]!.configuration.credentialProvider).toBe(secondProvider);
    expect(adapters[1]!.close).not.toHaveBeenCalled();

    await agent.dispose();
    expect(adapters[1]!.close).toHaveBeenCalledOnce();
    expect(adapters[2]!.close).toHaveBeenCalledOnce();
    expect(firstProvider.close).toHaveBeenCalledOnce();
    expect(secondProvider.close).toHaveBeenCalledOnce();
  });

  it('rebuilds the old model Adapter after a reconfiguration close failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-reconfiguration-close-failure-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const firstModel = { ...model, name: 'First configuration' };
    const secondModel = {
      ...model,
      name: 'Second configuration',
      modelId: 'coding-next'
    };
    const configurations: MarAgentModelConfiguration[] = [];
    let factoryCalls = 0;
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [firstModel],
      adapterFactory: (configuration) => {
        configurations.push(configuration);
        const rejectClose = factoryCalls++ === 0;
        const adapter: ModelAdapter = {
          configuration,
          async *start(): AsyncIterable<ModelEvent> {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          },
          close: vi.fn(async () => {
            if (rejectClose) throw new Error('close failed');
          })
        };
        adapter.createTurnSession = () => ({
          start: (request, signal) => adapter.start(request, signal),
          close: async () => undefined
        });
        return adapter;
      }
    });
    const session = await agent.createSession({ workspace, title: 'Close failure' });

    await expect(session.run({ prompt: 'first' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    await expect(
      agent.reconfigureModels({ models: [secondModel], defaultModelId: 'coding' })
    ).rejects.toThrow('close failed');
    await expect(session.run({ prompt: 'second' }).result()).resolves.toMatchObject({
      status: 'completed'
    });

    expect(configurations.map((configuration) => configuration.modelId)).toEqual([
      'coding',
      'coding'
    ]);
    await agent.dispose();
  });

  it('rejects reconfiguration while a main Session execution is active', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-active-main-reconfiguration-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: (configuration) => new BlockingExecutionAdapter(configuration, markStarted)
    });
    const session = await agent.createSession({ workspace, title: 'Active main execution' });
    const handle = session.run({ prompt: 'wait' });

    await started;
    const reconfigurationError = await agent
      .reconfigureModels({ models: [model], defaultModelId: 'coding' })
      .catch((error: unknown) => error);
    expect(reconfigurationError).toMatchObject({ code: 'MAR_AGENT_EXECUTION_ACTIVE' });
    expect(reconfigurationError).toBeInstanceOf(Error);
    expect((reconfigurationError as Error).message).toContain(
      'Models cannot be reconfigured while a main execution is active.'
    );

    handle.cancel();
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' });
    await agent.dispose();
  });

  it.each([
    {
      name: 'missing',
      configure: () => ({ ...model, apiKey: undefined })
    },
    {
      name: 'ambiguous',
      configure: () => ({
        ...model,
        credentialProvider: {
          acquire: vi.fn(),
          invalidate: vi.fn(),
          close: vi.fn(async () => undefined)
        }
      })
    }
  ])(
    'rejects $name SDK model credential sources during Agent initialization',
    async ({ configure }) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-agent-credential-validation-'));
      roots.push(home);
      const workspace = join(home, 'workspace');
      await mkdir(workspace);

      await expect(
        createMarAgent({
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [configure() as MarAgentModelConfiguration],
          adapterFactory: () => new ImmediateAdapter()
        })
      ).rejects.toMatchObject({
        code: 'MAR_AGENT_MODEL_CONFIG_INVALID'
      });
    }
  );

  it('closes a dynamic credential provider owned only by a disabled model', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-disabled-credential-lifecycle-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const close = vi.fn(async () => undefined);
    const credentialProvider = {
      acquire: vi.fn(),
      invalidate: vi.fn(),
      close
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [
        model,
        {
          ...model,
          id: 'disabled',
          name: 'Disabled',
          enabled: false,
          apiKey: undefined,
          credentialProvider
        } as MarAgentModelConfiguration
      ],
      adapterFactory: () => new ImmediateAdapter()
    });

    await agent.dispose();

    expect(close).toHaveBeenCalledOnce();
  });

  it('continues disposing host resources when a credential provider close fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-credential-close-failure-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const hostDispose = vi.spyOn(host, 'dispose');
    const dynamicModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: {
        acquire: vi.fn(),
        invalidate: vi.fn(),
        close: vi.fn(async () => {
          throw new Error('credential close failed');
        })
      }
    } as unknown as MarAgentModelConfiguration;
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [dynamicModel],
      adapterFactory: () => new ImmediateAdapter()
    });

    await expect(agent.dispose()).rejects.toThrow('credential close failed');

    expect(hostDispose).toHaveBeenCalledOnce();
  });

  it('waits for aborted running subagents before disposal completes', async () => {
    let settled = false;
    const scheduler = new SubagentScheduler(
      async (_task, signal) =>
        new Promise<never>((_resolve, reject) => {
          const finish = () => {
            settled = true;
            reject(signal.reason ?? new Error('cancelled'));
          };
          signal.addEventListener('abort', finish, { once: true });
        })
    );
    await scheduler.run({
      description: 'wait',
      prompt: 'wait for cancellation',
      role: 'explore',
      background: true
    });
    await scheduler.dispose();
    expect(settled).toBe(true);
  });

  it('waits for managed process termination and does not leave a process tree behind', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-process-lifecycle-'));
    roots.push(workspace);
    const tools = new LocalWorkspaceTools(workspace);
    const started = await tools.exec({
      action: 'start',
      command: `${process.execPath} -e "console.log(process.pid); setInterval(() => {}, 1000)"`,
      yieldMs: 250,
      timeoutMs: 10_000
    });
    const pid = Number(started.stdout.trim().split(/\s+/u).at(-1));
    expect(Number.isSafeInteger(pid)).toBe(true);
    await tools.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('retains managed processes and background subagents for the next Session execution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-warm-resources-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new WarmResourceAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Warm resources' });

    await expect(session.run({ prompt: 'start warm resources' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    const resumed = session.run({ prompt: 'resume warm resources' });
    const events = [];
    for await (const event of resumed) events.push(event);
    await expect(resumed.result()).resolves.toMatchObject({ status: 'completed' });

    const resumedRequest = adapter.requests.find((request) =>
      request.messages.some(
        (message) => message.role === 'user' && message.content === 'resume warm resources'
      )
    );
    const resumedContext = resumedRequest?.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');
    expect(resumedRequest?.system).not.toContain('# Retained Session resources');
    expect(resumedContext).not.toContain('# Retained Session resources');
    expect(
      resumedRequest?.messages.some(
        (message) => message.role === 'tool' && message.content.includes('processId')
      )
    ).toBe(true);
    expect(
      resumedRequest?.messages.some(
        (message) => message.role === 'tool' && message.content.includes('agentId')
      )
    ).toBe(true);
    expect(resumedContext).not.toContain('Explicit cancel still releases a resource immediately.');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'exec_wait',
          callId: 'warm-exec-poll'
        }),
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'agent_cancel',
          callId: 'warm-task-cancel',
          data: expect.objectContaining({
            description: 'Keep inspecting',
            status: 'cancelled'
          })
        })
      ])
    );
    await agent.dispose();
    const store = await import('../../src/agent-core/session/store/index.js').then(
      ({ JsonlSessionStore }) => JsonlSessionStore.open(home)
    );
    const records = await store.read(session.id);
    await store.close();
    expect(JSON.stringify(records)).not.toContain('# Retained Session resources');
  });

  it('retains managed processes and background subagents after the parent execution is interrupted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-interrupted-warm-resources-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new WarmResourceAdapter();
    const host = new McpScopeTrackingHost({ homeDirectory: home, workspace });
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Interrupted warm resources' });

    const interrupted = session.run({
      prompt: 'interrupt warm resources'
    });
    await adapter.childStarted;
    expect(host.catalogContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: interrupted.executionId,
          claimExecutionScope: true
        }),
        expect.objectContaining({
          executionScopeId: interrupted.executionId
        })
      ])
    );
    interrupted.cancel();
    await expect(interrupted.result()).resolves.toMatchObject({ status: 'cancelled' });

    const resumed = session.run({
      prompt: 'reuse interrupted resources'
    });
    const events = [];
    for await (const event of resumed) events.push(event);
    await expect(resumed.result()).resolves.toMatchObject({ status: 'completed' });
    const resumedRequest = adapter.requests.find((request) =>
      request.messages.some(
        (message) => message.role === 'user' && message.content === 'reuse interrupted resources'
      )
    );
    const resumedContext = resumedRequest?.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');
    expect(resumedContext).not.toContain('# Retained Session resources');
    expect(
      resumedRequest?.messages.some(
        (message) => message.role === 'tool' && message.content.includes('processId')
      )
    ).toBe(true);
    expect(
      resumedRequest?.messages.some(
        (message) => message.role === 'tool' && message.content.includes('agentId')
      )
    ).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'agent_message',
          callId: 'warm-task-message',
          data: expect.objectContaining({
            status: 'running',
            deliveryStatus: expect.stringMatching(/accepted|applied/u)
          })
        })
      ])
    );

    await agent.dispose();
  });

  it('cancels subagents and their active parent wait during Agent disposal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-foreground-dispose-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new WarmResourceAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Foreground disposal' });
    const handle = session.run({ prompt: 'start subagent and wait' });
    await adapter.childStarted;

    await expect(
      Promise.race([
        agent.dispose(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Agent disposal timed out')), 2_000);
          timer.unref();
        })
      ])
    ).resolves.toBeUndefined();
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('retains a subagent after cancelling its parent wait and recovers its handle only after Compact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-foreground-cancel-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new WarmResourceAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Foreground cancellation' });
    const handle = session.run({ prompt: 'start subagent and wait' });
    const events: MarAgentEvent[] = [];
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => (resolveStarted = resolve));
    const consume = (async () => {
      for await (const event of handle) {
        events.push(event);
        if (event.type === 'subagent.started') resolveStarted();
      }
    })();

    try {
      await adapter.childStarted;
      await expect(
        Promise.race([
          started,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Subagent start event timed out')),
              2_000
            );
            timer.unref();
          })
        ])
      ).resolves.toBeUndefined();

      handle.cancel();
      await expect(
        Promise.race([
          handle.result(),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Foreground subagent cancellation timed out')),
              2_000
            );
            timer.unref();
          })
        ])
      ).resolves.toMatchObject({ status: 'cancelled' });
      await consume;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'subagent.started',
            description: 'Wait for disposal'
          })
        ])
      );
      expect(
        events.some((event) => event.type === 'subagent.completed' && event.status === 'cancelled')
      ).toBe(false);

      expect((await session.compact().result()).status).toBe('completed');

      const resumed = session.run({
        prompt: 'inspect retained waiting subagent'
      });
      const resumedEvents: MarAgentEvent[] = [];
      for await (const event of resumed) resumedEvents.push(event);
      await expect(resumed.result()).resolves.toMatchObject({ status: 'completed' });
      expect(resumedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool.completed',
            toolName: 'agent_wait',
            callId: 'retained-foreground-wait',
            data: expect.objectContaining({
              status: 'running',
              waitOutcome: 'snapshot'
            })
          })
        ])
      );
      const resumedRequest = adapter.requests.find((request) =>
        request.messages.some(
          (message) =>
            message.role === 'user' && message.content === 'inspect retained waiting subagent'
        )
      );
      const retainedContext = resumedRequest?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n');
      expect(retainedContext).toMatch(/agentId: [0-9a-f-]+/u);
      expect(retainedContext).toContain('status: running');
    } finally {
      await agent.dispose();
    }
  });

  it('immediately reclaims active Session resources before deleting the Session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-session-delete-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new WarmResourceAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Delete active Session' });
    const handle = session.run({ prompt: 'start subagent and wait' });
    await adapter.childStarted;

    await expect(agent.deleteSession(session.id)).resolves.toBeUndefined();
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' });
    await expect(agent.openSession(session.id)).rejects.toThrow();
    await agent.dispose();
  });
});
