import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalAgentHost, SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/jsonl-store.js';
import type { ModelEvent } from '../../src/agent-core/model/contracts.js';
import { ExtensionManager } from '../../src/agent-core/extensions/manager.js';

const releaseFault = vi.hoisted(() => ({ path: '', error: new Error('lock release failed') }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await fs.rm(...args);
      if (args[0] === releaseFault.path) {
        releaseFault.path = '';
        throw releaseFault.error;
      }
    }
  };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  releaseFault.path = '';
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const model: MarAgentModelConfiguration = {
  id: 'test',
  name: 'Test',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'test',
  contextWindowTokens: 10000,
  maxOutputTokens: 1000,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  titleGeneration: false,
  codeMode: false,
  enabled: true
};
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-store-maintenance-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = await JsonlSessionStore.open(home);
  cleanups.push(() => store.close());
  async function agent() {
    const host = new LocalAgentHost({ homeDirectory: home, workspace: home });
    const ending = vi.fn();
    const retired = vi.fn();
    const attached = vi.fn();
    const adapterClose = vi.fn();
    const turnClose = vi.fn(async () => {});
    const entered = Promise.withResolvers<AbortSignal>();
    const resume = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    let hold = false;
    const instance = await createMarAgentWithAdapter({
      mode: 'normal',
      host,
      models: [model],
      sessionStore: store,
      runtimeExtensions: [
        {
          id: 'maintenance-test',
          apiVersion: '1.0',
          attachSession(context) {
            attached(context.sessionId);
            context.hooks.observe('session.ending', ending);
            context.resources.effect(() => () => {
              retired(context.sessionId);
            });
          }
        }
      ],
      adapterFactory: (configuration) => {
        async function* start(_request: unknown, signal: AbortSignal): AsyncIterable<ModelEvent> {
          signals.push(signal);
          if (hold) {
            entered.resolve(signal);
            await resume.promise;
          }
          yield { type: 'text.completed', itemId: 'answer', text: 'done' };
          yield { type: 'completed', reason: 'completed' };
        }
        return {
          configuration,
          start,
          close: adapterClose,
          createTurnSession: () => ({ start, close: turnClose })
        };
      }
    });
    const hostCleanup = vi.spyOn(host, 'disposeSessionResources');
    cleanups.push(async () => {
      resume.resolve();
      await instance.dispose();
    });
    return {
      instance,
      hostCleanup,
      ending,
      retired,
      attached,
      adapterClose,
      entered,
      resume,
      signals,
      hold: () => {
        hold = true;
      }
    };
  }
  return { home, store, agent };
}

function childInput(workspace: string, parentSessionId: string, rootSessionId = parentSessionId) {
  return {
    workspace,
    source: {
      type: 'subagent',
      parentSessionId,
      rootSessionId,
      parentExecutionId: 'parent',
      description: 'maintenance child',
      role: 'general-purpose'
    }
  } as const;
}

it.each(['clear', 'delete'] as const)(
  'rejects descendant creation after %s admission without blocking unrelated Sessions',
  async (kind) => {
    const f = await fixture();
    const root = await f.store.createSession({ workspace: f.home });
    const child = await f.store.createSession(childInput(f.home, root.id));
    const other = await f.store.createSession({ workspace: f.home });
    const before = await f.store.list({ source: 'subagent', rootSessionId: root.id });
    const holding = await f.store.acquireSessionMaintenance(root.id, kind);
    try {
      await expect(f.store.createSession(childInput(f.home, root.id))).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
      if (kind === 'delete')
        await expect(
          f.store.createSession(childInput(f.home, child.id, root.id))
        ).rejects.toMatchObject({
          code: 'MAR_AGENT_SESSION_LOCKED'
        });
      expect(await f.store.list({ source: 'subagent', rootSessionId: root.id })).toEqual(before);
      const unrelated = await f.store.createSession(childInput(f.home, other.id));
      const release = await f.store.acquireSessionLease(unrelated.id, {});
      await release();
      if (kind === 'delete') await f.store.delete(root.id, holding);
      else await f.store.clearSession(root.id, holding);
    } finally {
      await holding.release();
    }
    if (kind === 'delete') {
      await expect(f.store.createSession(childInput(f.home, root.id))).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_NOT_FOUND'
      });
      await expect(f.store.getSession(child.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_NOT_FOUND'
      });
      await expect(
        f.store.list({ source: 'subagent', rootSessionId: root.id })
      ).resolves.toMatchObject({ sessions: [] });
    } else await expect(f.store.createSession(childInput(f.home, root.id))).resolves.toBeDefined();
  }
);

it('finishes an in-flight child publication before tree maintenance admission', async () => {
  const f = await fixture();
  const root = await f.store.createSession({ workspace: f.home });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const append = f.store.append.bind(f.store);
  vi.spyOn(f.store, 'append').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    return append(...args);
  });
  const creating = f.store.createSession(childInput(f.home, root.id));
  await entered.promise;
  const admitting = f.store.acquireSessionMaintenance(root.id, 'delete');
  try {
    expect(
      await Promise.race([
        admitting.then(() => 'admitted'),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 30))
      ])
    ).toBe('pending');
  } finally {
    resume.resolve();
    const child = await creating;
    const holding = await admitting;
    try {
      expect(holding.sessionIds).toEqual(expect.arrayContaining([root.id, child.id]));
      await f.store.delete(root.id, holding);
      await expect(f.store.getSession(child.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_NOT_FOUND'
      });
    } finally {
      await holding.release();
    }
  }
});

it.each(['clearSession', 'deleteSession', 'tree'] as const)(
  'rejects foreign-owner %s before observable cleanup and permits retry',
  async (operation) => {
    const f = await fixture();
    const a = await f.agent();
    const b = await f.agent();
    const root = await b.instance.createSession({ workspace: f.home });
    const sibling =
      operation === 'tree'
        ? await f.store.createSession({
            workspace: f.home,
            source: {
              type: 'subagent',
              parentSessionId: root.id,
              rootSessionId: root.id,
              parentExecutionId: 'parent',
              description: 'sibling',
              role: 'general-purpose'
            }
          })
        : undefined;
    const target =
      operation === 'tree'
        ? await f.store.createSession({
            workspace: f.home,
            source: {
              type: 'subagent',
              parentSessionId: root.id,
              rootSessionId: root.id,
              parentExecutionId: 'parent',
              description: 'child',
              role: 'general-purpose'
            }
          })
        : root;
    expect((await root.run({ prompt: 'initialize B runtime' }).result()).status).toBe('completed');
    const attachedBefore = b.attached.mock.calls.length;
    a.hold();
    const running = (await a.instance.openSession(target.id)).run({ prompt: 'hold A writer' });
    const signal = await a.entered.promise;
    const before = await f.store.read(root.id);
    const action = operation === 'clearSession' ? 'clearSession' : 'deleteSession';
    await expect(b.instance[action](root.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_LOCKED'
    });
    expect(signal.aborted).toBe(false);
    expect(b.ending).not.toHaveBeenCalled();
    expect(b.retired).not.toHaveBeenCalled();
    expect(b.hostCleanup).not.toHaveBeenCalled();
    expect(b.adapterClose).not.toHaveBeenCalled();
    expect(await f.store.read(root.id)).toEqual(before);
    if (sibling) {
      const release = await f.store.acquireSessionLease(sibling.id, {});
      await release();
    }
    a.resume.resolve();
    await running.result();
    expect((await root.run({ prompt: 'B runtime survived refusal' }).result()).status).toBe(
      'completed'
    );
    expect(b.attached).toHaveBeenCalledTimes(attachedBefore);
    await b.instance[action](root.id);
    expect(b.ending).toHaveBeenCalled();
    expect(b.retired).toHaveBeenCalled();
    expect(b.hostCleanup).toHaveBeenCalled();
    expect(b.adapterClose).toHaveBeenCalled();
    if (action === 'clearSession') expect(await f.store.read(root.id)).toHaveLength(1);
    else
      await expect(f.store.getSession(root.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_NOT_FOUND'
      });
  }
);

it.each(['clearSession', 'deleteSession'] as const)(
  'holds %s ownership across host cleanup while unrelated sessions remain usable',
  async (action) => {
    const f = await fixture();
    const a = await f.agent();
    const b = await f.agent();
    const session = await a.instance.createSession({ workspace: f.home });
    await session.run({ prompt: 'warm runtime' }).result();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    a.hostCleanup.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
    });
    const mutation = vi.spyOn(f.store, action === 'clearSession' ? 'clearSession' : 'delete');
    const maintaining = a.instance[action](session.id);
    try {
      await entered.promise;
      expect(mutation).not.toHaveBeenCalled();
      const other = await b.instance.openSession(session.id);
      expect((await other.run({ prompt: 'must not enter' }).result()).errorCode).toBe(
        'MAR_AGENT_SESSION_LOCKED'
      );
      expect((await other.plan({ prompt: 'must not enter' }).result()).errorCode).toBe(
        'MAR_AGENT_SESSION_LOCKED'
      );
      expect((await other.compact().result()).errorCode).toBe('MAR_AGENT_SESSION_LOCKED');
      await expect(b.instance.setSessionTitle(session.id, 'must not enter')).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
      await expect(f.store.acquireSessionMaintenance(session.id, 'clear')).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
      const unrelated = await b.instance.createSession({ workspace: f.home });
      expect((await unrelated.run({ prompt: 'unrelated' }).result()).status).toBe('completed');
    } finally {
      resume.resolve();
      await maintaining;
    }
    expect(mutation).toHaveBeenCalledTimes(1);
    if (action === 'clearSession') {
      const release = await f.store.acquireSessionLease(session.id, {});
      await release();
      expect(
        (
          await (
            await b.instance.openSession(session.id)
          )
            .run({ prompt: 'after maintenance' })
            .result()
        ).status
      ).toBe('completed');
    } else
      await expect(b.instance.openSession(session.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_NOT_FOUND'
      });
  }
);

it('rejects a foreign-owned child before aborting the caller-owned active parent', async () => {
  const f = await fixture();
  const a = await f.agent();
  const b = await f.agent();
  const parent = await b.instance.createSession({ workspace: f.home });
  const child = await f.store.createSession({
    workspace: f.home,
    source: {
      type: 'subagent',
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      parentExecutionId: 'parent',
      description: 'child',
      role: 'general-purpose'
    }
  });
  a.hold();
  b.hold();
  const parentRun = parent.run({ prompt: 'parent' });
  const childRun = (await a.instance.openSession(child.id)).run({ prompt: 'child' });
  const signals = await Promise.all([a.entered.promise, b.entered.promise]);
  await expect(b.instance.deleteSession(parent.id)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  expect(b.ending).not.toHaveBeenCalled();
  expect(b.hostCleanup).not.toHaveBeenCalled();
  a.resume.resolve();
  b.resume.resolve();
  await Promise.all([parentRun.result(), childRun.result()]);
  await b.instance.deleteSession(parent.id);
});

it('joins same-owner active parent and child before deleting the tree', async () => {
  const f = await fixture();
  const a = await f.agent();
  const parent = await a.instance.createSession({ workspace: f.home });
  const child = await f.store.createSession({
    workspace: f.home,
    source: {
      type: 'subagent',
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      parentExecutionId: 'parent',
      description: 'child',
      role: 'general-purpose'
    }
  });
  a.hold();
  const runs = [
    parent.run({ prompt: 'parent' }),
    (await a.instance.openSession(child.id)).run({ prompt: 'child' })
  ];
  await vi.waitFor(() => expect(a.signals).toHaveLength(2));
  const mutation = vi.spyOn(f.store, 'delete');
  const deleting = a.instance.deleteSession(parent.id);
  try {
    await vi.waitFor(() => expect(a.signals.every((signal) => signal.aborted)).toBe(true));
    expect(mutation).not.toHaveBeenCalled();
    expect(a.hostCleanup).not.toHaveBeenCalled();
  } finally {
    a.resume.resolve();
    await deleting;
  }
  for (const run of runs) expect((await run.result()).status).toBe('cancelled');
  expect(a.ending).toHaveBeenCalledTimes(2);
  expect(a.hostCleanup).toHaveBeenCalledTimes(2);
  for (const id of [parent.id, child.id])
    await expect(f.store.getSession(id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_NOT_FOUND'
    });
});

it.each(['parent', 'child'] as const)(
  'joins every concurrent tree ending and preserves the first %s failure',
  async (first) => {
    const f = await fixture();
    const a = await f.agent();
    const parent = await a.instance.createSession({ workspace: f.home });
    const child = await f.store.createSession({
      workspace: f.home,
      source: {
        type: 'subagent',
        parentSessionId: parent.id,
        rootSessionId: parent.id,
        parentExecutionId: 'parent',
        description: 'child',
        role: 'general-purpose'
      }
    });
    await parent.run({ prompt: 'parent' }).result();
    await (await a.instance.openSession(child.id)).run({ prompt: 'child' }).result();
    const childEntered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const primary = new Error(first + ' ending failed');
    const end = ExtensionManager.prototype.endSession;
    vi.spyOn(ExtensionManager.prototype, 'endSession').mockImplementation(
      async function (id, reason, resumable) {
        await end.call(this, id, reason, resumable);
        if (id === parent.id) {
          await childEntered.promise;
          if (first === 'parent') throw primary;
          await resume.promise;
          throw new Error('later parent ending failed');
        }
        childEntered.resolve();
        if (first === 'child') throw primary;
        await resume.promise;
        throw new Error('child ending failed');
      }
    );
    const deleting = a.instance.deleteSession(parent.id);
    const result = expect(deleting).rejects.toBe(primary);
    try {
      await childEntered.promise;
      expect(a.retired).not.toHaveBeenCalled();
      expect(a.hostCleanup).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await result;
    }
    expect(a.hostCleanup).toHaveBeenCalledTimes(2);
    await expect(f.store.getSession(parent.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_NOT_FOUND'
    });
  }
);

it('keeps a same-owner retained writer physically locked until its real owner releases it', async () => {
  const f = await fixture();
  const a = await f.agent();
  const session = await a.instance.createSession({ workspace: f.home });
  const acquire = f.store.acquireSessionLease.bind(f.store);
  let releaseRetained!: () => Promise<void>;
  vi.spyOn(f.store, 'acquireSessionLease').mockImplementationOnce(async (id, owner) => {
    const release = await acquire(id, owner);
    releaseRetained = await f.store.retainSessionLease(id, owner);
    return release;
  });
  await session.run({ prompt: 'warm retained writer' }).result();
  a.hostCleanup.mockImplementationOnce(async () => {
    await releaseRetained();
    await expect(f.store.acquireSessionLease(session.id, {})).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_LOCKED'
    });
  });
  await a.instance.clearSession(session.id);
  expect(a.hostCleanup).toHaveBeenCalledTimes(1);
  const release = await f.store.acquireSessionLease(session.id, {});
  await release();
});

it.each(['clearSession', 'deleteSession'] as const)(
  'preserves the first %s failure, attempts independent cleanup and always releases ownership',
  async (action) => {
    for (const stage of ['ending', 'extension', 'host', 'store', 'release'] as const) {
      const f = await fixture();
      const a = await f.agent();
      const session = await a.instance.createSession({ workspace: f.home });
      await session.run({ prompt: 'warm runtime' }).result();
      const primary = new Error(stage + ' failed');
      const ending = vi.spyOn(ExtensionManager.prototype, 'endSession');
      const clear = ExtensionManager.prototype.clearSession;
      const clearing = vi.spyOn(ExtensionManager.prototype, 'clearSession');
      const mutate = vi.spyOn(f.store, action === 'clearSession' ? 'clearSession' : 'delete');
      if (stage === 'ending') ending.mockRejectedValueOnce(primary);
      if (stage === 'extension')
        clearing.mockImplementationOnce(async function (id) {
          await clear.call(this, id);
          throw primary;
        });
      if (stage === 'host') a.hostCleanup.mockRejectedValueOnce(primary);
      if (stage === 'store') mutate.mockRejectedValueOnce(primary);
      releaseFault.path = join(f.home, '.mar', 'agent', 'sessions', session.id, 'lock');
      await expect(a.instance[action](session.id)).rejects.toBe(
        stage === 'release' ? releaseFault.error : primary
      );
      expect(clearing).toHaveBeenCalledWith(session.id);
      expect(a.hostCleanup).toHaveBeenCalledWith(session.id);
      expect(a.adapterClose).toHaveBeenCalled();
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(releaseFault.path).toBe('');
      if (action === 'clearSession' || stage === 'store') {
        const release = await f.store.acquireSessionLease(session.id, {});
        await release();
        await a.instance[action](session.id);
      }
      mutate.mockRestore();
      clearing.mockRestore();
      ending.mockRestore();
    }
  }
);

it('validates maintenance scope, rejects fresh work and never steals retained references', async () => {
  const f = await fixture();
  const session = await f.store.createSession({ workspace: f.home });
  const other = await f.store.createSession({ workspace: f.home });
  const owner = {};
  const release = await f.store.acquireSessionLease(session.id, owner);
  const retained = await f.store.retainSessionLease(session.id, owner);
  await release();
  const holding = await f.store.acquireSessionMaintenance(session.id, 'clear', owner);
  await expect(f.store.acquireSessionLease(session.id, owner)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  await expect(f.store.acquireSessionWriteLease(session.id, owner)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  await expect(f.store.retainSessionLease(session.id, owner)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  await expect(f.store.delete(session.id, holding)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  await expect(f.store.clearSession(other.id, holding)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  await expect(f.store.clearSession(session.id, { ...holding })).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  await holding.release();
  await holding.release();
  expect(f.store.hasRetainedSessionLease(session.id, owner)).toBe(true);
  await expect(f.store.acquireSessionLease(session.id, {})).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  await retained();
  await expect(f.store.clearSession(session.id, holding)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  const next = await f.store.acquireSessionLease(session.id, {});
  await next();
});

it('rechecks tree membership during maintenance admission and releases earlier members on conflict', async () => {
  const f = await fixture();
  const root = await f.store.createSession({ workspace: f.home });
  const tree = f.store.sessionTree.bind(f.store);
  let child!: string;
  let releaseChild!: () => Promise<void>;
  const discover = vi.spyOn(f.store, 'sessionTree').mockImplementationOnce(async (id) => {
    const snapshot = await tree(id);
    child = (
      await f.store.createSession({
        workspace: f.home,
        source: {
          type: 'subagent',
          parentSessionId: root.id,
          rootSessionId: root.id,
          parentExecutionId: 'parent',
          description: 'new child',
          role: 'general-purpose'
        }
      })
    ).id;
    releaseChild = await f.store.acquireSessionLease(child, {});
    return snapshot;
  });
  releaseFault.path = join(f.home, '.mar', 'agent', 'sessions', root.id, 'lock');
  await expect(f.store.acquireSessionMaintenance(root.id, 'delete')).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  expect(releaseFault.path).toBe('');
  discover.mockRestore();
  const parentRelease = await f.store.acquireSessionLease(root.id, {});
  await parentRelease();
  await releaseChild();
  const holding = await f.store.acquireSessionMaintenance(root.id, 'delete');
  expect(holding.sessionIds).toEqual([root.id, child]);
  await f.store.delete(root.id, holding);
  await holding.release();
});
