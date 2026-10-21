import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { productCheckCommands } from './product-ci.mjs';

const root = resolve(import.meta.dirname, '..');
if (process.argv.length > 2) throw new Error('CI_ARGUMENT_INVALID');
const runId = (process.env.MAR_TEST_RUN_ID ?? `ci-product-${Date.now()}-${process.pid}`).replace(
  /[^a-zA-Z0-9_-]/gu,
  '-'
);
if (execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '')
  throw new Error('CI_SOURCE_DIRTY');
for (const [, command, args] of productCheckCommands(runId)) {
  execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, CI: '1', MAR_TEST_RUN_ID: runId },
    stdio: 'inherit',
    timeout: 3_600_000
  });
}
