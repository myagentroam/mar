import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  managedSearchSupported,
  newSearchInstallation
} from '../../mar-server/src/quick-start/search-installation.js';
import { startManagedSearch } from '../../mar-server/src/quick-start/search-runtime.js';

it.skipIf(!managedSearchSupported())(
  'reclaims owned search workers even after the leader exits',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-search-worker-'));
    const installation = newSearchInstallation(0);
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
      await search.stop();
      expect(await alive(worker)).toBe(false);
    } finally {
      if (leader) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30000
);
