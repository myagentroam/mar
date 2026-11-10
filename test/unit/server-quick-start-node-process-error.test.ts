import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createQuickStartConfig } from '../../mar-server/src/quick-start/config.js';
import { startLocalNode } from '../../mar-server/src/quick-start/node-runtime.js';

const tracked = vi.hoisted(() => ({ child: undefined as ChildProcess | undefined }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof realSpawn>) => {
      const child = actual.spawn(...args);
      tracked.child = child;
      return child;
    }
  };
});

describe('Quick Start Supervisor process errors', () => {
  it('does not infer exit from an error emitted by a live owned process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-node-process-error-'));
    const entrypoint = join(root, 'supervisor.cjs');
    await writeFile(
      entrypoint,
      "process.on('message', () => process.exit(0)); setInterval(() => {}, 1000);"
    );
    const config = createQuickStartConfig({
      serverPort: 41121,
      mysqlPort: 41122,
      node: true,
      search: 'disabled'
    });
    const node = await startLocalNode(
      root,
      config,
      { issue: async () => ({ token: 'fixture' }), online: () => false },
      1000,
      200,
      async () => entrypoint
    );
    const child = tracked.child!;
    const actualExit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      expect(child.pid).toBeDefined();
      child.emit('error', new Error('fixture: kill failed'));
      child.emit('error', new Error('fixture: repeated kill failure'));
      const ended = await Promise.race([
        node.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))
      ]);
      expect(ended).toBe(false);
      await node.stop();
      await actualExit;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await actualExit;
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it.skipIf(process.platform !== 'linux')(
    'reports unreclaimed ownership when the live Supervisor cannot be killed after an error',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'mar-node-reclaim-error-'));
      const entrypoint = join(root, 'supervisor.cjs');
      await writeFile(entrypoint, "process.on('message', () => {}); setInterval(() => {}, 1000);");
      const config = createQuickStartConfig({
        serverPort: 41123,
        mysqlPort: 41124,
        node: true,
        search: 'disabled'
      });
      const node = await startLocalNode(
        root,
        config,
        { issue: async () => ({ token: 'fixture' }), online: () => false },
        100,
        200,
        async () => entrypoint
      );
      const child = tracked.child!;
      const actualExit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const kill = process.kill.bind(process);
      const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === child.pid && signal === 'SIGKILL')
          throw Object.assign(new Error('fixture'), { code: 'EPERM' });
        return kill(pid, signal);
      });
      try {
        child.emit('error', new Error('fixture: kill failed'));
        await expect(node.stop()).rejects.toThrow('QUICK_START_NODE_RECLAIM_FAILED');
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
      } finally {
        spy.mockRestore();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await actualExit;
        await rm(root, { recursive: true, force: true });
      }
    },
    10000
  );
});
