import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computerUseRuntimeExecutable,
  defaultAllowedRoots,
  directTransferUdpPortRange,
  hostedConversationStorePath,
  loadNodeConfig,
  nodeDatabasePath,
  nodeDataDirectory
} from '../../src/config.js';
import { computerUseRuntimeVersion } from '../../src/computer-use-runtime-version.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node Workspace root configuration', () => {
  it('uses the Linux home directory or the Windows current-drive root when allowedRoots is not configured', () => {
    expect(defaultAllowedRoots('linux', '/home/node', '/srv/node')).toEqual(['/home/node']);
    expect(defaultAllowedRoots('win32', 'C:\\Users\\node', 'D:\\services\\mar-node')).toEqual([
      'D:\\'
    ]);
  });

  it('preserves explicit allowedRoots and loads defaults when the setting is missing', async () => {
    const directory = await temporaryDirectory();
    const configured = join(directory, 'configured.json');
    const defaulted = join(directory, 'defaulted.json');
    await writeFile(
      configured,
      JSON.stringify({ serverUrl: 'https://server.example', allowedRoots: ['/work'] })
    );
    await writeFile(defaulted, JSON.stringify({ serverUrl: 'https://server.example' }));

    await expect(loadNodeConfig(configured)).resolves.toMatchObject({ allowedRoots: ['/work'] });
    await expect(loadNodeConfig(defaulted)).resolves.toMatchObject({
      allowedRoots: defaultAllowedRoots()
    });
  });
});

describe('Node direct-transfer UDP configuration', () => {
  it('uses a shared default port pool and accepts a custom range', async () => {
    expect(directTransferUdpPortRange(undefined)).toEqual({ begin: 49_152, end: 49_215 });
    const directory = await temporaryDirectory();
    const path = join(directory, 'direct.json');
    await writeFile(
      path,
      JSON.stringify({
        serverUrl: 'https://server.example',
        directTransfer: { udpPortRangeBegin: 50_000, udpPortRangeEnd: 50_031 }
      })
    );

    const config = await loadNodeConfig(path);
    expect(config.directTransfer).toEqual({
      udpPortRangeBegin: 50_000,
      udpPortRangeEnd: 50_031
    });
    expect(directTransferUdpPortRange(config)).toEqual({ begin: 50_000, end: 50_031 });
  });

  it.each([
    {},
    { udpPortRangeBegin: 50_000 },
    { udpPortRangeEnd: 50_031 },
    { udpPortRangeBegin: 1_023, udpPortRangeEnd: 1_024 },
    { udpPortRangeBegin: 50_001, udpPortRangeEnd: 50_000 },
    { udpPortRangeBegin: 49_152, udpPortRangeEnd: 49_408 },
    { udpPortRangeBegin: 49_152.5, udpPortRangeEnd: 49_153 },
    { udpPortRangeBegin: 49_152, udpPortRangeEnd: 65_536 },
    { udpPortRangeBegin: 49_152, udpPortRangeEnd: 49_153, extra: true }
  ])('rejects an invalid direct-transfer UDP range %#', async (directTransfer) => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'invalid-direct.json');
    await writeFile(path, JSON.stringify({ serverUrl: 'https://server.example', directTransfer }));

    await expect(loadNodeConfig(path)).rejects.toThrow('NODE_CONFIG_INVALID');
  });
});

describe('Node data-directory configuration', () => {
  it('resolves the managed Computer Use runtime and an explicit validation override', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'mar-node.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'https://server.example',
        dataDirectory: 'runtime-data',
        computerUse: { enabled: true }
      })
    );

    const managed = await loadNodeConfig(configPath);
    expect(computerUseRuntimeExecutable(managed, configPath, 'win32', 'x64')).toBe(
      join(
        directory,
        'runtime-data',
        'computer-use',
        'runtime',
        `${computerUseRuntimeVersion}-win32-x64`,
        'python.exe'
      )
    );

    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'https://server.example',
        computerUse: { enabled: true, runtimeExecutable: 'validation/python.exe' }
      })
    );
    const overridden = await loadNodeConfig(configPath);
    expect(computerUseRuntimeExecutable(overridden, configPath, 'win32')).toBe(
      join(directory, 'validation', 'python.exe')
    );
  });

  it.each([
    {},
    { enabled: 'yes' },
    { enabled: true, runtimeExecutable: '' },
    { enabled: true, runtimeExecutable: ' python' },
    { enabled: false, extra: true }
  ])('rejects invalid Computer Use configuration %#', async (computerUse) => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'invalid-computer-use.json');
    await writeFile(path, JSON.stringify({ serverUrl: 'https://server.example', computerUse }));
    await expect(loadNodeConfig(path)).rejects.toThrow('NODE_CONFIG_INVALID');
  });

  it('derives the fixed SQLite path from dataDirectory and supports relative configuration paths', () => {
    const configPath = join('/opt', 'myagentroam', 'mar-node.json');
    const config = {
      serverUrl: 'https://server.example',
      allowedRoots: ['/work'],
      dataDirectory: 'runtime-data'
    };

    expect(nodeDataDirectory(config, configPath)).toBe(join('/opt', 'myagentroam', 'runtime-data'));
    expect(nodeDatabasePath(config, configPath)).toBe(
      join('/opt', 'myagentroam', 'runtime-data', 'node-runtime.sqlite')
    );
  });

  it('uses the configuration-file directory when dataDirectory is not configured', () => {
    const configPath = join('/opt', 'myagentroam', 'mar-node.json');
    const base = { serverUrl: 'https://server.example', allowedRoots: ['/work'] };

    expect(nodeDataDirectory(base, configPath)).toBe(join('/opt', 'myagentroam'));
    expect(nodeDatabasePath(base, configPath)).toBe(
      join('/opt', 'myagentroam', 'node-runtime.sqlite')
    );
  });

  it('allows a separate hosted-conversation root only inside dataDirectory', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'mar-node.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'https://server.example',
        dataDirectory: 'runtime-data',
        conversationHosting: { enabled: true, storeDirectory: 'hosted-conversations' }
      })
    );

    const config = await loadNodeConfig(configPath);
    expect(config.conversationHosting).toEqual({
      enabled: true,
      storeDirectory: 'hosted-conversations',
      inactiveRetentionDays: 60
    });
    expect(hostedConversationStorePath(config, configPath)).toBe(
      join(directory, 'runtime-data', 'hosted-conversations')
    );

    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'https://server.example',
        dataDirectory: 'runtime-data',
        conversationHosting: { enabled: true, storeDirectory: '../outside' }
      })
    );
    await expect(loadNodeConfig(configPath)).rejects.toThrow('NODE_CONFIG_INVALID');

    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'https://server.example',
        dataDirectory: 'runtime-data',
        conversationHosting: { enabled: false, storeDirectory: '../outside' }
      })
    );
    await expect(loadNodeConfig(configPath)).rejects.toThrow('NODE_CONFIG_INVALID');

    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'https://server.example',
        dataDirectory: 'runtime-data',
        conversationHosting: {
          enabled: true,
          storeDirectory: 'hosted-conversations',
          inactiveRetentionDays: 365
        }
      })
    );
    await expect(loadNodeConfig(configPath)).resolves.toMatchObject({
      conversationHosting: { inactiveRetentionDays: 365 }
    });

    for (const inactiveRetentionDays of [0, 366, 1.5]) {
      await writeFile(
        configPath,
        JSON.stringify({
          serverUrl: 'https://server.example',
          dataDirectory: 'runtime-data',
          conversationHosting: {
            enabled: true,
            storeDirectory: 'hosted-conversations',
            inactiveRetentionDays
          }
        })
      );
      await expect(loadNodeConfig(configPath)).rejects.toThrow('NODE_CONFIG_INVALID');
    }
  });

  it('rejects legacy databasePath configuration and requires manual migration', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'legacy.json');
    await writeFile(
      path,
      JSON.stringify({ serverUrl: 'https://server.example', databasePath: 'node.sqlite' })
    );

    await expect(loadNodeConfig(path)).rejects.toThrow('NODE_CONFIG_INVALID');
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'myagentroam-node-config-'));
  directories.push(path);
  return path;
}
