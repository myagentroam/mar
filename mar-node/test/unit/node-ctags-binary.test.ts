import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { symbolNavigationLanguages } from '@myagentroam/code-navigation/symbol-navigation';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_CTAGS_VERSION,
  bundledCtagsDirectory,
  bundledCtagsPath,
  repairBundledCtagsExecutable
} from '../../src/ctags-binary.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Node bundled Universal Ctags', () => {
  it.each([
    ['linux', 'x64', 'linux-x64/ctags'],
    ['linux', 'arm64', 'linux-arm64/ctags'],
    ['darwin', 'x64', 'darwin-x64/ctags'],
    ['darwin', 'arm64', 'darwin-arm64/ctags'],
    ['win32', 'x64', 'win32-x64/ctags.exe']
  ] as const)('selects %s %s from the package resources', (platform, arch, suffix) => {
    expect(
      bundledCtagsPath(platform, arch, root)
        .replaceAll('\\', '/')
        .endsWith(`/mar-node/vendor/ctags/${suffix}`)
    ).toBe(true);
  });

  it('rejects unsupported targets', () => {
    expect(() => bundledCtagsPath('win32', 'arm64', root)).toThrow('CTAGS_PLATFORM_UNSUPPORTED');
    expect(() => bundledCtagsPath('freebsd', 'x64', root)).toThrow('CTAGS_PLATFORM_UNSUPPORTED');
  });

  it.each([
    ['linux', 'arm64'],
    ['darwin', 'x64']
  ] as const)(
    'restores the execute bit lost from a bundled %s %s binary',
    async (platform, arch) => {
      const packageRoot = await mkdtemp(join(tmpdir(), 'mar-ctags-mode-'));
      temporaryDirectories.push(packageRoot);
      const executable = bundledCtagsPath(platform, arch, packageRoot);
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(executable, '#!/bin/sh\n', { mode: 0o644 });
      await chmod(executable, 0o644);

      await repairBundledCtagsExecutable(platform, arch, packageRoot);

      await expect(access(executable, constants.X_OK)).resolves.toBeUndefined();
    }
  );

  it('ships fixed binaries, licenses, and matching Ctags source', async () => {
    expect(BUNDLED_CTAGS_VERSION).toBe('6.2.0-ab95af1');
    const directory = bundledCtagsDirectory(root);
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64']
    ] as const)
      await access(bundledCtagsPath(platform, arch, root), constants.X_OK);
    await access(bundledCtagsPath('win32', 'x64', root), constants.R_OK);
    await expect(readFile(resolve(directory, 'licenses/COPYING'), 'utf8')).resolves.toContain(
      'GNU GENERAL PUBLIC LICENSE'
    );
    await expect(
      readFile(
        resolve(directory, 'source/universal-ctags-ab95af198f8eaeb6d50dc96e3adf52e769d3e5f0.tar.gz')
      )
    ).resolves.toHaveLength(3_381_683);

    const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as {
      version: string;
      license: string;
      source: { archive: string; sha256: string };
      targets: Record<string, { executable: string; executableSha256: string }>;
    };
    expect(manifest).toMatchObject({
      version: BUNDLED_CTAGS_VERSION,
      license: 'GPL-2.0-or-later',
      source: {
        archive: 'source/universal-ctags-ab95af198f8eaeb6d50dc96e3adf52e769d3e5f0.tar.gz'
      }
    });
    for (const target of Object.values(manifest.targets))
      expect(
        createHash('sha256')
          .update(await readFile(resolve(directory, target.executable)))
          .digest('hex')
      ).toBe(target.executableSha256);
    expect(
      createHash('sha256')
        .update(await readFile(resolve(directory, manifest.source.archive)))
        .digest('hex')
    ).toBe(manifest.source.sha256);
  });

  it('keeps the shared source maps aligned with the bundled Ctags executable', async () => {
    const { stdout } = await execFileAsync(bundledCtagsPath('linux', 'x64', root), ['--list-maps']);
    const bundledMaps = stdout
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/u))
      .filter((fields) => fields.length > 1)
      .map(([id, ...fileNamePatterns]) => ({ id, fileNamePatterns }));

    expect(symbolNavigationLanguages()).toEqual(bundledMaps);
  });
});
