import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const commonPaths = ['packages/protocol', 'mar-agent', 'mar-node'];
const codeNavigationPaths = ['packages/code-navigation'];
const marctlPaths = ['marctl'];
const runtimePaths = [
  'packages/computer-runtime-win32-x64',
  'packages/computer-runtime-win32-arm64',
  'packages/computer-runtime-darwin-x64',
  'packages/computer-runtime-darwin-arm64',
  'packages/computer-runtime-linux-x64',
  'packages/computer-runtime-linux-arm64',
  'mar-node/src/computer-use-runtime-version.ts',
  'scripts/computer-runtime-packages.mjs',
  'scripts/computer-use-runtime.lock.json',
  'scripts/computer-use-runtime-requirements',
  'scripts/prepare-computer-use-runtime.mjs',
  'scripts/stage-computer-use-runtime.mjs'
];

export const releaseLines = {
  common: {
    packagePath: 'mar-node/package.json',
    tagPrefixes: ['common-v'],
    paths: commonPaths
  },
  'code-navigation': {
    packagePath: 'packages/code-navigation/package.json',
    tagPrefixes: ['code-navigation-v', 'common-v'],
    paths: codeNavigationPaths
  },
  marctl: {
    packagePath: 'marctl/package.json',
    tagPrefixes: ['marctl-v', 'marmgr-v'],
    paths: [...marctlPaths, 'marmgr'],
    legacyPackagePath: 'marmgr/package.json'
  },
  runtime: {
    packagePath: 'packages/computer-runtime-linux-x64/package.json',
    tagPrefixes: ['runtime-v', 'common-v'],
    paths: runtimePaths
  }
};

const git = (directory, ...args) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();

async function packageVersion(directory, path, reference) {
  const text =
    reference === undefined
      ? await readFile(resolve(directory, path), 'utf8')
      : git(directory, 'show', `${reference}:${path}`);
  return JSON.parse(text).version;
}

function baselinePackagePath(directory, policy, reference) {
  if (
    policy.legacyPackagePath !== undefined &&
    git(directory, 'ls-tree', '--name-only', reference, '--', policy.packagePath) === ''
  )
    return policy.legacyPackagePath;
  return policy.packagePath;
}

async function baselinePackageVersion(directory, policy, reference) {
  return packageVersion(directory, baselinePackagePath(directory, policy, reference), reference);
}

export async function findReleaseBaseline(line, directory) {
  const policy = releaseLines[line];
  if (policy === undefined) throw new Error('RELEASE_LINE_INVALID');
  const version = await packageVersion(directory, policy.packagePath);
  const mergedTags = git(directory, 'tag', '--merged', 'HEAD', '--sort=-creatordate')
    .split('\n')
    .filter(Boolean);
  const primaryPrefix = policy.tagPrefixes[0];
  const primaryTags = mergedTags.filter((tag) => tag.startsWith(primaryPrefix));
  const fallbackTags = mergedTags.filter((tag) =>
    policy.tagPrefixes.slice(1).some((prefix) => tag.startsWith(prefix))
  );
  for (const tags of [primaryTags, fallbackTags]) {
    for (const requireSameVersion of [true, false]) {
      const baseline = await firstReadableBaseline(
        directory,
        policy,
        tags,
        version,
        requireSameVersion
      );
      if (baseline !== undefined) return { ...baseline, version };
    }
  }
  throw new Error('RELEASE_BASELINE_NOT_FOUND');
}

async function firstReadableBaseline(directory, policy, tags, version, requireSameVersion) {
  for (const tag of tags) {
    try {
      const baselineVersion = await baselinePackageVersion(directory, policy, tag);
      if (!requireSameVersion || baselineVersion === version) return { tag, baselineVersion };
    } catch {
      // Tags created before this release line existed are not valid baselines.
    }
  }
  return undefined;
}

export async function releaseLineStatus(line, directory) {
  const policy = releaseLines[line];
  if (policy === undefined) throw new Error('RELEASE_LINE_INVALID');
  const baseline = await findReleaseBaseline(line, directory);
  const candidates = git(directory, 'diff', '--name-only', baseline.tag, '--', ...policy.paths)
    .split('\n')
    .filter(Boolean);
  const changedPaths = [];
  for (const path of candidates) {
    if (!(
      path.endsWith('/package.json') && (await onlyVersionChanged(directory, baseline.tag, path))
    ))
      changedPaths.push(path);
  }
  const versionBaselineChanged =
    line !== 'common' &&
    baseline.version.split('.').slice(0, 2).join('.') !==
      baseline.baselineVersion.split('.').slice(0, 2).join('.');
  return {
    line,
    ...baseline,
    versionBaselineChanged,
    changed: changedPaths.length > 0 || versionBaselineChanged,
    changedPaths
  };
}

async function onlyVersionChanged(directory, reference, path) {
  try {
    if (git(directory, 'ls-tree', '--name-only', reference, '--', path) === '') return false;
    const before = JSON.parse(git(directory, 'show', `${reference}:${path}`));
    const after = JSON.parse(await readFile(resolve(directory, path), 'utf8'));
    delete before.version;
    delete after.version;
    return JSON.stringify(before) === JSON.stringify(after);
  } catch {
    return false;
  }
}

export async function assertIndependentReleaseChanged(line, directory) {
  if (line === 'common') throw new Error('RELEASE_LINE_INVALID');
  const status = await releaseLineStatus(line, directory);
  if (!status.changed) throw new Error('RELEASE_INDEPENDENT_PACKAGE_UNCHANGED');
  return status;
}

export async function assertUnifiedVersionPublished(directory, version) {
  const tags = git(directory, 'tag', '--points-at', 'HEAD').split('\n');
  if (!tags.includes(`product-v${version}`) && !tags.includes(`common-v${version}`))
    throw new Error('RELEASE_VERSION_NOT_PUBLISHED');
  let main;
  try {
    main = git(directory, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
  } catch {
    // A missing local main cannot establish a synchronized release baseline.
  }
  if (main !== git(directory, 'rev-parse', 'HEAD'))
    throw new Error('RELEASE_MAIN_NOT_SYNCHRONIZED');
}

export async function assertCommonCandidateChanged(directory) {
  const plan = await releasePlan(directory);
  if (!plan.commonCandidateChanged) throw new Error('RELEASE_COMMON_GROUP_UNCHANGED');
  return plan;
}

export async function releasePlan(directory) {
  const entries = await Promise.all(
    Object.keys(releaseLines).map(async (line) => [line, await releaseLineStatus(line, directory)])
  );
  const lines = Object.fromEntries(entries);
  const commonDependencyChanges = Object.fromEntries(
    await Promise.all(
      ['code-navigation', 'marctl', 'runtime'].map(async (line) => {
        const policy = releaseLines[line];
        const currentVersion = await packageVersion(directory, policy.packagePath);
        const commonBaselineVersion = await baselinePackageVersion(
          directory,
          policy,
          lines.common.tag
        );
        return [
          line,
          {
            currentVersion,
            commonBaselineVersion,
            changed:
              currentVersion !== commonBaselineVersion ||
              baselinePackagePath(directory, policy, lines.common.tag) !== policy.packagePath
          }
        ];
      })
    )
  );
  const commonVersionChanged = lines.common.version !== lines.common.baselineVersion;
  return {
    lines,
    commonDependencyChanges,
    commonVersionChanged,
    commonCandidateChanged:
      commonVersionChanged ||
      lines.common.changed ||
      Object.values(commonDependencyChanges).some(({ changed }) => changed),
    commonRequired:
      commonVersionChanged ||
      lines.common.changed ||
      lines['code-navigation'].changed ||
      lines.marctl.changed ||
      lines.runtime.changed ||
      Object.values(commonDependencyChanges).some(({ changed }) => changed)
  };
}
