import { readdir, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** Interprets Chromium's singleton without opening a profile or signaling a process. */
export async function chromiumProfileLock(path: string): Promise<'missing' | 'live' | 'stale'> {
  try {
    if (process.platform === 'win32') {
      // Chromium holds the lockfile with DELETE_ON_CLOSE.
      return (await readdir(path)).some((name) => name.toLowerCase() === 'lockfile')
        ? 'live'
        : 'missing';
    }
    const lock = await readlink(join(path, 'SingletonLock'));
    const prefix = `${hostname()}-`;
    const pid = Number(lock.slice(prefix.length));
    if (!lock.startsWith(prefix) || !Number.isSafeInteger(pid) || pid <= 0) return 'live';
    try {
      process.kill(pid, 0);
      return 'live';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale' : 'live';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}
