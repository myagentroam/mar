import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const bin = new URL('../../scripts/browser-bin/', import.meta.url);
const sharedResource = new URL('shared-resource.mjs', bin);

test('canceling auto-attach before daemon startup allows a retry in the same Execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mar-browser-cli-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'launch');
  await mkdir(join(root, 'active'));
  const fixture = join(root, 'pause-attach.cjs');
  // Pause the second registry lookup (with the lock held) before Playwright installs its SIGTERM handler.
  await writeFile(
    fixture,
    `const { createRequire } = require('node:module');
     const { dirname, join } = require('node:path');
     const fromCli = createRequire(new URL(${JSON.stringify(sharedResource.href)}));
     const core = dirname(fromCli.resolve('playwright-core/package.json', {
       paths: [dirname(fromCli.resolve('playwright/package.json'))]
     }));
     const api = join(core, 'lib', 'tools', 'cli-client');
     const { Registry } = require(join(api, 'registry.js'));
     const { Session } = require(join(api, 'session.js'));
     let calls = 0;
     Registry.load = async () => {
       if (++calls === 2 && process.connected) {
         process.channel.ref();
         process.send('before daemon');
         await new Promise(() => {});
       }
       return { entry() {} };
     };
     Session.startDaemon = async () => console.log('retried attach');`
  );
  const env = { ...process.env, MAR_PLAYWRIGHT_CLI_ROOT: root };
  const args = [
    '--require',
    fixture,
    '--import',
    new URL('cancel-launch.mjs', bin).href,
    '--import',
    sharedResource.href
  ];
  const child = spawn(process.execPath, [...args, '--eval', ''], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    timeout: 8_000
  });
  const closed = once(child, 'close');
  try {
    const [phase] = await once(child, 'message', { signal: AbortSignal.timeout(5_000) });
    assert.equal(phase, 'before daemon');
    assert((await stat(lock)).isDirectory());
    child.send('cancel');
    assert.deepEqual(await closed, [1, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }

  await assert.rejects(stat(lock), { code: 'ENOENT' });
  // A new launcher must acquire the same lock immediately. The eval claims it
  // again after normal release, like a concurrent launcher, and must keep it on exit.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [...args, '--eval', `require('node:fs').mkdirSync(${JSON.stringify(lock)})`],
    { cwd: root, env, timeout: 5_000 }
  );
  assert.equal(stdout.trim(), 'retried attach');
  assert((await stat(lock)).isDirectory());
});
