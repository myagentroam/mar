import { spawn } from 'node:child_process';
import {
  ownedGroupHasLiveProcesses,
  signalOwnedProcessGroup,
  waitForOwnedGroupExit
} from './owned-process-group.js';

/** Run one bounded preparation process tree without registering a service. */
export async function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  failureCode = 'QUICK_START_NODE_INSTALL_FAILED'
): Promise<void> {
  await runOwnedChild(command, args, env, signal, failureCode);
}

/** Capture only bounded listing output while retaining the same child ownership and cancellation. */
export async function runChildWithOutput(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  failureCode: string,
  maxBytes: number
): Promise<string> {
  return runOwnedChild(command, args, env, signal, failureCode, maxBytes);
}

async function runOwnedChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  failureCode: string,
  maxBytes?: number
): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', maxBytes === undefined ? 'ignore' : 'pipe', 'ignore'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
  let stopping = false;
  let reclaim: Promise<void> = Promise.resolve();
  let reclaimDeadline: NodeJS.Timeout | undefined;
  let failReclaim: () => void = () => {};
  const reclaimFailure = new Promise<never>((_, reject) => {
    failReclaim = () => reject(new Error('QUICK_START_NODE_RECLAIM_FAILED'));
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (!child.pid) return;
    reclaimDeadline = setTimeout(failReclaim, 15_000);
    reclaimDeadline.unref();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      reclaim = new Promise<void>((resolveReclaim, reject) => {
        killer.once('error', reject);
        killer.once('close', (code) =>
          code === 0 ? resolveReclaim() : reject(new Error('QUICK_START_NODE_RECLAIM_FAILED'))
        );
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reclaim = Promise.reject(error);
      }
    }
    // Attach a handler immediately; the result is checked before releasing the installation lock.
    void reclaim.catch(failReclaim);
  };
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (maxBytes !== undefined && outputBytes > maxBytes) stop();
    else chunks.push(chunk);
  });
  signal?.addEventListener('abort', stop, { once: true });
  const timeout = setTimeout(stop, 15 * 60_000);
  try {
    const result = await Promise.race([
      new Promise<number | null>((resolveResult, reject) => {
        child.on('error', () => {
          if (child.pid === undefined) reject(new Error(failureCode));
          else failReclaim();
        });
        child.once('close', resolveResult);
        if (signal?.aborted) stop();
      }),
      reclaimFailure
    ]);
    try {
      await Promise.race([reclaim, reclaimFailure]);
    } catch {
      throw new Error('QUICK_START_NODE_RECLAIM_FAILED');
    }
    let orphaned = false;
    if (process.platform === 'linux' && child.pid !== undefined) {
      try {
        orphaned = await ownedGroupHasLiveProcesses(child.pid);
        if (orphaned) {
          signalOwnedProcessGroup(child.pid, 'SIGKILL');
          if (!(await waitForOwnedGroupExit(child.pid, 15_000)))
            throw new Error('group still running');
        }
      } catch {
        throw new Error('QUICK_START_NODE_RECLAIM_FAILED');
      }
    }
    signal?.throwIfAborted();
    if (stopping || orphaned || result !== 0) throw new Error(failureCode);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timeout);
    if (reclaimDeadline) clearTimeout(reclaimDeadline);
    signal?.removeEventListener('abort', stop);
  }
}
