import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runCiPipeline } from './ci-release-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const runId = (process.env.MAR_TEST_RUN_ID ?? `ci-product-${Date.now()}-${process.pid}`).replace(
  /[^a-zA-Z0-9_-]/gu,
  '-'
);
const args = process.argv.slice(2);
const release = args[0] === '--release';
const commonManifest = release ? args[1] : undefined;
if (release && !commonManifest) throw new Error('CI_COMMON_MANIFEST_REQUIRED');

function run(command, commandArguments, testRunId = runId) {
  execFileSync(command, commandArguments, {
    cwd: root,
    env: { ...process.env, CI: '1', MAR_TEST_RUN_ID: testRunId },
    stdio: 'inherit',
    timeout: 3_600_000
  });
}

if (execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '')
  throw new Error('CI_SOURCE_DIRTY');
await runCiPipeline({
  root,
  runId,
  release,
  commonManifest,
  run,
  sourceCommit: () =>
    execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  makeTemp: () => mkdtemp(resolve(tmpdir(), 'mar-product-ci-')),
  removeTemp: (directory) => rm(directory, { recursive: true, force: true })
});
