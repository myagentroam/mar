import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createQuickStartConfig,
  readQuickStartConfig,
  resolveQuickStartConfigPath,
  resolveQuickStartNetwork,
  selectQuickStartComponents,
  writeQuickStartConfig
} from '../../mar-server/src/quick-start/config.js';

const createQuickStartServerAppMock = vi.hoisted(() => vi.fn());

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
  vi.doUnmock('../../ee/server/src/app.ts');
  vi.resetModules();
  createQuickStartServerAppMock.mockReset();
  vi.unstubAllEnvs();
});

describe('Quick Start configuration', () => {
  it('passes the resolved public and local Node URLs to Quick Start application assembly', async () => {
    const publicOrigin = 'https://public.invalid';
    vi.stubEnv('MAR_SERVER_HOST', '0.0.0.0');
    vi.stubEnv('MAR_PUBLIC_ORIGIN', publicOrigin);
    createQuickStartServerAppMock.mockResolvedValue({ app: {} });
    vi.doMock('../../ee/server/src/app.ts', () => ({
      createQuickStartServerApp: createQuickStartServerAppMock
    }));
    const config = createQuickStartConfig({
      serverPort: 5190,
      mysqlPort: 5191,
      node: true,
      search: 'disabled'
    });
    const root = await mkdtemp(join(tmpdir(), 'mar-quick-application-'));
    directories.push(root);
    const { createLocalApplication } =
      await import('../../mar-server/src/quick-start/application.js');

    await createLocalApplication(root, config);

    const options = createQuickStartServerAppMock.mock.calls[0]?.[0] as {
      readonly publicOrigin: string;
      readonly quickStartLocalServerUrl: string;
      readonly readQuickStartLocalNodeId?: () => Promise<string | undefined>;
    };
    expect({
      publicOrigin: options.publicOrigin,
      quickStartLocalServerUrl: options.quickStartLocalServerUrl
    }).toEqual({ publicOrigin, quickStartLocalServerUrl: 'http://127.0.0.1:5190' });
    expect(options.readQuickStartLocalNodeId).toBeTypeOf('function');
    if (options.readQuickStartLocalNodeId === undefined) return;

    await expect(options.readQuickStartLocalNodeId()).resolves.toBeUndefined();
    await mkdir(join(root, 'node-data'));
    const nodeConfigPath = join(root, 'node-data/node.json');
    await writeFile(nodeConfigPath, JSON.stringify({ registrationToken: 'fixture-pending' }));
    await expect(options.readQuickStartLocalNodeId()).resolves.toBeUndefined();
    await writeFile(nodeConfigPath, JSON.stringify({ nodeId: 'fixture-partial-node' }));
    await expect(options.readQuickStartLocalNodeId()).resolves.toBeUndefined();
    await writeFile(
      nodeConfigPath,
      JSON.stringify({ nodeId: 'fixture-local-node', credential: 'fixture-node-credential' })
    );
    await expect(options.readQuickStartLocalNodeId()).resolves.toBe('fixture-local-node');
    await writeFile(nodeConfigPath, '{"credential":"UNSAFE_FIXTURE_SECRET');
    await expect(options.readQuickStartLocalNodeId()).rejects.toThrow(
      'QUICK_START_NODE_CONFIG_INVALID'
    );
    await expect(options.readQuickStartLocalNodeId()).rejects.not.toThrow('UNSAFE_FIXTURE_SECRET');
    await rm(nodeConfigPath);
    await mkdir(nodeConfigPath);
    const readError = await options.readQuickStartLocalNodeId().catch((error: unknown) => error);
    expect(readError).toMatchObject({
      code: 'QUICK_START_NODE_CONFIG_READ_FAILED',
      message: 'QUICK_START_NODE_CONFIG_READ_FAILED'
    });
  });

  it('separates public HTTP/HTTPS origins from managed Node traffic', () => {
    expect(resolveQuickStartNetwork({ serverPort: 5190 }, {})).toEqual({
      host: '127.0.0.1',
      publicOrigin: 'http://127.0.0.1:5190',
      localServerUrl: 'http://127.0.0.1:5190'
    });
    for (const publicOrigin of [
      'http://192.0.2.10:5190',
      'http://mar.example.test:5190',
      'https://mar.example.test'
    ]) {
      expect(
        resolveQuickStartNetwork(
          { serverPort: 5190 },
          { MAR_SERVER_HOST: '0.0.0.0', MAR_PUBLIC_ORIGIN: publicOrigin }
        )
      ).toEqual({
        host: '0.0.0.0',
        publicOrigin,
        localServerUrl: 'http://127.0.0.1:5190'
      });
    }
    expect(
      resolveQuickStartNetwork({ serverPort: 5190 }, { MAR_SERVER_HOST: '::' }).localServerUrl
    ).toBe('http://[::1]:5190');
    expect(
      resolveQuickStartNetwork({ serverPort: 5190 }, { MAR_SERVER_HOST: '192.0.2.10' })
        .localServerUrl
    ).toBe('http://192.0.2.10:5190');
  });

  it.each([
    'ftp://mar.example.test',
    'http://user:pass@mar.example.test',
    'http://mar.example.test/path',
    'http://mar.example.test?query',
    'http://mar.example.test#fragment'
  ])('rejects a public URL that is not an HTTP(S) origin: %s', (publicOrigin) => {
    expect(() =>
      resolveQuickStartNetwork({ serverPort: 5190 }, { MAR_PUBLIC_ORIGIN: publicOrigin })
    ).toThrow('QUICK_START_NETWORK_INVALID');
  });

  it('uses the home directory by default and resolves explicit paths once', () => {
    const home = resolve('example-home');
    const cwd = resolve('example-cwd');
    expect(resolveQuickStartConfigPath(undefined, home, cwd)).toBe(
      join(home, '.myagentroam', 'quick-start', 'server.json')
    );
    expect(resolveQuickStartConfigPath('other/server.json', home, cwd)).toBe(
      join(cwd, 'other', 'server.json')
    );
  });

  it('persists credentials and component choices privately without regenerating them on read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-quick-config-'));
    directories.push(directory);
    const path = join(directory, 'server.json');
    const config = createQuickStartConfig({
      serverPort: 41823,
      mysqlPort: 41824,
      node: false,
      search: 'disabled'
    });
    await writeQuickStartConfig(path, config);
    expect(await readQuickStartConfig(path)).toEqual(config);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8')).mysql.password).toBe(config.mysql.password);
  });

  it('does not interpret corrupt or externally configured databases as a fresh installation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-quick-config-'));
    directories.push(directory);
    const path = join(directory, 'server.json');
    expect(await readQuickStartConfig(path)).toBeUndefined();
    await writeFile(path, '{broken');
    await expect(readQuickStartConfig(path)).rejects.toThrow('QUICK_START_CONFIG_INVALID');
    await writeFile(path, JSON.stringify({ databaseUrl: 'mysql://external/example' }));
    await expect(readQuickStartConfig(path)).rejects.toThrow('QUICK_START_CONFIG_INVALID');
  });

  it('retains choices and credentials on repeated setup unless explicitly disabled', () => {
    const original = createQuickStartConfig({
      serverPort: 41823,
      mysqlPort: 41824,
      node: true,
      search: 'managed'
    });
    const external = {
      ...original,
      search: { mode: 'external' as const, url: 'https://search.example.org' }
    };
    expect(selectQuickStartComponents(external, {})).toEqual(external);
    expect(selectQuickStartComponents(external, { node: false, searxng: false })).toEqual({
      ...external,
      node: { enabled: false },
      search: external.search
    });
    expect(selectQuickStartComponents(original, { searxng: false }).search).toEqual({
      mode: 'disabled'
    });
  });

  it('retains the actual installed component locations and versions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-quick-installed-'));
    directories.push(directory);
    const path = join(directory, 'server.json');
    const config = createQuickStartConfig({
      serverPort: 41823,
      mysqlPort: 41824,
      node: false,
      search: 'disabled'
    });
    const installed = {
      ...config,
      mysql: {
        ...config.mysql,
        installation: {
          version: '8.4.7',
          platform: 'linux',
          arch: 'x64',
          directory: 'components/mysql-8.4.7',
          libraryVersion: '0.3.113-4',
          libraryDirectory: 'components/libaio-0.3.113-4/usr/lib/x86_64-linux-gnu'
        }
      }
    };
    await writeQuickStartConfig(path, installed);
    expect(await readQuickStartConfig(path)).toEqual(installed);
  });

  it('retains browser preparation when locally disabling Node', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-quick-node-installed-'));
    directories.push(directory);
    const path = join(directory, 'server.json');
    const original = createQuickStartConfig({
      serverPort: 41001,
      mysqlPort: 41002,
      node: true,
      search: 'disabled'
    });
    const node = { enabled: true };
    const config = { ...original, node };
    await writeQuickStartConfig(path, config);
    const loaded = (await readQuickStartConfig(path))!;
    expect(loaded.node).toEqual(node);
    expect(selectQuickStartComponents(loaded, { node: false }).node).toEqual({
      ...node,
      enabled: false
    });
    const invalid = { ...config, node: { ...node, preparedVersion: '../other' } };
    await expect(writeQuickStartConfig(path, invalid)).rejects.toThrow(
      'QUICK_START_CONFIG_INVALID'
    );
    expect(await readQuickStartConfig(path)).toEqual(config);
  });

  it('does not discard an external search endpoint when disabling the local search component', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-quick-external-search-'));
    directories.push(directory);
    const path = join(directory, 'server.json');
    const config = createQuickStartConfig({
      serverPort: 41001,
      mysqlPort: 41002,
      node: false,
      search: 'disabled'
    });
    const external = {
      ...config,
      search: { mode: 'external' as const, url: 'https://search.example/' }
    };
    await writeQuickStartConfig(path, external);
    const selected = selectQuickStartComponents((await readQuickStartConfig(path))!, {
      searxng: false
    });
    await writeQuickStartConfig(path, selected);
    expect((await readQuickStartConfig(path))!.search).toEqual(external.search);
  });

  it('retains a managed search installation when disabling local search', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-quick-search-installed-'));
    directories.push(directory);
    const path = join(directory, 'server.json');
    const config = createQuickStartConfig({
      serverPort: 41001,
      mysqlPort: 41002,
      node: false,
      search: 'managed'
    });
    const installation = {
      version: '57ff753ad416b7bf27e59d72ae8c7cac93b56be4',
      uvVersion: '0.13.7',
      pythonVersion: '3.12.12',
      directory: 'components/searxng-57ff753ad',
      platform: 'linux',
      arch: 'x64',
      port: 41003
    };
    await writeQuickStartConfig(path, { ...config, search: { mode: 'managed', installation } });
    const loaded = (await readQuickStartConfig(path))!;
    expect(selectQuickStartComponents(loaded, { searxng: false }).search).toEqual({
      mode: 'disabled',
      installation
    });
  });
});
