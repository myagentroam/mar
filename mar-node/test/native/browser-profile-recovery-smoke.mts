import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BrowserNodeService } from '../../src/browser/browser-node-service.js';
import { BrowserProfiles } from '../../src/browser/browser-profiles.js';

// Uses an isolated profile and kills only the Chromium process spawned below.
// Run this unchanged on an exclusive Windows test host to exercise its lock file.
const root = await mkdtemp(join(tmpdir(), 'mar-browser-profile-recovery-'));
const scope = { workspaceId: 'profile-recovery', userId: 1 };
const errors: unknown[] = [];
const abandoned = await new BrowserProfiles({
  root: join(root, 'profiles'),
  isUnused: async () => false,
  failed: (error) => errors.push(error)
}).acquire(scope);
const retention = join(dirname(abandoned.path), 'retention.json');
const profileId = (JSON.parse(await readFile(retention, 'utf8')) as { id: string }).id;
const processOwner = spawn(
  chromium.executablePath(),
  [
    '--headless',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${abandoned.path}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
);
const exited = once(processOwner, 'exit');
const generation = randomUUID();
let service: BrowserNodeService | undefined;
try {
  const devtoolsPort = join(abandoned.path, 'DevToolsActivePort');
  await Promise.race([
    exited.then(() => {
      throw new Error('Chromium exited before startup');
    }),
    (async () => {
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        const port = await readFile(devtoolsPort, 'utf8').catch(() => '');
        if (/^\d+\r?\n/u.test(port)) return;
        await delay(50);
      }
      throw new Error('Chromium did not start');
    })()
  ]);
  service = new BrowserNodeService({
    root,
    generation,
    requireWorkspace: (id) => assert.equal(id, scope.workspaceId),
    workspacePath: () => root,
    relay: () => undefined,
    failed: (error) => errors.push(error)
  });
  const execute = (command: object) =>
    service!.execute('resource', {
      generation,
      __requestUserId: scope.userId,
      payload: { workspaceId: scope.workspaceId, command }
    });
  const open = () => execute({ action: 'open', preserveLogin: true });
  await assert.rejects(open, /BROWSER_PROFILE_BUSY/u);
  processOwner.kill('SIGKILL');
  await exited;
  const { browserId } = (await open()) as { browserId: string };
  assert(browserId);
  await execute({ action: 'close', browserId });
  assert.deepEqual(JSON.parse(await readFile(retention, 'utf8')).id, profileId);
  assert.equal(JSON.parse(await readFile(retention, 'utf8')).open, false);
  assert.deepEqual(errors, []);
  console.log(
    `Browser Profile: verified live lock and recovery after Chromium process termination on ${process.platform}.`
  );
} finally {
  if (processOwner.exitCode === null && processOwner.signalCode === null)
    processOwner.kill('SIGKILL');
  await exited.catch(() => undefined);
  await service?.shutdown();
  await rm(root, { force: true, recursive: true, maxRetries: 5 });
}
