import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireQuickStartLock } from '../../mar-server/src/quick-start/lock.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Quick Start deployment exclusion', () => {
  it('excludes concurrent setup/run and allows reuse after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-quick-lock-'));
    directories.push(root);
    const release = await acquireQuickStartLock(root);
    await expect(acquireQuickStartLock(root)).rejects.toThrow('QUICK_START_IN_USE');
    await Promise.all([release(), release()]);
    const releaseAgain = await acquireQuickStartLock(root);
    await releaseAgain();
  });

  it('does not remove an unknown existing lock or its contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-quick-lock-'));
    directories.push(root);
    await mkdir(join(root, '.deployment-lock'));
    await writeFile(join(root, '.deployment-lock', 'unknown'), 'keep');
    await expect(acquireQuickStartLock(root)).rejects.toThrow('QUICK_START_IN_USE');
  });
});
