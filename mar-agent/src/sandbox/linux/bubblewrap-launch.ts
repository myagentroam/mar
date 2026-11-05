import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentError } from '../../error.js';
import { unavailable, withCleanupDiagnostics } from './sandbox-error.js';
import { terminateSandboxChild } from './sandbox-process.js';

export interface LaunchSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly command: readonly string[];
  readonly seccomp: Buffer;
  readonly detached: boolean;
  readonly signal?: AbortSignal;
}

/** Owns startup files, descriptors and the child until successful handoff. */
export async function launchBubblewrap(spec: LaunchSpec): Promise<ChildProcessWithoutNullStreams> {
  spec.signal?.throwIfAborted();
  let directory: string | undefined;
  let argumentFd: number | undefined;
  let seccompFd: number | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let observedClose: Promise<void> | undefined;
  let detachObservers: (() => void) | undefined;
  let childExited = false;
  let childClosed = false;
  let childError = false;
  let failure: unknown;
  let failed = false;
  const cleanupFailures: ('close' | 'remove' | 'terminate' | 'exit_timeout')[] = [];
  try {
    directory = await mkdtemp(join(tmpdir(), 'mar-agent-bwrap-launch-'));
    const argumentPath = join(directory, 'arguments');
    const seccompPath = join(directory, 'seccomp.bpf');
    const writes = await Promise.allSettled([
      writeFile(argumentPath, `${spec.arguments.join('\0')}\0`, { mode: 0o600, flag: 'wx' }),
      writeFile(seccompPath, spec.seccomp, { mode: 0o600, flag: 'wx' })
    ]);
    const rejected = writes.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    spec.signal?.throwIfAborted();
    argumentFd = openSync(argumentPath, 'r');
    seccompFd = openSync(seccompPath, 'r');
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
    spec.signal?.throwIfAborted();
    const spawnedChild = spawn(spec.executable, ['--args', '3', '--', ...spec.command], {
      cwd: '/',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', argumentFd, seccompFd],
      windowsHide: true,
      detached: spec.detached,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
    }) as ChildProcessWithoutNullStreams;
    child = spawnedChild;
    let resolveClose!: () => void;
    observedClose = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const exited = () => {
      childExited = true;
    };
    const closed = () => {
      childExited = true;
      childClosed = true;
      resolveClose();
    };
    // Keep an error listener until ownership transfers, including after a spawn error.
    const ignoreError = () => {
      childError = true;
    };
    child.once('exit', exited);
    child.once('close', closed);
    child.on('error', ignoreError);
    detachObservers = () => {
      spawnedChild.off('exit', exited);
      spawnedChild.off('close', closed);
      spawnedChild.off('error', ignoreError);
    };
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        spawnedChild.off('spawn', onSpawn);
        spawnedChild.off('error', onError);
        spawnedChild.off('exit', onExit);
        spawnedChild.off('close', onExit);
        spec.signal?.removeEventListener('abort', onAbort);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(unavailable());
      };
      const onExit = () => {
        cleanup();
        reject(unavailable());
      };
      const onAbort = () => {
        cleanup();
        reject(spec.signal?.reason);
      };
      spawnedChild.once('spawn', onSpawn);
      spawnedChild.once('error', onError);
      spawnedChild.once('exit', onExit);
      spawnedChild.once('close', onExit);
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      if (spec.signal?.aborted) onAbort();
    });
    spec.signal?.throwIfAborted();
    if (childExited || childError || child.exitCode !== null || child.signalCode !== null)
      throw unavailable();
  } catch {
    failed = true;
    failure = spec.signal?.aborted ? spec.signal.reason : unavailable();
  }

  for (const fd of [argumentFd, seccompFd]) {
    if (fd === undefined) continue;
    try {
      closeSync(fd);
    } catch {
      cleanupFailures.push('close');
    }
  }
  if (directory !== undefined) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      cleanupFailures.push('remove');
    }
  }
  if (!failed && spec.signal?.aborted) {
    failed = true;
    failure = spec.signal.reason;
  }
  if (!failed && (childExited || childError)) {
    failed = true;
    failure = unavailable();
  }
  if (!failed && cleanupFailures.length > 0) {
    failed = true;
    failure = unavailable();
  }
  if (failed) {
    try {
      if (child !== undefined) {
        // A non-detached child shares the caller's group, which we must not signal.
        // Direct child termination cannot establish that its descendants exited.
        if (!spec.detached) cleanupFailures.push('terminate');
        try {
          if (!terminateSandboxChild(child, spec.detached)) cleanupFailures.push('terminate');
        } catch {
          cleanupFailures.push('terminate');
        }
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try {
            stream.destroy();
          } catch {
            cleanupFailures.push('close');
          }
        }
        if (!childClosed && observedClose !== undefined) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const exited = await Promise.race([
            observedClose.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), 1_000);
            })
          ]);
          if (timer !== undefined) clearTimeout(timer);
          if (!exited) {
            cleanupFailures.push('exit_timeout');
            try {
              child.unref();
            } catch {
              cleanupFailures.push('terminate');
            }
          }
        }
      }
    } finally {
      detachObservers?.();
      // A process that could not be confirmed dead may still emit an error after return.
      if (child !== undefined && !childClosed) child.on('error', () => {});
    }
    if (spec.signal?.aborted && failure === spec.signal.reason) throw failure;
    if (failure instanceof AgentError) throw withCleanupDiagnostics(failure, cleanupFailures);
    throw failure;
  }
  detachObservers?.();
  return child!;
}
