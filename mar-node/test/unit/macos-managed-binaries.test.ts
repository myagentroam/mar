import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { macosManagedDesktopBinaries } from '../../src/remote-desktop/macos-managed-binaries.js';

it('discovers only a complete executable macOS backend and topology helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-macos-binaries-'));
  try {
    const directory = join(root, 'vendor/macvnc/darwin-arm64');
    await mkdir(directory, { recursive: true });
    const binaryPath = join(directory, 'macVNC');
    const topologyBinary = join(directory, 'macos-topology');
    await writeFile(binaryPath, 'candidate');
    await chmod(binaryPath, 0o755);
    expect(await macosManagedDesktopBinaries(root, 'darwin', 'arm64')).toBeUndefined();
    await writeFile(topologyBinary, 'candidate');
    await chmod(topologyBinary, 0o755);
    expect(await macosManagedDesktopBinaries(root, 'darwin', 'arm64')).toEqual({
      binaryPath,
      topologyBinary
    });
    expect(await macosManagedDesktopBinaries(root, 'linux', 'arm64')).toBeUndefined();
    expect(await macosManagedDesktopBinaries(root, 'darwin', 'x64')).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
