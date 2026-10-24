import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { e2eOptions, smokeBuildFiles, assertSmokeReport } from './test-e2e-policy.mjs';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from '../test/e2e/support/playwright-test-database.ts';
import { PLAYWRIGHT_LICENSE_PRODUCT_UUID } from '../test/e2e/support/playwright-test-license.ts';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const options = e2eOptions(process.argv.slice(2));
process.env.MAR_E2E_MODE = options.mode;
process.env.MAR_E2E_LIST = options.list ? '1' : '0';
const testRunId = (process.env.MAR_TEST_RUN_ID ?? `e2e-${Date.now()}-${process.pid}`).replace(
  /[^a-zA-Z0-9_-]/gu,
  '_'
);
process.env.MAR_TEST_RUN_ID = testRunId;
if (!options.list && options.mode === 'smoke') {
  for (const file of smokeBuildFiles) {
    try {
      await access(resolve(root, file));
    } catch {
      throw new Error(`SMOKE_BUILD_REQUIRED: ${file}`);
    }
  }
}

let child;
let interrupted = false;
const forwardSignal = (signal) => {
  interrupted = true;
  if (child && !child.killed) child.kill(signal);
};
const onInterrupt = () => forwardSignal('SIGINT');
const onTerminate = () => forwardSignal('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);

async function run(command, arguments_) {
  child = spawn(command, arguments_, {
    cwd: root,
    // Compiled-artifact smoke must not inherit source loaders or development exports.
    env: { ...process.env, ...(options.mode === 'smoke' ? { NODE_OPTIONS: '' } : {}) },
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'pnpm'
  });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

let exitCode = 1;
let database;
let databaseCreated = false;
let licenseHostCreated = false;
const licenseHostPath = resolve(root, `test/runs/playwright-license-host-${testRunId}.txt`);
const reportPath = resolve(root, `test/runs/playwright-results-${testRunId}.json`);
try {
  if (!options.list && options.mode === 'full') {
    const buildCode = await run('pnpm', ['--filter', '@myagentroam/web-console', 'build']);
    if (buildCode !== 0 || interrupted) throw new Error('E2E_WEB_BUILD_FAILED');
  }
  if (!options.list && !['integration', 'fixtures'].includes(options.mode)) {
    database = resolvePlaywrightTestDatabase(testRunId);
    await createPlaywrightTestDatabase(database);
    databaseCreated = true;
    await mkdir(resolve(root, 'test/runs'), { recursive: true });
    await writeFile(licenseHostPath, PLAYWRIGHT_LICENSE_PRODUCT_UUID, { flag: 'wx' });
    licenseHostCreated = true;
  }
  if (interrupted) throw new Error('E2E_INTERRUPTED');
  if (!options.list) await rm(reportPath, { force: true });
  exitCode = await run(process.execPath, [
    ...(options.mode === 'smoke' ? [] : ['--conditions=development']),
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.config.mts',
    ...options.arguments
  ]);
  if (interrupted) exitCode = 1;
  if (exitCode === 0 && options.mode === 'smoke' && !options.list)
    assertSmokeReport(JSON.parse(await readFile(reportPath, 'utf8')));
} finally {
  try {
    if (databaseCreated) await dropPlaywrightTestDatabase(database);
  } finally {
    if (licenseHostCreated) await rm(licenseHostPath, { force: true });
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

process.exitCode = exitCode;
