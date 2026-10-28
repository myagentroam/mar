import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Signal only the detached group created for this child; never signal the host's group. */
export function terminateSandboxChild(
  child: ChildProcessWithoutNullStreams,
  detached: boolean
): boolean {
  const pid = child.pid;
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 1 || pid === process.pid))
    return false;
  if (detached && pid !== undefined && pid > 1) {
    try {
      process.kill(-pid, 'SIGKILL');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        // Even if group termination failed, do not abandon a live direct child.
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // The false result reports the unconfirmed group and child termination.
          }
        }
        return false;
      }
      if (child.exitCode !== null || child.signalCode !== null) return true;
      // A spawn failure may not have created the detached group yet.
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return child.kill('SIGKILL');
}
