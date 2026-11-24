import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { chromiumProfileLock } from './browser-profile-lock.js';

const RUN_DIRECTORY = /^browser-[a-z\d]{6}$/iu;
const RETIRED_PREFIX = 'retired-';
const PROFILE_ENTRY = /^[a-f\d]{64}$/u;
const OWNER_FILE = 'profile-owner';
const TEMPORARY = 'temporary';

/** Records which Chromium singleton guards a run. Only a successful launch may
 * publish the record; an interrupted launch may not yet have taken its lock. */
export async function recordBrowserRun(run: string, profiles: string, profile?: string) {
  const owner = profile ? basename(dirname(profile)) : TEMPORARY;
  if (profile && (!PROFILE_ENTRY.test(owner) || profile !== join(profiles, owner, 'data')))
    throw new Error('BROWSER_RUN_PROFILE_INVALID');
  await writeFile(join(run, OWNER_FILE), `${owner}\n`, { mode: 0o600, flag: 'wx' });
}

/** Move only a run whose Chromium has exited. The new name keeps that proof
 * intact if recursive removal is interrupted after deleting the owner record. */
export async function retireBrowserRun(run: string): Promise<void> {
  const retired = join(dirname(run), `${RETIRED_PREFIX}${basename(run)}`);
  await rename(run, retired);
  await rm(retired, { recursive: true, force: true });
}

/** Called once before any new launch under the Node's exclusive data-directory
 * ownership. Never operates on durable profile contents or unproven old runs. */
export async function sweepBrowserRuns(
  runs: string,
  profiles: string,
  failed: (error: unknown) => void
): Promise<void> {
  const entries = await readdir(runs, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  );
  for (const entry of entries) {
    const retired = entry.name.startsWith(RETIRED_PREFIX);
    const name = retired ? entry.name.slice(RETIRED_PREFIX.length) : entry.name;
    if (!entry.isDirectory() || !RUN_DIRECTORY.test(name)) continue;
    try {
      const path = join(runs, entry.name);
      if (retired) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      const owner = await readOwner(join(path, OWNER_FILE));
      const profile =
        owner && owner !== TEMPORARY ? join(profiles, owner, 'data') : join(path, 'profile');
      if (!owner && !(await stat(profile))?.isDirectory()) continue;
      const lock = await chromiumProfileLock(profile);
      // A legacy temporary run is identifiable only when its own stale lock remains.
      if (lock === 'stale' || (owner && lock === 'missing')) await retireBrowserRun(path);
    } catch (error) {
      failed(error);
    }
  }
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readOwner(path: string): Promise<string | undefined> {
  const info = await stat(path);
  if (!info?.isFile() || info.size > 65) return;
  const value = await readFile(path, 'utf8');
  if (!value.endsWith('\n')) return;
  const owner = value.slice(0, -1);
  if (owner === TEMPORARY || PROFILE_ENTRY.test(owner)) return owner;
}
