import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const product = join(dirname(fileURLToPath(import.meta.url)), '../..');
const binaries = join(product, 'packages/binaries');

test('native candidate build refuses to replace an existing output directory', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The candidate recipe requires Linux and Docker.');
  const root = await mkdtemp(join(tmpdir(), 'mar-native-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'marker');
  await writeFile(marker, 'keep');
  const script = join(binaries, 'vendor/tigervnc/build-linux-bookworm-x64.sh');
  assert.throws(() => execFileSync('bash', [script, root], { stdio: 'pipe' }));
  assert.equal(await readFile(marker, 'utf8'), 'keep');
});

test('binaries package retains both native build inputs and the actual static JPEG license materials', async (t) => {
  const cache = await mkdtemp(join(tmpdir(), 'mar-binaries-pack-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const windows = process.platform === 'win32';
  const result = JSON.parse(
    execFileSync(
      windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm',
      windows
        ? ['/d', '/s', '/c', `npm pack --json --ignore-scripts --pack-destination "${cache}"`]
        : ['pack', '--json', '--ignore-scripts', '--pack-destination', cache],
      {
        cwd: binaries,
        env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
        encoding: 'utf8'
      }
    )
  );
  const files = new Set(result[0].files.map((item) => item.path));
  const targetResult = JSON.parse(
    execFileSync(
      windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm',
      windows
        ? ['/d', '/s', '/c', `npm pack --json --ignore-scripts --pack-destination "${cache}"`]
        : ['pack', '--json', '--ignore-scripts', '--pack-destination', cache],
      {
        cwd: join(product, 'packages/binaries-linux-x64'),
        env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
        encoding: 'utf8'
      }
    )
  );
  const targetFiles = new Set(targetResult[0].files.map((item) => item.path));
  for (const path of [
    'vendor/tigervnc/manifest.json',
    'vendor/tigervnc/source/tigervnc-b555312d70d7ff017f866649a7e7167af4eb8fca.tar.gz',
    'vendor/tigervnc/patches/mar-input-cleanup.patch',
    'vendor/tigervnc/LICENCE.TXT',
    'vendor/tigervnc/build-x0vncserver.sh',
    'vendor/tigervnc/build-linux-bookworm-x64.sh',
    'vendor/tigervnc/bookworm-x64-build-in-container.sh',
    'vendor/tigervnc/bookworm-x64-packages.lock',
    'vendor/tigervnc/licenses/libjpeg-turbo-2.1.5/debian-copyright',
    'vendor/tigervnc/licenses/libjpeg-turbo-2.1.5/LICENSE.md',
    'vendor/tigervnc/licenses/libjpeg-turbo-2.1.5/README.ijg',
    'vendor/tigervnc/licenses/libjpeg-turbo-2.1.5/README.md',
    'vendor/x11-topology/build-x11-topology.sh',
    'vendor/x11-topology/x11-topology.c',
    'vendor/x11-topology/LICENSE'
  ])
    assert.ok(files.has(path), `missing package file: ${path}`);
  const manifest = JSON.parse(
    await readFile(join(binaries, 'vendor/tigervnc/manifest.json'), 'utf8')
  );
  assert.deepEqual(Object.keys(manifest.targets), ['linux-x64']);
  for (const [target, entry] of Object.entries(manifest.targets)) {
    assert.equal(entry.server, `${target}/x0vncserver`);
    assert.equal(entry.topology, `${target}/x11-topology`);
    for (const path of [entry.server, entry.topology])
      assert.ok(targetFiles.has(`vendor/tigervnc/${path}`), `missing target executable: ${path}`);
    for (const path of [entry.server, entry.topology])
      assert.ok(
        !files.has(`vendor/tigervnc/${path}`),
        `executable leaked into entry package: ${path}`
      );
  }
  if (!windows) {
    execFileSync('tar', ['-xzf', join(cache, targetResult[0].filename), '-C', cache]);
    const vendor = join(cache, 'package/vendor/tigervnc');
    for (const path of Object.values(manifest.targets['linux-x64']))
      await access(join(vendor, path), constants.X_OK);
    if (process.platform === 'linux' && process.arch === 'x64')
      assert.match(
        execFileSync(join(vendor, manifest.targets['linux-x64'].server), ['--version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        }),
        /1\.16\.2/u
      );
  }
  const license = await readFile(
    join(binaries, 'vendor/tigervnc/licenses/libjpeg-turbo-2.1.5/README.ijg'),
    'utf8'
  );
  assert.match(license, /Independent JPEG Group/u);
  assert.match(license, /copyright/u);
});
