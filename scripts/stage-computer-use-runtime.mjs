import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computerRuntimeTarget, computerRuntimeTargets } from './computer-runtime-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function stageComputerUseRuntime(input, directory = root) {
  const platform = closed(input.platform, ['win32', 'darwin', 'linux'], 'PLATFORM_INVALID');
  const architecture = closed(input.architecture, ['x64', 'arm64'], 'ARCHITECTURE_INVALID');
  const target = computerRuntimeTarget(platform, architecture);
  if (target === undefined) throw new Error('COMPUTER_RUNTIME_TARGET_INVALID');
  const source = resolve(input.source);
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) throw new Error('COMPUTER_RUNTIME_SOURCE_INVALID');
  const executable = safeRelative(input.executable ?? target.executable);
  const output = resolve(directory, target.path, 'runtime');
  await rm(output, { recursive: true, force: true });
  await mkdir(dirname(output), { recursive: true });
  await cp(source, output, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true
  });
  await rm(resolve(output, 'manifest.json'), { force: true });
  const files = [];
  for (const path of await regularFiles(output)) {
    const bytes = await readFile(path);
    files.push({
      path: relative(output, path).split(sep).join('/'),
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (!files.some((file) => file.path === executable))
    throw new Error('COMPUTER_RUNTIME_EXECUTABLE_MISSING');
  if (platform !== 'win32' && ((await stat(resolve(output, executable))).mode & 0o111) === 0)
    throw new Error('COMPUTER_RUNTIME_EXECUTABLE_INVALID');
  const manifest = {
    formatVersion: 1,
    runtimeVersion: bounded(input.runtimeVersion, 'RUNTIME_VERSION_INVALID'),
    platform,
    architecture,
    executable,
    files
  };
  await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function stageAllComputerUseRuntimes(input, directory = root) {
  const sourceRoot = resolve(input.sourceRoot);
  const runtimeVersion = bounded(input.runtimeVersion, 'RUNTIME_VERSION_INVALID');
  const manifests = [];
  for (const target of computerRuntimeTargets)
    manifests.push(
      await stageComputerUseRuntime(
        {
          source: resolve(sourceRoot, target.id),
          platform: target.platform,
          architecture: target.architecture,
          runtimeVersion,
          executable: target.executable
        },
        directory
      )
    );
  return manifests;
}

async function regularFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await regularFiles(path)));
    else if (entry.isFile()) output.push(path);
    else throw new Error('COMPUTER_RUNTIME_FILE_TYPE_INVALID');
  }
  return output;
}

function safeRelative(value) {
  const normalized = String(value).replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('COMPUTER_RUNTIME_PATH_INVALID');
  return normalized;
}

function closed(value, options, code) {
  if (!options.includes(value)) throw new Error(code);
  return value;
}

function bounded(value, code) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128)
    throw new Error(code);
  return value.trim();
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceRoot = argument('source-root');
  if (sourceRoot !== undefined)
    await stageAllComputerUseRuntimes({
      sourceRoot,
      runtimeVersion: argument('runtime-version')
    });
  else
    await stageComputerUseRuntime({
      source: argument('source'),
      platform: argument('platform'),
      architecture: argument('architecture'),
      runtimeVersion: argument('runtime-version'),
      executable: argument('executable')
    });
}
