import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { unexpectedNpmPackageFiles } from '../../scripts/check-release-artifacts.mjs';

const product = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const targets = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
];
const nativeTarget = `${process.platform}-${process.arch}`;

function npm(args, cwd, cache) {
  const windows = process.platform === 'win32';
  const quote = (arg) => `"${arg.replaceAll('"', '\\"')}"`;
  return execFileSync(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm',
    windows ? ['/d', '/s', '/c', ['npm', ...args].map(quote).join(' ')] : args,
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' }
    }
  );
}

test('npm platform packages contain only their target and install through the shared entry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mar-platform-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(product, 'packages/binaries');
  const entryPack = JSON.parse(
    npm(['pack', '--json', '--ignore-scripts', '--pack-destination', root], entry, root)
  )[0];
  assert.deepEqual(
    unexpectedNpmPackageFiles(
      '@myagentroam/binaries',
      entryPack.files.map((file) => file.path)
    ),
    []
  );
  const binaryPath =
    /^vendor\/(?:ripgrep|ctags|tigervnc|ultravnc)\/(linux|darwin|win32)-(x64|arm64)\//u;
  assert.equal(
    entryPack.files.some((file) => binaryPath.test(file.path)),
    false
  );
  let selected;
  const packages = new Map();
  for (const target of targets) {
    const directory = join(product, `packages/binaries-${target}`);
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.deepEqual([metadata.os[0], metadata.cpu[0]], target.split('-'));
    packages.set(metadata.name, metadata);
    const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', root];
    if (target !== nativeTarget) args.push('--dry-run');
    const packed = JSON.parse(npm(args, directory, root))[0];
    assert.deepEqual(
      unexpectedNpmPackageFiles(
        metadata.name,
        packed.files.map((file) => file.path)
      ),
      []
    );
    const assets = packed.files.map((file) => file.path).filter((path) => binaryPath.test(path));
    assert.ok(assets.some((path) => path.includes(`/${target}/rg`)));
    assert.ok(assets.every((path) => path.includes(`/${target}/`)));
    for (const asset of assets) {
      const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
      assert.equal(
        hash(await readFile(join(directory, asset))),
        hash(await readFile(join(entry, asset))),
        `platform asset differs from source: ${asset}`
      );
    }
    if (target === nativeTarget) selected = packed;
  }
  if (!selected) return;
  const install = join(root, 'install');
  await mkdir(install);
  await writeFile(join(install, 'package.json'), '{"private":true}\n');
  const archive = await readFile(join(root, selected.filename));
  const requests = [];
  const registry = createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1));
    requests.push(name);
    if (name === 'native.tgz') return response.end(archive);
    const metadata = packages.get(name);
    if (!metadata) {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        name,
        'dist-tags': { latest: metadata.version },
        versions: {
          [metadata.version]: {
            ...metadata,
            dist: { tarball: `http://127.0.0.1:${registry.address().port}/native.tgz` }
          }
        }
      })
    );
  });
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  try {
    const args = [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry',
      `http://127.0.0.1:${registry.address().port}`,
      `--@myagentroam:registry=http://127.0.0.1:${registry.address().port}`,
      join(root, entryPack.filename)
    ];
    const windows = process.platform === 'win32';
    const child = spawn(
      windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm',
      windows ? ['/d', '/s', '/c', ['npm', ...args].map((arg) => `"${arg}"`).join(' ')] : args,
      {
        cwd: install,
        env: { ...process.env, npm_config_cache: root, npm_config_update_notifier: 'false' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 0, output);
  } finally {
    await new Promise((resolve, reject) =>
      registry.close((error) => (error ? reject(error) : resolve()))
    );
  }
  const installed = await readdir(join(install, 'node_modules/@myagentroam'));
  assert.deepEqual(
    installed.sort(),
    ['binaries', `binaries-${nativeTarget}`].sort(),
    JSON.stringify(requests)
  );
  const requireFromEntry = createRequire(
    join(install, 'node_modules/@myagentroam/binaries/package.json')
  );
  assert.equal(
    requireFromEntry.resolve(`@myagentroam/binaries-${nativeTarget}/package.json`),
    join(install, `node_modules/@myagentroam/binaries-${nativeTarget}/package.json`)
  );
  const executable = join(
    install,
    `node_modules/@myagentroam/binaries-${nativeTarget}/vendor/ripgrep/${nativeTarget}`,
    process.platform === 'win32' ? 'rg.exe' : 'rg'
  );
  assert.match(execFileSync(executable, ['--version'], { encoding: 'utf8' }), /ripgrep 15\.1\.0/u);
});
