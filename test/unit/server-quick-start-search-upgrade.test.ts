import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuickStartConfig,
  readQuickStartConfig,
  writeQuickStartConfig,
  type QuickStartConfig,
  type SearchInstallation
} from '../../mar-server/src/quick-start/config.js';
import { newSearchInstallation } from '../../mar-server/src/quick-start/search-installation.js';
import { setupQuickStart } from '../../mar-server/src/quick-start/setup.js';

const mocks = vi.hoisted(() => ({
  prepareMysql: vi.fn(async (_root: string, installation: unknown) => installation),
  prepareSearch: vi.fn(),
  startSearch: vi.fn(),
  ready: vi.fn(),
  stop: vi.fn()
}));
vi.mock('../../mar-server/src/quick-start/search-installation.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareSearchInstallation: mocks.prepareSearch,
  managedSearchSupported: () => true
}));
vi.mock('../../mar-server/src/quick-start/search-runtime.js', () => ({
  startManagedSearch: mocks.startSearch
}));
vi.mock('../../mar-server/src/quick-start/mysql-installation.js', () => ({
  prepareMysqlInstallation: mocks.prepareMysql
}));
vi.mock('../../mar-server/src/quick-start/mysql-runtime.js', () => ({
  initializeManagedMysql: async () => {},
  startManagedMysql: async () => ({ stop: async () => {} }),
  waitForMysql: async () => ({ end: async () => {} })
}));
vi.mock('../../mar-server/src/quick-start/application.js', () => ({
  createLocalApplication: async () => ({ app: { ready: async () => {}, shutdown: async () => {} } })
}));

const legacy: SearchInstallation = {
  version: '57ff753ad416b7bf27e59d72ae8c7cac93b56be4',
  directory: 'components/searxng-57ff753ad-linux-x64',
  pythonVersion: '3.12.12',
  uvVersion: '0.13.7',
  arch: 'x64',
  platform: 'linux',
  port: 49503
};

describe('Quick Start managed search upgrade', () => {
  let root: string;
  let path: string;
  let config: QuickStartConfig;

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), 'mar-search-upgrade-'));
    path = join(root, 'server.json');
    config = {
      ...createQuickStartConfig({
        serverPort: 49501,
        mysqlPort: 49502,
        node: true,
        search: 'managed'
      }),
      search: { mode: 'managed', installation: legacy }
    };
    await writeQuickStartConfig(path, config);
    mocks.startSearch.mockResolvedValue({ ready: mocks.ready, stop: mocks.stop });
    mocks.ready.mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('switches an existing deployment only after the replacement passes JSON and stops', async () => {
    const replacement = newSearchInstallation(legacy.port);
    expect(replacement.version).not.toBe(legacy.version);
    expect(replacement.directory).not.toBe(legacy.directory);
    mocks.stop.mockImplementationOnce(async () => {
      expect(await readQuickStartConfig(path)).toEqual(config);
    });

    await setupQuickStart({ command: 'setup', config: path });

    expect(mocks.prepareSearch).toHaveBeenCalledWith(
      root,
      config.deploymentId,
      replacement,
      expect.any(AbortSignal),
      legacy
    );
    expect(mocks.startSearch).toHaveBeenCalledWith(root, replacement, config.deploymentId);
    expect(mocks.stop).toHaveBeenCalledWith({ requireGracefulExit: true });
    expect(await readQuickStartConfig(path)).toEqual({
      ...config,
      search: { mode: 'managed', installation: replacement }
    });
  });

  it.each(['prepare', 'probe', 'stop'] as const)(
    'leaves the previous installation selected when %s fails',
    async (phase) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      if (phase === 'prepare') mocks.prepareSearch.mockRejectedValueOnce(new Error('failure'));
      if (phase === 'probe') mocks.ready.mockResolvedValueOnce(false);
      if (phase === 'stop') mocks.stop.mockRejectedValueOnce(new Error('failure'));

      await setupQuickStart({ command: 'setup', config: path });

      expect(await readQuickStartConfig(path)).toEqual(config);
      if (phase === 'probe')
        expect(mocks.stop).toHaveBeenCalledWith({ requireGracefulExit: false });
    }
  );

  it('does not switch on cancellation while stopping the candidate', async () => {
    mocks.stop.mockImplementationOnce(async () => {
      process.emit('SIGINT');
    });

    await expect(setupQuickStart({ command: 'setup', config: path })).rejects.toThrow(
      'QUICK_START_CANCELLED'
    );

    expect(await readQuickStartConfig(path)).toEqual(config);
  });

  it('reinstalls the current version in a fresh directory without preparing MySQL', async () => {
    const current = newSearchInstallation(legacy.port);
    await writeQuickStartConfig(path, {
      ...config,
      search: { mode: 'managed', installation: current }
    });

    await setupQuickStart({ command: 'setup', config: path, reinstallSearxng: true });

    expect(mocks.prepareMysql).not.toHaveBeenCalled();
    const replacement = (await readQuickStartConfig(path))?.search.installation;
    expect(replacement).toEqual({ ...current, directory: expect.any(String) });
    expect(replacement?.directory).not.toBe(current.directory);
    expect(mocks.prepareSearch).toHaveBeenCalledWith(
      root,
      config.deploymentId,
      replacement,
      expect.any(AbortSignal),
      current
    );
  });

  it('reports a failed explicit reinstall and keeps the current installation selected', async () => {
    const current = newSearchInstallation(legacy.port);
    const existing: QuickStartConfig = {
      ...config,
      search: { mode: 'managed', installation: current }
    };
    await writeQuickStartConfig(path, existing);
    mocks.ready.mockResolvedValueOnce(false);

    await expect(
      setupQuickStart({ command: 'setup', config: path, reinstallSearxng: true })
    ).rejects.toThrow('QUICK_START_SEARCH_NOT_READY');

    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(await readQuickStartConfig(path)).toEqual(existing);
  });

  it.each([
    { mode: 'disabled', installation: legacy },
    { mode: 'external', url: 'http://127.0.0.1:56666', installation: legacy }
  ] as const)('does not touch $mode search', async (search) => {
    await writeQuickStartConfig(path, { ...config, search });

    await setupQuickStart({ command: 'setup', config: path });

    expect(mocks.prepareSearch).not.toHaveBeenCalled();
    expect(mocks.startSearch).not.toHaveBeenCalled();
    expect((await readQuickStartConfig(path))?.search).toEqual(search);

    await expect(
      setupQuickStart({ command: 'setup', config: path, reinstallSearxng: true })
    ).rejects.toThrow('QUICK_START_SEARCH_REINSTALL_REQUIRES_MANAGED');
    expect(mocks.prepareSearch).not.toHaveBeenCalled();
    expect((await readQuickStartConfig(path))?.search).toEqual(search);
  });
});
