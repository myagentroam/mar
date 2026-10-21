import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeConfig } from '../../src/config.js';
import {
  ComputerUseRuntimeError,
  ManagedComputerUseRuntime
} from '../../src/computer-use-runtime.js';
import { computerUseRuntimeVersion } from '../../src/computer-use-runtime-version.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-computer-runtime-'));
  roots.push(root);
  const packageRoot = join(root, 'package');
  const source = join(packageRoot, 'runtime');
  const executable = Buffer.from('#!/usr/bin/env python3\n');
  await mkdir(join(source, 'bin'), { recursive: true });
  await writeFile(join(source, 'bin/python3'), executable, { mode: 0o700 });
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({
      formatVersion: 1,
      runtimeVersion: computerUseRuntimeVersion,
      platform: 'linux',
      architecture: 'x64',
      executable: 'bin/python3',
      files: [
        {
          path: 'bin/python3',
          size: executable.byteLength,
          sha256: createHash('sha256').update(executable).digest('hex')
        }
      ]
    })
  );
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@myagentroam/computer-runtime-linux-x64',
      version: computerUseRuntimeVersion
    })
  );
  const config: NodeConfig = {
    serverUrl: 'https://server.example',
    allowedRoots: [root],
    dataDirectory: 'data',
    computerUse: { enabled: true }
  };
  const configPath = join(root, 'node.json');
  let installCount = 0;
  const createRuntime = () =>
    new ManagedComputerUseRuntime(
      () => config,
      configPath,
      'linux',
      'x64',
      async (runtimePackage) => {
        installCount += 1;
        expect(runtimePackage).toEqual({
          name: '@myagentroam/computer-runtime-linux-x64',
          version: computerUseRuntimeVersion
        });
        return packageRoot;
      }
    );
  return {
    root,
    source,
    packageRoot,
    runtime: createRuntime(),
    createRuntime,
    installCount: () => installCount
  };
}

describe('ManagedComputerUseRuntime', () => {
  it('verifies and atomically installs the bundled runtime into Node private data', async () => {
    const { runtime } = await fixture();
    const [executable, concurrentExecutable] = await Promise.all([
      runtime.ensure(),
      runtime.ensure()
    ]);
    expect(concurrentExecutable).toBe(executable);
    expect(
      executable.endsWith(
        join('computer-use', 'runtime', `${computerUseRuntimeVersion}-linux-x64`, 'bin', 'python3')
      )
    ).toBe(true);
    await expect(readFile(executable, 'utf8')).resolves.toContain('python3');
    await expect(runtime.ensure()).resolves.toBe(executable);
  });

  it('serializes installation across runtime instances and reuses the installed version', async () => {
    const fixtureValue = await fixture();
    const [first, second] = await Promise.all([
      fixtureValue.runtime.ensure(),
      fixtureValue.createRuntime().ensure()
    ]);
    expect(second).toBe(first);
    expect(fixtureValue.installCount()).toBe(1);
  });

  it('replaces a damaged installed version from the verified package', async () => {
    const fixtureValue = await fixture();
    const executable = await fixtureValue.runtime.ensure();
    await writeFile(executable, 'damaged');
    await expect(fixtureValue.createRuntime().ensure()).resolves.toBe(executable);
    await expect(readFile(executable, 'utf8')).resolves.toContain('python3');
    expect(fixtureValue.installCount()).toBe(2);
  });

  it('rejects a damaged platform runtime without using another Python', async () => {
    const { runtime, source } = await fixture();
    await writeFile(join(source, 'bin/python3'), 'damaged');
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: 'COMPUTER_RUNTIME_INTEGRITY_FAILED'
    } satisfies Partial<ComputerUseRuntimeError>);
  });

  it('rejects a Unix runtime whose executable permission was damaged', async () => {
    const { runtime, source } = await fixture();
    await chmod(join(source, 'bin/python3'), 0o600);
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: 'COMPUTER_RUNTIME_INTEGRITY_FAILED'
    } satisfies Partial<ComputerUseRuntimeError>);
  });

  it('rejects symbolic links in a downloaded runtime', async () => {
    const { runtime, source, root } = await fixture();
    const outside = join(root, 'outside-python');
    await writeFile(outside, '#!/usr/bin/env python3\n', { mode: 0o700 });
    await rm(join(source, 'bin/python3'));
    await symlink(outside, join(source, 'bin/python3'));
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: 'COMPUTER_RUNTIME_MANIFEST_INVALID'
    } satisfies Partial<ComputerUseRuntimeError>);
  });

  it('rejects a downloaded runtime root that is a symbolic link', async () => {
    const { runtime, source, root } = await fixture();
    const linkedSource = join(root, 'linked-runtime');
    await rename(source, linkedSource);
    await symlink(linkedSource, source, 'dir');
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: 'COMPUTER_RUNTIME_MANIFEST_INVALID'
    } satisfies Partial<ComputerUseRuntimeError>);
  });

  it('reports a stable package identity error', async () => {
    const { runtime, packageRoot } = await fixture();
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@myagentroam/computer-runtime-linux-x64',
        version: '0.9.94'
      })
    );
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: 'COMPUTER_RUNTIME_PACKAGE_INVALID'
    } satisfies Partial<ComputerUseRuntimeError>);
  });

  it('reports an unavailable package installation without probing another target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-computer-runtime-missing-'));
    roots.push(root);
    const requested: string[] = [];
    const config: NodeConfig = {
      serverUrl: 'https://server.example',
      allowedRoots: [root],
      dataDirectory: 'data',
      computerUse: { enabled: true }
    };
    const runtime = new ManagedComputerUseRuntime(
      () => config,
      join(root, 'node.json'),
      'linux',
      'x64',
      async (runtimePackage) => {
        requested.push(runtimePackage.name);
        throw new Error('registry unavailable');
      }
    );
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: 'COMPUTER_RUNTIME_INSTALL_FAILED'
    } satisfies Partial<ComputerUseRuntimeError>);
    expect(requested).toEqual(['@myagentroam/computer-runtime-linux-x64']);
  });

  it.each([
    ['win32', 'arm64', '@myagentroam/computer-runtime-win32-arm64'],
    ['darwin', 'x64', '@myagentroam/computer-runtime-darwin-x64'],
    ['darwin', 'arm64', '@myagentroam/computer-runtime-darwin-arm64'],
    ['linux', 'arm64', '@myagentroam/computer-runtime-linux-arm64']
  ] as const)('resolves the managed runtime for %s %s', async (platform, architecture, name) => {
    const root = await mkdtemp(join(tmpdir(), 'mar-computer-runtime-platform-'));
    roots.push(root);
    const config: NodeConfig = {
      serverUrl: 'https://server.example',
      allowedRoots: [root],
      dataDirectory: 'data',
      computerUse: { enabled: true }
    };
    const requested: string[] = [];
    const runtime = new ManagedComputerUseRuntime(
      () => config,
      join(root, 'node.json'),
      platform,
      architecture,
      async (runtimePackage) => {
        requested.push(runtimePackage.name);
        throw new Error('registry unavailable');
      }
    );
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: 'COMPUTER_RUNTIME_INSTALL_FAILED'
    } satisfies Partial<ComputerUseRuntimeError>);
    expect(requested).toEqual([name]);
  });

  it('rejects unsupported platform pairs before resolving a package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-computer-runtime-unsupported-'));
    roots.push(root);
    const config: NodeConfig = {
      serverUrl: 'https://server.example',
      allowedRoots: [root],
      dataDirectory: 'data',
      computerUse: { enabled: true }
    };
    let resolved = false;
    const runtime = new ManagedComputerUseRuntime(
      () => config,
      join(root, 'node.json'),
      'freebsd',
      'x64',
      async () => {
        resolved = true;
        return root;
      }
    );
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: 'COMPUTER_RUNTIME_PLATFORM_UNSUPPORTED'
    } satisfies Partial<ComputerUseRuntimeError>);
    expect(resolved).toBe(false);
  });
});
