import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

/** Fresh package build; callers must serialize builds targeting the same dist directory. */
export async function buildAgent(): Promise<void> {
  const cwd = process.cwd();
  await execute(process.execPath, ['../scripts/clean-build-output.mjs', 'dist'], { cwd });
  await execute(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
    cwd
  });
}
