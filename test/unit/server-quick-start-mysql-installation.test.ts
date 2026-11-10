import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareMysqlInstallation } from '../../mar-server/src/quick-start/mysql-installation.js';
import { downloadPinnedFile } from '../../mar-server/src/quick-start/download.js';

vi.mock('../../mar-server/src/quick-start/download.js', () => ({ downloadPinnedFile: vi.fn() }));
const directories: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Quick Start MySQL installation', () => {
  it.runIf(process.platform === 'linux' && process.arch === 'x64')(
    'checks required extractors before downloading',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'mar-quick-mysql-tools-'));
      directories.push(root);
      vi.stubEnv('PATH', '');
      await expect(prepareMysqlInstallation(root)).rejects.toThrow(
        'QUICK_START_MYSQL_TOOLS_MISSING'
      );
      expect(downloadPinnedFile).not.toHaveBeenCalled();
    }
  );

  it('uses the recorded installation without downloading or replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-quick-mysql-'));
    directories.push(root);
    const installation = {
      version: '8.4.1',
      platform: process.platform,
      arch: process.arch,
      directory: 'components/mysql-old',
      libraryVersion: '1',
      libraryDirectory: 'components/lib-old'
    };
    await mkdir(join(root, installation.directory, 'bin'), { recursive: true });
    await mkdir(join(root, installation.libraryDirectory), { recursive: true });
    await writeFile(
      join(
        root,
        installation.directory,
        'bin',
        process.platform === 'win32' ? 'mysqld.exe' : 'mysqld'
      ),
      'existing'
    );
    if (process.platform !== 'win32')
      await writeFile(join(root, installation.libraryDirectory, 'libaio.so.1'), 'existing');
    expect(await prepareMysqlInstallation(root, installation)).toEqual(installation);
    expect(downloadPinnedFile).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'linux' && process.arch === 'x64')(
    'preflights Windows extraction and reuses its private pinned installation',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'mar-quick-mysql-win-'));
      directories.push(root);
      const bin = join(root, 'bin');
      await mkdir(bin);
      await writeFile(
        join(bin, 'tar.exe'),
        `#!/bin/sh
case "$1" in
  --version) printf 'fixture tar\\n' ;;
  -tf) printf 'mysql-8.4.7-winx64/bin/mysqld.exe\\n' ;;
  -xf) /bin/mkdir -p "$4/bin"; printf 'owned binary' > "$4/bin/mysqld.exe" ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o700 }
      );
      vi.mocked(downloadPinnedFile).mockImplementation(async (_url, _digest, destination) => {
        await writeFile(destination, 'fixture archive');
      });
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      vi.stubEnv('PATH', '');
      await expect(prepareMysqlInstallation(root)).rejects.toThrow(
        'QUICK_START_MYSQL_TOOLS_MISSING'
      );
      expect(downloadPinnedFile).not.toHaveBeenCalled();
      vi.stubEnv('PATH', bin);
      const installed = await prepareMysqlInstallation(root);
      expect(installed.platform).toBe('win32');
      expect(await readFile(join(root, installed.directory, 'bin/mysqld.exe'), 'utf8')).toBe(
        'owned binary'
      );
      expect(vi.mocked(downloadPinnedFile)).toHaveBeenCalledOnce();
      expect(await prepareMysqlInstallation(root, installed)).toEqual(installed);
      expect(vi.mocked(downloadPinnedFile)).toHaveBeenCalledOnce();
    }
  );

  it.runIf(process.platform === 'linux' && process.arch === 'x64')(
    'rejects a Windows archive with an out-of-directory path before extraction',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'mar-quick-mysql-win-escape-'));
      directories.push(root);
      const bin = join(root, 'bin');
      await mkdir(bin);
      await writeFile(
        join(bin, 'tar.exe'),
        `#!/bin/sh
case "$1" in
  --version) exit 0 ;;
  -tf) printf 'mysql-8.4.7-winx64/../../escape\\n' ;;
  -xf) printf 'unexpected' > "$MAR_FIXTURE_EXTRACTED" ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o700 }
      );
      vi.mocked(downloadPinnedFile).mockImplementation(async (_url, _digest, destination) => {
        await writeFile(destination, 'fixture archive');
      });
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      vi.stubEnv('PATH', bin);
      vi.stubEnv('MAR_FIXTURE_EXTRACTED', join(root, 'extracted'));
      await expect(prepareMysqlInstallation(root)).rejects.toThrow('QUICK_START_DOWNLOAD_INVALID');
      await expect(access(join(root, 'extracted'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(root, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
});
