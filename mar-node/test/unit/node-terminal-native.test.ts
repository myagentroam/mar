import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repairPtySpawnHelper } from '../../src/terminal.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(architecture: string) {
  const root = await mkdtemp(join(tmpdir(), 'mar-pty-helper-'));
  directories.push(root);
  const helper = join(root, `prebuilds/darwin-${architecture}/spawn-helper`);
  await mkdir(dirname(helper), { recursive: true });
  await writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  return { root, helper };
}

describe.runIf(process.platform !== 'win32')('native PTY helper permissions', () => {
  it.each(['arm64', 'x64'])(
    'repairs a non-executable macOS %s prebuild without changing its contents',
    async (architecture) => {
      const { root, helper } = await fixture(architecture);
      await expect(access(helper, constants.X_OK)).rejects.toThrow();
      repairPtySpawnHelper('darwin', architecture, root);
      await expect(access(helper, constants.X_OK)).resolves.toBeUndefined();
      expect((await stat(helper)).mode & 0o777).toBe(0o755);
      expect(await readFile(helper, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    }
  );

  it('does not modify non-macOS installations', async () => {
    const { root, helper } = await fixture('arm64');
    repairPtySpawnHelper('linux', 'arm64', root);
    expect((await stat(helper)).mode & 0o777).toBe(0o644);
  });
});
