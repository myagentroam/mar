import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';
import type { ModelEvent } from '../../src/model/contracts.js';
import { ExtensionManager } from '../../src/extensions/manager.js';

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
const model: AgentModelConfiguration = {
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

it('keeps a deleting main execution visible to model reconfiguration until its Turn is joined', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-delete-reconfigure-'));
  const started = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const turnClose = vi.fn(async () => {});
  const providerClose = vi.fn(async () => {});
  const provider = { acquire: vi.fn(), invalidate: vi.fn(), close: providerClose };
  const { apiKey: _apiKey, ...dynamicModel } = model;
  const agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
      models: [{ ...dynamicModel, credentialProvider: provider }],
      extensions: [
        {
          id: 'deletion-barrier',
          apiVersion: '1.0',
          attachSession(context) {
            context.resources.effect(() => () => retired.resolve());
          }
        }
      ]
    },
    (configuration) => {
      async function* start(): AsyncIterable<ModelEvent> {
        started.resolve();
        await release.promise;
        yield { type: 'completed', reason: 'completed' };
      }
      return { configuration, start, createTurnSession: () => ({ start, close: turnClose }) };
    }
  );
  let deletion: Promise<void> | undefined;
  try {
    const session = await agent.createSession({ workspace: home });
    const execution = session.run({ prompt: 'hold' });
    let settled = false;
    void execution.result().finally(() => {
      settled = true;
    });
    await started.promise;
    deletion = agent.deleteSession(session.id);
    await retired.promise;
    await expect(agent.reconfigureModels({ models: [model] })).rejects.toMatchObject({
      code: 'MAR_AGENT_EXECUTION_ACTIVE'
    });
    expect(settled).toBe(false);
    expect(turnClose).not.toHaveBeenCalled();
    expect(providerClose).not.toHaveBeenCalled();
    release.resolve();
    await deletion;
    expect(turnClose).toHaveBeenCalledOnce();
    await agent.reconfigureModels({ models: [model] });
    expect(providerClose).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await deletion?.catch(() => {});
    await agent.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
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
    const instance = await createAgentWithAdapter(
      {
        mode: 'normal',
        host,
        models: [model],
        sessionStore: store,
        extensions: [
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
        ]
      },
      (configuration) => {
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
    );
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

it('blocks opening all explicitly admitted members throughout deletion', async () => {
  const f = await fixture();
  const root = await f.store.createSession({ workspace: f.home });
  const child = await f.store.createSession(childInput(f.home, root.id));
  const { instance, hostCleanup } = await f.agent();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  hostCleanup.mockImplementation(async (id) => {
    if (id === root.id) {
      entered.resolve();
      await release.promise;
    }
  });
  const deleting = instance.deleteSessions([root.id, child.id]);
  try {
    await entered.promise;
    await expect(instance.openSession(child.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CLOSING'
    });
    await expect(instance.clearSession(child.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CLOSING'
    });
  } finally {
    release.resolve();
    await deleting;
  }
});

it('rejects missing deletion members before closing or deleting an existing Session', async () => {
  const f = await fixture();
  const root = await f.store.createSession({ workspace: f.home });
  const { instance, hostCleanup } = await f.agent();
  await expect(
    instance.deleteSessions([root.id, '00000000-0000-4000-8000-000000000000'])
  ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_NOT_FOUND' });
  expect(hostCleanup).not.toHaveBeenCalled();
  await expect(f.store.getSession(root.id)).resolves.toMatchObject({ id: root.id });
});

it('joins reverse-order deletion requests while rejecting a different overlapping set', async () => {
  const f = await fixture();
  const ids = (
    await Promise.all(Array.from({ length: 3 }, () => f.store.createSession({ workspace: f.home })))
  )
    .map((session) => session.id)
    .sort();
  const [a, b, c] = ids as [string, string, string];
  const { instance, hostCleanup } = await f.agent();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const acquire = f.store.acquireSessionMaintenance.bind(f.store);
  const admission = vi
    .spyOn(f.store, 'acquireSessionMaintenance')
    .mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      return acquire(...args);
    });
  const originalOrder = [b, a];
  const first = instance.deleteSessions(originalOrder);
  await entered.promise;
  const second = instance.deleteSessions([a, b]);
  try {
    expect(first).toBe(second);
    expect(originalOrder).toEqual([b, a]);
    expect(admission).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledWith(a, 'delete', expect.anything(), [a, b]);
    await expect(instance.deleteSessions([a, c])).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CLOSING'
    });
  } finally {
    resume.resolve();
    await Promise.all([first, second]);
  }
  expect(hostCleanup).toHaveBeenCalledTimes(2);
  await expect(f.store.getSession(c)).resolves.toMatchObject({ id: c });
});

it('joins a pending create before disposing global resources', async () => {
  const f = await fixture();
  const { instance } = await f.agent();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const create = f.store.createSession.bind(f.store);
  vi.spyOn(f.store, 'createSession').mockImplementation(async (input) => {
    entered.resolve();
    await release.promise;
    return create(input);
  });
  const opening = instance.createSession({ workspace: f.home });
  const outcome = opening.then(
    () => undefined,
    (error: unknown) => error
  );
  await entered.promise;
  let disposed = false;
  const disposing = instance.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  release.resolve();
  expect(await outcome).toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
  await disposing;
  expect(disposed).toBe(true);
});

it.each(['clear', 'delete', 'dispose'] as const)(
  'waits for an in-flight open before %s completes and rejects the stale candidate',
  async (operation) => {
    const f = await fixture();
    const stored = await f.store.createSession({ workspace: f.home });
    const { instance } = await f.agent();
    const entered = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.store.getSession.bind(f.store);
    let blocked = false;
    vi.spyOn(f.store, 'getSession').mockImplementation(async (id) => {
      if (id === stored.id && !blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      return original(id);
    });
    const acquire = f.store.acquireSessionMaintenance.bind(f.store);
    vi.spyOn(f.store, 'acquireSessionMaintenance').mockImplementation(async (...args) => {
      const lease = await acquire(...args);
      admitted.resolve();
      return lease;
    });
    const opening = instance.openSession(stored.id);
    void opening.catch(() => undefined);
    await entered.promise;
    let completed = false;
    const maintenance = (
      operation === 'dispose'
        ? instance.dispose()
        : operation === 'clear'
          ? instance.clearSession(stored.id)
          : instance.deleteSession(stored.id)
    ).then(() => {
      completed = true;
    });
    try {
      if (operation !== 'dispose') await admitted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
    } finally {
      release.resolve();
    }
    await expect(opening).rejects.toBeDefined();
    await maintenance;
    expect(completed).toBe(true);
  }
);

it('joins a stale open during dispose without retaining a Session lease', async () => {
  const f = await fixture();
  const stored = await f.store.createSession({ workspace: f.home });
  const { instance } = await f.agent();
  const cleanupAgent = cleanups.pop()!;
  cleanups.push(() => cleanupAgent().catch(() => undefined));
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.store.getSession.bind(f.store);
  vi.spyOn(f.store, 'getSession').mockImplementation(async (id) => {
    if (id === stored.id) {
      ready.resolve();
      await release.promise;
    }
    return original(id);
  });
  const opening = instance.openSession(stored.id);
  void opening.catch(() => undefined);
  await ready.promise;
  const disposing = instance.dispose();
  void disposing.catch(() => undefined);
  release.resolve();
  await expect(opening).rejects.toBeDefined();
  await expect(disposing).resolves.toBeUndefined();
  const releaseLease = await f.store.acquireSessionLease(stored.id, {});
  await releaseLease();
});

it.each(['clear', 'delete'] as const)(
  'does not invalidate an in-flight candidate when %s admission fails',
  async (operation) => {
    const f = await fixture();
    const stored = await f.store.createSession({ workspace: f.home });
    const { instance, hostCleanup } = await f.agent();
    const foreignRelease = await f.store.acquireSessionLease(stored.id, {});
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.store.getSession.bind(f.store);
    let blocked = false;
    vi.spyOn(f.store, 'getSession').mockImplementation(async (id) => {
      if (id === stored.id && !blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      return original(id);
    });
    const opening = instance.openSession(stored.id);
    await entered.promise;
    try {
      await expect(
        operation === 'clear' ? instance.clearSession(stored.id) : instance.deleteSession(stored.id)
      ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
      expect(hostCleanup).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await foreignRelease();
    }
    expect((await opening).id).toBe(stored.id);
  }
);

it.each(['clear', 'delete'] as const)(
  'rejects descendant creation after %s admission without blocking unrelated Sessions',
  async (kind) => {
    const f = await fixture();
    const root = await f.store.createSession({ workspace: f.home });
    const child = await f.store.createSession(childInput(f.home, root.id));
    const other = await f.store.createSession({ workspace: f.home });
    const before = await f.store.list({ source: 'subagent', rootSessionId: root.id });
    const holding = await f.store.acquireSessionMaintenance(
      root.id,
      kind,
      undefined,
      kind === 'delete' ? [root.id, child.id] : undefined
    );
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

it('finishes an in-flight child publication before explicit maintenance admission', async () => {
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
      expect(holding.sessionIds).toEqual([root.id]);
      await f.store.delete(root.id, holding);
      await expect(f.store.getSession(child.id)).resolves.toMatchObject({ id: child.id });
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
    const action = () =>
      operation === 'tree'
        ? b.instance.deleteSessions([root.id, sibling!.id, target.id])
        : b.instance[operation](root.id);
    await expect(action()).rejects.toMatchObject({
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
    await action();
    expect(b.ending).toHaveBeenCalled();
    expect(b.retired).toHaveBeenCalled();
    expect(b.hostCleanup).toHaveBeenCalled();
    expect(b.adapterClose).toHaveBeenCalled();
    if (operation === 'clearSession') expect(await f.store.read(root.id)).toHaveLength(1);
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
  await expect(b.instance.deleteSessions([parent.id, child.id])).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  expect(b.ending).not.toHaveBeenCalled();
  expect(b.hostCleanup).not.toHaveBeenCalled();
  a.resume.resolve();
  b.resume.resolve();
  await Promise.all([parentRun.result(), childRun.result()]);
  await b.instance.deleteSessions([parent.id, child.id]);
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
  const deleting = a.instance.deleteSessions([parent.id, child.id]);
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
    const deleting = a.instance.deleteSessions([parent.id, child.id]);
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

it('releases earlier explicit members when a later member conflicts', async () => {
  const f = await fixture();
  const sessions = await Promise.all(
    Array.from({ length: 2 }, () => f.store.createSession({ workspace: f.home }))
  );
  const [foreign, anchor] = sessions.map((session) => session.id).sort() as [string, string];
  const releaseForeign = await f.store.acquireSessionLease(foreign, {});
  releaseFault.path = join(f.home, '.mar', 'agent', 'sessions', anchor, 'lock');
  await expect(
    f.store.acquireSessionMaintenance(anchor, 'delete', undefined, [anchor, foreign])
  ).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  expect(releaseFault.path).toBe('');
  const parentRelease = await f.store.acquireSessionLease(anchor, {});
  await parentRelease();
  await releaseForeign();
  const holding = await f.store.acquireSessionMaintenance(anchor, 'delete', undefined, [
    anchor,
    foreign
  ]);
  expect(new Set(holding.sessionIds)).toEqual(new Set([anchor, foreign]));
  await f.store.delete(anchor, holding);
  await holding.release();
});
