import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commonNames = [
  '@myagentroam/protocol',
  '@myagentroam/code-navigation',
  '@myagentroam/agent',
  '@myagentroam/node'
];
const commonPaths = ['packages/protocol', 'mar-agent', 'mar-node'];
const codeNavigationPath = 'packages/code-navigation';
const productPaths = [
  '.',
  'mar-server',
  'ee/server',
  'ee/web',
  'mar-web-console',
  'packages/server-core',
  'packages/web-core'
];
export const MAIN_PACKAGE_PATHS = [...productPaths, ...commonPaths].map((path) =>
  path === '.' ? 'package.json' : `${path}/package.json`
);
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const check = (value, code) => {
  if (!value) throw new Error(code);
};
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

export function validateMarctlVersionLine(marctlVersion, commonVersion) {
  check(
    typeof marctlVersion === 'string' &&
      stable.test(marctlVersion) &&
      typeof commonVersion === 'string' &&
      stable.test(commonVersion),
    'RELEASE_VERSION_INVALID'
  );
  check(
    marctlVersion.split('.').slice(0, 2).join('.') ===
      commonVersion.split('.').slice(0, 2).join('.'),
    'RELEASE_MARCTL_VERSION_LINE_MISMATCH'
  );
  return { marctlVersion, commonVersion };
}

export function validateVersionGroups(products, common) {
  check(
    products.length > 0 && common.length === commonPaths.length,
    'RELEASE_VERSION_GROUP_INVALID'
  );
  const versions = [...products, ...common];
  check(
    versions.every((version) => typeof version === 'string' && stable.test(version)),
    'RELEASE_VERSION_INVALID'
  );
  check(new Set(versions).size === 1, 'RELEASE_VERSION_GROUP_MISMATCH');
  return { productVersion: products[0], commonVersion: common[0] };
}

export async function readReleaseVersions(directory = root) {
  const products = await Promise.all(
    productPaths.map((path) => json(resolve(directory, path, 'package.json')))
  );
  const common = await Promise.all(
    commonPaths.map((path) => json(resolve(directory, path, 'package.json')))
  );
  const versions = validateVersionGroups(
    products.map((pkg) => pkg.version),
    common.map((pkg) => pkg.version)
  );
  const codeNavigation = await json(resolve(directory, codeNavigationPath, 'package.json'));
  check(
    codeNavigation.name === '@myagentroam/code-navigation' &&
      typeof codeNavigation.version === 'string' &&
      stable.test(codeNavigation.version),
    'RELEASE_CODE_NAVIGATION_VERSION_INVALID'
  );
  const marctl = await json(resolve(directory, 'marctl/package.json'));
  check(marctl.name === '@myagentroam/marctl', 'RELEASE_PACKAGE_NAME_INVALID');
  const { marctlVersion } = validateMarctlVersionLine(marctl.version, versions.commonVersion);
  check(
    common[2].dependencies?.['@myagentroam/marctl'] === 'workspace:*' ||
      common[2].dependencies?.['@myagentroam/marctl'] === marctlVersion,
    'RELEASE_MARCTL_DEPENDENCY_INVALID'
  );
  const versioned = [
    ...common.map((pkg, index) => ({
      pkg,
      name: ['@myagentroam/protocol', '@myagentroam/agent', '@myagentroam/node'][index]
    })),
    { pkg: codeNavigation, name: '@myagentroam/code-navigation' }
  ];
  for (const { pkg, name: expectedName } of versioned) {
    check(pkg.name === expectedName, 'RELEASE_PACKAGE_NAME_INVALID');
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const [name, version] of Object.entries(pkg[section] ?? {}))
        if (commonNames.includes(name))
          check(
            version === 'workspace:*' ||
              version ===
                (name === codeNavigation.name ? codeNavigation.version : versions.commonVersion),
            'RELEASE_COMMON_DEPENDENCY_INVALID'
          );
  }
  return { ...versions, codeNavigationVersion: codeNavigation.version, marctlVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await readReleaseVersions()));
