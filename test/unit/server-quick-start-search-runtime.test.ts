import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  managedSearchSupported,
  newSearchInstallation,
  prepareSearchInstallation
} from '../../mar-server/src/quick-start/search-installation.js';
import { startManagedSearch } from '../../mar-server/src/quick-start/search-runtime.js';

const current = newSearchInstallation(0);
const previous = {
  ...current,
  version: '57ff753ad416b7bf27e59d72ae8c7cac93b56be4',
  directory: 'components/searxng-57ff753ad-linux-x64'
};

it.skipIf(!managedSearchSupported())(
  'restores or refreshes candidate settings from the selected installation on retry',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-search-settings-'));
    const oldTarget = join(root, previous.directory);
    const candidate = join(root, current.directory);
    try {
      await mkdir(oldTarget, { recursive: true });
      await writeFile(join(oldTarget, '.owner'), 'other-deployment\n');
      await writeFile(join(oldTarget, 'settings.yml'), 'general:\n  instance_name: Existing\n');
      await mkdir(join(candidate, 'venv/bin'), { recursive: true });
      await mkdir(join(candidate, 'searx/searx'), { recursive: true });
      await writeFile(join(candidate, '.owner'), 'fixture\n');
      await writeFile(join(candidate, '.mar-installed'), `${current.version}\n`);
      await writeFile(join(candidate, 'venv/bin/python'), '');
      await writeFile(join(candidate, 'searx/searx/webapp.py'), '');
      const settings = join(candidate, 'settings.yml');
      await writeFile(settings, 'stale candidate');

      await expect(
        prepareSearchInstallation(root, 'fixture', current, undefined, previous)
      ).rejects.toThrow('QUICK_START_SEARCH_COMPONENT_NOT_OWNED');
      expect(await readFile(settings, 'utf8')).toBe('stale candidate');

      await writeFile(join(oldTarget, '.owner'), 'fixture\n');
      await prepareSearchInstallation(root, 'fixture', current, undefined, previous);
      expect(await readFile(settings, 'utf8')).toBe('general:\n  instance_name: Existing\n');
      expect(await readFile(join(oldTarget, 'settings.yml'), 'utf8')).toBe(
        await readFile(settings, 'utf8')
      );

      await unlink(settings);
      await prepareSearchInstallation(root, 'fixture', current, undefined, previous);
      expect(await readFile(settings, 'utf8')).toBe('general:\n  instance_name: Existing\n');

      await unlink(join(oldTarget, 'settings.yml'));
      await prepareSearchInstallation(root, 'fixture', current, undefined, previous);
      expect(await readFile(settings, 'utf8')).toContain('formats: [html, json]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.skipIf(!managedSearchSupported()).each([
  { installation: current, requireGracefulExit: true },
  { installation: current, requireGracefulExit: false },
  { installation: previous, requireGracefulExit: false }
])(
  'reclaims owned search workers after leader exit ($installation.version, strict stop: $requireGracefulExit)',
  async ({ installation, requireGracefulExit }) => {
    const root = await mkdtemp(join(tmpdir(), 'mar-search-worker-'));
    const target = join(root, installation.directory);
    let leader = 0;
    let worker = 0;
    const alive = async (pid: number) => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    try {
      await mkdir(join(target, 'venv/bin'), { recursive: true });
      await mkdir(join(target, 'searx/searx'), { recursive: true });
      await writeFile(join(target, '.owner'), 'fixture\n');
      await writeFile(join(target, '.mar-installed'), `${installation.version}\n`);
      await writeFile(join(target, 'searx/searx/webapp.py'), '');
      await writeFile(join(target, 'settings.yml'), '');
      await writeFile(
        join(target, 'venv/bin/python'),
        `#!${process.execPath}
const fs=require('node:fs'); const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(join(root, 'pids'))}, JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);
`,
        { mode: 0o700 }
      );
      const search = await startManagedSearch(root, installation, 'fixture');
      for (let i = 0; i < 100 && !worker; i++) {
        try {
          [leader, worker] = JSON.parse(await readFile(join(root, 'pids'), 'utf8'));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(leader && worker).toBeTruthy();
      process.kill(leader, 'SIGKILL');
      await search.exited;
      expect(await alive(worker)).toBe(true);
      if (requireGracefulExit)
        await expect(search.stop({ requireGracefulExit })).rejects.toThrow(
          'QUICK_START_SEARCH_STOP_FAILED'
        );
      else await search.stop();
      expect(await alive(worker)).toBe(false);
    } finally {
      if (leader) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {
          // The process group may already be gone after a completed stop.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30000
);
