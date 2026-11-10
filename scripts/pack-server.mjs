import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

// Stage the already-built Server and its production workspace dependencies as one npm artifact.
const root = resolve(import.meta.dirname, '..');
const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination || process.argv.length !== 3)
  throw new Error('Usage: node scripts/pack-server.mjs <new-output-directory>');
await mkdir(destination, { recursive: false });
const temporary = await mkdtemp(resolve(tmpdir(), 'mar-server-pack-'));
try {
  const stage = resolve(temporary, 'server');
  await command('pnpm', [
    '--filter',
    '@myagentroam/server',
    '--config.node-linker=hoisted',
    'deploy',
    '--prod',
    stage
  ]);
  const artifact = resolve(temporary, 'artifact');
  await mkdir(artifact);
  for (const name of ['dist', 'web'])
    await cp(resolve(stage, name), resolve(artifact, name), { recursive: true });
  const path = resolve(stage, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  delete manifest.private;
  manifest.bin = { 'mar-server': './dist/quick-start/cli.js' };
  const nodeVersion = JSON.parse(
    await readFile(resolve(root, 'mar-node/package.json'), 'utf8')
  ).version;
  if (typeof nodeVersion !== 'string' || nodeVersion !== manifest.version)
    throw new Error('SERVER_NODE_VERSION_MISMATCH');
  manifest.dependencies = { '@myagentroam/node': nodeVersion };
  // The Docker/source Server graph stays unchanged; only the npm artifact depends on Node.
  const modules = resolve(stage, 'node_modules');
  const topLevel = [];
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(resolve(modules, entry.name), { withFileTypes: true }))
        if (child.isDirectory()) topLevel.push(`${entry.name}/${child.name}`);
    } else topLevel.push(entry.name);
  }
  await mkdir(resolve(artifact, 'node_modules'), { recursive: true });
  for (const name of topLevel) {
    await mkdir(dirname(resolve(artifact, 'node_modules', name)), { recursive: true });
    await cp(resolve(modules, name), resolve(artifact, 'node_modules', name), {
      recursive: true,
      dereference: true,
      filter: (source) => !['.bin', '.pnpm'].includes(basename(source))
    });
    await bundle(name);
  }
  // pnpm deploy retains workspace: ranges in copied workspace manifests. npm must be
  // able to re-resolve these bundled packages on a later consumer install as well.
  await normalizeWorkspaceRanges(resolve(artifact, 'node_modules'));
  manifest.bundleDependencies = topLevel;
  manifest.files = ['dist', 'web', 'LICENSE', 'LICENSE.ee', 'NOTICE', 'LICENSING.md'];
  manifest.publishConfig = { access: 'public' };
  await writeFile(resolve(artifact, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of ['LICENSE', 'NOTICE', 'LICENSING.md'])
    await copyFile(resolve(root, name), resolve(artifact, name));
  await copyFile(resolve(root, 'ee/LICENSE'), resolve(artifact, 'LICENSE.ee'));
  await command('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], artifact);

  async function bundle(name) {
    const installed = JSON.parse(
      await readFile(resolve(artifact, 'node_modules', name, 'package.json'), 'utf8')
    );
    if (installed.name !== name || typeof installed.version !== 'string')
      throw new Error(`Invalid staged dependency: ${name}`);
    manifest.dependencies[name] = installed.version;
  }

  async function normalizeWorkspaceRanges(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const packageDirectory = resolve(directory, entry.name);
      if (entry.name.startsWith('@')) {
        await normalizeWorkspaceRanges(packageDirectory);
        continue;
      }
      const packageFile = resolve(packageDirectory, 'package.json');
      const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
      let changed = false;
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, range] of Object.entries(metadata[section] ?? {})) {
          if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
          const resolved = JSON.parse(
            await readFile(resolve(artifact, 'node_modules', name, 'package.json'), 'utf8')
          );
          if (resolved.name !== name || typeof resolved.version !== 'string')
            throw new Error(`Invalid bundled workspace dependency: ${name}`);
          const specifier = range.slice('workspace:'.length);
          metadata[section][name] =
            specifier === '*'
              ? resolved.version
              : specifier === '^' || specifier === '~'
                ? `${specifier}${resolved.version}`
                : specifier;
          changed = true;
        }
      }
      if (changed) await writeFile(packageFile, `${JSON.stringify(metadata, null, 2)}\n`);
      const nested = resolve(packageDirectory, 'node_modules');
      try {
        await readdir(nested);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      await normalizeWorkspaceRanges(nested);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function command(file, args, cwd = root) {
  const child = spawn(file, args, { cwd, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  if (code !== 0) throw new Error(`${file} failed with exit code ${code}`);
}
