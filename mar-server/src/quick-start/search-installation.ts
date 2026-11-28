import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SearchInstallation } from './config.js';
import { downloadPinnedFile } from './download.js';
import { runChild } from './owned-preparation.js';
import { SEARCH_REQUIREMENTS } from './search-requirements.js';

const previousSourceVersion = '57ff753ad416b7bf27e59d72ae8c7cac93b56be4';
const sourceVersion = 'd96f0ec9bbb8555bd379334a4adcbd1dc06575d5';
const sourceDigest = '3e71f4d170a39216f9f4365a376b9ae2792875a546d890488857dbd41f010fda';
const uvVersion = '0.13.7';
const uvDigest = 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83';
const pythonVersion = '3.12.12';

/** Only the Linux x64 wheel and Granian combination validated by this release is prepared. */
export function managedSearchSupported(): boolean {
  const report = process.report.getReport();
  const glibc =
    typeof report === 'string'
      ? undefined
      : (report as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
  const match = /^(\d+)\.(\d+)/u.exec(glibc ?? '');
  return (
    process.platform === 'linux' &&
    process.arch === 'x64' &&
    !!match &&
    (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 28))
  );
}

export function newSearchInstallation(port: number, reinstall = false): SearchInstallation {
  const suffix = reinstall ? `-${randomBytes(8).toString('hex')}` : '';
  return {
    version: sourceVersion,
    uvVersion,
    pythonVersion,
    directory: `components/searxng-${sourceVersion.slice(0, 9)}-linux-x64${suffix}`,
    platform: 'linux',
    arch: 'x64',
    port
  };
}

/** Prepares the current release in its own directory; the caller owns activation. */
export async function prepareSearchInstallation(
  root: string,
  deploymentId: string,
  installation: SearchInstallation,
  signal?: AbortSignal,
  previous?: SearchInstallation
): Promise<void> {
  assertSearchPackage(installation);
  if (installation.version !== sourceVersion)
    throw new Error('QUICK_START_SEARCH_VERSION_UNSUPPORTED');
  const target = resolve(root, installation.directory);
  let replacementSettings: Buffer | string | undefined;
  if (previous) {
    assertSearchPackage(previous);
    const oldTarget = resolve(root, previous.directory);
    if (oldTarget === target) throw new Error('QUICK_START_SEARCH_COMPONENT_INVALID');
    try {
      const settings = join(oldTarget, 'settings.yml');
      await access(settings);
      await assertSearchOwner(oldTarget, deploymentId);
      replacementSettings = await readFile(settings);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      replacementSettings = defaultSearchSettings();
    }
  }
  signal?.throwIfAborted();
  try {
    await runChild('tar', ['--version'], process.env, signal, 'QUICK_START_SEARCH_TOOLS_MISSING');
  } catch (error) {
    if (error instanceof Error && error.message === 'QUICK_START_NODE_RECLAIM_FAILED') throw error;
    signal?.throwIfAborted();
    throw new Error('QUICK_START_SEARCH_TOOLS_MISSING');
  }
  await mkdir(resolve(root, 'components'), { recursive: true, mode: 0o700 });
  try {
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, '.owner'), `${deploymentId}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await assertSearchOwner(target, deploymentId);
  }
  const marker = join(target, '.mar-installed');
  const installed = await readFile(marker, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (installed !== undefined) {
    if (installed !== `${sourceVersion}\n`) throw new Error('QUICK_START_SEARCH_COMPONENT_INVALID');
    if (replacementSettings !== undefined) await copySearchSettings(target, replacementSettings);
    await assertSearchInstallation(root, installation, deploymentId);
    return;
  }
  await extractOnce(
    target,
    'uv',
    `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-x86_64-unknown-linux-gnu.tar.gz`,
    uvDigest,
    signal
  );
  await extractOnce(
    target,
    'searx',
    `https://codeload.github.com/searxng/searxng/tar.gz/${sourceVersion}`,
    sourceDigest,
    signal
  );
  const env = preparationEnvironment(target);
  const uv = join(target, 'uv/uv');
  // Fetch the pinned CPython build from its release origin without installing user-wide shims.
  await runChild(
    uv,
    [
      'python',
      'install',
      pythonVersion,
      '--mirror',
      'https://github.com/astral-sh/python-build-standalone/releases/download',
      '--no-bin',
      '--no-progress'
    ],
    env,
    signal,
    'QUICK_START_SEARCH_INSTALL_FAILED'
  );
  await runChild(
    uv,
    ['venv', '--allow-existing', '--python', pythonVersion, join(target, 'venv'), '--no-progress'],
    env,
    signal,
    'QUICK_START_SEARCH_INSTALL_FAILED'
  );
  const requirements = join(target, 'requirements.txt');
  try {
    await writeFile(requirements, SEARCH_REQUIREMENTS, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(requirements, 'utf8')) !== SEARCH_REQUIREMENTS
    )
      throw error;
  }
  await runChild(
    uv,
    [
      'pip',
      'install',
      '--python',
      join(target, 'venv/bin/python'),
      '--index-url',
      'https://pypi.org/simple',
      '--only-binary',
      ':all:',
      '--no-deps',
      '--no-progress',
      '-r',
      requirements
    ],
    env,
    signal,
    'QUICK_START_SEARCH_INSTALL_FAILED'
  );
  if (replacementSettings !== undefined) await copySearchSettings(target, replacementSettings);
  else {
    try {
      await writeFile(join(target, 'settings.yml'), defaultSearchSettings(), {
        flag: 'wx',
        mode: 0o600
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  signal?.throwIfAborted();
  await assertSearchInstallation(root, installation, deploymentId);
  await writeFile(marker, `${sourceVersion}\n`, { flag: 'wx', mode: 0o600 });
}

export async function assertSearchInstallation(
  root: string,
  installation: SearchInstallation,
  deploymentId: string
): Promise<void> {
  assertSearchPackage(installation);
  const target = resolve(root, installation.directory);
  await assertSearchOwner(target, deploymentId);
  await Promise.all(
    ['venv/bin/python', 'searx/searx/webapp.py', 'settings.yml'].map((path) =>
      access(join(target, path))
    )
  );
}

function assertSearchPackage(installation: SearchInstallation): void {
  if (
    !managedSearchSupported() ||
    installation.platform !== process.platform ||
    installation.arch !== process.arch
  )
    throw new Error('QUICK_START_SEARCH_PLATFORM_UNSUPPORTED');
  if (
    (installation.version !== sourceVersion && installation.version !== previousSourceVersion) ||
    installation.uvVersion !== uvVersion ||
    installation.pythonVersion !== pythonVersion
  )
    throw new Error('QUICK_START_SEARCH_VERSION_UNSUPPORTED');
}

async function assertSearchOwner(target: string, deploymentId: string): Promise<void> {
  if ((await readFile(join(target, '.owner'), 'utf8').catch(() => '')) !== `${deploymentId}\n`)
    throw new Error('QUICK_START_SEARCH_COMPONENT_NOT_OWNED');
}

function defaultSearchSettings(): string {
  return `use_default_settings: true\nserver:\n  secret_key: "${randomBytes(32).toString('hex')}"\n  limiter: false\n  public_instance: false\nsearch:\n  formats: [html, json]\n`;
}

async function copySearchSettings(target: string, settings: Buffer | string): Promise<void> {
  // Refresh the private candidate on retry, even if it had settings from an older attempt.
  const temporary = join(target, `.settings-${randomBytes(12).toString('hex')}`);
  await writeFile(temporary, settings, { flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, join(target, 'settings.yml'));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function preparationEnvironment(target: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(UV_|PIP_|PYTHON)/iu.test(key)) delete env[key];
  return {
    ...env,
    UV_PYTHON_INSTALL_DIR: join(target, 'python'),
    UV_CACHE_DIR: join(target, 'cache'),
    UV_PYTHON_PREFERENCE: 'only-managed'
  };
}

async function extractOnce(
  target: string,
  name: string,
  url: string,
  digest: string,
  signal?: AbortSignal
): Promise<void> {
  const destination = join(target, name);
  try {
    await access(destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = await mkdtemp(join(target, '.extract-'));
  let retain = false;
  try {
    const archive = join(staging, 'archive');
    const extracted = join(staging, 'content');
    await mkdir(extracted, { mode: 0o700 });
    await downloadPinnedFile(url, digest, archive, signal);
    await runChild(
      'tar',
      ['-xzf', archive, '-C', extracted, '--strip-components=1'],
      process.env,
      signal,
      'QUICK_START_SEARCH_INSTALL_FAILED'
    );
    signal?.throwIfAborted();
    await rename(extracted, destination);
  } catch (error) {
    retain = error instanceof Error && error.message === 'QUICK_START_NODE_RECLAIM_FAILED';
    throw error;
  } finally {
    if (!retain) await rm(staging, { recursive: true, force: true });
  }
}
