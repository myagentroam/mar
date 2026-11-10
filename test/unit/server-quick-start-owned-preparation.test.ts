import type { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runChild,
  runChildWithOutput
} from '../../mar-server/src/quick-start/owned-preparation.js';
import { ownedGroupHasLiveProcesses } from '../../mar-server/src/quick-start/owned-process-group.js';

const tracked = vi.hoisted(() => ({ child: undefined as ChildProcess | undefined }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof spawn>) => {
      const child = actual.spawn(...args);
      tracked.child = child;
      return child;
    }
  };
});

describe.skipIf(process.platform !== 'linux')('owned preparation process groups', () => {
  let root = '';
  let leader = 0;

  afterEach(async () => {
    if (leader) {
      try {
        process.kill(-leader, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
    leader = 0;
    root = '';
  });

  it('keeps handling errors from a live child after reporting reclamation failure', async () => {
    const outcome = runChild(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.env
    ).catch((error: unknown) => error);
    const child = tracked.child!;
    leader = child.pid!;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      expect(leader).toBeGreaterThan(1);
      child.emit('error', new Error('fixture: first live process error'));
      expect(await outcome).toMatchObject({ message: 'QUICK_START_NODE_RECLAIM_FAILED' });
      expect(process.kill(leader, 0)).toBe(true);
      expect(() =>
        child.emit('error', new Error('fixture: repeated live process error'))
      ).not.toThrow();
    } finally {
      process.kill(-leader, 'SIGKILL');
      await exited;
      leader = 0;
    }
  });

  it('bounds archive listing output and confirms the child has exited', async () => {
    root = await mkdtemp(join(tmpdir(), 'mar-owned-listing-'));
    const leaderFile = join(root, 'leader');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid)); process.stdout.write('x'.repeat(32768)); setInterval(() => {}, 1000);`;
    const result = await runChildWithOutput(
      process.execPath,
      ['-e', script],
      process.env,
      undefined,
      'QUICK_START_DOWNLOAD_INVALID',
      1024
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    leader = Number(await readFile(leaderFile, 'utf8'));
    expect(result).toMatchObject({ message: 'QUICK_START_DOWNLOAD_INVALID' });
    expect(await ownedGroupHasLiveProcesses(leader)).toBe(false);
    leader = 0;
  });

  it('reclaims workers left by an already exited leader and reports preparation failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'mar-owned-preparation-'));
    const leaderFile = join(root, 'leader');
    const workerFile = join(root, 'worker');
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid));
      const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(workerFile)}, String(worker.pid));
      worker.unref();
    `;
    const result = await runChild(process.execPath, ['-e', script], process.env).then(
      () => undefined,
      (error: unknown) => error
    );
    leader = Number(await readFile(leaderFile, 'utf8'));
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('QUICK_START_NODE_INSTALL_FAILED');
    expect(Number(await readFile(workerFile, 'utf8'))).toBeGreaterThan(1);
    expect(await ownedGroupHasLiveProcesses(leader)).toBe(false);
    leader = 0;
  });

  it('reports an unreclaimed process immediately when cancellation cannot signal it', async () => {
    root = await mkdtemp(join(tmpdir(), 'mar-owned-preparation-'));
    const leaderFile = join(root, 'leader');
    const controller = new AbortController();
    const script = `require('node:fs').writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const result = runChild(process.execPath, ['-e', script], process.env, controller.signal).then(
      () => undefined,
      (error: unknown) => error
    );
    for (let i = 0; i < 100 && !leader; i++) {
      try {
        leader = Number(await readFile(leaderFile, 'utf8'));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(leader).toBeGreaterThan(1);
    const kill = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -leader && signal === 'SIGKILL')
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    try {
      controller.abort();
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('QUICK_START_NODE_RECLAIM_FAILED');
      expect(await ownedGroupHasLiveProcesses(leader)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
