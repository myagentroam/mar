import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname } from 'node:path';
import { resolveWorkspaceFileManagerTarget } from './files.js';

interface FileManagerTarget {
  readonly path: string;
  readonly kind: 'FILE' | 'DIRECTORY';
}
interface FileManagerInvocation {
  readonly command: string;
  readonly args: readonly string[];
}
interface Options {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess;
}

export function fileManagerInvocation(
  platform: NodeJS.Platform,
  target: FileManagerTarget
): FileManagerInvocation {
  if (platform === 'win32')
    return {
      command: 'explorer.exe',
      args: target.kind === 'FILE' ? ['/select,', target.path] : [target.path]
    };
  if (platform === 'darwin')
    return { command: 'open', args: target.kind === 'FILE' ? ['-R', target.path] : [target.path] };
  if (platform === 'linux')
    return {
      command: 'xdg-open',
      args: [target.kind === 'FILE' ? dirname(target.path) : target.path]
    };
  throw new Error('FILE_MANAGER_UNAVAILABLE');
}

export async function revealWorkspaceFileInFileManager(
  workspaceRoot: string,
  requestedPath: string,
  options: Options = {}
): Promise<{ readonly revealed: true }> {
  const target = await resolveWorkspaceFileManagerTarget(workspaceRoot, requestedPath);
  const platform = options.platform ?? process.platform;
  const invocation = fileManagerInvocation(platform, target);
  const spawnProcess = options.spawnProcess ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnProcess(invocation.command, invocation.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      if (platform === 'win32') child.once('spawn', () => resolve());
      else
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error('FILE_MANAGER_UNAVAILABLE'));
        });
    });
  } catch (error) {
    throw new Error('FILE_MANAGER_UNAVAILABLE', { cause: error });
  }
  child.unref();
  return { revealed: true };
}
