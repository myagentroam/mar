import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ pidFile: '' }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    closeSync(fd: number) {
      fs.closeSync(fd);
      if (!fault.pidFile) return;
      const pidFile = fault.pidFile;
      fault.pidFile = '';
      const until = Date.now() + 2_000;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(pidFile) && Date.now() < until) Atomics.wait(sleeper, 0, 0, 5);
      if (!fs.existsSync(pidFile)) throw new Error('fixture failed to start');
      // Let the shell leader exit while its descendant retains the inherited pipes.
      Atomics.wait(sleeper, 0, 0, 50);
      throw new Error('injected descriptor close failure');
    }
  };
});

import { launchBubblewrap } from '../../src/sandbox/linux/bubblewrap-launch.js';
import { terminateSandboxChild } from '../../src/sandbox/linux/sandbox-process.js';

const directories: string[] = [];
afterEach(async () => {
  fault.pidFile = '';
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it.skipIf(process.platform !== 'linux')(
  'reclaims a detached launch group and its inherited pipes when parent cleanup fails',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-launch-group-'));
    directories.push(directory);
    const path = join(directory, 'backend');
    const pidFile = join(directory, 'pid');
    await writeFile(path, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nexit 0\n`);
    await chmod(path, 0o700);
    fault.pidFile = pidFile;
    let pid: number | undefined;
    const alive = async () => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    try {
      const error = await launchBubblewrap({
        executable: path,
        arguments: [],
        command: [],
        seccomp: Buffer.alloc(8),
        detached: true
      }).catch((value: unknown) => value);
      pid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(pid).toBeGreaterThan(1);
      expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', details: { cleanup: ['close'] } });
      await vi.waitFor(async () => expect(await alive()).toBe(false), {
        timeout: 1_500,
        interval: 25
      });
    } finally {
      if (pid !== undefined && pid > 1 && (await alive())) process.kill(pid, 'SIGKILL');
    }
  },
  5_000
);

it('never signals a host process group for non-detached or invalid child identities', () => {
  const groupKill = vi.spyOn(process, 'kill');
  try {
    const kill = vi.fn(() => true);
    const child = {
      pid: 999999,
      exitCode: null,
      signalCode: null,
      kill
    } as unknown as ChildProcessWithoutNullStreams;
    expect(terminateSandboxChild(child, false)).toBe(true);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(groupKill).not.toHaveBeenCalled();
    const invalid = { ...child, pid: process.pid } as ChildProcessWithoutNullStreams;
    expect(terminateSandboxChild(invalid, true)).toBe(false);
    expect(groupKill).not.toHaveBeenCalled();
  } finally {
    groupKill.mockRestore();
  }
});

it('still attempts to terminate the direct child when group signaling is denied', () => {
  const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('private'), { code: 'EPERM' });
  });
  try {
    const kill = vi.fn(() => true);
    const child = {
      pid: 999999,
      exitCode: null,
      signalCode: null,
      kill
    } as unknown as ChildProcessWithoutNullStreams;
    expect(terminateSandboxChild(child, true)).toBe(false);
    expect(groupKill).toHaveBeenCalledWith(-999999, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  } finally {
    groupKill.mockRestore();
  }
});
