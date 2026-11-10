import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createQuickStartConfig } from '../../mar-server/src/quick-start/config.js';
import { startManagedMysql } from '../../mar-server/src/quick-start/mysql-runtime.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn()
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe('Quick Start MySQL ownership', () => {
  it.runIf(process.platform === 'linux' && process.arch === 'x64')(
    'refuses absent or mismatched data ownership before spawning or modifying data',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'mar-mysql-owner-'));
      roots.push(root);
      await mkdir(join(root, 'mysql-data'));
      await writeFile(join(root, 'mysql-data', 'sentinel'), 'preserve');
      const base = createQuickStartConfig({
        serverPort: 41001,
        mysqlPort: 41002,
        node: false,
        search: 'disabled'
      });
      const config = {
        ...base,
        mysql: {
          ...base.mysql,
          installation: {
            version: '8.4.7',
            platform: 'linux',
            arch: 'x64',
            directory: 'components/mysql',
            libraryVersion: '1',
            libraryDirectory: 'components/lib'
          }
        }
      };
      await expect(startManagedMysql(root, config)).rejects.toThrow(
        'QUICK_START_MYSQL_DATA_NOT_OWNED'
      );
      await writeFile(join(root, 'mysql-data.owner'), 'different-deployment\n');
      await expect(startManagedMysql(root, config)).rejects.toThrow(
        'QUICK_START_MYSQL_DATA_NOT_OWNED'
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(await readFile(join(root, 'mysql-data', 'sentinel'), 'utf8')).toBe('preserve');
    }
  );
});
