import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalAgentHost, SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/jsonl-store.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

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
  titleGeneration: false,
  codeMode: false,
  enabled: true
};
const { apiKey: _staticKey, ...dynamicModel } = model;

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
    const agent = await createMarAgentWithAdapter({
      mode: 'normal',
      host,
      models: [phase === 'provider' ? { ...dynamicModel, credentialProvider: provider } : model],
      adapterFactory: (configuration) => {
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
    });
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
  const agent = await createMarAgentWithAdapter({
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
  const agent = await createMarAgentWithAdapter({
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
