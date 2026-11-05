import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkNodeDeploySource } from '../../scripts/check-node-deploy-source.mjs';

test('Node deploy source verifies binaries and embedded navigation and CLI against the build', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mar-node-deploy-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const stage = join(root, 'stage');
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  for (const [name, original, content] of [
    ['agent', 'mar-agent', 'dist/index.js'],
    ['protocol', 'packages/protocol', 'dist/index.js'],
    ['binaries', 'packages/binaries', 'vendor/ripgrep/linux-x64/rg']
  ]) {
    const target = `node_modules/@myagentroam/${name}`;
    await put(join(source, original, 'package.json'), '{"version":"1.0.0"}');
    await put(join(stage, target, 'package.json'), '{"version":"1.0.0"}');
    await put(join(source, original, content), 'fixture');
    await put(join(stage, target, content), 'fixture');
  }
  for (const [original, target] of [
    ['packages/code-navigation/dist/index.js', 'dist/code-navigation/index.js'],
    ['marctl/bin/marctl.mjs', 'dist/marctl/bin/marctl.mjs'],
    ['marctl/src/scp-worker.cjs', 'dist/marctl/src/scp-worker.cjs']
  ]) {
    await put(join(source, original), 'fixture');
    await put(join(stage, target), 'fixture');
  }
  await put(join(source, 'mar-node/package.json'), '{"version":"1.0.0"}');
  await put(join(stage, 'dist/marctl/package.json'), '{"version":"1.0.0"}');
  await checkNodeDeploySource(source, stage);
  for (const path of [
    'node_modules/@myagentroam/binaries/vendor/ripgrep/linux-x64/rg',
    'dist/code-navigation/index.js',
    'dist/marctl/src/scp-worker.cjs'
  ]) {
    await put(join(stage, path), 'mismatch');
    await assert.rejects(checkNodeDeploySource(source, stage), /NODE_DEPLOY_CONTENT_MISMATCH/u);
    await put(join(stage, path), 'fixture');
  }
  await put(join(stage, 'dist/marctl/package.json'), '{"version":"2.0.0"}');
  await assert.rejects(checkNodeDeploySource(source, stage), /NODE_DEPLOY_VERSION_MISMATCH/u);
});
