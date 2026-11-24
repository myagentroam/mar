import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

// The Node Run supplies the root. Use the same registry and stop protocol as
// the pinned CLI's close-all, across all workspace directories in this root.
const root = process.argv[2];
if (!root) throw new Error('A browser CLI scope root is required.');
process.env.PWTEST_DAEMON_SESSION_DIR = join(root, 'd');
process.env.PWTEST_SOCKETS_DIR = root;
process.env.PWTEST_CLI_GLOBAL_CONFIG = root;
const require = createRequire(import.meta.url);
const playwright = createRequire(require.resolve('playwright/package.json'));
const core = dirname(playwright.resolve('playwright-core/package.json'));
const { Registry } = require(join(core, 'lib/tools/cli-client/registry.js'));
const { Session } = require(join(core, 'lib/tools/cli-client/session.js'));
const dashboard = join(core, 'lib/entry/dashboardApp.js');
const execute = promisify(execFile);
let settleUntil = 0;

function launchStillRunning(name) {
  const match = /^start-([1-9]\d*)-[a-zA-Z0-9]+$/u.exec(name);
  if (!match) return false;
  try {
    process.kill(Number(match[1]), 0);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') return true;
    return false;
  }
}

for (;;) {
  const files = await readdir(root);
  const launches = files.filter((name) => name.startsWith('start-'));
  const starting = launches.some(launchStillRunning);
  // Forced termination can leave a marker after the wrapper exits. Recheck
  // briefly for a final registry publication, without waiting on a dead PID.
  if (!starting && launches.length > 0 && settleUntil === 0) settleUntil = Date.now() + 500;
  const registry = await Registry.load();
  const stops = [...registry.entryMap().values()].flat().map((entry) => new Session(entry).stop());
  if (files.includes('dashboard-used'))
    stops.push(execute(process.execPath, [dashboard, '--kill']));
  const outcomes = await Promise.allSettled(stops);
  if (!starting && Date.now() >= settleUntil) {
    if (outcomes.some(({ status }) => status === 'rejected'))
      throw new Error('A browser CLI session could not be closed.');
    break;
  }
  await setTimeout(100);
}
