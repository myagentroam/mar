import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { terminateProcessTree } from '../process-tree.js';
import type { ComputerUseConfiguration, ComputerUseSupport } from './contracts.js';
import { PYTHON_PROBE_SOURCE } from './probe-source.js';

export async function probeComputerUse(
  configuration: ComputerUseConfiguration
): Promise<ComputerUseSupport> {
  const platform = platformName();
  const base = {
    platform,
    backend: 'PYAUTOGUI' as const,
    runtimeExecutable: configuration.runtimeExecutable,
    supportsScreenshot: false,
    supportsInput: false,
    supportsUnicodePaste: false,
    supportsPrimaryDisplay: false
  };
  if (!configuration.enabled)
    return { ...base, available: false, reasonCode: 'COMPUTER_USE_DISABLED' };
  if (process.platform === 'linux' && (!process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']))
    return { ...base, available: false, reasonCode: 'COMPUTER_DESKTOP_UNSUPPORTED' };
  try {
    await access(configuration.runtimeExecutable);
    const result = await runProbe(configuration.runtimeExecutable);
    if (result === undefined)
      return { ...base, available: false, reasonCode: 'COMPUTER_RUNTIME_UNAVAILABLE' };
    return { ...base, ...result, available: result.reasonCode === null };
  } catch {
    return { ...base, available: false, reasonCode: 'COMPUTER_RUNTIME_UNAVAILABLE' };
  }
}

type ProbeResult = Pick<
  ComputerUseSupport,
  | 'reasonCode'
  | 'supportsScreenshot'
  | 'supportsInput'
  | 'supportsUnicodePaste'
  | 'supportsPrimaryDisplay'
>;

async function runProbe(executable: string): Promise<ProbeResult | undefined> {
  const child = spawn(executable, ['-c', PYTHON_PROBE_SOURCE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let overflow = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > 4096) overflow = true;
    if (!overflow) stdout += chunk.toString('utf8');
  });
  child.stderr.resume();
  return await new Promise<ProbeResult | undefined>((resolveProbe) => {
    const timeout = setTimeout(() => {
      void terminateProcessTree(child).finally(() => resolveProbe(undefined));
    }, 10_000);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || overflow) return resolveProbe(undefined);
      try {
        const value = JSON.parse(stdout) as ProbeResult;
        if (
          value === null ||
          typeof value !== 'object' ||
          typeof value.supportsScreenshot !== 'boolean' ||
          typeof value.supportsInput !== 'boolean' ||
          typeof value.supportsUnicodePaste !== 'boolean' ||
          typeof value.supportsPrimaryDisplay !== 'boolean'
        )
          return resolveProbe(undefined);
        const reasonCode =
          value.reasonCode === 'COMPUTER_DESKTOP_UNSUPPORTED'
            ? value.reasonCode
            : !value.supportsScreenshot || !value.supportsPrimaryDisplay
              ? 'COMPUTER_RUNTIME_UNAVAILABLE'
              : !value.supportsInput
                ? 'COMPUTER_INPUT_PERMISSION_DENIED'
                : !value.supportsUnicodePaste
                  ? 'COMPUTER_RUNTIME_UNAVAILABLE'
                  : null;
        resolveProbe({
          supportsScreenshot: value.supportsScreenshot,
          supportsInput: value.supportsInput,
          supportsUnicodePaste: value.supportsUnicodePaste,
          supportsPrimaryDisplay: value.supportsPrimaryDisplay,
          reasonCode
        });
      } catch {
        resolveProbe(undefined);
      }
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolveProbe(undefined);
    });
  });
}

function platformName(): ComputerUseSupport['platform'] {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}
