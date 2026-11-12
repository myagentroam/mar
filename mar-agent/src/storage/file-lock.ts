import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentError } from '../error.js';

/** Own one nonempty lock directory; stale cleanup never removes another incarnation's owner. */
export async function acquireFileLock(
  path: string,
  message = 'Session index is busy.',
  waitMs = 5000,
  options: { readonly signal?: AbortSignal; readonly code?: string } = {}
): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  options.signal?.throwIfAborted();
  const pending = await mkdtemp(`${path}.pending-`);
  const owner = randomUUID();
  let published = false;
  try {
    await writeFile(
      join(pending, owner),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      { mode: 0o600 }
    );
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        // Publishing a nonempty directory cannot replace another owner's nonempty directory.
        await rename(pending, path);
        published = true;
        break;
      } catch (cause) {
        if (
          !['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM'].includes(
            (cause as NodeJS.ErrnoException).code ?? ''
          )
        )
          throw cause;
        if (await removeDeadOwner(path)) continue;
        if (Date.now() >= deadline)
          throw new AgentError(options.code ?? 'MAR_AGENT_SESSION_LOCKED', message, { cause });
      }
      await delay(
        25 + Math.floor(Math.random() * 25),
        undefined,
        options.signal ? { signal: options.signal } : {}
      );
    }
    try {
      options.signal?.throwIfAborted();
    } catch (error) {
      await removeOwner(path, owner).catch(() => undefined);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await removeOwner(path, owner);
    };
  } finally {
    // An unpublished candidate only reaches here on failure; cleanup must preserve that error.
    if (!published) await rm(pending, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeDeadOwner(path: string): Promise<boolean> {
  let owners: string[];
  try {
    owners = await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
  if (owners.length === 0) return removeEmptyDirectory(path);
  if (owners.length !== 1) return false;
  const owner = owners[0]!;
  try {
    const metadata = JSON.parse(await readFile(join(path, owner), 'utf8')) as { pid?: unknown };
    if (
      typeof metadata.pid !== 'number' ||
      !Number.isSafeInteger(metadata.pid) ||
      metadata.pid <= 0
    )
      return false;
    try {
      process.kill(metadata.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
  } catch {
    return false;
  }
  return removeOwner(path, owner);
}

/** Remove only this incarnation's owner; rmdir cannot remove a newly published nonempty lock. */
async function removeOwner(path: string, owner: string): Promise<boolean> {
  try {
    await unlink(join(path, owner));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return removeEmptyDirectory(path);
}

async function removeEmptyDirectory(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
}
