import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Checks and signals only a process group created by the current Quick Start invocation. */
export function signalOwnedProcessGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function ownedGroupHasLiveProcesses(group: number): Promise<boolean> {
  try {
    process.kill(-group, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  let inaccessible = false;
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === group && fields[0] !== 'Z') return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inaccessible = true;
    }
  }
  return inaccessible;
}

export async function waitForOwnedGroupExit(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await ownedGroupHasLiveProcesses(group))) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return false;
}
