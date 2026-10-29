import { effectiveInstructions } from './support/model-context.js';
import { access, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, type McpToolCatalogContext } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { LocalWorkspaceTools } from '../support/local-workspace-tools.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/model/contracts.js';
import { AsyncQueue } from '../../src/runtime/async-queue.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

const model: AgentModelConfiguration = {
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

class WarmProcessAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  readonly #rounds = new Map<string, number>();
  readonly processReady: Promise<void>;
  #resolveProcessReady!: () => void;

  constructor() {
    this.processReady = new Promise<void>((resolve) => (this.#resolveProcessReady = resolve));
  }

  async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const prompt =
      [...request.messages]
        .reverse()
        .find((message) => message.role === 'user' && message.contextKind === undefined)?.content ??
      '';
    const round = this.#rounds.get(prompt) ?? 0;
    this.#rounds.set(prompt, round + 1);
    if ((prompt === 'start warm process' || prompt === 'interrupt warm process') && round === 0) {
      yield {
        type: 'client_tool.call',
        callId: prompt === 'start warm process' ? 'start-process' : 'interrupt-process',
        name: 'exec',
        arguments: {
          command:
            JSON.stringify(process.execPath) +
            ' -e "console.log(\'READY\'); setInterval(() => {}, 1000)"',
          yieldMs: 100,
          timeoutMs: 10_000
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (prompt === 'interrupt warm process') {
      this.#resolveProcessReady();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return;
    }
    if (
      (prompt === 'resume warm process' || prompt === 'reuse interrupted process') &&
      round === 0
    ) {
      const retained = request.messages
        .filter((message) => message.role === 'tool')
        .flatMap((message) => {
          try {
            return [JSON.parse(message.content) as { processId?: string }];
          } catch {
            return [];
          }
        });
      const processId = retained.find((value) => value.processId)?.processId;
      if (!processId) throw new Error('retained process ID missing from history');
      yield {
        type: 'client_tool.call',
        callId: prompt === 'resume warm process' ? 'resume-process' : 'reuse-process',
        name: 'exec_wait',
        arguments: { processId }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer-' + prompt, text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ReconfigurableSessionAdapter implements ModelAdapter {
  readonly close = vi.fn(async () => undefined);

  constructor(
    readonly configuration: AgentModelConfiguration,
    private readonly state: { activeStarted(): void; releaseActive: Promise<void> }
  ) {}

  async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const prompt =
      [...request.messages]
        .reverse()
        .find((message) => message.role === 'user' && message.contextKind === undefined)?.content ??
      '';
    if (prompt === 'hold active Session') {
      this.state.activeStarted();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const abort = () => {
          if (settled) return;
          settled = true;
          reject(signal.reason ?? new Error('cancelled'));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        void this.state.releaseActive.then(() => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          resolve();
        });
      });
    }
    yield { type: 'text.completed', itemId: 'answer-' + prompt, text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class BlockingExecutionAdapter implements ModelAdapter {
  constructor(
    readonly configuration: AgentModelConfiguration,
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
  it('never buffers best-effort live values while keeping ordinary events in order', async () => {
    const queue = new AsyncQueue<number>();
    for (let i = 0; i < 10_000; i++) queue.pushIfWaiting(i);
    expect(queue.bufferedSize).toBe(0);
    const iterator = queue[Symbol.asyncIterator]();
    queue.push(1);
    queue.pushIfWaiting(2);
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(queue.bufferedSize).toBe(0);
    const waiting = iterator.next();
    queue.pushIfWaiting(3);
    expect(await waiting).toEqual({ value: 3, done: false });
    queue.pushIfWaiting(4);
    queue.push(5);
    queue.close();
    queue.pushIfWaiting(6);
    expect(await iterator.next()).toEqual({ value: 5, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

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
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model]
        },
        () => new ImmediateAdapter()
      );
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
    } as unknown as AgentModelConfiguration;
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [dynamicModel, { ...dynamicModel, id: 'review', name: 'Review' }]
      },
      () => new ImmediateAdapter()
    );

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
    } as AgentModelConfiguration;
    const secondModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: secondProvider
    } as AgentModelConfiguration;
    const configurations: AgentModelConfiguration[] = [];
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [firstModel]
      },
      (configuration) => {
        configurations.push(configuration);
        return new ImmediateAdapter();
      }
    );
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
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model],
        systemInstruction: 'ORIGINAL_HOST_INSTRUCTION'
      },
      (configuration) => ({
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
    );
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
    } as AgentModelConfiguration;
    const secondModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: {
        acquire: vi.fn(),
        invalidate: vi.fn(),
        close: secondClose
      }
    } as AgentModelConfiguration;
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [firstModel]
      },
      () => new ImmediateAdapter()
    );
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

  it('rebinds an idle Session without interrupting another active Session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-active-session-reconfiguration-'));
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
    } as AgentModelConfiguration;
    const secondModel = {
      ...model,
      apiKey: undefined,
      credentialProvider: secondProvider
    } as AgentModelConfiguration;
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => (markActiveStarted = resolve));
    let releaseActive!: () => void;
    const activeRelease = new Promise<void>((resolve) => (releaseActive = resolve));
    const state = { activeStarted: markActiveStarted, releaseActive: activeRelease };
    const adapters: ReconfigurableSessionAdapter[] = [];
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [firstModel]
      },
      (configuration) => {
        const adapter = new ReconfigurableSessionAdapter(configuration, state);
        adapters.push(adapter);
        return adapter;
      }
    );
    const idleSession = await agent.createSession({ workspace, title: 'Idle Session' });
    const activeSession = await agent.createSession({
      workspace,
      title: 'Active Session',
      source: {
        type: 'subagent',
        parentSessionId: idleSession.id,
        rootSessionId: idleSession.id,
        parentExecutionId: 'completed-parent',
        role: 'general-purpose',
        description: 'Active child'
      }
    });

    try {
      await expect(
        idleSession.run({ prompt: 'initialize idle Session' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      const activeExecution = activeSession.run({ prompt: 'hold active Session' });
      await activeStarted;
      expect(adapters).toHaveLength(2);

      await expect(
        agent.reconfigureModels({ models: [secondModel], defaultModelId: 'coding' })
      ).resolves.toBeUndefined();
      expect(adapters[0]!.close).toHaveBeenCalledOnce();
      expect(adapters[1]!.close).not.toHaveBeenCalled();
      expect(firstProvider.close).not.toHaveBeenCalled();

      await expect(
        idleSession.run({ prompt: 'continue after rebinding' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(adapters).toHaveLength(3);
      expect(adapters[2]!.configuration.credentialProvider).toBe(secondProvider);
      expect(adapters[1]!.close).not.toHaveBeenCalled();

      releaseActive();
      await expect(activeExecution.result()).resolves.toMatchObject({ status: 'completed' });
      expect(adapters[1]!.close).toHaveBeenCalledOnce();

      await agent.dispose();
      expect(adapters[1]!.close).toHaveBeenCalledOnce();
      expect(adapters[2]!.close).toHaveBeenCalledOnce();
      expect(firstProvider.close).toHaveBeenCalledOnce();
      expect(secondProvider.close).toHaveBeenCalledOnce();
    } finally {
      releaseActive();
      await agent.dispose();
    }
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
    const configurations: AgentModelConfiguration[] = [];
    let factoryCalls = 0;
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [firstModel]
      },
      (configuration) => {
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
    );
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
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      (configuration) => new BlockingExecutionAdapter(configuration, markStarted)
    );
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

  it('cancels an active Session execution during Agent disposal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-active-session-dispose-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      (configuration) => new BlockingExecutionAdapter(configuration, markStarted)
    );
    const session = await agent.createSession({ workspace, title: 'Dispose active Session' });
    const execution = session.run({ prompt: 'wait until disposal' });

    try {
      await started;
      await expect(agent.dispose()).resolves.toBeUndefined();
      await expect(execution.result()).resolves.toMatchObject({ status: 'cancelled' });
    } finally {
      await agent.dispose();
    }
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
        createMarAgent(
          {
            mode: 'normal',
            host: new LocalAgentHost({ homeDirectory: home, workspace }),
            models: [configure() as AgentModelConfiguration]
          },
          () => new ImmediateAdapter()
        )
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
    const agent = await createMarAgent(
      {
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
          } as AgentModelConfiguration
        ]
      },
      () => new ImmediateAdapter()
    );

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
    } as unknown as AgentModelConfiguration;
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [dynamicModel]
      },
      () => new ImmediateAdapter()
    );

    await expect(agent.dispose()).rejects.toThrow('credential close failed');

    expect(hostDispose).toHaveBeenCalledOnce();
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

  it('retains managed processes for the next Session execution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-warm-process-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new WarmProcessAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );
    const session = await agent.createSession({ workspace, title: 'Warm process' });

    await expect(session.run({ prompt: 'start warm process' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    const resumed = session.run({ prompt: 'resume warm process' });
    const events = [];
    for await (const event of resumed) events.push(event);
    await expect(resumed.result()).resolves.toMatchObject({ status: 'completed' });

    const resumedRequest = adapter.requests.find((request) =>
      request.messages.some(
        (message) => message.role === 'user' && message.content === 'resume warm process'
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
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'exec_wait',
          callId: 'resume-process'
        })
      ])
    );

    await agent.dispose();
    const store = await import('../../src/session/store/index.js').then(({ JsonlSessionStore }) =>
      JsonlSessionStore.open(home)
    );
    const records = await store.read(session.id);
    await store.close();
    expect(JSON.stringify(records)).not.toContain('# Retained Session resources');
  });

  it('retains managed processes after the parent execution is interrupted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-interrupted-warm-process-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new WarmProcessAdapter();
    const host = new McpScopeTrackingHost({ homeDirectory: home, workspace });
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      () => adapter
    );
    const session = await agent.createSession({ workspace, title: 'Interrupted warm process' });

    const interrupted = session.run({ prompt: 'interrupt warm process' });
    await adapter.processReady;
    expect(host.catalogContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: interrupted.executionId,
          claimExecutionScope: true
        })
      ])
    );
    interrupted.cancel();
    await expect(interrupted.result()).resolves.toMatchObject({ status: 'cancelled' });

    const resumed = session.run({ prompt: 'reuse interrupted process' });
    const events = [];
    for await (const event of resumed) events.push(event);
    await expect(resumed.result()).resolves.toMatchObject({ status: 'completed' });
    expect(host.catalogContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executionId: resumed.executionId, claimExecutionScope: true })
      ])
    );
    const resumedRequest = adapter.requests.find((request) =>
      request.messages.some(
        (message) => message.role === 'user' && message.content === 'reuse interrupted process'
      )
    );
    expect(
      resumedRequest?.messages.some(
        (message) => message.role === 'tool' && message.content.includes('processId')
      )
    ).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'exec_wait',
          callId: 'reuse-process'
        })
      ])
    );

    await agent.dispose();
  });

  it('immediately cancels an active Session execution before deleting the Session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-session-delete-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      (configuration) => new BlockingExecutionAdapter(configuration, markStarted)
    );
    const session = await agent.createSession({ workspace, title: 'Delete active Session' });
    const handle = session.run({ prompt: 'block until deleted' });
    await started;

    await expect(agent.deleteSession(session.id)).resolves.toBeUndefined();
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' });
    await expect(agent.openSession(session.id)).rejects.toThrow();
    await agent.dispose();
  });
});
