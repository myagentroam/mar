import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createBrowserLauncher } from '../../src/browser/browser-launcher.js';
import { recordBrowserRun } from '../../src/browser/browser-run-directories.js';

// Real locks from isolated Chromium children. No shared Node or profile is touched.
const root = await mkdtemp(join(tmpdir(), 'mar-browser-run-recovery-'));
const runs = join(root, 'runs');
const profiles = join(root, 'profiles');
const sweep = () =>
  createBrowserLauncher(runs, profiles, (error) => {
    throw error;
  }).sweepOrphans();

try {
  await mkdir(runs);
  const unmarked = await mkdtemp(join(runs, 'browser-'));
  await mkdir(join(unmarked, 'profile'));
  const invalid = await mkdtemp(join(runs, 'browser-'));
  await writeFile(join(invalid, 'profile-owner'), '../profile\n');
  await mkdir(join(runs, 'profile-data-extension'));
  const preserved = [basename(unmarked), basename(invalid), 'profile-data-extension'].sort();
  // The previous Node died during recursive removal, after deleting the owner record.
  const interruptedRemoval = await mkdtemp(join(runs, 'retired-browser-'));
  await writeFile(join(interruptedRemoval, 'remaining-download'), 'leftover');
  await sweep();
  assert.deepEqual((await readdir(runs)).sort(), preserved);
  for (const mode of ['temporary', 'durable', 'legacy'] as const) {
    if (mode === 'legacy' && process.platform === 'win32') continue;
    const run = await mkdtemp(join(runs, 'browser-'));
    const durable = mode === 'durable' ? join(profiles, 'a'.repeat(64), 'data') : undefined;
    const profile = durable ?? join(run, 'profile');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'preserved'), 'profile data');
    await mkdir(join(run, 'downloads'));
    await writeFile(join(run, 'downloads', 'unfinished'), 'download data');
    const child = spawn(
      chromium.executablePath(),
      [
        '--headless',
        '--no-sandbox',
        '--no-first-run',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank'
      ],
      { stdio: 'ignore' }
    );
    const exited = once(child, 'exit');
    try {
      await Promise.race([
        exited.then(() => {
          throw new Error('Chromium exited before startup');
        }),
        waitForPort(profile)
      ]);
      if (mode !== 'legacy') await recordBrowserRun(run, profiles, durable);
      await sweep();
      assert.equal(await readFile(join(run, 'downloads', 'unfinished'), 'utf8'), 'download data');
      child.kill('SIGKILL');
      await exited;
      await sweep();
      assert.deepEqual((await readdir(runs)).sort(), preserved);
      if (durable) assert.equal(await readFile(join(durable, 'preserved'), 'utf8'), 'profile data');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
    }
  }
  console.log(
    `Browser runs: preserved live Chromium and reclaimed abandoned runs on ${process.platform}.`
  );
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

async function waitForPort(profile: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    if (/^\d+\r?\n/u.test(port)) return;
    await delay(50);
  }
  throw new Error('Chromium did not start');
}
