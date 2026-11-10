import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { authPlugins } from 'mysql2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQuickStartConfig } from '../../mar-server/src/quick-start/config.js';
import {
  initializeManagedMysql,
  startManagedMysql,
  waitForMysql
} from '../../mar-server/src/quick-start/mysql-runtime.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn()
}));
vi.mock('mysql2/promise', () => ({ default: { createConnection: vi.fn() } }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Quick Start Windows MySQL runtime contract', () => {
  it('uses a private pipe and SQL shutdown without installing a service or signaling the process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-mysql-win-contract-'));
    roots.push(root);
    const base = createQuickStartConfig({
      serverPort: 41001,
      mysqlPort: 41002,
      node: false,
      search: 'disabled'
    });
    const config = {
      ...base,
      mysql: {
        ...base.mysql,
        installation: {
          version: '8.4.7',
          platform: 'win32',
          arch: 'x64',
          directory: 'components/mysql',
          libraryVersion: 'builtin',
          libraryDirectory: 'components/mysql/bin'
        }
      }
    };
    await mkdir(join(root, 'mysql-data'));
    await writeFile(join(root, 'mysql-data.owner'), `${config.deploymentId}\n`);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const query = vi.fn(async () => {
      queueMicrotask(() => child.emit('exit', 0, null));
    });
    vi.mocked(mysql.createConnection).mockResolvedValue({ query, destroy: vi.fn() } as never);
    const plugin = vi.spyOn(authPlugins, 'caching_sha2_password');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const running = await startManagedMysql(root, config, { socketOnly: true });
    const [binary, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(binary).toMatch(/mysqld\.exe$/u);
    expect(args).toContain('--mysqlx=0');
    expect(args).toContain('--no-monitor');
    expect(args).toContain('--enable-named-pipe');
    expect(args).toContain('--skip-networking');
    expect(args).not.toContain('--install');
    expect(running.socket).toMatch(/^\\\\\.\\pipe\\mar-mysql-[0-9a-f]{32}$/u);
    expect(options?.env?.LD_LIBRARY_PATH).toBe(process.env.LD_LIBRARY_PATH);
    await running.stop();
    expect(plugin).toHaveBeenCalledWith({ overrideIsSecure: false });
    expect(vi.mocked(mysql.createConnection).mock.calls[0]?.[0]).toMatchObject({
      authPlugins: { caching_sha2_password: expect.any(Function) }
    });
    expect(query).toHaveBeenCalledWith('SHUTDOWN');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports forced shutdown as failure when the SQL shutdown connection is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-mysql-win-forced-'));
    roots.push(root);
    const base = createQuickStartConfig({
      serverPort: 41001,
      mysqlPort: 41002,
      node: false,
      search: 'disabled'
    });
    const config = {
      ...base,
      mysql: {
        ...base.mysql,
        installation: {
          version: '8.4.7',
          platform: 'win32',
          arch: 'x64',
          directory: 'components/mysql',
          libraryVersion: 'builtin',
          libraryDirectory: 'components/mysql/bin'
        }
      }
    };
    await mkdir(join(root, 'mysql-data'));
    await writeFile(join(root, 'mysql-data.owner'), `${config.deploymentId}\n`);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    });
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 1, null));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(mysql.createConnection).mockRejectedValue(new Error('unavailable'));
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const running = await startManagedMysql(root, config);
    await expect(running.stop()).rejects.toThrow('QUICK_START_MYSQL_FORCED_STOP');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not treat a signal error as process exit or remove its socket directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-mysql-win-signal-error-'));
    roots.push(root);
    const base = createQuickStartConfig({
      serverPort: 41001,
      mysqlPort: 41002,
      node: false,
      search: 'disabled'
    });
    const config = {
      ...base,
      mysql: {
        ...base.mysql,
        installation: {
          version: '8.4.7',
          platform: 'win32',
          arch: 'x64',
          directory: 'components/mysql',
          libraryVersion: 'builtin',
          libraryDirectory: 'components/mysql/bin'
        }
      }
    };
    await mkdir(join(root, 'mysql-data'));
    await writeFile(join(root, 'mysql-data.owner'), `${config.deploymentId}\n`);
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    });
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('kill failed')));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(mysql.createConnection).mockRejectedValue(new Error('unavailable'));
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const running = await startManagedMysql(root, config);
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    const pidFile = args.find((arg) => arg.startsWith('--pid-file='))!.slice('--pid-file='.length);
    const socketDirectory = dirname(pidFile);
    roots.push(socketDirectory);
    await expect(running.stop()).rejects.toThrow('QUICK_START_MYSQL_RECLAIM_FAILED');
    await expect(access(socketDirectory)).resolves.toBeUndefined();
  });

  it('initializes without a service and shuts down the temporary private server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-mysql-win-init-'));
    roots.push(root);
    const base = createQuickStartConfig({
      serverPort: 41001,
      mysqlPort: 41002,
      node: false,
      search: 'disabled'
    });
    const config = {
      ...base,
      mysql: {
        ...base.mysql,
        installation: {
          version: '8.4.7',
          platform: 'win32',
          arch: 'x64',
          directory: 'components/mysql',
          libraryVersion: 'builtin',
          libraryDirectory: 'components/mysql/bin'
        }
      }
    };
    const init = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    });
    const server = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    });
    vi.mocked(spawn)
      .mockImplementationOnce(() => {
        queueMicrotask(() => init.emit('exit', 0, null));
        return init as never;
      })
      .mockReturnValueOnce(server as never);
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SHUTDOWN') queueMicrotask(() => server.emit('exit', 0, null));
    });
    vi.mocked(mysql.createConnection)
      .mockRejectedValueOnce(new Error('initial root password is empty'))
      .mockResolvedValue({
        query,
        end: vi.fn(),
        destroy: vi.fn()
      } as never);
    const plugin = vi.spyOn(authPlugins, 'caching_sha2_password');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    await initializeManagedMysql(root, config);
    expect(plugin).toHaveBeenCalledTimes(3);
    expect(plugin).toHaveBeenCalledWith({ overrideIsSecure: false });
    expect(vi.mocked(mysql.createConnection).mock.calls).toHaveLength(3);
    expect(
      vi
        .mocked(mysql.createConnection)
        .mock.calls.map(([options]) => (options as { password: string }).password)
    ).toEqual([config.mysql.password, '', config.mysql.password]);
    for (const [options] of vi.mocked(mysql.createConnection).mock.calls)
      expect(options).toMatchObject({
        authPlugins: { caching_sha2_password: expect.any(Function) }
      });
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--initialize-insecure');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--mysqlx=0');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--no-monitor');
    expect(vi.mocked(spawn).mock.calls[1]?.[1]).toContain('--skip-networking');
    expect(vi.mocked(spawn).mock.calls[1]?.[1]).toContain('--no-monitor');
    expect(query).toHaveBeenCalledWith('SHUTDOWN');
    expect(init.kill).not.toHaveBeenCalled();
    expect(server.kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'linux')(
    'leaves Unix socket authentication unchanged',
    async () => {
      vi.mocked(mysql.createConnection).mockResolvedValue({ end: vi.fn() } as never);
      await waitForMysql(
        { socket: '/tmp/fixture.sock', exited: new Promise(() => {}), stop: async () => {} },
        'mar',
        ['fixture']
      );
      expect(vi.mocked(mysql.createConnection).mock.calls[0]?.[0]).not.toHaveProperty(
        'authPlugins'
      );
    }
  );

  it('preserves new data when cancellation reports a signal error without process exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-mysql-win-init-error-'));
    roots.push(root);
    const base = createQuickStartConfig({
      serverPort: 41001,
      mysqlPort: 41002,
      node: false,
      search: 'disabled'
    });
    const config = {
      ...base,
      mysql: {
        ...base.mysql,
        installation: {
          version: '8.4.7',
          platform: 'win32',
          arch: 'x64',
          directory: 'components/mysql',
          libraryVersion: 'builtin',
          libraryDirectory: 'components/mysql/bin'
        }
      }
    };
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    });
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('kill failed')));
      return true;
    });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => controller.abort());
      return child as never;
    });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    await expect(initializeManagedMysql(root, config, controller.signal)).rejects.toThrow(
      'QUICK_START_MYSQL_RECLAIM_FAILED'
    );
    await expect(access(join(root, 'mysql-data'))).resolves.toBeUndefined();
    await expect(access(join(root, 'mysql-data.owner'))).resolves.toBeUndefined();
  });
});
