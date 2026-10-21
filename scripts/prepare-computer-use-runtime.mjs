import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computerRuntimeTargets } from './computer-runtime-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(root, 'scripts/computer-use-runtime.lock.json');
const digestPattern = /^[a-f0-9]{64}$/u;

export async function readComputerUseRuntimeLock(path = lockPath) {
  const lock = JSON.parse(await readFile(path, 'utf8'));
  if (
    lock?.formatVersion !== 1 ||
    typeof lock.runtimeId !== 'string' ||
    lock.runtimeId.length === 0 ||
    typeof lock.pythonVersion !== 'string' ||
    lock.packageIndex !== 'https://pypi.org/simple' ||
    !Array.isArray(lock.binaryOnlyPackages) ||
    lock.binaryOnlyPackages.length === 0 ||
    lock.binaryOnlyPackages.some(
      (name) => typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(name)
    ) ||
    !Array.isArray(lock.packages?.common) ||
    typeof lock.requirements?.common !== 'string'
  )
    throw new Error('COMPUTER_RUNTIME_LOCK_INVALID');
  const expected = new Set(computerRuntimeTargets.map(({ id }) => id));
  const actual = new Set(Object.keys(lock.targets ?? {}));
  if (
    expected.size !== actual.size ||
    [...expected].some((id) => !actual.has(id)) ||
    computerRuntimeTargets.some(({ id, platform }) => {
      const target = lock.targets[id];
      return (
        typeof target?.url !== 'string' ||
        !target.url.startsWith('https://') ||
        !digestPattern.test(target.sha256) ||
        !Array.isArray(lock.packages[platform]) ||
        typeof lock.requirements[platform] !== 'string'
      );
    })
  )
    throw new Error('COMPUTER_RUNTIME_LOCK_INVALID');
  const requirementsRoot = dirname(path);
  for (const group of ['common', 'win32', 'darwin', 'linux']) {
    const requirementPath = lockedRelative(requirementsRoot, lock.requirements[group]);
    const content = await readFile(requirementPath, 'utf8');
    const specifications = content
      .split(/\r?\n/u)
      .map((line) => /^([A-Za-z0-9_.-]+==[^ \\]+)(?:\s|$)/u.exec(line)?.[1])
      .filter((value) => value !== undefined);
    if (
      specifications.length !== lock.packages[group].length ||
      specifications.some((value, index) => value !== lock.packages[group][index]) ||
      (specifications.length > 0 && !content.includes('--hash=sha256:'))
    )
      throw new Error('COMPUTER_RUNTIME_REQUIREMENTS_INVALID');
  }
  return { ...lock, requirementsRoot };
}

export function defaultComputerUseRuntimeSourceRoot(lock, directory = root) {
  return resolve(directory, 'test/runs/computer-use-runtimes', lock.runtimeId);
}

export function computerUseRuntimeSourceRoot(lock, environment = process.env, directory = root) {
  const configured = environment['MAR_COMPUTER_USE_RUNTIME_SOURCE_ROOT']?.trim();
  return configured ? resolve(configured) : defaultComputerUseRuntimeSourceRoot(lock, directory);
}

export function currentComputerRuntimeId(platform = process.platform, architecture = process.arch) {
  const target = computerRuntimeTargets.find(
    (candidate) => candidate.platform === platform && candidate.architecture === architecture
  );
  if (target === undefined) throw new Error('COMPUTER_RUNTIME_HOST_UNSUPPORTED');
  return target.id;
}

export function computerRuntimePipTarget(targetId, pythonVersion) {
  const [major, minor] = pythonVersion.split('.');
  const abi = `cp${major}${minor}`;
  const targets = {
    'win32-x64': { platform: 'win_amd64', sitePackages: 'Lib/site-packages' },
    'win32-arm64': { platform: 'win_arm64', sitePackages: 'Lib/site-packages' },
    'darwin-x64': {
      platform: 'macosx_10_13_x86_64',
      sitePackages: `lib/python${major}.${minor}/site-packages`
    },
    'darwin-arm64': {
      platform: 'macosx_11_0_arm64',
      sitePackages: `lib/python${major}.${minor}/site-packages`
    },
    'linux-x64': {
      platform: 'manylinux_2_28_x86_64',
      sitePackages: `lib/python${major}.${minor}/site-packages`
    },
    'linux-arm64': {
      platform: 'manylinux_2_28_aarch64',
      sitePackages: `lib/python${major}.${minor}/site-packages`
    }
  };
  const target = targets[targetId];
  if (target === undefined || !/^\d+$/u.test(major) || !/^\d+$/u.test(minor))
    throw new Error('COMPUTER_RUNTIME_TARGET_INVALID');
  return { ...target, abi, pythonVersion: `${major}.${minor}` };
}

export async function expectedComputerUseRuntimeSource(lock, targetId, runtimeTreeSha256) {
  const target = computerRuntimeTargets.find(({ id }) => id === targetId);
  const source = lock.targets[targetId];
  if (target === undefined || source === undefined)
    throw new Error('COMPUTER_RUNTIME_TARGET_INVALID');
  return {
    formatVersion: 1,
    runtimeId: lock.runtimeId,
    pythonVersion: lock.pythonVersion,
    target: targetId,
    runtimeTreeSha256,
    pythonArchive: { url: source.url, sha256: source.sha256 },
    packageIndex: lock.packageIndex,
    binaryOnlyPackages: lock.binaryOnlyPackages,
    packages: [...lock.packages.common, ...lock.packages[target.platform]],
    requirements: await Promise.all(
      ['common', target.platform].map(async (group) => {
        const path = resolve(lock.requirementsRoot, lock.requirements[group]);
        return { path: lock.requirements[group], sha256: await sha256(path) };
      })
    )
  };
}

export async function verifyPreparedComputerUseRuntime(source, lock, targetId) {
  let actual;
  try {
    actual = JSON.parse(await readFile(resolve(source, '.mar-runtime-source.json'), 'utf8'));
  } catch {
    throw new Error('COMPUTER_RUNTIME_SOURCE_IDENTITY_INVALID');
  }
  const expected = await expectedComputerUseRuntimeSource(
    lock,
    targetId,
    await computerUseRuntimeTreeSha256(source)
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('COMPUTER_RUNTIME_SOURCE_IDENTITY_INVALID');
  return actual;
}

export async function prepareComputerUseRuntime(input = {}) {
  const lock = input.lock ?? (await readComputerUseRuntimeLock());
  const targetId = input.targetId ?? currentComputerRuntimeId();
  const target = computerRuntimeTargets.find(({ id }) => id === targetId);
  const source = lock.targets[targetId];
  if (target === undefined || source === undefined)
    throw new Error('COMPUTER_RUNTIME_TARGET_INVALID');
  const sourceRoot =
    input.sourceRoot ?? computerUseRuntimeSourceRoot(lock, input.environment, input.directory);
  const output = resolve(sourceRoot, targetId);
  if (!input.force && (await exists(output))) throw new Error('COMPUTER_RUNTIME_OUTPUT_EXISTS');
  await mkdir(sourceRoot, { recursive: true });
  const cache = resolve(sourceRoot, '.cache');
  await mkdir(cache, { recursive: true });
  const archive = resolve(cache, `${targetId}-${basename(new URL(source.url).pathname)}`);
  await downloadLocked(source.url, source.sha256, archive);
  const work = await mkdtemp(resolve(sourceRoot, `.prepare-${targetId}-`));
  try {
    const extracted = resolve(work, 'extracted');
    await mkdir(extracted);
    execFileSync('tar', ['-xzf', archive, '-C', extracted], { stdio: 'inherit' });
    const staged = resolve(work, targetId);
    await cp(resolve(extracted, 'python'), staged, { recursive: true, dereference: true });
    const executable = resolve(staged, target.executable);
    await access(executable);
    if (target.platform !== 'win32') await chmod(executable, 0o755);
    const pipTarget = computerRuntimePipTarget(targetId, lock.pythonVersion);
    const sitePackages = resolve(staged, pipTarget.sitePackages);
    await mkdir(sitePackages, { recursive: true });
    runPython(input.preparationPython ?? 'python3', [
      '-m',
      'pip',
      'install',
      '--isolated',
      '--disable-pip-version-check',
      '--no-input',
      '--no-cache-dir',
      '--no-deps',
      '--require-hashes',
      '--index-url',
      lock.packageIndex,
      '--only-binary',
      lock.binaryOnlyPackages.join(','),
      '--platform',
      pipTarget.platform,
      '--implementation',
      'cp',
      '--python-version',
      pipTarget.pythonVersion,
      '--abi',
      pipTarget.abi,
      '--target',
      sitePackages,
      '--requirement',
      resolve(lock.requirementsRoot, lock.requirements.common),
      '--requirement',
      resolve(lock.requirementsRoot, lock.requirements[target.platform])
    ]);
    await verifyInstalledModules(sitePackages, target.platform);
    await writeFile(
      resolve(staged, '.mar-runtime-source.json'),
      `${JSON.stringify(
        await expectedComputerUseRuntimeSource(
          lock,
          targetId,
          await computerUseRuntimeTreeSha256(staged)
        ),
        null,
        2
      )}\n`
    );
    if (input.force) await rm(output, { recursive: true, force: true });
    await rename(staged, output);
    return output;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function verifyInstalledModules(sitePackages, platform) {
  const required = ['PIL', 'pyautogui', 'pyscreeze', 'pyperclip'];
  if (platform === 'darwin') required.push('objc', 'AppKit');
  if (platform === 'linux') required.push('Xlib');
  try {
    await Promise.all(required.map((name) => access(resolve(sitePackages, name))));
  } catch {
    throw new Error('COMPUTER_RUNTIME_REQUIRED_MODULE_MISSING');
  }
}

function lockedRelative(base, value) {
  const path = resolve(base, value);
  const child = relative(base, path);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`))
    throw new Error('COMPUTER_RUNTIME_REQUIREMENTS_INVALID');
  return path;
}

async function downloadLocked(url, expectedSha256, output) {
  if ((await exists(output)) && (await sha256(output)) === expectedSha256) return;
  await rm(output, { force: true });
  const temporary = `${output}.download-${process.pid}`;
  await rm(temporary, { force: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`COMPUTER_RUNTIME_DOWNLOAD_FAILED:${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(temporary, bytes, { flag: 'wx' });
  if ((await sha256(temporary)) !== expectedSha256) {
    await rm(temporary, { force: true });
    throw new Error('COMPUTER_RUNTIME_SOURCE_HASH_MISMATCH');
  }
  await rename(temporary, output);
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export async function computerUseRuntimeTreeSha256(directory) {
  const files = await runtimeFiles(directory);
  const hash = createHash('sha256');
  for (const path of files) {
    const name = relative(directory, path).split(sep).join('/');
    if (name === '.mar-runtime-source.json') continue;
    hash.update(name);
    hash.update('\0');
    hash.update(await sha256(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function runtimeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await runtimeFiles(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error('COMPUTER_RUNTIME_FILE_TYPE_INVALID');
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runPython(executable, args) {
  execFileSync(executable, args, { stdio: 'inherit', timeout: 600_000 });
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lock = await readComputerUseRuntimeLock();
  const output = await prepareComputerUseRuntime({
    lock,
    targetId: argument('target'),
    sourceRoot: argument('output-root'),
    force: process.argv.includes('--force')
  });
  console.log(output);
}
