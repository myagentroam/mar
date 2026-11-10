import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQuickStartConfig } from '../../mar-server/src/quick-start/config.js';
import { acquireQuickStartLock } from '../../mar-server/src/quick-start/lock.js';
import { startLocalNode } from '../../mar-server/src/quick-start/node-runtime.js';
import { serverNodeEntrypoint } from '../../mar-server/src/quick-start/node-dependency.js';

vi.mock('../../mar-server/src/quick-start/node-dependency.js', () => ({
  serverNodeEntrypoint: vi.fn()
}));

function useFixture(root: string): void {
  vi.mocked(serverNodeEntrypoint).mockResolvedValue(
    join(root, 'components/node/node_modules/@myagentroam/node/dist/main.js')
  );
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Quick Start Node lifecycle', () => {
  it('does not treat an unsuccessful Supervisor exit as reclaiming its still-running Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-quick-node-failed-stop-'));
    directories.push(root);
    useFixture(root);
    const installation = {
      version: '0.13.4',
      directory: 'components/node',
      platform: process.platform,
      arch: process.arch,
      nodeAbi: process.versions.modules
    };
    const target = join(root, installation.directory, 'node_modules/@myagentroam/node/dist');
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, 'main.js'),
      `
      const fs = require('node:fs'); const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true, stdio:'ignore'});
      process.send({type:'node-quick-start-child',pid:child.pid});
      fs.writeFileSync(${JSON.stringify(join(root, 'node-pid'))}, String(child.pid));
      process.on('message', () => process.exit(1)); setInterval(() => {}, 1000);
    `
    );
    const config = {
      ...createQuickStartConfig({
        serverPort: 41001,
        mysqlPort: 41002,
        node: true,
        search: 'disabled'
      }),
      node: { enabled: true }
    };
    const node = await startLocalNode(
      root,
      config,
      { issue: async () => ({ token: 'token' }), online: () => false },
      1000,
      200
    );
    let pid: number | undefined;
    try {
      for (let i = 0; i < 100 && pid === undefined; i++) {
        try {
          pid = Number(await readFile(join(root, 'node-pid'), 'utf8'));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(pid).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(node.stop()).rejects.toThrow('QUICK_START_NODE_RECLAIM_FAILED');
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }, 10000);
  it('reports reclaim failure when a reported owned process remains alive after Supervisor termination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-quick-node-unreaped-'));
    directories.push(root);
    useFixture(root);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    });
    const otherExit = new Promise<void>((resolve) => other.once('exit', () => resolve()));
    try {
      const installation = {
        version: '0.13.4',
        directory: 'components/node',
        platform: process.platform,
        arch: process.arch,
        nodeAbi: process.versions.modules
      };
      const target = join(root, installation.directory, 'node_modules/@myagentroam/node/dist');
      await mkdir(target, { recursive: true });
      await writeFile(
        join(target, 'main.js'),
        `
        const fs = require('node:fs');
        process.send({type:'node-quick-start-child',pid:${other.pid}});
        fs.writeFileSync(${JSON.stringify(join(root, 'reported'))}, 'yes');
        process.on('message', () => {}); setInterval(() => {}, 1000);
      `
      );
      const config = {
        ...createQuickStartConfig({
          serverPort: 41001,
          mysqlPort: 41002,
          node: true,
          search: 'disabled'
        }),
        node: { enabled: true }
      };
      const node = await startLocalNode(
        root,
        config,
        { issue: async () => ({ token: 'token' }), online: () => false },
        100,
        200
      );
      for (let i = 0; i < 100; i++) {
        try {
          await readFile(join(root, 'reported'));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(node.stop()).rejects.toThrow('QUICK_START_NODE_RECLAIM_FAILED');
    } finally {
      other.kill('SIGKILL');
      await otherExit;
    }
  }, 10000);
  it('registers once, saves identity and stops its Supervisor through IPC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-quick-node-runtime-'));
    directories.push(root);
    useFixture(root);
    const installation = {
      version: '0.13.4',
      directory: 'components/node',
      platform: process.platform,
      arch: process.arch,
      nodeAbi: process.versions.modules
    };
    const entry = join(root, installation.directory, 'node_modules/@myagentroam/node/dist');
    await mkdir(entry, { recursive: true });
    await writeFile(
      join(entry, 'main.js'),
      `
      const fs = require('node:fs');
      const path = process.argv[process.argv.indexOf('--config') + 1];
      const config = JSON.parse(fs.readFileSync(path));
      config.nodeId = 'local-node'; config.credential = 'fixture-credential'; delete config.registrationToken;
      fs.writeFileSync(path, JSON.stringify(config));
      process.on('message', message => { if (message.type === 'node-quick-start-stop') process.exit(0); });
    `
    );
    const config = {
      ...createQuickStartConfig({
        serverPort: 41001,
        mysqlPort: 41002,
        node: true,
        search: 'disabled'
      }),
      node: { enabled: true }
    };
    let issued = 0;
    const bootstrap = {
      issue: async () => {
        issued++;
        return { token: 'fixture-token' };
      },
      online: (id: string) => id === 'local-node'
    };
    const signal = new Promise<void>(() => {});
    for (let i = 0; i < 2; i++) {
      const child = await startLocalNode(
        root,
        { ...config, serverPort: 41001 + i * 100 },
        bootstrap
      );
      try {
        expect(await child.online(signal)).toBe(true);
      } finally {
        await child.stop();
      }
      if (i === 0) {
        const path = join(root, 'node-data/node.json');
        const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        saved.allowedRoots = [join(root, 'first-project'), join(root, 'second-project')];
        await writeFile(path, JSON.stringify(saved));
      }
    }
    expect(issued).toBe(1);
    const saved = JSON.parse(await readFile(join(root, 'node-data/node.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(saved.nodeId).toBe('local-node');
    expect(saved.credential).toBe('fixture-credential');
    expect(saved.serverUrl).toBe('http://127.0.0.1:41101');
    expect(saved.registrationToken).toBeUndefined();
    expect(saved.conversationHosting).toEqual({ enabled: false });
    expect(saved.allowedRoots).toEqual([join(root, 'first-project'), join(root, 'second-project')]);
  });

  it('reclaims an unresponsive Supervisor and detached child before the lock is released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-quick-node-stuck-'));
    directories.push(root);
    useFixture(root);
    const installation = {
      version: '0.13.4',
      directory: 'components/node',
      platform: process.platform,
      arch: process.arch,
      nodeAbi: process.versions.modules
    };
    const entry = join(root, installation.directory, 'node_modules/@myagentroam/node/dist');
    await mkdir(entry, { recursive: true });
    await writeFile(
      join(entry, 'main.js'),
      `
      const fs = require('node:fs'); const {spawn} = require('node:child_process');
      const {dirname,join} = require('node:path');
      const config = process.argv[process.argv.indexOf('--config') + 1];
      const root = dirname(dirname(config));
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
      process.send({type:'node-quick-start-child',pid:child.pid});
      fs.writeFileSync(join(root, 'pids'), JSON.stringify({supervisor: process.pid, child: child.pid}));
      process.on('message', () => {}); setInterval(() => {}, 1000);
    `
    );
    const config = {
      ...createQuickStartConfig({
        serverPort: 41001,
        mysqlPort: 41002,
        node: true,
        search: 'disabled'
      }),
      node: { enabled: true }
    };
    const release = await acquireQuickStartLock(root);
    const child = await startLocalNode(
      root,
      config,
      { issue: async () => ({ token: 'fixture-token' }), online: () => false },
      200
    );
    try {
      let pids: { supervisor: number; child: number } | undefined;
      for (let i = 0; i < 100 && !pids; i++) {
        try {
          pids = JSON.parse(await readFile(join(root, 'pids'), 'utf8'));
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      expect(pids).toBeDefined();
      const stopping = child.stop();
      await expect(acquireQuickStartLock(root)).rejects.toThrow('QUICK_START_IN_USE');
      await expect(stopping).rejects.toThrow('QUICK_START_NODE_STOP_TIMEOUT');
      for (const pid of [pids!.supervisor, pids!.child]) {
        let alive = true;
        for (let i = 0; i < 100 && alive; i++) {
          try {
            if (process.platform === 'linux') {
              const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
              alive = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
            } else process.kill(pid, 0);
          } catch {
            alive = false;
          }
          if (alive) await new Promise((r) => setTimeout(r, 25));
        }
        expect(alive).toBe(false);
      }
    } finally {
      await release();
    }
  }, 10_000);
});
