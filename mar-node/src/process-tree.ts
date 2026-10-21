import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export type ProcessTreeCommand = (
  file: string,
  args: readonly string[],
  options: { readonly windowsHide: boolean }
) => Promise<unknown>;

export interface ManagedProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Kills the process group on Unix and the complete task tree on Windows. */
export async function terminateProcessTree(
  child: ManagedProcess,
  platform: NodeJS.Platform = process.platform,
  runCommand: ProcessTreeCommand = executeFile
): Promise<void> {
  if (child.pid === undefined) return;
  if (platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
