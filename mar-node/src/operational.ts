import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { writeNodeLog } from './rotating-log.js';

const secretKey = /(?:password|credential|token|cookie|authorization|secret|api[_-]?key)/i;

export interface RunnerProbeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runRunnerProbe(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly logStderr?: boolean;
  }
): Promise<RunnerProbeResult> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      windowsHide: true,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status: number | null, reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (status !== 0)
        logNodeCommandFailure(basename(command), {
          ...(status === null ? {} : { exitCode: status }),
          ...(options.logStderr === false ? {} : { stderr }),
          ...(reason === undefined ? {} : { reason }),
          durationMs: Math.round(performance.now() - startedAt)
        });
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      finish(null, 'TIMEOUT');
      child.kill();
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value: string) => (stdout += value));
    child.stderr.on('data', (value: string) => (stderr += value));
    child.once('error', (error) =>
      finish(null, (error as NodeJS.ErrnoException).code ?? 'START_FAILED')
    );
    child.once('close', (status) => finish(status));
  });
}

export interface NodeMetricSnapshot {
  readonly connectionAttempts: number;
  readonly reconnects: number;
  readonly heartbeats: number;
  readonly runnerFailures: number;
}
export class NodeMetrics {
  private connectionAttempts = 0;
  private reconnects = 0;
  private heartbeats = 0;
  private runnerFailures = 0;
  connectedAttempt(): void {
    this.connectionAttempts += 1;
  }
  reconnectScheduled(): void {
    this.reconnects += 1;
  }
  heartbeatSent(): void {
    this.heartbeats += 1;
  }
  runnerFailed(): void {
    this.runnerFailures += 1;
  }
  snapshot(): NodeMetricSnapshot {
    return {
      connectionAttempts: this.connectionAttempts,
      reconnects: this.reconnects,
      heartbeats: this.heartbeats,
      runnerFailures: this.runnerFailures
    };
  }
}
export function redactLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        secretKey.test(key) ? '[REDACTED]' : redactLogValue(item)
      ])
    );
  return value;
}
export function minimalRunnerEnvironment(
  input: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const allowed = new Set([
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'TERM'
  ]);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key) && !secretKey.test(key) && typeof value === 'string') output[key] = value;
  }
  return output;
}

/** Windows npm CLIs are `.cmd` shims and require the controlled command processor path. */
export function platformCliCommand(command: string, platform = process.platform): string {
  if (platform !== 'win32' || /\.(?:cmd|exe|bat)$/i.test(command)) return command;
  return `${command}.cmd`;
}

/**
 * Runs only Node-owned CLI arguments through Windows' command processor so npm
 * `.cmd` shims work without enabling `shell: true` on the actual child process.
 */
export function platformCliInvocation(
  command: string,
  args: readonly string[],
  platform = process.platform,
  comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
): { readonly command: string; readonly args: readonly string[] } {
  const cliCommand = platformCliCommand(command, platform);
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(cliCommand))
    return { command: cliCommand, args };
  if (![cliCommand, ...args].every((value) => /^[A-Za-z0-9_@./:\\ -]+$/.test(value)))
    throw new Error('NODE_CLI_COMMAND_INVALID');
  return {
    command: comspec,
    args: [
      '/d',
      '/s',
      '/c',
      [cliCommand, ...args].map((value) => (value.includes(' ') ? `"${value}"` : value)).join(' ')
    ]
  };
}
export function nodeLog(event: string, fields: Record<string, unknown> = {}): void {
  const safeFields = redactLogValue(fields) as Record<string, unknown>;
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', component: 'mar-node', event, ...safeFields })}\n`;
  process.stdout.write(line);
  writeNodeLog(line);
}

/** Logs Node-owned subprocess failures without copying argv, stdout or environment values. */
export function logNodeCommandFailure(
  command: string,
  result: {
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly reason?: string;
    readonly durationMs?: number;
  }
): void {
  const details = result.stderr?.trim().slice(0, 1_000);
  nodeLog('node.command.failed', {
    command,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(details ? { errorDetails: details } : {})
  });
}
