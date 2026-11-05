import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PyAutoGuiComputerUseProvider,
  computerUseToolDefinition
} from '../../src/runner/mar-agent/computer-use.js';
import { ComputerUseDesktopLeaseService } from '../../src/computer-use/session.js';
import { probeComputerUse } from '../../src/computer-use/probe.js';
import { ComputerUseControlIndicator } from '../../src/computer-use/indicator.js';
import { PythonWorker } from '../../src/computer-use/worker.js';

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
  it('closes the worker when startup ownership handoff fails', async () => {
    const runtimeExecutable = await fakeRuntime();
    let worker: PythonWorker | undefined;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await expect(
        PythonWorker.start(runtimeExecutable, (started) => {
          worker = started;
          close = vi.spyOn(started, 'close');
          throw new Error('handoff failed');
        })
      ).rejects.toThrow('handoff failed');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await worker?.close();
    }
  });

  it('retains indicator startup and cleanup failures in a stable cleanup error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-indicator-failure-test-'));
    roots.push(root);
    const marker = join(root, 'indicator-directory');
    const executable = join(root, 'indicator-start-failure');
    await writeFile(
      executable,
      `#!/bin/sh\ndir=$(dirname "$2")\nprintf '%s' "$dir" > ${JSON.stringify(marker)}\nchmod 500 "$dir"\nexit 7\n`,
      { mode: 0o700 }
    );
    try {
      let failure: unknown;
      try {
        await ComputerUseControlIndicator.show(executable);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
      const cause = (failure as Error).cause as AggregateError;
      expect(cause).toBeInstanceOf(AggregateError);
      expect(cause.errors[0]).toEqual(
        expect.objectContaining({ message: expect.stringContaining('exited during startup') })
      );
      expect(cause.errors[1]).toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
    } finally {
      const directory = await readFile(marker, 'utf8').catch(() => '');
      if (directory.startsWith(join(tmpdir(), 'mar-computer-use-indicator-'))) {
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

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

  it('ignores non-object JSON lines from the worker without crashing the Node', async () => {
    const runtimeExecutable = await fakeRuntime();
    const provider = new PyAutoGuiComputerUseProvider({ enabled: true, runtimeExecutable });
    const binding = (await provider.bind({
      runId: 'invalid-lines',
      sessionId: 'invalid-lines',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    }))!;
    try {
      const result = await binding.call(
        {
          callId: 'invalid-lines',
          name: 'mcp__mar_computer__exec',
          arguments: {
            code: 'import sys; sys.__stdout__.write("null\\n0\\n\\"text\\"\\n[]\\n"); sys.__stdout__.flush(); log("ok")'
          }
        },
        new AbortController().signal
      );
      expect(result.data).toMatchObject({ outcome: 'SUCCEEDED', logs: ['ok'] });
    } finally {
      await binding.close();
      await provider.dispose();
    }
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

  it('keeps the lease until a closing binding finishes indicator preparation and cleanup', async () => {
    const runtimeExecutable = await fakeRuntime();
    const lease = new ComputerUseDesktopLeaseService();
    let releaseIndicator!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseIndicator = resolve;
    });
    const closeIndicator = vi.fn(async () => undefined);
    const showControlIndicator = vi.fn(async () => {
      await ready;
      return { close: closeIndicator };
    });
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      { lease, showControlIndicator }
    );
    const binding = await provider.bind({
      runId: 'run-pending-indicator',
      sessionId: 'session-pending-indicator',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    const call = binding!.call(
      {
        callId: 'pending',
        name: 'mcp__mar_computer__exec',
        arguments: { code: 'log("must not run")' }
      },
      new AbortController().signal
    );
    const outcome = call.then(
      () => 'resolved',
      () => 'rejected'
    );
    await vi.waitFor(() => expect(showControlIndicator).toHaveBeenCalledOnce());
    let firstFinished = false;
    let secondFinished = false;
    const first = binding!.close().then(() => {
      firstFinished = true;
    });
    const second = binding!.close().then(() => {
      secondFinished = true;
    });
    try {
      await Promise.resolve();
      expect(firstFinished).toBe(false);
      expect(secondFinished).toBe(false);
      expect(lease.holder()?.runId).toBe('run-pending-indicator');
    } finally {
      releaseIndicator();
      await Promise.allSettled([first, second, outcome]);
      await provider.dispose();
    }
    expect(await outcome).toBe('rejected');
    expect(closeIndicator).toHaveBeenCalledOnce();
    expect(lease.holder()).toBeUndefined();
  });

  it('retains the lease and reports cleanup failure rather than permitting a new binding', async () => {
    const runtimeExecutable = await fakeRuntime();
    const lease = new ComputerUseDesktopLeaseService();
    const controller = new AbortController();
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      {
        lease,
        showControlIndicator: async () => {
          controller.abort();
          return {
            close: async () => {
              throw new Error('cleanup failed');
            }
          };
        }
      }
    );
    const input = {
      runId: 'cleanup-failure',
      sessionId: 'cleanup-failure-session',
      mode: 'run' as const,
      enabled: true,
      modelSupportsImages: true
    };
    const binding = (await provider.bind(input))!;
    await expect(
      binding.call(
        { callId: 'cleanup-failure', name: 'mcp__mar_computer__exec', arguments: { code: 'pass' } },
        controller.signal
      )
    ).rejects.toMatchObject({
      code: 'COMPUTER_UNAVAILABLE',
      message: expect.stringContaining('cleanup failed')
    });
    await expect(
      binding.call(
        { callId: 'after-failure', name: 'mcp__mar_computer__exec', arguments: { code: 'pass' } },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
    await expect(binding.close()).rejects.toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
    await expect(provider.reset()).rejects.toThrow('Computer Use cleanup failed');
    expect(lease.holder()?.runId).toBe('cleanup-failure');
    await expect(provider.bind({ ...input, runId: 'next' })).rejects.toMatchObject({
      code: 'COMPUTER_UNAVAILABLE'
    });
    await expect(provider.dispose()).rejects.toThrow('Computer Use cleanup failed');
  });

  it('retains successful execution when indicator cleanup fails and blocks the desktop', async () => {
    const runtimeExecutable = await fakeRuntime();
    const lease = new ComputerUseDesktopLeaseService();
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      {
        lease,
        showControlIndicator: async () => ({
          close: async () => {
            throw new Error('cleanup');
          }
        })
      }
    );
    const binding = await provider.bind({
      runId: 'success-cleanup',
      sessionId: 'success-cleanup',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    try {
      const result = await binding!.call(
        {
          callId: 'success-cleanup',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'log("completed")' }
        },
        new AbortController().signal
      );
      expect(result.data).toMatchObject({ outcome: 'SUCCEEDED', observationId: '' });
      expect(result.content).toContain('cleanup failed');
      await expect(binding!.close()).rejects.toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
      expect(lease.holder()?.runId).toBe('success-cleanup');
    } finally {
      await expect(provider.reset()).rejects.toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
    }
  });

  it('retains unknown outcome when post-send worker cleanup fails', async () => {
    const runtimeExecutable = await fakeRuntime();
    const wrapper = await readFile(runtimeExecutable, 'utf8');
    await writeFile(
      runtimeExecutable,
      wrapper.replace('#!/bin/sh\n', '#!/bin/sh\nif [ "$1" = "-c" ]; then exit 7; fi\n')
    );
    const directoryFile = join(dirname(runtimeExecutable), 'worker-directory');
    const lease = new ComputerUseDesktopLeaseService();
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      {
        lease,
        probe: async () => ({
          available: true,
          platform: 'linux',
          backend: 'PYAUTOGUI',
          runtimeExecutable,
          reasonCode: null,
          supportsScreenshot: true,
          supportsInput: true,
          supportsUnicodePaste: true,
          supportsPrimaryDisplay: true
        }),
        showControlIndicator: async () => ({ close: async () => undefined })
      }
    );
    const binding = await provider.bind({
      runId: 'worker-cleanup',
      sessionId: 'worker-cleanup',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    try {
      const code = `import os\nopen(${JSON.stringify(directoryFile)}, 'w').write(os.getcwd())\nraise RuntimeError('action failed')`;
      const result = await binding!.call(
        { callId: 'worker-cleanup', name: 'mcp__mar_computer__exec', arguments: { code } },
        new AbortController().signal
      );
      expect(result.data).toMatchObject({ outcome: 'OUTCOME_UNKNOWN', observationId: '' });
      expect(result.content).toContain('action failed');
      expect(result.content).toContain('cleanup failed');
      await expect(binding!.close()).rejects.toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
      expect(lease.holder()?.runId).toBe('worker-cleanup');
    } finally {
      try {
        await expect(provider.reset()).rejects.toMatchObject({ code: 'COMPUTER_CLEANUP_FAILED' });
      } finally {
        const directory = await readFile(directoryFile, 'utf8').catch(() => '');
        if (directory.startsWith(join(tmpdir(), 'mar-computer-use-')))
          await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('handles worker spawn failure without losing cleanup ownership', async () => {
    const runtimeExecutable = join(
      tmpdir(),
      `missing-computer-runtime-${Date.now()}-${Math.random()}`
    );
    const lease = new ComputerUseDesktopLeaseService();
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      {
        lease,
        probe: async () => ({
          available: true,
          platform: 'linux',
          backend: 'PYAUTOGUI',
          runtimeExecutable,
          supportsScreenshot: true,
          supportsInput: true,
          supportsUnicodePaste: true,
          supportsPrimaryDisplay: true,
          reasonCode: null
        }),
        showControlIndicator: async () => ({ close: async () => undefined })
      }
    );
    const binding = (await provider.bind({
      runId: 'spawn-failure',
      sessionId: 'spawn-failure',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    }))!;
    try {
      await expect(
        binding.call(
          { callId: 'spawn', name: 'mcp__mar_computer__exec', arguments: { code: 'pass' } },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: 'COMPUTER_WORKER_START_FAILED' });
    } finally {
      await binding.close();
      await provider.dispose();
    }
    expect(lease.holder()).toBeUndefined();
  });

  it('holds the desktop lease until the terminated worker actually exits', async () => {
    const runtimeExecutable = await fakeRuntime();
    const root = dirname(runtimeExecutable);
    const started = join(root, 'worker-started');
    const stopping = join(root, 'worker-stopping');
    const release = join(root, 'worker-release');
    const lease = new ComputerUseDesktopLeaseService();
    const provider = new PyAutoGuiComputerUseProvider(
      { enabled: true, runtimeExecutable },
      { lease, showControlIndicator: async () => ({ close: async () => undefined }) }
    );
    const binding = await provider.bind({
      runId: 'run-worker-exit',
      sessionId: 'session-worker-exit',
      mode: 'run',
      enabled: true,
      modelSupportsImages: true
    });
    const code = [
      'import signal, pathlib, time',
      `started = pathlib.Path(${JSON.stringify(started)})`,
      `stopping = pathlib.Path(${JSON.stringify(stopping)})`,
      `release = pathlib.Path(${JSON.stringify(release)})`,
      'def stop_handler(*args):',
      '    stopping.write_text("stopping")',
      '    while not release.exists(): time.sleep(0.01)',
      '    raise SystemExit()',
      'signal.signal(signal.SIGTERM, stop_handler)',
      'started.write_text("started")',
      'time.sleep(30)'
    ].join('\n');
    const call = binding!.call(
      { callId: 'pending-worker', name: 'mcp__mar_computer__exec', arguments: { code } },
      new AbortController().signal
    );
    const outcome = call.then(
      () => undefined,
      () => undefined
    );
    let closed = false;
    try {
      await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('started'));
      const closing = binding!.close().then(() => {
        closed = true;
      });
      await vi.waitFor(async () => expect(await readFile(stopping, 'utf8')).toBe('stopping'));
      await Promise.race([closing, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
      expect(closed).toBe(false);
      expect(lease.holder()?.runId).toBe('run-worker-exit');
      await writeFile(release, 'release');
      await closing;
      expect(lease.holder()).toBeUndefined();
    } finally {
      await writeFile(release, 'release');
      await outcome;
      await binding!.close();
      await provider.dispose();
    }
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
      first!.call(
        {
          callId: 'closed-binding',
          name: 'mcp__mar_computer__exec',
          arguments: { code: 'counter = 999' }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE' });
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
