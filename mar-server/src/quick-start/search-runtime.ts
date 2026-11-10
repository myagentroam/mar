import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SearchInstallation } from './config.js';
import { assertSearchInstallation } from './search-installation.js';
import { probeSearchEndpoint } from './search-probe.js';
import {
  ownedGroupHasLiveProcesses,
  signalOwnedProcessGroup,
  waitForOwnedGroupExit
} from './owned-process-group.js';

/** Owns the one local Granian process and its workers; never manages external search. */
export async function startManagedSearch(
  root: string,
  installation: SearchInstallation,
  deploymentId: string
) {
  const target = resolve(root, installation.directory);
  if ((await readFile(resolve(target, '.mar-installed'), 'utf8')) !== `${installation.version}\n`)
    throw new Error('QUICK_START_SEARCH_NOT_PREPARED');
  await assertSearchInstallation(root, installation, deploymentId);
  const portCheck = createServer();
  await new Promise<void>((resolveReady, reject) => {
    portCheck.once('error', reject);
    portCheck.listen(installation.port, '127.0.0.1', resolveReady);
  });
  await new Promise<void>((resolveClose, reject) =>
    portCheck.close((error) => (error ? reject(error) : resolveClose()))
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PYTHON|SEARXNG_)/iu.test(key)) delete env[key];
  const child = spawn(
    resolve(target, 'venv/bin/python'),
    [
      '-m',
      'granian',
      '--interface',
      'wsgi',
      '--host',
      '127.0.0.1',
      '--port',
      String(installation.port),
      '--workers',
      '1',
      'searx.webapp:app'
    ],
    {
      cwd: resolve(target, 'searx'),
      env: {
        ...env,
        PYTHONPATH: resolve(target, 'searx'),
        SEARXNG_SETTINGS_PATH: resolve(target, 'settings.yml')
      },
      stdio: 'ignore',
      detached: true,
      windowsHide: true
    }
  );
  let ended = false;
  const exited = new Promise<number | null>((done) => {
    child.once('error', () => {
      ended = true;
      done(null);
    });
    child.once('exit', (code) => {
      ended = true;
      done(code);
    });
  });
  let stopping: Promise<void> | undefined;
  return {
    exited,
    endpoint: `http://127.0.0.1:${installation.port}`,
    async ready(signal?: AbortSignal): Promise<boolean> {
      for (let i = 0; i < 10 && !ended; i++) {
        signal?.throwIfAborted();
        if (await probeSearchEndpoint(`http://127.0.0.1:${installation.port}`)) return !ended;
        await delay(500);
      }
      return false;
    },
    stop: () =>
      (stopping ??= (async () => {
        const pid = child.pid;
        if (pid === undefined) {
          await exited;
          return;
        }
        try {
          if (!ended) child.kill('SIGTERM');
          else if (await ownedGroupHasLiveProcesses(pid)) signalOwnedProcessGroup(pid, 'SIGTERM');
          let cleared = await waitForOwnedGroupExit(pid, 15_000);
          if (!cleared) {
            signalOwnedProcessGroup(pid, 'SIGKILL');
            cleared = await waitForOwnedGroupExit(pid, 5_000);
            if (!cleared) throw new Error('QUICK_START_SEARCH_RECLAIM_FAILED');
            await exited;
            throw new Error('QUICK_START_SEARCH_FORCED_STOP');
          }
          const result = await Promise.race([exited, delay(5_000, undefined, { ref: false })]);
          if (result === undefined) throw new Error('QUICK_START_SEARCH_RECLAIM_FAILED');
          if (result !== 0 && result !== null) throw new Error('QUICK_START_SEARCH_STOP_FAILED');
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('QUICK_START_SEARCH_'))
            throw error;
          throw new Error('QUICK_START_SEARCH_RECLAIM_FAILED');
        }
      })())
  };
}
