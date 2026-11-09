import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Reaps the native PTY tree without entering the potentially blocked addon. */
export async function terminatePtyTree(pid) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      await execute('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 2_000
      });
    } catch (error) {
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if (probe.code === 'ESRCH') return;
        throw probe;
      }
      throw error;
    }
    return;
  }
  // Foreground jobs can have a different group from their shell, on both POSIX platforms.
  const { stdout } = await execute('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 1_000 });
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const tree = [pid];
  const seen = new Set(tree);
  for (let index = 0; index < tree.length; index++) {
    for (const [child, parent] of rows) {
      if (parent === tree[index] && !seen.has(child)) {
        tree.push(child);
        seen.add(child);
      }
    }
  }
  for (const target of tree.reverse()) {
    try {
      process.kill(target, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
