import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

test('Node internal staging rewrites supported imports and rejects unknown internal exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-node-stage-'));
  const put = async (path, value) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  };
  try {
    await mkdir(join(root, 'scripts'));
    await copyFile(
      resolve(import.meta.dirname, '../../scripts/stage-node-internals.mjs'),
      join(root, 'scripts/stage-node-internals.mjs')
    );
    await put('mar-node/package.json', JSON.stringify({ version: '1.2.3' }));
    await put('mar-node/src/terminal-pty-host.mjs', 'export {};');
    await put('mar-node/src/terminal-pty-tree.mjs', 'export {};');
    await put('packages/code-navigation/dist/index.js', 'export {};');
    await put('packages/code-navigation/dist/symbol-navigation.js', 'export {};');
    await put('marctl/src/cli.mjs', 'export {};');
    await put('marctl/bin/marctl.mjs', 'export {};');
    const entry = join(root, 'mar-node/dist/entry.js');
    await put(
      'mar-node/dist/entry.js',
      "import '@myagentroam/code-navigation';\nimport '@myagentroam/marctl/bin/marctl.mjs';\n"
    );
    const script = join(root, 'scripts/stage-node-internals.mjs');
    execFileSync(process.execPath, [script]);
    const output = await readFile(entry, 'utf8');
    assert.equal(
      await readFile(join(root, 'mar-node/dist/terminal-pty-host.mjs'), 'utf8'),
      'export {};'
    );
    assert.equal(
      await readFile(join(root, 'mar-node/dist/terminal-pty-tree.mjs'), 'utf8'),
      'export {};'
    );
    assert.match(output, /\.\/code-navigation\/index\.js/u);
    assert.match(output, /\.\/marctl\/bin\/marctl\.mjs/u);
    assert.equal(
      JSON.parse(await readFile(join(root, 'mar-node/dist/marctl/package.json'), 'utf8')).version,
      '1.2.3'
    );
    await writeFile(entry, "import '@myagentroam/code-navigation/new-export';\n");
    assert.throws(
      () => execFileSync(process.execPath, [script], { stdio: 'pipe' }),
      /Unstaged internal dependency/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
