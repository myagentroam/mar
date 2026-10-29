import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { createAgent as createSdkAgent } from '@myagentroam/agent';
import {
  MarAgentSessionRuntimeRegistry,
  type MarAgentRuntimeUse
} from '../../src/runner/mar-agent/session-runtime-registry.js';
import type { MarAgentRuntimeRequest } from '../../src/runner/mar-agent/session-runtime.js';
import { MarAgentRuntimeModelFactory } from '../../src/runner/mar-agent/runtime-model-factory.js';
import {
  MarAgentMcpClientCache,
  MarAgentMcpClientPool
} from '../../src/runner/mar-agent/mcp-client-pool.js';
import * as operational from '../../src/operational.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture() {
  vi.spyOn(operational, 'nodeLog').mockImplementation(() => undefined);
  const cwd = await mkdtemp(join(tmpdir(), 'mar-runtime-registry-'));
  const releases: ReturnType<typeof vi.fn>[] = [];
  const cache = new MarAgentMcpClientCache();
  vi.spyOn(cache, 'acquire').mockImplementation(async () => {
    const release = vi.fn(async () => undefined);
    releases.push(release);
    return { pool: new MarAgentMcpClientPool(), release };
  });
  const session = { id: 'native-session' };
  const agent = {
    createSession: vi.fn(async () => session),
    openSession: vi.fn(async () => session),
    reconfigureModels: vi.fn(async () => undefined),
    setSystemInstruction: vi.fn(),
    dispose: vi.fn(async () => undefined)
  };
  const hosts: Parameters<typeof createSdkAgent>[0]['host'][] = [];
  const createAgent = vi.fn(async (input: Parameters<typeof createSdkAgent>[0]) => {
    hosts.push(input.host);
    return agent;
  });
  const releaseEnvironment = vi.fn();
  const computer = vi.fn(async (_alias: string) => undefined);
  const promote = vi.fn((_alias: string, _native: string) => undefined);
  const question = vi.fn(async (_runId: string) => ({}));
  const registry = new MarAgentSessionRuntimeRegistry(
    {
      mcpClients: cache,
      createAgent: createAgent as unknown as typeof createSdkAgent,
      modelFactory: new MarAgentRuntimeModelFactory({
        resolve: async () => {
          throw new Error('UNEXPECTED_CREDENTIAL_REQUEST');
        }
      }),
      resourceIdleTtlMs: 600_000,
      retainEnvironment: () => releaseEnvironment,
      customTitle: () => undefined,
      modelUsage: vi.fn(),
      question
    },
    promote,
    computer
  );
  const model: MarAgentRuntimeRequest['model'] = {
    id: 'fixture',
    name: 'Fixture',
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: 'https://fixture.invalid',
    credential: { type: 'INLINE_API_KEY', value: 'fixture-only' },
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
  const request: MarAgentRuntimeRequest = {
    runId: 'first',
    sessionId: 'bootstrap',
    cwd,
    model,
    models: [model],
    mode: 'run',
    mcpServers: []
  };
  const lifetimes: ReturnType<typeof lifetime>[] = [];
  function lifetime(runId: string) {
    const abort = new AbortController();
    const done = deferred();
    return {
      runId,
      signal: abort.signal,
      cancel: vi.fn(() => abort.abort()),
      settled: done.promise,
      finish: (use?: MarAgentRuntimeUse) => {
        use?.terminal();
        done.resolve();
      }
    };
  }
  function run(runId: string) {
    const value = lifetime(runId);
    lifetimes.push(value);
    return value;
  }
  return {
    registry,
    request,
    run,
    agent,
    createAgent,
    releases,
    releaseEnvironment,
    computer,
    promote,
    hosts,
    question,
    close: async () => {
      for (const value of lifetimes) value.finish();
      try {
        await registry.dispose();
      } finally {
        await cache.close();
        await rm(cwd, { recursive: true, force: true });
      }
    }
  };
}

it('reserves both known aliases before opening and releases one Runtime through either alias', async () => {
  const f = await fixture();
  const gate = deferred();
  f.agent.openSession.mockImplementationOnce(async () => {
    await gate.promise;
    return { id: 'native-session' };
  });
  try {
    const first = f.run('first');
    const acquisition = f.registry.acquire(
      { ...f.request, externalSessionId: 'native-session' },
      first
    );
    await expect(
      f.registry.acquire({ ...f.request, sessionId: 'native-session' }, f.run('competing'))
    ).rejects.toThrow('MAR_AGENT_SESSION_RUNTIME_ACTIVE');
    await vi.waitFor(() => expect(f.agent.openSession).toHaveBeenCalledOnce());
    const release = f.registry.releaseSession('bootstrap');
    expect(f.registry.releaseSession('native-session')).toBe(release);
    const rejected = expect(acquisition).rejects.toThrow();
    gate.resolve();
    await rejected;
    first.finish();
    await release;
    expect(f.agent.dispose).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    expect(f.releases[0]).toHaveBeenCalledOnce();
    expect(f.registry.findRuntime('bootstrap')).toBeUndefined();
    expect(f.registry.findRuntime('native-session')).toBeUndefined();
  } finally {
    gate.resolve();
    await f.close();
  }
});

it('handles promotion reentering release without publishing or disposing the Runtime twice', async () => {
  const f = await fixture();
  let release: Promise<void> | undefined;
  f.promote.mockImplementation(() => {
    release = f.registry.releaseSession('native-session');
  });
  try {
    const first = f.run('first');
    await expect(f.registry.acquire(f.request, first)).rejects.toThrow(
      'MAR_AGENT_SESSION_RUNTIME_RELEASED'
    );
    first.finish();
    await release;
    expect(f.agent.dispose).toHaveBeenCalledOnce();
    expect(f.releases[0]).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('rolls back failed promotion and permits a native Session retry', async () => {
  const f = await fixture();
  f.promote.mockImplementationOnce(() => {
    throw new Error('PROMOTION_FAILED');
  });
  try {
    await expect(f.registry.acquire(f.request, f.run('failed'))).rejects.toThrow(
      'PROMOTION_FAILED'
    );
    expect(f.agent.dispose).toHaveBeenCalledOnce();
    const next = f.run('retry');
    const use = await f.registry.acquire(
      { ...f.request, runId: 'retry', externalSessionId: 'native-session' },
      next
    );
    expect(f.agent.openSession).toHaveBeenCalledWith('native-session');
    next.finish(use);
  } finally {
    await f.close();
  }
});

it('rolls back a conflicting native identity without releasing the existing Session resources', async () => {
  const f = await fixture();
  try {
    const first = f.run('first');
    const use = await f.registry.acquire(f.request, first);
    await expect(
      f.registry.acquire({ ...f.request, sessionId: 'another-bootstrap' }, f.run('conflict'))
    ).rejects.toThrow('MAR_AGENT_SESSION_RUNTIME_ACTIVE');
    use.assertUsable();
    expect(f.registry.findRuntime('bootstrap')).toBe(use.runtime);
    expect(f.computer).not.toHaveBeenCalled();
    expect(f.registry.findRuntime('another-bootstrap')).toBeUndefined();
    first.finish(use);
  } finally {
    await f.close();
  }
});

it('blocks acquire during Computer Use cleanup even without a Runtime', async () => {
  const f = await fixture();
  const gate = deferred();
  f.computer.mockImplementationOnce(async () => {
    await gate.promise;
  });
  try {
    const release = f.registry.releaseSession('bootstrap');
    expect(f.registry.releaseSession('bootstrap')).toBe(release);
    await expect(f.registry.acquire(f.request, f.run('blocked'))).rejects.toThrow(
      'MAR_AGENT_SESSION_RUNTIME_RELEASED'
    );
    expect(f.createAgent).not.toHaveBeenCalled();
    gate.resolve();
    await release;
    const next = f.run('next');
    const use = await f.registry.acquire(f.request, next);
    next.finish(use);
  } finally {
    gate.resolve();
    await f.close();
  }
});

it('allows terminal continuation but drains old cleanup before destroying resources', async () => {
  const f = await fixture();
  try {
    const first = f.run('first');
    const old = await f.registry.acquire(f.request, first);
    old.terminal();
    const next = f.run('next');
    const current = await f.registry.acquire({ ...f.request, runId: 'next' }, next);
    expect(current.runtime).toBe(old.runtime);
    old.terminal();
    current.assertUsable();
    next.finish(current);
    let finished = false;
    const release = f.registry.releaseSession('native-session').then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(f.agent.dispose).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    first.finish(old);
    await release;
    expect(f.agent.dispose).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('does not let old cleanup extend the next idle TTL', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    const first = f.run('first');
    const old = await f.registry.acquire(f.request, first);
    old.terminal();
    const next = f.run('next');
    const current = await f.registry.acquire(f.request, next);
    next.finish(current);
    await vi.advanceTimersByTimeAsync(599_999);
    first.finish(old);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.agent.dispose).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('waits for old cleanup before Host replacement and reopens the confirmed native Session', async () => {
  const f = await fixture();
  try {
    const first = f.run('first');
    const old = await f.registry.acquire(f.request, first);
    old.terminal();
    const next = f.run('next');
    const acquisition = f.registry.acquire(
      { ...f.request, runId: 'next', secretEnvironment: { FIXTURE_SCOPE: 'changed' } },
      next
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.agent.dispose).not.toHaveBeenCalled();
    first.finish(old);
    const current = await acquisition;
    expect(f.agent.createSession).toHaveBeenCalledOnce();
    expect(f.agent.openSession).toHaveBeenCalledExactlyOnceWith('native-session');
    expect(f.agent.dispose).toHaveBeenCalledOnce();
    next.finish(current);
  } finally {
    await f.close();
  }
});

it('joins Host replacement when release arrives during old Agent disposal', async () => {
  const f = await fixture();
  const gate = deferred();
  try {
    const first = f.run('first');
    const old = await f.registry.acquire(f.request, first);
    first.finish(old);
    f.agent.dispose.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const next = f.run('next');
    const acquisition = f.registry.acquire(
      { ...f.request, secretEnvironment: { FIXTURE_SCOPE: 'changed' } },
      next
    );
    await vi.waitFor(() => expect(f.agent.dispose).toHaveBeenCalledOnce());
    const release = f.registry.releaseSession('bootstrap');
    const rejected = expect(acquisition).rejects.toThrow();
    gate.resolve();
    await rejected;
    next.finish();
    await release;
    expect(f.createAgent).toHaveBeenCalledOnce();
    expect(f.agent.dispose).toHaveBeenCalledOnce();
    expect(f.releases[0]).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await f.close();
  }
});

it('does not create a replacement after old resource cleanup fails', async () => {
  const f = await fixture();
  try {
    const first = f.run('first');
    const old = await f.registry.acquire(f.request, first);
    first.finish(old);
    f.agent.dispose.mockRejectedValueOnce(new Error('DISPOSE_FAILED'));
    await expect(
      f.registry.acquire(
        { ...f.request, secretEnvironment: { FIXTURE_SCOPE: 'changed' } },
        f.run('next')
      )
    ).rejects.toThrow('DISPOSE_FAILED');
    expect(f.createAgent).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    expect(f.releases[0]).toHaveBeenCalledOnce();
    expect(f.registry.findRuntime('bootstrap')).toBeUndefined();
  } finally {
    await f.close();
  }
});

it('still releases Agent, MCP and environment when Computer Use cleanup fails', async () => {
  const f = await fixture();
  try {
    const first = f.run('first');
    const use = await f.registry.acquire(f.request, first);
    first.finish(use);
    f.computer.mockRejectedValueOnce(new Error('COMPUTER_CLEANUP_FAILED'));
    await expect(f.registry.releaseSession('bootstrap')).rejects.toThrow('COMPUTER_CLEANUP_FAILED');
    expect(f.agent.dispose).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    expect(f.releases[0]).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('does not route old Host callbacks into the replacement Run', async () => {
  const f = await fixture();
  try {
    const first = f.run('first');
    const old = await f.registry.acquire(f.request, first);
    const oldHost = f.hosts[0]!;
    const signal = new AbortController().signal;
    const input = { requestId: 'question', questions: [] };
    await oldHost.requestUserInput!(input, signal);
    expect(f.question).toHaveBeenLastCalledWith('first', input, signal);
    first.finish(old);
    f.question.mockClear();
    f.agent.dispose.mockImplementationOnce(async () => {
      expect(await oldHost.requestUserInput!(input, signal)).toEqual({});
      expect(f.question).not.toHaveBeenCalled();
    });
    const next = f.run('next');
    const use = await f.registry.acquire(
      { ...f.request, runId: 'next', secretEnvironment: { FIXTURE_SCOPE: 'changed' } },
      next
    );
    await oldHost.requestUserInput!(input, signal);
    expect(f.question).not.toHaveBeenCalled();
    await f.hosts[1]!.requestUserInput!(input, signal);
    expect(f.question).toHaveBeenLastCalledWith('next', input, signal);
    next.finish(use);
  } finally {
    await f.close();
  }
});

it('preserves the opening error when rollback also fails and permits a fresh acquire', async () => {
  const f = await fixture();
  try {
    f.agent.createSession.mockRejectedValueOnce(new Error('OPEN_FAILED'));
    f.agent.dispose.mockImplementationOnce(() => {
      throw new Error('DISPOSE_FAILED');
    });
    f.releaseEnvironment.mockImplementationOnce(() => {
      throw new Error('ENVIRONMENT_FAILED');
    });
    await expect(f.registry.acquire(f.request, f.run('failed'))).rejects.toThrow('OPEN_FAILED');
    expect(f.releases[0]).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    expect(operational.nodeLog).toHaveBeenCalledWith(
      'runner.mar-agent.runtime.cleanup_failed',
      expect.objectContaining({
        code: 'MAR_AGENT_RUNTIME_CLEANUP_FAILED',
        stage: 'creation_rollback'
      })
    );
    const retry = f.run('retry');
    retry.finish(await f.registry.acquire({ ...f.request, runId: 'retry' }, retry));
  } finally {
    await f.close();
  }
});

it('continues resource release after a synchronous disposal failure', async () => {
  const f = await fixture();
  try {
    const first = f.run('first');
    first.finish(await f.registry.acquire(f.request, first));
    f.agent.dispose.mockImplementationOnce(() => {
      throw new Error('DISPOSE_FAILED');
    });
    await expect(f.registry.releaseSession('bootstrap')).rejects.toThrow('DISPOSE_FAILED');
    expect(f.releases[0]).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    expect(operational.nodeLog).toHaveBeenCalledWith(
      'runner.mar-agent.runtime.cleanup_failed',
      expect.objectContaining({
        sessionId: 'native-session',
        code: 'MAR_AGENT_RUNTIME_CLEANUP_FAILED',
        stage: 'resource_release',
        resource: 'agent'
      })
    );
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  'preserves the first release error while attempting all remaining resource cleanup (Computer Use failure: %s)',
  async (computerFails) => {
    const f = await fixture();
    try {
      const first = f.run('first');
      const use = await f.registry.acquire(f.request, first);
      first.finish(use);
      if (computerFails) f.computer.mockRejectedValueOnce(new Error('COMPUTER_CLEANUP_FAILED'));
      f.agent.dispose.mockRejectedValueOnce(new Error('AGENT_DISPOSE_FAILED'));
      f.releases[0]!.mockRejectedValueOnce(new Error('MCP_RELEASE_FAILED'));
      await expect(f.registry.releaseSession('bootstrap')).rejects.toThrow(
        computerFails ? 'COMPUTER_CLEANUP_FAILED' : 'AGENT_DISPOSE_FAILED'
      );
      expect(f.agent.dispose).toHaveBeenCalledOnce();
      expect(f.releases[0]).toHaveBeenCalledOnce();
      expect(f.releaseEnvironment).toHaveBeenCalledOnce();
      expect(operational.nodeLog).toHaveBeenCalledWith(
        'runner.mar-agent.runtime.cleanup_failed',
        expect.objectContaining({ code: 'MAR_AGENT_RUNTIME_CLEANUP_FAILED' })
      );
    } finally {
      await f.close();
    }
  }
);

it.each([false, true])(
  'releases every resource when diagnostics throw (cleanup failure: %s)',
  async (cleanupFails) => {
    const f = await fixture();
    try {
      const first = f.run('first');
      const use = await f.registry.acquire(f.request, first);
      first.finish(use);
      const failure = new Error('AGENT_DISPOSAL_FAILED');
      if (cleanupFails) f.agent.dispose.mockRejectedValueOnce(failure);
      vi.mocked(operational.nodeLog).mockImplementation(() => {
        throw new Error('LOG_STORAGE_FAILED');
      });
      const release = f.registry.releaseSession('native-session');
      if (cleanupFails) await expect(release).rejects.toBe(failure);
      else await expect(release).resolves.toBeUndefined();
      expect(f.computer).toHaveBeenCalled();
      expect(f.releases[0]).toHaveBeenCalledOnce();
      expect(f.releaseEnvironment).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  }
);

it('does not revive a waiting idle-expiry acquisition after explicit Session release', async () => {
  const f = await fixture();
  const gate = deferred();
  vi.useFakeTimers();
  try {
    const first = f.run('first');
    const use = await f.registry.acquire(f.request, first);
    first.finish(use);
    f.agent.dispose.mockImplementationOnce(async () => {
      await gate.promise;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.agent.dispose).toHaveBeenCalledOnce();
    const waiting = f.registry.acquire(f.request, f.run('waiting'));
    const rejected = expect(waiting).rejects.toThrow('MAR_AGENT_SESSION_RUNTIME_RELEASED');
    const release = f.registry.releaseSession('bootstrap');
    gate.resolve();
    await release;
    await rejected;
    expect(f.createAgent).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await f.close();
  }
});

it('keeps the Session identity in idle cleanup failure diagnostics', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    const first = f.run('first');
    first.finish(await f.registry.acquire(f.request, first));
    f.agent.dispose.mockRejectedValueOnce(new Error('PRIVATE_DISPOSAL_DETAIL'));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(operational.nodeLog).toHaveBeenCalledWith('runner.mar-agent.runtime.cleanup_failed', {
      sessionId: 'native-session',
      code: 'MAR_AGENT_RUNTIME_CLEANUP_FAILED'
    });
    expect(JSON.stringify(vi.mocked(operational.nodeLog).mock.calls)).not.toContain(
      'PRIVATE_DISPOSAL_DETAIL'
    );
    expect(f.releases[0]).toHaveBeenCalledOnce();
    expect(f.releaseEnvironment).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('closes admission synchronously and does not create late cleanup entries after dispose', async () => {
  const f = await fixture();
  try {
    const disposal = f.registry.dispose();
    expect(f.registry.dispose()).toBe(disposal);
    expect(f.registry.releaseSession('unknown')).toBe(disposal);
    await expect(f.registry.acquire(f.request, f.run('late'))).rejects.toThrow(
      'MAR_AGENT_RUN_CONTROLLER_DISPOSED'
    );
    await disposal;
    expect(f.computer).not.toHaveBeenCalled();
    expect(f.createAgent).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
