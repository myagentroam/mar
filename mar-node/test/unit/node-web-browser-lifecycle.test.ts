import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  load: vi.fn(),
  writeService: vi.fn(),
  log: vi.fn()
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock('../../src/config.js', () => ({
  loadNodeConfig: mocks.load,
  nodeConfigPath: () => '/fixture/config.json',
  nodeDatabasePath: (config: { dataDirectory: string }) =>
    join(config.dataDirectory, 'node-runtime.sqlite'),
  nodeDataDirectory: (config: { dataDirectory: string }) => config.dataDirectory
}));
vi.mock('../../src/connector.js', () => ({ NodeConnector: vi.fn() }));
vi.mock('../../src/health.js', () => ({ getNodeHealth: () => ({}) }));
vi.mock('../../src/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/service.js')>()),
  writeServiceDefinition: mocks.writeService,
  removeServiceDefinition: vi.fn()
}));
vi.mock('../../src/rotating-log.js', () => ({ configureNodeLog: vi.fn() }));
vi.mock('../../src/operational.js', () => ({
  nodeLog: mocks.log,
  platformCliInvocation: (command: string, args: string[]) => ({ command, args })
}));
import { superviseNode } from '../../src/supervisor.js';
import { nodeUpgradeRequestPath } from '../../src/service/node-upgrade-coordinator.js';

const directories: string[] = [];
const argv = [...process.argv];
afterEach(async () => {
  process.argv = [...argv];
  vi.resetModules();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node browser preparation lifecycle', () => {
  it.each(['install', 'upgrade'])(
    'prepares Chromium before writing the %s service definition',
    async (command) => {
      mocks.load.mockResolvedValue({
        dataDirectory: '/fixture/data',
        allowedRoots: ['/fixture/work']
      });
      mocks.spawnSync.mockReturnValue({ status: 0 });
      process.argv = [
        process.execPath,
        '/fixture/dist/main.js',
        command,
        '--output',
        '/fixture/service'
      ];
      await import('../../src/main.js');
      expect(mocks.spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringContaining('scripts/install-web-browser.mjs')],
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.objectContaining({ PLAYWRIGHT_BROWSERS_PATH: expect.any(String) })
        })
      );
      expect(mocks.spawnSync.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.writeService.mock.invocationCallOrder[0]!
      );
      expect(mocks.writeService.mock.calls[0]?.[6]).toBe(
        mocks.spawnSync.mock.calls[0]?.[2].env.PLAYWRIGHT_BROWSERS_PATH
      );
    }
  );

  it('does not write service definitions after browser preparation fails', async () => {
    mocks.load.mockResolvedValue({ dataDirectory: '/fixture/data', allowedRoots: [] });
    mocks.spawnSync.mockReturnValue({ status: 1 });
    process.argv = [process.execPath, '/fixture/dist/main.js', 'install'];
    await expect(import('../../src/main.js')).rejects.toThrow('NODE_WEB_BROWSER_INSTALL_FAILED');
    expect(mocks.writeService).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    'prepares Chromium in script-disabled managed upgrades before switching versions (exit %s)',
    async (browserCode) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-web-upgrade-'));
      directories.push(directory);
      const database = join(directory, 'node-runtime.sqlite');
      const requestPath = nodeUpgradeRequestPath(database);
      await mkdir(dirname(requestPath), { recursive: true });
      await writeFile(requestPath, JSON.stringify({ schemaVersion: 1, targetVersion: '1.2.3' }));
      mocks.load.mockResolvedValue({ dataDirectory: directory });
      const next = join(
        directory,
        'node-versions',
        '1.2.3',
        'node_modules',
        '@myagentroam',
        'node',
        'dist',
        'main.js'
      );
      const codes = [75, 0, 0, browserCode, 0];
      mocks.spawn.mockImplementation((_command: string, args: string[]) => {
        const child = new EventEmitter();
        const code = codes.shift();
        if (code === undefined) throw new Error('Unexpected process');
        void (async () => {
          await Promise.resolve();
          if (args[0] === 'install') {
            await mkdir(dirname(next), { recursive: true });
            await writeFile(next, 'fixture');
          }
          child.emit('close', code);
        })();
        return child;
      });
      await superviseNode('/fixture/config.json', '/fixture/old/main.js');
      const invocations = mocks.spawn.mock.calls;
      expect(invocations[1]?.[1]).toContain('--ignore-scripts');
      expect(invocations[3]?.[1]).toEqual([
        join(dirname(dirname(next)), 'scripts', 'install-web-browser.mjs')
      ]);
      expect(invocations[4]?.[1][0]).toBe(browserCode === 0 ? next : '/fixture/old/main.js');
      const result = JSON.parse(await readFile(join(directory, 'upgrade-result.json'), 'utf8'));
      if (browserCode === 0) {
        expect(result.state).toBe('SUCCEEDED');
        expect((await readFile(join(directory, 'node-active-entrypoint'), 'utf8')).trim()).toBe(
          next
        );
      } else {
        expect(result).toMatchObject({
          state: 'FAILED',
          errorCode: 'NODE_UPGRADE_BROWSER_INSTALL_FAILED'
        });
        await expect(readFile(join(directory, 'node-active-entrypoint'))).rejects.toMatchObject({
          code: 'ENOENT'
        });
      }
    }
  );
});

it('keeps the prepared browser path in all generated service entrypoints without weakening systemd protection', async () => {
  const service =
    await vi.importActual<typeof import('../../src/service.js')>('../../src/service.js');
  const path = '/fixture/data/web-browsers';
  const unit = service.systemdUnit(
    '/usr/bin/node',
    '/fixture/config.json',
    undefined,
    ['/fixture/data'],
    path
  );
  expect(unit).toContain('[Unit]\nDescription=MyAgentRoam Node\n');
  expect(unit).not.toContain('\\n');
  expect(unit).toContain('ProtectSystem=strict');
  expect(unit).toContain('ReadWritePaths="/fixture/data" "/fixture/data/web-browsers"');
  expect(unit).toContain('Environment="PLAYWRIGHT_BROWSERS_PATH=/fixture/data/web-browsers"');
  expect(
    service.launchdServiceDefinition('/usr/bin/node', '/fixture/config.json', undefined, path)
  ).toContain('<string>/fixture/data/web-browsers</string>');
  expect(
    JSON.parse(service.windowsServiceDefinition('node.exe', 'config.json', undefined, path))
      .binaryPath
  ).toContain('--browser-cache "/fixture/data/web-browsers"');
});
