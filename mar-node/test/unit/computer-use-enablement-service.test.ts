import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeConfig } from '../../src/config.js';
import {
  probeComputerUse,
  type ComputerUseSupport
} from '../../src/runner/mar-agent/computer-use.js';
import { createFakeComputerRuntime } from './support/computer-use-runtime.js';
import { ComputerUseEnablementService } from '../../src/service/computer-use-enablement-service.js';

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
    reset: vi.fn(async () => undefined),
    dispose: vi.fn()
  };
  const service = new ComputerUseEnablementService({
    config: () => config,
    setConfig: (next) => {
      config = next;
    },
    configPath: path,
    provider,
    prepareRuntime: vi.fn(async () => join(root, 'runtime/python')),
    publish,
    now: () => 42
  });
  return { path, provider, publish, service, config: () => config };
}

describe('ComputerUseEnablementService', () => {
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
    provider.support.mockRejectedValueOnce(new Error('COMPUTER_INPUT_PERMISSION_DENIED'));
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
});
