import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

function runCli(entrypoint, args) {
  return execFileSync(process.execPath, [fileURLToPath(new URL(entrypoint, root)), ...args], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    timeout: 10_000
  });
}

test('compiled Node CLI reports health on the current platform without configuration', () => {
  assert.deepEqual(JSON.parse(runCli('mar-node/dist/main.js', ['status'])), {
    status: 'ok',
    platform: process.platform
  });
});

test('compiled Agent CLI exposes help without model credentials', () => {
  assert.match(runCli('mar-agent/dist/cli/main.js', ['--help']), /^maragent - MAR coding agent/u);
});

test('compiled Node marctl entrypoint resolves the workspace CLI without a Server', () => {
  const { version } = JSON.parse(readFileSync(new URL('marctl/package.json', root), 'utf8'));
  assert.equal(runCli('mar-node/dist/marctl.js', ['--version']).trim(), `marctl ${version}`);
});
