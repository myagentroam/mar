import { readdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function files(directory, prefix = '') {
  const entries = await readdir(resolve(directory, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await files(directory, path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`NODE_DEPLOY_ENTRY_INVALID: ${path}`);
  }
  return result.sort();
}

async function sameFiles(source, deployed, include = () => true, filterDeployed = true) {
  const original = (await files(source)).filter(include);
  const actual = (await files(deployed)).filter(filterDeployed ? include : () => true);
  if (JSON.stringify(original) !== JSON.stringify(actual) || original.length === 0)
    throw new Error(`NODE_DEPLOY_FILES_MISMATCH: ${source}`);
  for (const path of original)
    if (!(await readFile(resolve(source, path))).equals(await readFile(resolve(deployed, path))))
      throw new Error(`NODE_DEPLOY_CONTENT_MISMATCH: ${path}`);
}

export async function checkNodeDeploySource(source, deployed) {
  const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
  for (const [name, directory] of [
    ['agent', 'mar-agent'],
    ['protocol', 'packages/protocol'],
    ['binaries', 'packages/binaries']
  ]) {
    const original = resolve(source, directory);
    const actual = resolve(deployed, 'node_modules/@myagentroam', name);
    if (
      (await json(resolve(original, 'package.json'))).version !==
      (await json(resolve(actual, 'package.json'))).version
    )
      throw new Error(`NODE_DEPLOY_VERSION_MISMATCH: ${name}`);
    await sameFiles(
      resolve(original, name === 'binaries' ? 'vendor' : 'dist'),
      resolve(actual, name === 'binaries' ? 'vendor' : 'dist'),
      name === 'binaries'
        ? (path) =>
            !/^(?:ripgrep|ctags|tigervnc|ultravnc|macvnc)\/(?:linux|darwin|win32)-(?:x64|arm64)\//u.test(
              path
            )
        : undefined,
      name !== 'binaries'
    );
    if (name === 'binaries') {
      const target = `${process.platform}-${process.arch}`;
      const packageName = `@myagentroam/binaries-${target}`;
      const installed = createRequire(await realpath(resolve(actual, 'package.json'))).resolve(
        `${packageName}/package.json`
      );
      const originalTarget = resolve(source, 'packages', `binaries-${target}`);
      if (
        (await json(resolve(originalTarget, 'package.json'))).version !==
        (await json(installed)).version
      )
        throw new Error(`NODE_DEPLOY_VERSION_MISMATCH: ${packageName}`);
      await sameFiles(resolve(originalTarget, 'vendor'), resolve(installed, '../vendor'));
    }
  }
  await sameFiles(
    resolve(source, 'packages/code-navigation/dist'),
    resolve(deployed, 'dist/code-navigation'),
    (path) => path.endsWith('.js')
  );
  for (const part of ['bin', 'src'])
    await sameFiles(
      resolve(source, 'marctl', part),
      resolve(deployed, 'dist/marctl', part),
      (path) => /\.(?:mjs|cjs)$/u.test(path)
    );
  const node = await json(resolve(source, 'mar-node/package.json'));
  const cli = await json(resolve(deployed, 'dist/marctl/package.json'));
  if (node.version !== cli.version) throw new Error('NODE_DEPLOY_VERSION_MISMATCH: marctl');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('NODE_DEPLOY_SOURCE_ARGUMENT_INVALID');
  await checkNodeDeploySource(resolve(process.argv[2]), resolve(process.argv[3]));
}
