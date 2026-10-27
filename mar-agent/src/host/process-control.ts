import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export async function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    killer.once('error', () => {
      child.kill();
      resolve();
    });
    killer.once('exit', () => resolve());
  });
}
