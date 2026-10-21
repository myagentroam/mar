import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextPatchVersion } from './bump-version.mjs';
import { assertIndependentReleaseChanged } from './release-version-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const CODE_NAVIGATION_PACKAGE_PATH = 'packages/code-navigation/package.json';

export async function bumpCodeNavigationVersion(directory = root) {
  const packagePaths = [CODE_NAVIGATION_PACKAGE_PATH];
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  const branch = git('branch', '--show-current');
  if (branch !== 'develop') throw new Error('RELEASE_DEVELOP_BRANCH_REQUIRED');
  if (git('status', '--porcelain') !== '') throw new Error('RELEASE_SOURCE_DIRTY');
  await assertIndependentReleaseChanged('code-navigation', directory);

  const packages = await Promise.all(
    packagePaths.map(async (path) => ({
      path,
      value: JSON.parse(await readFile(resolve(directory, path), 'utf8'))
    }))
  );
  const versions = new Set(packages.map(({ value }) => value.version));
  if (versions.size !== 1) throw new Error('RELEASE_COMMON_VERSION_GROUP_MISMATCH');
  const current = packages[0]?.value.version;
  const version = nextPatchVersion(current);
  await Promise.all(
    packages.map(({ path, value }) =>
      writeFile(resolve(directory, path), `${JSON.stringify({ ...value, version }, null, 2)}\n`)
    )
  );
  return { current, version, paths: packagePaths };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2]) throw new Error('RELEASE_BUMP_TARGET_INVALID');
  const result = await bumpCodeNavigationVersion();
  process.stdout.write(`codeNavigationVersion ${result.current} -> ${result.version}\n`);
}
