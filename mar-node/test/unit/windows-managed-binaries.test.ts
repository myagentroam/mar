import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { windowsManagedDesktopBinaries } from '../../src/remote-desktop/windows-managed-binaries.js';

it('discovers only the complete packaged Windows x64 backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-ultravnc-package-'));
  try {
    const directory = join(root, 'vendor/ultravnc/win32-x64');
    await mkdir(directory, { recursive: true });
    expect(await windowsManagedDesktopBinaries(root, 'win32', 'x64')).toBeUndefined();
    for (const name of ['winvnc.exe', 'vnchooks.dll', 'ddengine64.dll', 'ultravnc.portable'])
      await writeFile(join(directory, name), 'fixture');
    expect(await windowsManagedDesktopBinaries(root, 'win32', 'x64')).toEqual({
      binaryPath: join(directory, 'winvnc.exe')
    });
    expect(await windowsManagedDesktopBinaries(root, 'win32', 'arm64')).toBeUndefined();
    expect(await windowsManagedDesktopBinaries(root, 'linux', 'x64')).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
