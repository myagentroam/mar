import { executionActivity } from './support/execution-activity.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as operational from '../../src/operational.js';
import type { ExecutionHandle } from '@myagentroam/agent';
import { createEnvelope, type MarAgentRuntimeModelConfiguration } from '@myagentroam/protocol';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { NodeControlMessageService } from '../../src/service/node-control-message-service.js';
import {
  MarAgentManagedRunController,
  resolveRunModels
} from '../../src/runner/mar-agent/managed-run-controller.js';
import {
  MarAgentMcpClientCache,
  MarAgentMcpClientPool
} from '../../src/runner/mar-agent/mcp-client-pool.js';

type Options = NonNullable<ConstructorParameters<typeof MarAgentManagedRunController>[2]>;
type Phase = 'admission' | 'open' | 'refresh' | 'computer' | 'mcp' | 'metadata';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.spyOn(operational, 'nodeLog').mockImplementation(() => undefined));

async function fixture(phase: Phase, mode: 'run' | 'plan' | 'compact' = 'run') {
  const cwd = await mkdtemp(join(tmpdir(), 'mar-preparation-cancellation-'));
  let entered!: () => void;
  let unblock!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (unblock = resolve));
  let blocked = false;
  let preparationFailure = false;
  const wait = async (stage: Phase) => {
    if (stage !== phase || blocked) return;
    blocked = true;
    entered();
    await gate;
    if (preparationFailure) throw new Error('FIXTURE_PREPARATION_FAILED');
  };
  const handle: ExecutionHandle = {
    executionId: 'sdk-execution',
    async *[Symbol.asyncIterator]() {},
    result: async () => ({
      executionId: 'sdk-execution',
      status: 'completed',
      finalAnswer: 'done'
    }),
    cancel: vi.fn()
  };
  const session = {
    id: 'native-session',
    run: vi.fn(() => handle),
    plan: vi.fn(() => handle),
    compact: vi.fn(() => handle)
  };
  const agent = {
    createSession: vi.fn(async () => {
      await wait('open');
      return session;
    }),
    openSession: vi.fn(async () => {
      await wait('open');
      return session;
    }),
    getSession: vi.fn(async () => {
      await wait('metadata');
      return { id: session.id, title: 'Fixture', automaticTitlePending: false };
    }),
    reconfigureModels: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined)
  };
  const createAgent = vi.fn(async () => agent);
  const releaseEnvironment = vi.fn();
  const retainEnvironment = vi.fn(() => releaseEnvironment);
  const binding = { tools: [], call: vi.fn(), close: vi.fn(async () => undefined) };
  const bind = vi.fn(async () => {
    await wait('computer');
    return binding;
  });
  const refresh = vi
    .spyOn(MarAgentMcpClientPool.prototype, 'refreshForExecution')
    .mockImplementation(async () => wait('refresh'));
  const releaseMcp = vi.fn(async () => undefined);
  if (phase === 'mcp') {
    const acquire = MarAgentMcpClientCache.prototype.acquire;
    vi.spyOn(MarAgentMcpClientCache.prototype, 'acquire').mockImplementation(async function (
      this: MarAgentMcpClientCache,
      servers,
      directory,
      options
    ) {
      if (options?.reusable !== false) return acquire.call(this, servers, directory, options);
      await wait('mcp');
      return {
        pool: new MarAgentMcpClientPool(),
        release: releaseMcp
      };
    });
  }
  const activity = executionActivity();
  const host = {
    ...activity,
    adopt: vi.fn(),
    promote: vi.fn(),
    syncTitle: vi.fn(async () => undefined),
    emit: vi.fn((runId: string, _type: string, _payload: unknown, status?: string) => {
      if (
        status === 'SUCCEEDED' ||
        status === 'FAILED' ||
        status === 'CANCELLED' ||
        status === 'INTERRUPTED'
      )
        activity.active.delete(runId);
    }),
    emitItem: vi.fn(),
    run: vi.fn(),
    commandState: vi.fn(),
    setCommandState: vi.fn(),
    clearCommandState: vi.fn(),
    commandStates: vi.fn(() => []),
    webSearch: vi.fn()
  };
  const runner = new MarAgentRunner();
  const computerUse = {
    support: vi.fn(),
    reset: vi.fn(),
    bind,
    releaseSession: vi.fn(),
    dispose: vi.fn()
  };
  const controller = new MarAgentManagedRunController(runner, host, {
    createAgent: createAgent as unknown as NonNullable<Options['createAgent']>,
    retainEnvironment,
    computerUse
  });
  runner.bindControl({
    start: (envelope) => controller.start(envelope),
    cancel: (runId, intent) => controller.cancel(runId, intent),
    respondUserInput: (runId, requestId, answers) =>
      controller.respondUserInput(runId, requestId, answers)
  });
  const configuration: MarAgentRuntimeModelConfiguration = {
    id: 'fixture',
    name: 'Fixture',
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: 'https://fixture.invalid',
    apiKey: 'fixture-only',
    modelId: 'fixture',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  };
  const model = resolveRunModels(configuration, [configuration])[0]!;
  const input = {
    sessionId: session.id,
    input: 'fixture input',
    cwd,
    model,
    models: [model],
    effort: '',
    mode,
    mcpServers:
      phase === 'mcp'
        ? [{ name: 'fixture', transport: 'HTTP' as const, lifecycle: 'EXECUTION' as const }]
        : [],
    images: []
  };
  const run = (controller as unknown as { run(input: unknown): Promise<void> }).run.bind(
    controller
  );
  return {
    controller,
    computerUse,
    runners: new RunnerRegistry([runner]),
    host,
    session,
    handle,
    createAgent,
    retainEnvironment,
    releaseEnvironment,
    agent,
    model,
    binding,
    releaseMcp,
    refresh,
    reached,
    unblock,
    failPreparation: () => {
      preparationFailure = true;
    },
    run: (runId: string, overrides: Record<string, unknown> = {}) =>
      run({ ...input, runId, ...overrides }),
    close: async () => {
      unblock();
      try {
        await controller.dispose();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  };
}

it.each(['idle expiry', 'session release', 'controller disposal'] as const)(
  'retains the environment until Runtime %s and releases it exactly once',
  async (release) => {
    const f = await fixture('admission');
    vi.useFakeTimers();
    try {
      const environment = { MAR_GIT_TOKEN: 'fixture-capability' };
      await f.run('first', { secretEnvironment: environment });
      await f.run('second', { secretEnvironment: environment });
      expect(f.retainEnvironment).toHaveBeenCalledExactlyOnceWith(environment);
      expect(f.releaseEnvironment).not.toHaveBeenCalled();
      if (release === 'idle expiry') {
        await vi.advanceTimersByTimeAsync(599_999);
        expect(f.releaseEnvironment).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      } else if (release === 'session release') {
        await f.controller.releaseSession('native-session');
      } else await f.controller.dispose();
      expect(f.agent.dispose).toHaveBeenCalledOnce();
      expect(f.releaseEnvironment).toHaveBeenCalledOnce();
      expect(f.agent.dispose.mock.invocationCallOrder[0]).toBeLessThan(
        f.releaseEnvironment.mock.invocationCallOrder[0]!
      );
      await f.controller.dispose();
      expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  }
);

it('returns the environment reference after Runtime creation fails and acquires it again on retry', async () => {
  const f = await fixture('admission');
  try {
    f.createAgent.mockRejectedValueOnce(new Error('FIXTURE_AGENT_CREATION_FAILED'));
    await f.run('failed');
    expect(f.host.emit).toHaveBeenCalledWith('failed', 'run.failed', expect.anything(), 'FAILED');
    expect(f.retainEnvironment).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    await f.run('retry');
    expect(f.retainEnvironment).toHaveBeenCalledTimes(2);
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    await f.controller.dispose();
    expect(f.releaseEnvironment).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it('rejects an expired environment before creating an Agent and permits a fresh retry', async () => {
  const f = await fixture('admission');
  try {
    f.retainEnvironment.mockImplementationOnce(() => {
      throw new Error('GIT_CREDENTIAL_CONTEXT_EXPIRED');
    });
    await f.run('failed');
    expect(f.host.emit).toHaveBeenCalledWith('failed', 'run.failed', expect.anything(), 'FAILED');
    expect(f.createAgent).not.toHaveBeenCalled();
    expect(f.releaseEnvironment).not.toHaveBeenCalled();
    await f.run('retry');
    expect(f.createAgent).toHaveBeenCalledOnce();
    await f.controller.dispose();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it.each(['acquiring', 'running', 'idle'] as const)(
  'does not let an old finalizer reclaim or extend the %s continuation lease',
  async (phase) => {
    const f = await fixture('admission');
    let enterClose!: () => void;
    let finishClose!: () => void;
    let enterNext!: () => void;
    let finishNext!: () => void;
    const closing = new Promise<void>((resolve) => (enterClose = resolve));
    const closeGate = new Promise<void>((resolve) => (finishClose = resolve));
    const nextEntered = new Promise<void>((resolve) => (enterNext = resolve));
    const nextGate = new Promise<void>((resolve) => (finishNext = resolve));
    f.binding.close.mockImplementationOnce(async () => {
      enterClose();
      await closeGate;
    });
    let first: Promise<void> | undefined;
    let next: Promise<void> | undefined;
    vi.useFakeTimers();
    try {
      first = f.run('first');
      await closing;
      expect(f.host.emit).not.toHaveBeenCalledWith(
        'first',
        'run.completed',
        { status: 'SUCCEEDED' },
        'SUCCEEDED'
      );
      if (phase === 'acquiring') {
        f.agent.reconfigureModels.mockImplementationOnce(async () => {
          enterNext();
          await nextGate;
        });
        const changed = { ...f.model, name: 'Updated fixture' };
        next = f.run('next', { model: changed, models: [changed] });
      } else {
        f.session.run.mockReturnValueOnce({
          ...f.handle,
          // eslint-disable-next-line require-yield -- This fixture fails or waits for cancellation without emitting model events.
          async *[Symbol.asyncIterator]() {
            enterNext();
            await nextGate;
          }
        });
        next = f.run('next');
      }
      await nextEntered;
      if (phase === 'idle') {
        finishNext();
        await next;
        await vi.advanceTimersByTimeAsync(300_000);
      }
      finishClose();
      await first;
      expect(f.host.emit).toHaveBeenCalledWith(
        'first',
        'run.completed',
        { status: 'SUCCEEDED' },
        'SUCCEEDED'
      );
      await vi.advanceTimersByTimeAsync(phase === 'idle' ? 300_000 : 600_000);
      expect(f.agent.dispose).toHaveBeenCalledTimes(phase === 'idle' ? 1 : 0);
      expect(f.createAgent).toHaveBeenCalledTimes(1);
      if (phase !== 'idle') {
        finishNext();
        await next;
        await vi.advanceTimersByTimeAsync(599_999);
        expect(f.agent.dispose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(f.agent.dispose).toHaveBeenCalledTimes(1);
      }
    } finally {
      finishClose();
      finishNext();
      await Promise.allSettled([first, next]);
      await f.close();
      vi.useRealTimers();
    }
  }
);

it('restores idle expiry after a retained Runtime fails model reconfiguration', async () => {
  const f = await fixture('admission');
  vi.useFakeTimers();
  try {
    await f.run('first');
    f.agent.reconfigureModels.mockRejectedValueOnce(new Error('FIXTURE_RECONFIGURATION_FAILED'));
    const changed = { ...f.model, name: 'Updated fixture' };
    await f.run('failed', { model: changed, models: [changed] });
    expect(f.host.emit).toHaveBeenCalledWith('failed', 'run.failed', expect.anything(), 'FAILED');
    await vi.advanceTimersByTimeAsync(599_999);
    expect(f.agent.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.agent.dispose).toHaveBeenCalledOnce();
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});

it('disposes a Run reentrantly started before Runtime acquisition without admitting the SDK', async () => {
  const f = await fixture('admission');
  let disposal: Promise<void> | undefined;
  f.host.emit.mockImplementation((runId, _event, _payload, status) => {
    if (status === 'STARTING') disposal = f.controller.dispose();
    if (
      status === 'SUCCEEDED' ||
      status === 'FAILED' ||
      status === 'CANCELLED' ||
      status === 'INTERRUPTED'
    )
      f.host.active.delete(runId);
  });
  try {
    await f.run('first');
    await disposal;
    expect(f.createAgent).not.toHaveBeenCalled();
    expect(f.session.run).not.toHaveBeenCalled();
    expect(f.host.active.size).toBe(0);
  } finally {
    await f.close();
  }
});

it('joins a failed event stream with the accepted result and cleanup before publishing failure', async () => {
  const f = await fixture('admission');
  const result = Promise.withResolvers<Awaited<ReturnType<ExecutionHandle['result']>>>();
  const streamFailed = Promise.withResolvers<void>();
  f.session.run.mockReturnValueOnce({
    executionId: 'sdk-execution',
    async *[Symbol.asyncIterator]() {
      streamFailed.resolve();
      throw new Error('STREAM_FAILURE');
    },
    result: () => result.promise,
    cancel: vi.fn()
  });
  try {
    const running = f.run('stream-failure');
    await streamFailed.promise;
    expect(f.host.emit).not.toHaveBeenCalledWith(
      'stream-failure',
      'run.failed',
      expect.anything(),
      'FAILED'
    );
    expect(f.binding.close).not.toHaveBeenCalled();
    result.resolve({ executionId: 'sdk-execution', status: 'completed', finalAnswer: 'done' });
    await running;
    expect(f.binding.close).toHaveBeenCalledOnce();
    expect(f.host.emit).toHaveBeenCalledWith(
      'stream-failure',
      'run.failed',
      expect.objectContaining({ code: 'MAR_AGENT_RUN_FAILED' }),
      'FAILED'
    );
  } finally {
    result.resolve({ executionId: 'sdk-execution', status: 'completed', finalAnswer: 'done' });
    await f.close();
  }
});

it('drains a late Computer Use binding before Session release completes', async () => {
  const f = await fixture('computer');
  try {
    const running = f.run('first');
    await f.reached;
    let released = false;
    const release = f.controller.releaseSession('native-session').then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(f.agent.dispose).not.toHaveBeenCalled();
    f.unblock();
    await Promise.all([running, release]);
    expect(f.session.run).not.toHaveBeenCalled();
    expect(f.binding.close).toHaveBeenCalledOnce();
    expect(f.agent.dispose).toHaveBeenCalledOnce();
    await f.run('next');
    expect(f.session.run).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('settles Run cleanup and still releases Execution MCP when Computer Use unbinding fails', async () => {
  const f = await fixture('mcp');
  f.binding.close.mockRejectedValueOnce(new Error('COMPUTER_CLOSE_FAILED'));
  try {
    const running = f.run('first');
    await f.reached;
    f.unblock();
    await running;
    await f.controller.dispose();
    expect(f.releaseMcp).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    expect(f.host.active.size).toBe(0);
    const terminals = f.host.emit.mock.calls.filter((call) =>
      ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(call[3] as string)
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.[3]).toBe('SUCCEEDED');
  } finally {
    await f.close();
  }
});

it('still disposes Computer Use when closing the global MCP cache fails', async () => {
  const f = await fixture('admission');
  try {
    await f.run('first');
    vi.spyOn(MarAgentMcpClientCache.prototype, 'close').mockRejectedValueOnce(
      new Error('CACHE_CLOSE_FAILED')
    );
    const disposal = f.controller.dispose();
    expect(f.controller.dispose()).toBe(disposal);
    await expect(disposal).rejects.toThrow('CACHE_CLOSE_FAILED');
    expect(f.computerUse.dispose).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
  } finally {
    await f.close().catch(() => undefined);
  }
});

it('correlates Runtime reuse and release without logging Host configuration', async () => {
  const f = await fixture('admission');
  try {
    await f.run('first');
    await f.run('second');
    await f.run('changed', { secretEnvironment: { FIXTURE_SECRET: 'not-for-logs' } });
    await f.controller.releaseSession('native-session');
    const records = vi.mocked(operational.nodeLog).mock.calls;
    expect(records.map(([event]) => event)).toEqual([
      'runner.mar-agent.runtime.created',
      'runner.mar-agent.runtime.reused',
      'runner.mar-agent.runtime.releasing',
      'runner.mar-agent.runtime.created',
      'runner.mar-agent.runtime.releasing'
    ]);
    const firstId = records[0]![1]!.runtimeId;
    expect(firstId).toEqual(expect.any(String));
    expect(records[1]![1]!.runtimeId).toBe(firstId);
    expect(records[2]![1]).toEqual({
      runtimeId: firstId,
      sessionId: 'native-session',
      reason: 'host_configuration_changed',
      changedCategories: ['environment']
    });
    expect(records[3]![1]!.runtimeId).not.toBe(firstId);
    expect(records[4]![1]).toEqual({
      runtimeId: records[3]![1]!.runtimeId,
      sessionId: 'native-session',
      reason: 'session_released'
    });
    for (const [, fields] of records)
      expect(
        Object.keys(fields!).every((key) =>
          ['runtimeId', 'sessionId', 'runId', 'reason', 'changedCategories'].includes(key)
        )
      ).toBe(true);
    expect(JSON.stringify(records)).not.toContain('not-for-logs');
    expect(JSON.stringify(records)).not.toContain('FIXTURE_SECRET');
  } finally {
    await f.close();
  }
});

it.each(['admission', 'open', 'refresh', 'computer', 'mcp', 'metadata'] as const)(
  'handles interruption during %s without a late SDK start or a busy continuation',
  async (phase) => {
    const f = await fixture(phase);
    const pending = f.run('first');
    try {
      if (phase !== 'admission') await f.reached;
      expect(f.controller.cancel('first', 'INTERRUPT')).toBe(true);
      expect(f.host.emit).toHaveBeenCalledWith('first', 'run.cancelling', { intent: 'INTERRUPT' });
      expect(f.host.emit).not.toHaveBeenCalledWith(
        'first',
        'run.cancelled',
        expect.anything(),
        'CANCELLED'
      );
      f.unblock();
      await pending;

      expect(f.session.run).not.toHaveBeenCalled();
      expect(f.host.emitItem).not.toHaveBeenCalled();
      expect(f.host.emit).toHaveBeenCalledWith(
        'first',
        'run.cancelled',
        { status: 'CANCELLED' },
        'CANCELLED'
      );
      expect(f.host.active.has('first')).toBe(false);
      expect(f.controller.cancel('first', 'INTERRUPT')).toBe(false);
      if (phase === 'computer' || phase === 'metadata')
        expect(f.binding.close).toHaveBeenCalledTimes(1);
      if (phase === 'mcp') expect(f.releaseMcp).toHaveBeenCalledTimes(1);

      await f.run('second');
      expect(f.session.run).toHaveBeenCalledTimes(1);
      expect(f.host.emit).toHaveBeenCalledWith(
        'second',
        'run.completed',
        { status: 'SUCCEEDED' },
        'SUCCEEDED'
      );
      expect(f.host.emitItem).not.toHaveBeenCalled();
    } finally {
      f.unblock();
      await pending;
      await f.close();
    }
  }
);

it.each(['run', 'plan', 'compact'] as const)(
  'interrupts %s preparation and successfully admits the next execution',
  async (mode) => {
    const f = await fixture('computer', mode);
    const pending = f.run('first');
    try {
      await f.reached;
      expect(f.controller.cancel('first', 'INTERRUPT')).toBe(true);
      f.unblock();
      await pending;
      expect(f.session[mode]).not.toHaveBeenCalled();
      await f.run('second');
      expect(f.session[mode]).toHaveBeenCalledTimes(1);
      expect(f.host.emitItem).not.toHaveBeenCalled();
    } finally {
      f.unblock();
      await pending;
      await f.close();
    }
  }
);

it('still delegates active SDK cancellation exactly once', async () => {
  const f = await fixture('admission');
  let entered!: () => void;
  let stop!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const cancel = vi.fn(() => stop());
  f.session.run.mockReturnValueOnce({
    ...f.handle,
    // eslint-disable-next-line require-yield -- This fixture fails or waits for cancellation without emitting model events.
    async *[Symbol.asyncIterator]() {
      entered();
      await stopped;
    },
    result: async () => ({ executionId: 'sdk-execution', status: 'cancelled', finalAnswer: '' }),
    cancel
  });
  const pending = f.run('first');
  try {
    await started;
    expect(f.controller.cancel('first', 'INTERRUPT')).toBe(true);
    expect(f.controller.cancel('first', 'CANCEL')).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    await pending;
    expect(f.host.emit).toHaveBeenCalledWith(
      'first',
      'run.cancelled',
      { status: 'CANCELLED' },
      'CANCELLED'
    );
    await f.run('second');
    expect(f.session.run).toHaveBeenCalledTimes(2);
    expect(f.host.emitItem).not.toHaveBeenCalled();
  } finally {
    stop();
    await pending;
    await f.close();
  }
});

it.each(['run', 'plan', 'compact'] as const)(
  'cancels %s preparation even when its pending setup fails',
  async (mode) => {
    const f = await fixture('open', mode);
    const pending = f.run('first');
    try {
      await f.reached;
      expect(f.controller.cancel('first', 'CANCEL')).toBe(true);
      f.failPreparation();
      f.unblock();
      await pending;
      expect(f.host.emitItem).not.toHaveBeenCalled();
      expect(f.host.emit).toHaveBeenCalledWith(
        'first',
        'run.cancelled',
        { status: 'CANCELLED' },
        'CANCELLED'
      );
      expect(f.session[mode]).not.toHaveBeenCalled();
      expect(f.host.active.has('first')).toBe(false);
    } finally {
      f.unblock();
      await pending;
      await f.close();
    }
  }
);

it('keeps control ownership until cancelled preparation cleanup finishes', async () => {
  const f = await fixture('metadata');
  let cleanupEntered!: () => void;
  let finishCleanup!: () => void;
  const reachedCleanup = new Promise<void>((resolve) => (cleanupEntered = resolve));
  const cleanup = new Promise<void>((resolve) => (finishCleanup = resolve));
  f.binding.close.mockImplementationOnce(async () => {
    cleanupEntered();
    await cleanup;
  });
  const pending = f.run('first');
  try {
    await f.reached;
    expect(f.controller.cancel('first', 'INTERRUPT')).toBe(true);
    f.unblock();
    await reachedCleanup;
    expect(f.host.active.has('first')).toBe(true);
    expect(f.controller.cancel('first', 'INTERRUPT')).toBe(true);
    expect(f.host.emit).not.toHaveBeenCalledWith(
      'first',
      'run.cancelled',
      expect.anything(),
      'CANCELLED'
    );
    finishCleanup();
    await pending;
    await f.run('second');
    expect(f.session.run).toHaveBeenCalledTimes(1);
    expect(f.host.emitItem).not.toHaveBeenCalled();
  } finally {
    f.unblock();
    finishCleanup();
    await pending;
    await f.close();
  }
});

it('does not use the uncontrolled-cancellation fallback while the Runner is preparing', async () => {
  const f = await fixture('computer');
  const completeUncontrolledCancellation = vi.fn();
  const close = vi.fn();
  const send = vi.fn();
  const control = new NodeControlMessageService({
    config: () => undefined,
    register: vi.fn(),
    connected: vi.fn(),
    close,
    inspectWorkspace: vi.fn(),
    handleNodeRequest: vi.fn(),
    handleRuntimeCredentialResponse: () => false,
    runners: f.runners,
    deliverSessionChannelMessage: vi.fn(),
    completeUncontrolledCancellation,
    send
  });
  const pending = f.run('first');
  try {
    await f.reached;
    control.handle(JSON.stringify(createEnvelope('run.interrupt', { runId: 'first' })));
    expect(close).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('ack', { type: 'run.interrupt' }, expect.any(String));
    expect(f.host.emit).toHaveBeenCalledWith('first', 'run.cancelling', { intent: 'INTERRUPT' });
    expect(completeUncontrolledCancellation).not.toHaveBeenCalled();
    f.unblock();
    await pending;
    expect(f.session.run).not.toHaveBeenCalled();
    await f.run('second');
    expect(f.session.run).toHaveBeenCalledTimes(1);
    expect(f.host.emitItem).not.toHaveBeenCalled();
  } finally {
    f.unblock();
    await pending;
    await f.close();
  }
});
