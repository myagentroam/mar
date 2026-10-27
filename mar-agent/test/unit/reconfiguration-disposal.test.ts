import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgent, createAgentWithAdapter } from '../../src/sdk/agent.js';
import { closeModelAdapters } from '../../src/sdk/model-runtime.js';
import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';
import type { ModelAdapter } from '../../src/model/contracts.js';
import type { ExtensionModelsApi } from '../../src/extensions/models.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

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
  titleGeneration: false,
  codeMode: false,
  enabled: true
};
const { apiKey: _staticKey, ...dynamicModel } = model;

it.each([0, 1, 2])(
  'rejects an uncommitted reconfiguration when dispose wins after %i microtasks',
  async (hops) => {
    const home = await mkdtemp(join(tmpdir(), 'mar-reconfigure-microtask-'));
    homes.push(home);
    const a = { acquire: vi.fn(), invalidate: vi.fn(), close: vi.fn(async () => {}) };
    const b = { acquire: vi.fn(), invalidate: vi.fn(), close: vi.fn(async () => {}) };
    const agent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
      models: [{ ...dynamicModel, credentialProvider: a }]
    });
    try {
      const pending = agent.reconfigureModels({
        models: [{ ...dynamicModel, credentialProvider: b }]
      });
      const outcome = pending.catch((error: unknown) => error);
      for (let index = 0; index < hops; index++) await Promise.resolve();
      await agent.dispose();
      expect(await outcome).toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
      expect(a.close).toHaveBeenCalledOnce();
      expect(b.close).not.toHaveBeenCalled();
    } finally {
      await agent.dispose();
    }
  }
);

it('keeps an admitted reconfiguration committed when dispose starts during provider retirement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-reconfigure-committed-'));
  homes.push(home);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const a = {
    acquire: vi.fn(),
    invalidate: vi.fn(),
    close: vi.fn(async () => {
      entered.resolve();
      await release.promise;
    })
  };
  const b = { acquire: vi.fn(), invalidate: vi.fn(), close: vi.fn(async () => {}) };
  const agent = await createAgent({
    mode: 'normal',
    host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
    models: [{ ...dynamicModel, credentialProvider: a }]
  });
  try {
    const pending = agent.reconfigureModels({
      models: [{ ...dynamicModel, credentialProvider: b }]
    });
    await entered.promise;
    const disposal = agent.dispose();
    expect(b.close).not.toHaveBeenCalled();
    release.resolve();
    await expect(pending).resolves.toBeUndefined();
    await disposal;
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await agent.dispose();
  }
});

it('keeps providers for overlapping independent Extension generations through reconfiguration and disposal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-extension-generations-'));
  homes.push(home);
  const enteredA = Promise.withResolvers<void>();
  const enteredB = Promise.withResolvers<void>();
  const transformEntered = Promise.withResolvers<void>();
  const releaseTransform = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closeA = vi.fn(async () => {});
  const closeB = vi.fn(async () => {});
  const providerA = { acquire: vi.fn(), invalidate: vi.fn(), close: closeA };
  const providerB = { acquire: vi.fn(), invalidate: vi.fn(), close: closeB };
  let models!: ExtensionModelsApi;
  const agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
      models: [{ ...dynamicModel, credentialProvider: providerA }],
      extensions: [
        {
          id: 'provider-generation',
          apiVersion: '1.0',
          attachSession(context) {
            if (!context.models) throw new Error('Missing models capability');
            models = context.models;
            context.hooks.intercept('model.request', async (request, _call, next) => {
              if (request.system === 'hold-B') {
                transformEntered.resolve();
                await releaseTransform.promise;
              }
              return next(request);
            });
          }
        }
      ]
    },
    (configuration) => ({
      configuration,
      async *start(request) {
        if (request.system === 'hold-A') {
          enteredA.resolve();
          await release.promise;
        }
        if (request.system === 'hold-B') {
          enteredB.resolve();
          await release.promise;
        }
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      },
      close: async () => {}
    })
  );
  const running: Promise<unknown>[] = [];
  try {
    const session = await agent.createSession({ workspace: home });
    expect((await session.run({ prompt: 'initialize' }).result()).status).toBe('completed');
    running.push(models.generate({ system: 'hold-A', prompt: 'probe' }));
    await enteredA.promise;
    await agent.reconfigureModels({ models: [{ ...dynamicModel, credentialProvider: providerB }] });
    running.push(models.generate({ system: 'hold-B', prompt: 'probe' }));
    await transformEntered.promise;
    await agent.reconfigureModels({ models: [model] });
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
    releaseTransform.resolve();
    await enteredB.promise;
    const disposal = agent.dispose();
    await setImmediate();
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
    release.resolve();
    await Promise.allSettled(running);
    await disposal;
    expect(closeA).toHaveBeenCalledOnce();
    expect(closeB).toHaveBeenCalledOnce();
  } finally {
    releaseTransform.resolve();
    release.resolve();
    await Promise.allSettled(running);
    await agent.dispose();
  }
});

it('releases the generation adapter reference when the request hook fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-extension-hook-failure-'));
  homes.push(home);
  const close = vi.fn(async () => {});
  const provider = { acquire: vi.fn(), invalidate: vi.fn(), close };
  const failure = new Error('request rejected');
  let models!: ExtensionModelsApi;
  const adapterClose = vi.fn(async () => {});
  const agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
      models: [model],
      extensions: [
        {
          id: 'failing-hook',
          apiVersion: '1.0',
          attachSession(context) {
            if (!context.models) throw new Error('Missing models capability');
            models = context.models;
            context.hooks.intercept('model.request', async (request, _call, next) => {
              if (request.system === 'reject') throw failure;
              return next(request);
            });
          }
        }
      ]
    },
    (configuration) => ({
      configuration,
      async *start() {
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      },
      close: adapterClose
    })
  );
  try {
    const session = await agent.createSession({ workspace: home });
    await session.run({ prompt: 'initialize' }).result();
    await agent.reconfigureModels({ models: [{ ...dynamicModel, credentialProvider: provider }] });
    const previousCloseCount = adapterClose.mock.calls.length;
    await expect(models.generate({ system: 'reject', prompt: 'probe' })).rejects.toBe(failure);
    expect(adapterClose).toHaveBeenCalledTimes(previousCloseCount + 1);
    await agent.reconfigureModels({ models: [model] });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await agent.dispose();
  }
});

it('joins every distinct adapter close after a synchronous failure and preserves the first error', async () => {
  const failure = new Error('synchronous close failure');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = {
    close: vi.fn(() => {
      throw failure;
    })
  } as unknown as ModelAdapter;
  const second = {
    close: vi.fn(async () => {
      entered.resolve();
      await release.promise;
    })
  } as unknown as ModelAdapter;
  let settled = false;
  const closing = closeModelAdapters([first, second, first]).finally(() => {
    settled = true;
  });
  void closing.catch(() => undefined);
  await entered.promise;
  expect(settled).toBe(false);
  release.resolve();
  await expect(closing).rejects.toBe(failure);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
});

it.each(['clear', 'delete'] as const)(
  'does not close a shared adapter while another Session is active during %s',
  async (operation) => {
    const home = await mkdtemp(join(tmpdir(), 'mar-shared-adapter-'));
    homes.push(home);
    const host = new LocalAgentHost({ homeDirectory: home, workspace: home });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const close = vi.fn(async () => {});
    let hold = false;
    let shared: ModelAdapter | undefined;
    const agent = await createAgentWithAdapter(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      (configuration) => {
        if (shared) return shared;
        async function* start() {
          if (hold) {
            entered.resolve();
            await release.promise;
          }
          yield { type: 'text.completed' as const, itemId: 'answer', text: 'done' };
          yield { type: 'completed' as const, reason: 'completed' as const };
        }
        shared = {
          configuration,
          start,
          close,
          createTurnSession: () => ({ start, close: async () => {} })
        };
        return shared;
      }
    );
    try {
      const first = await agent.createSession({ workspace: home });
      const second = await agent.createSession({ workspace: home });
      expect((await first.run({ prompt: 'first' }).result()).status).toBe('completed');
      hold = true;
      const running = second.run({ prompt: 'second' });
      await entered.promise;
      if (operation === 'clear') await agent.clearSession(first.id);
      else await agent.deleteSession(first.id);
      expect(close).not.toHaveBeenCalled();
      release.resolve();
      expect((await running.result()).status).toBe('completed');
    } finally {
      release.resolve();
      await agent.dispose();
    }
    expect(close).toHaveBeenCalledOnce();
  }
);

it.each([
  { phase: 'adapter', fail: false },
  { phase: 'adapter', fail: true },
  { phase: 'provider', fail: false },
  { phase: 'provider', fail: true }
] as const)(
  'joins in-flight $phase retirement before disposing (fail=$fail)',
  async ({ phase, fail }) => {
    const home = await mkdtemp(join(tmpdir(), 'mar-reconfiguration-disposal-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('retirement failed');
    const close = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      if (fail && close.mock.calls.length === 1) throw failure;
    });
    const provider = { acquire: vi.fn(), invalidate: vi.fn(), close };
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const hostClose = vi.spyOn(host, 'dispose');
    const agent = await createAgentWithAdapter(
      {
        mode: 'normal',
        host,
        models: [phase === 'provider' ? { ...dynamicModel, credentialProvider: provider } : model]
      },
      (configuration) => {
        const start = async function* () {
          yield { type: 'text.completed' as const, itemId: 'answer', text: 'done' };
          yield { type: 'completed' as const, reason: 'completed' as const };
        };
        return {
          configuration,
          start,
          createTurnSession: () => ({ start, close: async () => undefined }),
          ...(phase === 'adapter' ? { close } : {})
        };
      }
    );
    let reconfiguration: Promise<unknown> | undefined;
    let disposal: Promise<void> | undefined;
    try {
      if (phase === 'adapter') {
        const session = await agent.createSession({ workspace, title: 'Retained adapter' });
        expect((await session.run({ prompt: 'prepare' }).result()).status).toBe('completed');
      }
      reconfiguration = agent
        .reconfigureModels({ models: [{ ...model, name: 'Replacement' }] })
        .catch((error: unknown) => error);
      await entered.promise;
      disposal = agent.dispose();
      const disposed = disposal.catch((error: unknown) => error);
      expect(agent.dispose()).toBe(disposal);
      // Allow pending cleanup continuations to run while retirement is still gated.
      let settled = false;
      void disposed.then(() => {
        settled = true;
      });
      await setImmediate();
      expect(settled).toBe(false);
      expect(hostClose).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      release.resolve();
      const result = await reconfiguration;
      if (phase === 'adapter' && fail) expect(result).toBe(failure);
      else if (phase === 'adapter') expect(result).toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
      else expect(result).toBeUndefined();
      expect(await disposed).toBe(phase === 'adapter' && fail ? failure : undefined);
      expect(close).toHaveBeenCalledTimes(phase === 'provider' && fail ? 2 : 1);
      await expect(agent.reconfigureModels({ models: [model] })).rejects.toMatchObject({
        code: 'MAR_AGENT_DISPOSED'
      });
    } finally {
      release.resolve();
      await reconfiguration;
      await (disposal ?? agent.dispose()).catch(() => undefined);
    }
  }
);

it('retries retired providers serially and continues all cleanup after a provider failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-provider-disposal-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error('provider close failed');
  const firstClose = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    throw failure;
  });
  const secondClose = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('retry the second provider during disposal'))
    .mockResolvedValue(undefined);
  const storeClose = vi.spyOn(JsonlSessionStore.prototype, 'close');
  const host = new LocalAgentHost({ homeDirectory: home, workspace });
  const hostClose = vi.spyOn(host, 'dispose');
  const provider = { acquire: vi.fn(), invalidate: vi.fn(), close: firstClose };
  const other = { acquire: vi.fn(), invalidate: vi.fn(), close: secondClose };
  const agent = await createAgentWithAdapter({
    mode: 'normal',
    host,
    models: [
      { ...dynamicModel, credentialProvider: provider },
      { ...dynamicModel, id: 'other', enabled: false, credentialProvider: other }
    ]
  });
  const reconfiguration = agent.reconfigureModels({ models: [model] });
  await entered.promise;
  const disposal = agent.dispose();
  const outcome = disposal.catch((error: unknown) => error);
  try {
    await setImmediate();
    expect(firstClose).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
  }
  await reconfiguration;
  expect(await outcome).toBe(failure);
  expect(firstClose).toHaveBeenCalledTimes(2);
  expect(secondClose).toHaveBeenCalledTimes(2);
  expect(hostClose).toHaveBeenCalledOnce();
  expect(storeClose).toHaveBeenCalledOnce();
});

it('joins pending provider retirement when another close throws synchronously', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-provider-synchronous-close-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error('synchronous provider close failure');
  const firstClose = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const secondClose = vi.fn(() => {
    throw failure;
  });
  const host = new LocalAgentHost({ homeDirectory: home, workspace });
  const hostClose = vi.spyOn(host, 'dispose');
  const agent = await createAgentWithAdapter({
    mode: 'normal',
    host,
    models: [
      {
        ...dynamicModel,
        credentialProvider: { acquire: vi.fn(), invalidate: vi.fn(), close: firstClose }
      },
      {
        ...dynamicModel,
        id: 'other',
        enabled: false,
        credentialProvider: { acquire: vi.fn(), invalidate: vi.fn(), close: secondClose }
      }
    ]
  });
  const reconfiguration = agent
    .reconfigureModels({ models: [model] })
    .catch((error: unknown) => error);
  await entered.promise;
  const disposal = agent.dispose().catch((error: unknown) => error);
  try {
    await setImmediate();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(hostClose).not.toHaveBeenCalled();
    release.resolve();
    expect(await reconfiguration).toBeUndefined();
    expect(await disposal).toBe(failure);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledTimes(2);
    expect(hostClose).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await reconfiguration;
    await disposal;
  }
});
