import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextPatchVersion } from './bump-version.mjs';
import { readReleaseVersions, validateMarctlVersionLine } from './release-artifacts.mjs';
import { assertIndependentReleaseChanged } from './release-version-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MARCTL_PACKAGE_PATH = 'marctl/package.json';

export async function bumpMarctlVersion(directory = root, packagePath = MARCTL_PACKAGE_PATH) {
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  if (git('branch', '--show-current') !== 'develop')
    throw new Error('RELEASE_DEVELOP_BRANCH_REQUIRED');
  if (git('status', '--porcelain') !== '') throw new Error('RELEASE_SOURCE_DIRTY');
  await assertIndependentReleaseChanged('marctl', directory);

  const path = resolve(directory, packagePath);
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  const current = pkg.version;
  const { commonVersion } = await readReleaseVersions(directory);
  validateMarctlVersionLine(current, commonVersion);
  const version = nextPatchVersion(current);
  await writeFile(path, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  return { current, version, path: packagePath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await bumpMarctlVersion();
  process.stdout.write(`marctlVersion ${result.current} -> ${result.version}\n`);
}
