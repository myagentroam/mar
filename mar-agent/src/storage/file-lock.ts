import { open, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentError } from '../error.js';

export async function acquireFileLock(
  path: string,
  message = 'Session index is busy.',
  waitMs = 5000,
  options: { readonly signal?: AbortSignal; readonly code?: string } = {}
): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    options.signal?.throwIfAborted();
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      if (await removeDeadOwner(path)) continue;
      if (Date.now() >= deadline)
        throw new AgentError(options.code ?? 'MAR_AGENT_SESSION_LOCKED', message, { cause });
      await delay(
        25 + Math.floor(Math.random() * 25),
        undefined,
        options.signal ? { signal: options.signal } : {}
      );
      continue;
    }
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
      );
      options.signal?.throwIfAborted();
    } catch (error) {
      try {
        await handle.close();
      } finally {
        await rm(path, { force: true });
      }
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await handle.close();
      await rm(path, { force: true });
    };
  }
}

async function removeDeadOwner(path: string): Promise<boolean> {
  const reclaimerPath = `${path}.reclaim`;
  let reclaimer;
  try {
    // Only one process may unlink a dead owner's path; all other contenders wait.
    reclaimer = await open(reclaimerPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
    if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid)) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      await rm(path, { force: true });
      return true;
    }
  } catch {
    return false;
  } finally {
    try {
      await reclaimer.close();
    } finally {
      await rm(reclaimerPath, { force: true });
    }
  }
}
