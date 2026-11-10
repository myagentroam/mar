import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareMysqlInstallation } from '../../mar-server/src/quick-start/mysql-installation.js';
import {
  newSearchInstallation,
  prepareSearchInstallation
} from '../../mar-server/src/quick-start/search-installation.js';
import { downloadPinnedFile } from '../../mar-server/src/quick-start/download.js';

vi.mock('../../mar-server/src/quick-start/download.js', () => ({ downloadPinnedFile: vi.fn() }));
const roots: string[] = [];
const originalKill = process.kill.bind(process);
let ownedGroup = 0;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (ownedGroup) {
    try {
      originalKill(-ownedGroup, 'SIGKILL');
    } catch {}
    ownedGroup = 0;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'linux' && process.arch === 'x64')(
  'owned extraction cancellation',
  () => {
    it.each(['mysql-tar', 'mysql-dpkg', 'search-tar'] as const)(
      'reaps the real %s extractor before removing its staging',
      async (kind) => {
        const root = await mkdtemp(join(tmpdir(), 'mar-extract-cancel-'));
        roots.push(root);
        const bin = join(root, 'bin');
        await mkdir(bin);
        const delayed = `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\ntrap '' TERM\nprintf '%s' "$$" > "$MAR_EXTRACT_PID"\nwhile :; do /bin/sleep 1; done\n`;
        const fast = `#!/bin/sh\nexit 0\n`;
        await writeFile(join(bin, 'tar'), kind.endsWith('tar') ? delayed : fast, { mode: 0o700 });
        await writeFile(join(bin, 'dpkg-deb'), kind === 'mysql-dpkg' ? delayed : fast, {
          mode: 0o700
        });
        vi.stubEnv('PATH', bin);
        const pidPath = join(root, 'extract.pid');
        vi.stubEnv('MAR_EXTRACT_PID', pidPath);
        vi.mocked(downloadPinnedFile).mockImplementation(async (_url, _digest, destination) => {
          await writeFile(destination, 'fixture archive');
        });
        if (kind === 'mysql-dpkg') {
          const mysql = join(root, 'components/mysql-8.4.7-linux-x64');
          await mkdir(mysql, { recursive: true });
          await writeFile(
            join(mysql, '.mar-installed'),
            '543ec7d310c4f0786344d243663e5db9e985b03e741ee935370ab08b3274f05a\n'
          );
        }
        const controller = new AbortController();
        const operation =
          kind === 'search-tar'
            ? prepareSearchInstallation(
                root,
                'fixture',
                newSearchInstallation(12345),
                controller.signal
              )
            : prepareMysqlInstallation(root, undefined, controller.signal);
        const outcome = operation.then(
          () => undefined,
          (error: unknown) => error
        );
        await vi.waitFor(async () => {
          ownedGroup = Number(await readFile(pidPath, 'utf8'));
          expect(ownedGroup).toBeGreaterThan(1);
        });
        controller.abort(new Error('fixture cancelled'));
        expect(await outcome).toMatchObject({ message: 'fixture cancelled' });
        expect(() => originalKill(ownedGroup, 0)).toThrow();
        ownedGroup = 0;
        const components = join(root, 'components');
        const entries = await readdir(components);
        expect(entries.filter((name) => name.startsWith('.download-'))).toEqual([]);
        if (kind === 'mysql-tar')
          await expect(access(join(components, 'mysql-8.4.7-linux-x64'))).rejects.toMatchObject({
            code: 'ENOENT'
          });
        if (kind === 'mysql-dpkg')
          await expect(
            access(join(components, 'libaio-0.3.113-4-linux-x64'))
          ).rejects.toMatchObject({ code: 'ENOENT' });
        if (kind === 'search-tar') {
          const search = join(
            components,
            newSearchInstallation(12345).directory.split('/').at(-1)!
          );
          expect((await readdir(search)).filter((name) => name.startsWith('.extract-'))).toEqual(
            []
          );
        }
      },
      30000
    );

    it.each(['mysql', 'search'] as const)(
      'keeps %s staging when the owned extractor cannot be reclaimed',
      async (kind) => {
        const root = await mkdtemp(join(tmpdir(), 'mar-extract-retain-'));
        roots.push(root);
        const bin = join(root, 'bin');
        await mkdir(bin);
        await writeFile(
          join(bin, 'tar'),
          `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf '%s' "$$" > "$MAR_EXTRACT_PID"\nwhile :; do /bin/sleep 1; done\n`,
          { mode: 0o700 }
        );
        await writeFile(join(bin, 'dpkg-deb'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        vi.stubEnv('PATH', bin);
        const pidPath = join(root, 'extract.pid');
        vi.stubEnv('MAR_EXTRACT_PID', pidPath);
        vi.mocked(downloadPinnedFile).mockImplementation(async (_url, _digest, destination) => {
          await writeFile(destination, 'fixture archive');
        });
        const controller = new AbortController();
        const operation =
          kind === 'search'
            ? prepareSearchInstallation(
                root,
                'fixture',
                newSearchInstallation(12345),
                controller.signal
              )
            : prepareMysqlInstallation(root, undefined, controller.signal);
        const outcome = operation.then(
          () => undefined,
          (error: unknown) => error
        );
        await vi.waitFor(async () => {
          ownedGroup = Number(await readFile(pidPath, 'utf8'));
          expect(ownedGroup).toBeGreaterThan(1);
        });
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === -ownedGroup && signal === 'SIGKILL')
            throw Object.assign(new Error('fixture'), { code: 'EPERM' });
          return originalKill(pid, signal);
        });
        controller.abort();
        expect(await outcome).toMatchObject({ message: 'QUICK_START_NODE_RECLAIM_FAILED' });
        const components = join(root, 'components');
        if (kind === 'mysql') {
          expect((await readdir(components)).some((name) => name.startsWith('.download-'))).toBe(
            true
          );
          await access(join(components, 'mysql-8.4.7-linux-x64'));
        } else {
          const search = join(root, newSearchInstallation(12345).directory);
          expect((await readdir(search)).some((name) => name.startsWith('.extract-'))).toBe(true);
        }
        originalKill(-ownedGroup, 'SIGKILL');
        await vi.waitFor(() => expect(() => originalKill(ownedGroup, 0)).toThrow());
        ownedGroup = 0;
      },
      30000
    );
  }
);
