import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createQuickStartConfig,
  readQuickStartConfig,
  resolveQuickStartConfigPath,
  selectQuickStartComponents,
  writeQuickStartConfig
} from '../../mar-server/src/quick-start/config.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Quick Start configuration', () => {
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
    await expect(
      writeQuickStartConfig(path, {
        ...config,
        node: { ...node, preparedVersion: '../other' }
      })
    ).rejects.toThrow('QUICK_START_CONFIG_INVALID');
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
