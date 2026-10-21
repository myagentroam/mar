import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUnifiedVersionPublished } from './release-version-policy.mjs';
import { MAIN_PACKAGE_PATHS } from './release-artifacts.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function nextPatchVersion(version) {
  if (!stable.test(version)) throw new Error('RELEASE_PRODUCT_VERSION_INVALID');
  const [major, minor, patch] = version.split('.').map(Number);
  if (patch === Number.MAX_SAFE_INTEGER) throw new Error('RELEASE_PRODUCT_VERSION_OVERFLOW');
  return `${major}.${minor}.${patch + 1}`;
}

export async function bumpVersion(directory = root) {
  const packagePaths = MAIN_PACKAGE_PATHS;
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  const branch = git('branch', '--show-current');
  if (branch !== 'develop') throw new Error('RELEASE_DEVELOP_BRANCH_REQUIRED');
  if (git('status', '--porcelain') !== '') throw new Error('RELEASE_SOURCE_DIRTY');

  const packages = await Promise.all(
    packagePaths.map(async (path) => ({
      path,
      value: JSON.parse(await readFile(resolve(directory, path), 'utf8'))
    }))
  );
  const versions = new Set(packages.map(({ value }) => value.version));
  if (versions.size !== 1) throw new Error('RELEASE_PRODUCT_VERSION_GROUP_MISMATCH');
  const current = packages[0]?.value.version;
  const version = nextPatchVersion(current);
  await assertUnifiedVersionPublished(directory, current);
  await Promise.all(
    packages.map(({ path, value }) =>
      writeFile(resolve(directory, path), `${JSON.stringify({ ...value, version }, null, 2)}\n`)
    )
  );
  return { current, version, paths: packagePaths };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await bumpVersion();
  process.stdout.write(`version ${result.current} -> ${result.version}\n`);
}
