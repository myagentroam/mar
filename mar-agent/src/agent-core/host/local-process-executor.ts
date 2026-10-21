import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { prepareLocalShellProcess } from './local-shell.js';

export interface LocalProcessSpawnRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly shell?: boolean | string;
  /** Shell startup for exec only; native processes and workers omit this field. */
  readonly shellLogin?: boolean;
  readonly environment: NodeJS.ProcessEnv;
  /** Explicit per-start values take precedence over execution-bound Host environment. */
  readonly environmentOverrides?: Readonly<Record<string, string | undefined>>;
  readonly environmentKeys?: readonly string[];
  /** Trusted, bounded read-only worker assets; never supplied by model tool input. */
  readonly runtimeDirectories?: readonly string[];
  readonly detached: boolean;
  readonly owner?: {
    readonly sessionId: string;
    readonly executionId?: string;
    readonly operationId?: string;
    readonly ownerInstanceId?: string;
  };
  readonly signal?: AbortSignal;
}

export interface LocalProcessExecutor {
  spawn(request: LocalProcessSpawnRequest): Promise<ChildProcessWithoutNullStreams>;
}

/** Preserves the direct local execution behavior used by the CLI and normal Node Workbench. */
export const directLocalProcessExecutor: LocalProcessExecutor = {
  async spawn(request) {
    request = prepareLocalShellProcess(request);
    return spawn(request.command, [...(request.args ?? [])], {
      cwd: request.cwd,
      shell: request.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: request.detached,
      env: request.environment
    });
  }
};

export async function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    killer.once('error', () => {
      child.kill();
      resolve();
    });
    killer.once('exit', () => resolve());
  });
}
