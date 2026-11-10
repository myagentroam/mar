import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SearchInstallation } from './config.js';
import { downloadPinnedFile } from './download.js';
import { runChild } from './owned-preparation.js';
import { SEARCH_REQUIREMENTS } from './search-requirements.js';

const sourceVersion = '57ff753ad416b7bf27e59d72ae8c7cac93b56be4';
const sourceDigest = '711ee0c77457ff9af09058e512a43452fd7394b68aab307415674791cc9037b0';
const uvDigest = 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83';

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

export function newSearchInstallation(port: number): SearchInstallation {
  return {
    version: sourceVersion,
    uvVersion: '0.13.7',
    pythonVersion: '3.12.12',
    directory: 'components/searxng-57ff753ad-linux-x64',
    platform: 'linux',
    arch: 'x64',
    port
  };
}

export async function prepareSearchInstallation(
  root: string,
  deploymentId: string,
  installation: SearchInstallation,
  signal?: AbortSignal
): Promise<void> {
  if (
    !managedSearchSupported() ||
    installation.platform !== process.platform ||
    installation.arch !== process.arch ||
    installation.version !== sourceVersion ||
    installation.uvVersion !== '0.13.7' ||
    installation.pythonVersion !== '3.12.12'
  )
    throw new Error('QUICK_START_SEARCH_PLATFORM_UNSUPPORTED');
  signal?.throwIfAborted();
  try {
    await runChild('tar', ['--version'], process.env, signal, 'QUICK_START_SEARCH_TOOLS_MISSING');
  } catch (error) {
    if (error instanceof Error && error.message === 'QUICK_START_NODE_RECLAIM_FAILED') throw error;
    signal?.throwIfAborted();
    throw new Error('QUICK_START_SEARCH_TOOLS_MISSING');
  }
  const target = resolve(root, installation.directory);
  await mkdir(resolve(root, 'components'), { recursive: true, mode: 0o700 });
  try {
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, '.owner'), `${deploymentId}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(join(target, '.owner'), 'utf8').catch(() => '')) !== `${deploymentId}\n`)
      throw new Error('QUICK_START_SEARCH_COMPONENT_NOT_OWNED');
  }
  const marker = join(target, '.mar-installed');
  try {
    if ((await readFile(marker, 'utf8')) !== `${sourceVersion}\n`)
      throw new Error('QUICK_START_SEARCH_COMPONENT_INVALID');
    await assertSearchInstallation(root, installation);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await extractOnce(
    target,
    'uv',
    'https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-unknown-linux-gnu.tar.gz',
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
  await runChild(
    uv,
    ['python', 'install', '3.12.12', '--no-progress'],
    env,
    signal,
    'QUICK_START_SEARCH_INSTALL_FAILED'
  );
  await runChild(
    uv,
    ['venv', '--allow-existing', '--python', '3.12.12', join(target, 'venv'), '--no-progress'],
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
  const settings = join(target, 'settings.yml');
  try {
    await writeFile(
      settings,
      `use_default_settings: true\nserver:\n  secret_key: "${randomBytes(32).toString('hex')}"\n  limiter: false\n  public_instance: false\nsearch:\n  formats: [html, json]\n`,
      { flag: 'wx', mode: 0o600 }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  signal?.throwIfAborted();
  await assertSearchInstallation(root, installation);
  await writeFile(marker, `${sourceVersion}\n`, { flag: 'wx', mode: 0o600 });
}

export async function assertSearchInstallation(
  root: string,
  installation: SearchInstallation,
  deploymentId?: string
): Promise<void> {
  const target = resolve(root, installation.directory);
  if (
    !managedSearchSupported() ||
    installation.platform !== process.platform ||
    installation.arch !== process.arch ||
    installation.version !== sourceVersion ||
    installation.uvVersion !== '0.13.7' ||
    installation.pythonVersion !== '3.12.12'
  )
    throw new Error('QUICK_START_SEARCH_PLATFORM_UNSUPPORTED');
  if (
    deploymentId !== undefined &&
    (await readFile(join(target, '.owner'), 'utf8').catch(() => '')) !== `${deploymentId}\n`
  )
    throw new Error('QUICK_START_SEARCH_COMPONENT_NOT_OWNED');
  await Promise.all(
    ['venv/bin/python', 'searx/searx/webapp.py', 'settings.yml'].map((path) =>
      access(join(target, path))
    )
  );
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
