import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ComputerUseDesktopLeaseService,
  PyAutoGuiComputerUseProvider,
  computerUseToolDefinition,
  probeComputerUse
} from '../../src/runner/mar-agent/computer-use.js';

import {
  createFakeComputerRuntime,
  type DesktopFixtureOptions
} from './support/computer-use-runtime.js';

const roots: string[] = [];
const previousDisplay = process.env['DISPLAY'];
const previousWayland = process.env['WAYLAND_DISPLAY'];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (previousDisplay === undefined) delete process.env['DISPLAY'];
  else process.env['DISPLAY'] = previousDisplay;
  if (previousWayland === undefined) delete process.env['WAYLAND_DISPLAY'];
  else process.env['WAYLAND_DISPLAY'] = previousWayland;
});

async function fakeRuntime(options: DesktopFixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mar-computer-use-test-'));
  roots.push(root);
  process.env['DISPLAY'] = ':99';
  delete process.env['WAYLAND_DISPLAY'];
  return createFakeComputerRuntime(root, options);
}

describe('Computer Use core', () => {
  it.each(['xclip', 'xsel'] as const)(
    'does not consume a one-shot clipboard selection while probing %s',
    async (clipboardBackend) => {
      const runtimeExecutable = await fakeRuntime({
        clipboardBackend,
        clipboardPopulated: true,
        clipboardOneShot: true
      });
      await expect(probeComputerUse({ enabled: true, runtimeExecutable })).resolves.toMatchObject({
        available: true,
        supportsUnicodePaste: true
      });
      expect(await readFile(join(dirname(runtimeExecutable), 'effects'), 'utf8')).toBe('');
      expect(await readFile(join(dirname(runtimeExecutable), 'clipboard'), 'utf8')).toBe(
        'original clipboard: 中文 📋'
      );
    }
  );

  it.each(['linux', 'win32', 'darwin'] as const)(
    'requires platform input and clipboard evidence on %s without changing the desktop',
    async (platform) => {
      for (const options of [
        { platform },
        { platform, clipboardPopulated: true },
        { platform, input: false },
        { platform, clipboardDenied: true },
        { platform, unknownBackend: true }
      ]) {
        const runtimeExecutable = await fakeRuntime(options);
        const input = !('input' in options);
        const paste = input && !('clipboardDenied' in options) && !('unknownBackend' in options);
        await expect(probeComputerUse({ enabled: true, runtimeExecutable })).resolves.toMatchObject(
          {
            available: paste,
            reasonCode: !input
              ? 'COMPUTER_INPUT_PERMISSION_DENIED'
              : paste
                ? null
                : 'COMPUTER_RUNTIME_UNAVAILABLE',
            supportsScreenshot: true,
            supportsPrimaryDisplay: true,
            supportsInput: input,
            supportsUnicodePaste: paste
          }
        );
        expect(await readFile(join(dirname(runtimeExecutable), 'effects'), 'utf8')).toBe('');
        expect(await readFile(join(dirname(runtimeExecutable), 'clipboard'), 'utf8')).toBe(
          'original clipboard: 中文 📋'
        );
      }
    }
  );

  it('rejects a Windows desktop that is not the current input desktop', async () => {
    const runtimeExecutable = await fakeRuntime({ platform: 'win32', currentDesktop: false });
    await expect(probeComputerUse({ enabled: true, runtimeExecutable })).resolves.toMatchObject({
      available: false,
      reasonCode: 'COMPUTER_INPUT_PERMISSION_DENIED',
      supportsScreenshot: true,
      supportsInput: false,
      supportsUnicodePaste: false
    });
  });

  it('rejects unsupported desktops, disabled configuration, and invalid screenshots', async () => {
    const runtimeExecutable = await fakeRuntime({ platform: 'unsupported' });
    await expect(probeComputerUse({ enabled: true, runtimeExecutable })).resolves.toMatchObject({
      available: false,
      reasonCode: 'COMPUTER_DESKTOP_UNSUPPORTED',
      supportsScreenshot: false,
      supportsInput: false,
      supportsUnicodePaste: false
    });
    const invalidScreenshot = await fakeRuntime({ screenshot: false });
    await expect(
      probeComputerUse({ enabled: true, runtimeExecutable: invalidScreenshot })
    ).resolves.toMatchObject({
      available: false,
      reasonCode: 'COMPUTER_RUNTIME_UNAVAILABLE',
      supportsScreenshot: false
    });
    await expect(
      probeComputerUse({ enabled: false, runtimeExecutable: invalidScreenshot })
    ).resolves.toMatchObject({
      available: false,
      reasonCode: 'COMPUTER_USE_DISABLED',
      supportsInput: false
    });
    process.env['WAYLAND_DISPLAY'] = 'wayland-0';
    await expect(
      probeComputerUse({ enabled: true, runtimeExecutable: invalidScreenshot })
    ).resolves.toMatchObject({
      available: false,
      reasonCode: 'COMPUTER_DESKTOP_UNSUPPORTED',
      supportsInput: false
    });
  });

  it('keeps repeated probes, binding, and call-time rechecks free of input and clipboard writes', async () => {
    const runtimeExecutable = await fakeRuntime();
    const configuration = { enabled: true, runtimeExecutable };
    await probeComputerUse(configuration);
    await probeComputerUse(configuration);
    const provider = new PyAutoGuiComputerUseProvider(configuration);
    try {
      const binding = await provider.bind({
        runId: 'probe-run',
        sessionId: 'probe-session',
        mode: 'run',
        enabled: true,
        modelSupportsImages: true
      });
      expect(binding).toBeDefined();
      await expect(
        binding!.call(
          {
            callId: 'observe',
            name: 'mcp__mar_computer__exec',
            arguments: { code: '' }
          },
          new AbortController().signal
        )
      ).resolves.toMatchObject({ data: { outcome: 'SUCCEEDED' } });
      expect(await readFile(join(dirname(runtimeExecutable), 'effects'), 'utf8')).toBe('');
      expect(await readFile(join(dirname(runtimeExecutable), 'clipboard'), 'utf8')).toBe(
        'original clipboard: 中文 📋'
      );
      await binding!.close();
    } finally {
      await provider.dispose();
    }
  });

  it('retains screenshot evidence without claiming input when XTEST is unavailable', async () => {
    const runtimeExecutable = await fakeRuntime({ input: false });
    await expect(probeComputerUse({ enabled: true, runtimeExecutable })).resolves.toMatchObject({
      available: false,
      reasonCode: 'COMPUTER_INPUT_PERMISSION_DENIED',
      supportsScreenshot: true,
      supportsPrimaryDisplay: true,
      supportsInput: false,
      supportsUnicodePaste: false
    });
  });

  it('rejects binding or execution when input permission evidence is lost', async () => {
    const runtimeExecutable = await fakeRuntime({ input: false });
    const provider = new PyAutoGuiComputerUseProvider({ enabled: true, runtimeExecutable });
    const input = {
      runId: 'run-probe',
      sessionId: 'session-probe',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    } as const;
    try {
      await expect(provider.bind(input)).resolves.toBeUndefined();
      await writeFile(join(dirname(runtimeExecutable), 'options.json'), '{}');
      await provider.reset();
      const binding = await provider.bind(input);
      expect(binding).toBeDefined();
      await writeFile(
        join(dirname(runtimeExecutable), 'options.json'),
        JSON.stringify({ input: false })
      );
      await expect(
        binding!.call(
          { callId: 'lost-permission', name: 'mcp__mar_computer__exec', arguments: { code: '' } },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: 'COMPUTER_INPUT_PERMISSION_DENIED' });
      expect(await readFile(join(dirname(runtimeExecutable), 'effects'), 'utf8')).toBe('');
      expect(await readFile(join(dirname(runtimeExecutable), 'clipboard'), 'utf8')).toBe(
        'original clipboard: 中文 📋'
      );
      await binding!.close();
    } finally {
      await provider.dispose();
    }
  });

  it('does not claim Unicode paste when no clipboard backend is available', async () => {
    const runtimeExecutable = await fakeRuntime({ clipboard: false });
    await expect(probeComputerUse({ enabled: true, runtimeExecutable })).resolves.toMatchObject({
      available: false,
      reasonCode: 'COMPUTER_RUNTIME_UNAVAILABLE',
      supportsScreenshot: true,
      supportsPrimaryDisplay: true,
      supportsInput: true,
      supportsUnicodePaste: false
    });
  });

  it('probes a configured PyAutoGUI runtime without desktop input side effects', async () => {
    const runtimeExecutable = await fakeRuntime();
    await expect(probeComputerUse({ enabled: true, runtimeExecutable })).resolves.toMatchObject({
      available: true,
      reasonCode: null,
      backend: 'PYAUTOGUI',
      supportsScreenshot: true,
      supportsInput: true,
      supportsUnicodePaste: true,
      supportsPrimaryDisplay: true
    });
    expect(computerUseToolDefinition.agentScope).toBe('ROOT_ONLY');
    expect(computerUseToolDefinition.name).toBe('mcp__mar_computer__exec');
    expect(computerUseToolDefinition.description).toContain('Combine deterministic operations');
    expect(computerUseToolDefinition.description).toContain(
      'do not split predictable keyboard steps'
    );
  });

  it('keeps a Run namespace, returns screenshots, and rejects stale observations', async () => {
    const runtimeExecutable = await fakeRuntime();
    const provider = new PyAutoGuiComputerUseProvider({ enabled: true, runtimeExecutable });
    const binding = await provider.bind({
      runId: 'run-a',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    expect(binding).toBeDefined();
    const first = await binding!.call(
      {
        callId: 'first',
        name: 'mcp__mar_computer__exec',
        arguments: {
          code: 'counter = globals().get("counter", 0) + 1; log(counter)',
          basedOnObservationId: null,
          timeoutMs: null
        }
      },
      new AbortController().signal
    );
    expect(first.data).toMatchObject({
      outcome: 'SUCCEEDED',
      runtimeGeneration: 1,
      logs: ['1']
    });
    expect(first.images).toHaveLength(1);
    const observationId = (first.data as { observationId: string }).observationId;

    const second = await binding!.call(
      {
        callId: 'second',
        name: 'mcp__mar_computer__exec',
        arguments: {
          code: 'counter += 1; log(counter)',
          basedOnObservationId: observationId
        }
      },
      new AbortController().signal
    );
    expect(second.data).toMatchObject({ outcome: 'SUCCEEDED', logs: ['2'] });
    await expect(
      binding!.call(
        {
          callId: 'stale',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'log("must not run")', basedOnObservationId: observationId }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'COMPUTER_OBSERVATION_STALE' });
    await binding!.close();
    await provider.dispose();
  });

  it('shows the control indicator around execution and fails before desktop code without it', async () => {
    const runtimeExecutable = await fakeRuntime();
    const close = vi.fn(async () => undefined);
    const showControlIndicator = vi.fn(async () => ({ close }));
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      { showControlIndicator }
    );
    const binding = await provider.bind({
      runId: 'run-indicator',
      sessionId: 'session-indicator',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await expect(
      binding!.call(
        {
          callId: 'indicator',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'log("executed")' }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ data: { logs: ['executed'] } });
    expect(showControlIndicator).toHaveBeenCalledWith(runtimeExecutable);
    expect(close).toHaveBeenCalledOnce();
    await binding!.close();
    await provider.dispose();

    const unavailable = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      { showControlIndicator: async () => Promise.reject(new Error('unavailable')) }
    );
    const unavailableBinding = await unavailable.bind({
      runId: 'run-unavailable',
      sessionId: 'session-unavailable',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await expect(
      unavailableBinding!.call(
        {
          callId: 'indicator-unavailable',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'raise RuntimeError("must not execute")' }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'COMPUTER_CONTROL_INDICATOR_UNAVAILABLE' });
    await unavailableBinding!.close();
    await unavailable.dispose();
  });

  it('stops an active desktop script when the control indicator is lost', async () => {
    const runtimeExecutable = await fakeRuntime();
    let loseIndicator: ((error: Error) => void) | undefined;
    const lost = new Promise<Error>((resolve) => {
      loseIndicator = resolve;
    });
    const close = vi.fn(async () => undefined);
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      { showControlIndicator: async () => ({ lost, close }) }
    );
    const binding = await provider.bind({
      runId: 'run-indicator-lost',
      sessionId: 'session-indicator-lost',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    setTimeout(() => loseIndicator!(new Error('indicator lost')), 100);
    await expect(
      binding!.call(
        {
          callId: 'indicator-lost',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'time.sleep(10)' }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      data: { outcome: 'OUTCOME_UNKNOWN', runtimeGeneration: 2 }
    });
    expect(close).toHaveBeenCalledOnce();
    await binding!.close();
    await provider.dispose();
  });

  it('holds one desktop lease across calls and releases it when the Run closes', async () => {
    const runtimeExecutable = await fakeRuntime();
    const lease = new ComputerUseDesktopLeaseService();
    const firstProvider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      { lease }
    );
    const secondProvider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      { lease }
    );
    const first = await firstProvider.bind({
      runId: 'run-a',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    const second = await secondProvider.bind({
      runId: 'run-b',
      sessionId: 'session-b',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await first!.call(
      {
        callId: 'observe-a',
        name: 'mcp__mar_computer__exec',
        arguments: { code: '' }
      },
      new AbortController().signal
    );
    await expect(
      second!.call(
        {
          callId: 'observe-b',
          name: 'mcp__mar_computer__exec',
          arguments: { code: '' }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'DESKTOP_BUSY' });

    await first!.close();
    await expect(
      second!.call(
        {
          callId: 'observe-b-after-release',
          name: 'mcp__mar_computer__exec',
          arguments: { code: '' }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ data: { outcome: 'SUCCEEDED' } });
    await second!.close();
    await Promise.all([firstProvider.dispose(), secondProvider.dispose()]);
  });

  it('marks an interrupted started script as outcome unknown and rebuilds the worker', async () => {
    const runtimeExecutable = await fakeRuntime();
    const provider = new PyAutoGuiComputerUseProvider({ enabled: true, runtimeExecutable });
    const binding = await provider.bind({
      runId: 'run-a',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    const controller = new AbortController();
    try {
      await binding!.call(
        {
          callId: 'warm-worker',
          name: 'mcp__mar_computer__exec',
          arguments: { code: '' }
        },
        new AbortController().signal
      );
      const startedPath = join(dirname(runtimeExecutable), 'script-started');
      const execution = binding!.call(
        {
          callId: 'interrupt',
          name: 'mcp__mar_computer__exec',
          arguments: {
            code: `__import__('pathlib').Path(${JSON.stringify(startedPath)}).write_text('started'); time.sleep(10)`
          }
        },
        controller.signal
      );
      await vi.waitFor(async () => expect(await readFile(startedPath, 'utf8')).toBe('started'), {
        timeout: 5000
      });
      controller.abort();
      const interrupted = await execution;
      expect(interrupted.data).toMatchObject({
        outcome: 'OUTCOME_UNKNOWN',
        runtimeGeneration: 2
      });
      expect(interrupted.content).toContain('do not replay automatically');

      const recovered = await binding!.call(
        {
          callId: 'recover',
          name: 'mcp__mar_computer__exec',
          arguments: { code: '' }
        },
        new AbortController().signal
      );
      expect(recovered.data).toMatchObject({
        outcome: 'SUCCEEDED',
        runtimeGeneration: 2
      });
    } finally {
      controller.abort();
      await binding!.close();
      await provider.dispose();
    }
  });

  it('does not bind for plans, text-only models, or a Run without explicit enablement', async () => {
    const runtimeExecutable = await fakeRuntime();
    const provider = new PyAutoGuiComputerUseProvider({ enabled: true, runtimeExecutable });
    await expect(
      provider.bind({
        runId: 'plan',
        sessionId: 'session-a',
        mode: 'plan',
        enabled: true,
        modelSupportsImages: true
      })
    ).resolves.toBeUndefined();
    await expect(
      provider.bind({
        runId: 'text',
        sessionId: 'session-a',
        mode: 'run',
        enabled: true,
        modelSupportsImages: false
      })
    ).resolves.toBeUndefined();
    await expect(
      provider.bind({
        runId: 'disabled',
        sessionId: 'session-a',
        mode: 'run',
        enabled: false,
        modelSupportsImages: true
      })
    ).resolves.toBeUndefined();
    await provider.dispose();
  });

  it('keeps the Python namespace warm across Runs in one Session but invalidates observations', async () => {
    const runtimeExecutable = await fakeRuntime();
    const provider = new PyAutoGuiComputerUseProvider({ enabled: true, runtimeExecutable });
    const first = await provider.bind({
      runId: 'run-a',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    const initialized = await first!.call(
      {
        callId: 'initialize',
        name: 'mcp__mar_computer__exec',
        arguments: { code: 'counter = 41; log(counter)' }
      },
      new AbortController().signal
    );
    const oldObservationId = (initialized.data as { observationId: string }).observationId;
    await first!.close();

    const resumed = await provider.bind({
      runId: 'run-b',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await expect(
      resumed!.call(
        {
          callId: 'old-observation',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'log("must not run")', basedOnObservationId: oldObservationId }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'COMPUTER_OBSERVATION_STALE' });
    await expect(
      resumed!.call(
        {
          callId: 'resume',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'counter += 1; log(counter)' }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      data: { outcome: 'SUCCEEDED', runtimeGeneration: 1, logs: ['42'] }
    });
    await resumed!.close();
    await provider.dispose();
  });

  it('releases a detached desktop lease while retaining the warm Session runtime', async () => {
    const runtimeExecutable = await fakeRuntime();
    const lease = new ComputerUseDesktopLeaseService();
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      { lease }
    );
    const first = await provider.bind({
      runId: 'run-a',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await first!.call(
      {
        callId: 'initialize',
        name: 'mcp__mar_computer__exec',
        arguments: { code: 'counter = 1' }
      },
      new AbortController().signal
    );
    await first!.close();
    expect(lease.holder()).toBeUndefined();

    const other = await provider.bind({
      runId: 'run-b',
      sessionId: 'session-b',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await expect(
      other!.call(
        {
          callId: 'other-session',
          name: 'mcp__mar_computer__exec',
          arguments: { code: '' }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ data: { outcome: 'SUCCEEDED' } });
    await other!.close();

    const resumed = await provider.bind({
      runId: 'run-c',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await expect(
      resumed!.call(
        {
          callId: 'resume',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'counter += 1; log(counter)' }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ data: { logs: ['2'] } });
    await resumed!.close();
    await provider.dispose();
  });

  it('explicitly releases a warm Session runtime through the owning lifecycle', async () => {
    const runtimeExecutable = await fakeRuntime();
    const provider = new PyAutoGuiComputerUseProvider({ enabled: true, runtimeExecutable });
    const first = await provider.bind({
      runId: 'run-a',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await first!.call(
      {
        callId: 'initialize',
        name: 'mcp__mar_computer__exec',
        arguments: { code: 'counter = 1' }
      },
      new AbortController().signal
    );
    await first!.close();
    await provider.releaseSession('session-a');

    const released = await provider.bind({
      runId: 'run-b',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await expect(
      released!.call(
        {
          callId: 'released',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'log("counter" in globals())' }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ data: { logs: ['False'] } });
    await released!.close();
    await provider.dispose();
  });

  it('does not recreate a released or disposed Session after an asynchronous support probe', async () => {
    const runtimeExecutable = await fakeRuntime();
    const support = {
      available: true,
      reasonCode: null,
      platform: 'linux',
      backend: 'PYAUTOGUI',
      runtimeExecutable,
      supportsScreenshot: true,
      supportsInput: true,
      supportsUnicodePaste: true,
      supportsPrimaryDisplay: true
    } as const;
    let resolveReleaseProbe: ((value: typeof support) => void) | undefined;
    const releaseProvider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      {
        probe: () =>
          new Promise((resolve) => {
            resolveReleaseProbe = resolve;
          })
      }
    );
    const releasedBinding = releaseProvider.bind({
      runId: 'run-a',
      sessionId: 'session-a',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await releaseProvider.releaseSession('session-a');
    resolveReleaseProbe!(support);
    await expect(releasedBinding).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE' });
    await releaseProvider.dispose();

    let resolveDisposeProbe: ((value: typeof support) => void) | undefined;
    const disposedProvider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      {
        probe: () =>
          new Promise((resolve) => {
            resolveDisposeProbe = resolve;
          })
      }
    );
    const disposedBinding = disposedProvider.bind({
      runId: 'run-b',
      sessionId: 'session-b',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    await disposedProvider.dispose();
    resolveDisposeProbe!(support);
    await expect(disposedBinding).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE' });
  });
});
