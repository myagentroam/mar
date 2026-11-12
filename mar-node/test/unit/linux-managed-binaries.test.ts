import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { linuxManagedDesktopBinaries } from '../../src/remote-desktop/linux-managed-binaries.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it('uses only an installed managed target with both executables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-desktop-binaries-'));
  directories.push(root);
  const vendor = join(root, 'vendor/tigervnc');
  await mkdir(join(vendor, 'linux-x64'), { recursive: true });
  const manifest = join(vendor, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ targets: {} }));
  expect(await linuxManagedDesktopBinaries(root, 'linux', 'x64')).toBeUndefined();
  await writeFile(manifest, JSON.stringify({ targets: { 'linux-x64': {
    server: 'linux-x64/x0vncserver', topology: 'linux-x64/x11-topology'
  } } }));
  expect(await linuxManagedDesktopBinaries(root, 'linux', 'x64')).toBeUndefined();
  for (const name of ['x0vncserver', 'x11-topology']) {
    const path = join(vendor, 'linux-x64', name);
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    await chmod(path, 0o755);
  }
  expect(await linuxManagedDesktopBinaries(root, 'linux', 'x64')).toEqual({
    binaryPath: join(vendor, 'linux-x64/x0vncserver'),
    topologyBinary: join(vendor, 'linux-x64/x11-topology')
  });
  expect(await linuxManagedDesktopBinaries(root, 'darwin', 'x64')).toBeUndefined();
  expect(await linuxManagedDesktopBinaries(root, 'linux', 'arm64')).toBeUndefined();
});
