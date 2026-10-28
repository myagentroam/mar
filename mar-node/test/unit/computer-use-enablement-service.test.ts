import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeConfig } from '../../src/config.js';
import { ComputerUseRuntimeError } from '../../src/computer-use-runtime.js';
import { ComputerUseError, type ComputerUseSupport } from '../../src/computer-use/contracts.js';
import { probeComputerUse } from '../../src/computer-use/probe.js';
import { createFakeComputerRuntime } from './support/computer-use-runtime.js';
import { ComputerUseEnablementService } from '../../src/service/computer-use-enablement-service.js';
import { ConversationHostingEnablementService } from '../../src/service/conversation-hosting-enablement-service.js';
import { NodeConfigMutations } from '../../src/service/node-config-mutations.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(enabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'mar-computer-use-enablement-'));
  roots.push(root);
  const path = join(root, 'node.json');
  let config: NodeConfig = {
    serverUrl: 'https://server.example',
    allowedRoots: [root],
    computerUse: { enabled, runtimeExecutable: 'runtime/python' }
  };
  await writeFile(path, JSON.stringify(config));
  const publish = vi.fn();
  const provider = {
    support: vi.fn<() => Promise<ComputerUseSupport>>(async () => ({
      available: true,
      reasonCode: null,
      platform: 'windows' as const,
      backend: 'PYAUTOGUI' as const,
      runtimeExecutable: join(root, 'runtime/python'),
      supportsScreenshot: true,
      supportsInput: true,
      supportsUnicodePaste: true,
      supportsPrimaryDisplay: true
    })),
    bind: vi.fn(),
    releaseSession: vi.fn(),
    reset: vi.fn<() => Promise<void>>(async () => undefined),
    dispose: vi.fn()
  };
  const mutations = new NodeConfigMutations();
  const setConfig = (next: NodeConfig) => {
    config = next;
  };
  const prepareRuntime = vi.fn(async () => join(root, 'runtime/python'));
  const service = new ComputerUseEnablementService({
    mutations,
    config: () => config,
    setConfig,
    configPath: path,
    provider,
    prepareRuntime,
    publish,
    now: () => 42
  });
  const hosting = new ConversationHostingEnablementService({
    mutations,
    config: () => config,
    setConfig,
    configPath: path,
    platform: () => 'linux',
    capability: () => ({
      apiVersion: 1,
      state: 'AVAILABLE',
      sandboxBackend: 'BUBBLEWRAP',
      sandboxPolicyVersion: 1,
      acceptsNewConversations: true,
      supportsExistingConversations: true,
      capacity: 'AVAILABLE'
    }),
    initialize: async () => undefined,
    prepareForDisable: () => () => undefined,
    publishCapabilities: () => undefined
  });
  return { path, provider, prepareRuntime, publish, service, hosting, config: () => config };
}

describe('ComputerUseEnablementService', () => {
  it('does not prepare or probe after an obsolete reset completes', async () => {
    const { service, provider, prepareRuntime } = await fixture(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.reset.mockImplementationOnce(() => gate);
    service.initialize();
    await service.operations()['computer.use.disable']!({});
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(provider.support).not.toHaveBeenCalled();
    expect(service.capability().state).toBe('DISABLED');
  });

  it('restores authorization after a failed save and permits the next feature write', async () => {
    const { service, hosting, provider, path, config } = await fixture(true);
    const original = await readFile(path, 'utf8');
    provider.reset.mockImplementationOnce(async () => {
      await rm(path);
      await mkdir(path);
    });
    await expect(service.operations()['computer.use.disable']!({})).rejects.toThrow();
    expect(config().computerUse?.enabled).toBe(true);
    await rm(path, { recursive: true });
    await writeFile(path, original);
    await hosting.operations()['conversation.hosting.enable']!({ enabled: true });
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(persisted.computerUse.enabled).toBe(true);
    expect(persisted.conversationHosting.enabled).toBe(true);
  });

  it('preserves both feature updates when enable requests overlap', async () => {
    const { service, hosting, path, config } = await fixture();
    await Promise.all([
      service.operations()['computer.use.enable']!({ enabled: true }),
      hosting.operations()['conversation.hosting.enable']!({ enabled: true })
    ]);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(config().computerUse?.enabled).toBe(true);
    expect(config().conversationHosting?.enabled).toBe(true);
    expect(persisted.computerUse.enabled).toBe(true);
    expect(persisted.conversationHosting.enabled).toBe(true);
  });

  it.each([false, true])(
    'does not persist a pending disable through another feature (reset failure: %s)',
    async (resetFails) => {
      const { service, hosting, provider, path, config } = await fixture(true);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      provider.reset.mockImplementationOnce(async () => {
        await gate;
        if (resetFails) throw new Error('reset failed');
      });
      const disable = service.operations()['computer.use.disable']!({});
      const disableResult = Promise.resolve(disable).then(
        () => null,
        (error: unknown) => error
      );
      expect(config().computerUse?.enabled).toBe(false);
      const enableHosting = hosting.operations()['conversation.hosting.enable']!({ enabled: true });
      void Promise.resolve(enableHosting).catch(() => undefined);
      try {
        expect(config().conversationHosting?.enabled).not.toBe(true);
        const persisted = JSON.parse(await readFile(path, 'utf8'));
        expect(persisted.computerUse.enabled).toBe(true);
        expect(persisted.conversationHosting?.enabled).not.toBe(true);
      } finally {
        release();
        await Promise.allSettled([disableResult, enableHosting]);
      }
      expect(await disableResult).toEqual(resetFails ? new Error('reset failed') : null);
      await enableHosting;
      expect(config().computerUse?.enabled).toBe(resetFails);
      expect(config().conversationHosting?.enabled).toBe(true);
      const persisted = JSON.parse(await readFile(path, 'utf8'));
      expect(persisted.computerUse.enabled).toBe(resetFails);
      expect(persisted.conversationHosting.enabled).toBe(true);
    }
  );

  it('projects measured partial and complete desktop support without upgrading missing evidence', async () => {
    const previousDisplay = process.env['DISPLAY'];
    const previousWayland = process.env['WAYLAND_DISPLAY'];
    try {
      process.env['DISPLAY'] = ':99';
      delete process.env['WAYLAND_DISPLAY'];
      for (const options of [
        {},
        { input: false },
        { clipboard: false },
        { clipboardDenied: true }
      ]) {
        const root = await mkdtemp(join(tmpdir(), 'mar-computer-projection-'));
        roots.push(root);
        const runtimeExecutable = await createFakeComputerRuntime(root, options);
        const measured = await probeComputerUse({ enabled: true, runtimeExecutable });
        const { provider, publish, service } = await fixture(true);
        provider.support.mockResolvedValueOnce(measured);
        service.initialize();
        await vi.waitFor(() => expect(service.capability().state).not.toBe('INITIALIZING'));
        expect(service.capability()).toEqual({
          apiVersion: 1,
          enabled: true,
          backend: measured.backend,
          state: measured.available ? 'AVAILABLE' : 'UNAVAILABLE',
          supportsScreenshot: measured.supportsScreenshot,
          supportsInput: measured.supportsInput,
          supportsUnicodePaste: measured.supportsUnicodePaste,
          supportsPrimaryDisplay: measured.supportsPrimaryDisplay,
          ...(measured.reasonCode === null ? {} : { reasonCode: measured.reasonCode }),
          measuredAt: 42
        });
        expect(publish).toHaveBeenLastCalledWith(service.capability());
      }
    } finally {
      if (previousDisplay === undefined) delete process.env['DISPLAY'];
      else process.env['DISPLAY'] = previousDisplay;
      if (previousWayland === undefined) delete process.env['WAYLAND_DISPLAY'];
      else process.env['WAYLAND_DISPLAY'] = previousWayland;
    }
  });

  it('defaults to disabled and persists enable before probing asynchronously', async () => {
    const { path, provider, publish, service, config } = await fixture();
    expect(service.capability().state).toBe('DISABLED');
    const result = await service.operations()['computer.use.enable']!({ enabled: true });
    expect((result as { capability: { state: string } }).capability.state).toBe('INITIALIZING');
    expect(config().computerUse?.enabled).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).computerUse.enabled).toBe(true);
    await vi.waitFor(() => expect(provider.support).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'AVAILABLE' }))
    );
  });

  it('publishes failure reason and disables by resetting resources', async () => {
    const { provider, publish, service, config } = await fixture(true);
    provider.support.mockRejectedValueOnce(
      new ComputerUseError('COMPUTER_INPUT_PERMISSION_DENIED', 'Input permission denied.')
    );
    service.initialize();
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: 'UNAVAILABLE',
          reasonCode: 'COMPUTER_INPUT_PERMISSION_DENIED'
        })
      )
    );
    const result = await service.operations()['computer.use.disable']!({});
    expect((result as { capability: { state: string } }).capability.state).toBe('DISABLED');
    expect(config().computerUse?.enabled).toBe(false);
    expect(provider.reset).toHaveBeenCalled();
  });

  it('does not interpret an unknown error message as a stable code', async () => {
    const { provider, service } = await fixture(true);
    provider.support.mockRejectedValueOnce(new Error('COMPUTER_INPUT_PERMISSION_DENIED'));
    service.initialize();
    await vi.waitFor(() => expect(service.capability().state).toBe('UNAVAILABLE'));
    expect(service.capability().reasonCode).toBe('COMPUTER_PROBE_FAILED');
  });

  it('preserves the structured runtime error code', async () => {
    const { provider, service } = await fixture(true);
    provider.reset.mockRejectedValueOnce(new ComputerUseRuntimeError('COMPUTER_RUNTIME_MISSING'));
    service.initialize();
    await vi.waitFor(() => expect(service.capability().state).toBe('UNAVAILABLE'));
    expect(service.capability().reasonCode).toBe('COMPUTER_RUNTIME_MISSING');
  });
});
