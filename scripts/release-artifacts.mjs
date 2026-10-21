import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { computerRuntimeNames, computerRuntimeTargets } from './computer-runtime-packages.mjs';
import { assertCommonCandidateChanged } from './release-version-policy.mjs';
import { checkProductLicense } from './check-product-license.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildableCommonNames = ['protocol', 'code-navigation', 'agent', 'node'].map(
  (name) => `@myagentroam/${name}`
);
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
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
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

export function validateCommonManifest(value) {
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value.formatVersion === 1 || value.formatVersion === 2) &&
      typeof value.commonVersion === 'string' &&
      stable.test(value.commonVersion),
    'RELEASE_COMMON_MANIFEST_INVALID'
  );
  if (value.formatVersion === 2)
    check(
      typeof value.codeNavigationVersion === 'string' && stable.test(value.codeNavigationVersion),
      'RELEASE_CODE_NAVIGATION_VERSION_INVALID'
    );
  check(
    typeof value.sourceCommit === 'string' &&
      typeof value.lockfileSha256 === 'string' &&
      /^[a-f0-9]{40}$/u.test(value.sourceCommit) &&
      /^[a-f0-9]{64}$/u.test(value.lockfileSha256),
    'RELEASE_COMMON_PROVENANCE_INVALID'
  );
  check(
    Array.isArray(value.packages) && value.packages.length === commonNames.length,
    'RELEASE_COMMON_GROUP_INCOMPLETE'
  );
  const names = new Set();
  const files = new Set();
  for (const item of value.packages) {
    check(
      item && commonNames.includes(item.name) && !names.has(item.name),
      'RELEASE_COMMON_PACKAGE_INVALID'
    );
    check(
      item.version ===
        (item.name === '@myagentroam/code-navigation'
          ? (value.codeNavigationVersion ?? value.commonVersion)
          : value.commonVersion) &&
        typeof item.sha512 === 'string' &&
        /^[a-f0-9]{128}$/u.test(item.sha512),
      'RELEASE_COMMON_DIGEST_INVALID'
    );
    check(
      typeof item.file === 'string' &&
        /^[a-z0-9][a-z0-9.-]*\.tgz$/u.test(item.file) &&
        !files.has(item.file),
      'RELEASE_COMMON_FILENAME_INVALID'
    );
    names.add(item.name);
    files.add(item.file);
  }
  return value;
}

function packedContents(bytes, allowMarctlFiles = false) {
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  let metadata;
  const names = new Set();
  const files = new Map();
  const modes = new Map();
  let terminated = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      check(
        tar.subarray(offset).every((value) => value === 0),
        'RELEASE_TARBALL_TRAILING_DATA'
      );
      terminated = true;
      break;
    }
    const text = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/su, '');
    const rawChecksum = text(148, 156).trim();
    check(/^[0-7]+$/u.test(rawChecksum), 'RELEASE_TARBALL_INVALID');
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    check(checksum === Number.parseInt(rawChecksum, 8), 'RELEASE_TARBALL_CHECKSUM_INVALID');
    const prefix = text(345, 500);
    const name = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`;
    check(
      name.startsWith('package/') &&
        !name.includes('\\') &&
        !name.split('/').some((part) => part === '..' || part === '.') &&
        !names.has(name),
      'RELEASE_ARCHIVE_PATH_INVALID'
    );
    names.add(name);
    const type = header[156];
    check(type === 0 || type === 48 || type === 53, 'RELEASE_ARCHIVE_ENTRY_TYPE_INVALID');
    const rawMode = text(100, 108).trim();
    check(/^[0-7]+$/u.test(rawMode), 'RELEASE_TARBALL_INVALID');
    const mode = Number.parseInt(rawMode, 8);
    check(Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o7777, 'RELEASE_TARBALL_INVALID');
    const rawSize = text(124, 136).trim();
    check(/^[0-7]+$/u.test(rawSize), 'RELEASE_TARBALL_INVALID');
    const size = Number.parseInt(rawSize, 8);
    check(
      Number.isSafeInteger(size) && offset + 512 + size <= tar.length,
      'RELEASE_TARBALL_INVALID'
    );
    if (type === 53) check(size === 0, 'RELEASE_TARBALL_INVALID');
    else if (name === 'package/package.json') {
      check(metadata === undefined && size <= 1024 * 1024, 'RELEASE_PACKAGE_METADATA_INVALID');
      metadata = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
    } else {
      const path = name.slice('package/'.length);
      const allowed =
        /^(?:LICENSE|NOTICE|README)(?:\.[a-zA-Z0-9-]+)*$/u.test(path) ||
        /^dist\/[a-zA-Z0-9_./-]+\.(?:js|d\.ts)$/u.test(path) ||
        path === 'scripts/install-web-browser.mjs' ||
        (allowMarctlFiles &&
          (/^(?:bin|src)\/[a-zA-Z0-9_./-]+\.mjs$/u.test(path) ||
            path === 'src/scp-worker.cjs' ||
            path === 'src/terminal-relay-sender.d.mts')) ||
        /^vendor\/ripgrep\/(?:manifest\.json|LICENSE-MIT|UNLICENSE|(?:darwin|linux|win32)-(?:x64|arm64)\/rg(?:\.exe)?)$/u.test(
          path
        ) ||
        /^vendor\/ctags\/(?:manifest\.json|NOTICE|(?:darwin|linux)-(?:x64|arm64)\/ctags|win32-x64\/ctags\.exe|source\/universal-ctags-(?:6\.2\.1|[a-f0-9]{40})\.tar\.gz|licenses\/(?:COPYING|COPYING\.MinGW-w64-runtime\.txt|LICENSE\.janssen|LICENSE\.libyaml|win32-x64\/(?:COPYING|COPYING\.MinGW-w64-runtime\.txt|Copyright\.libxml2|LICENCE\.pcre2|LICENSE\.janssen|LICENSE\.libyaml)|official-snapshot\/(?:darwin-arm64|darwin-x64|linux-arm64|linux-x64)\/(?:COPYING|RECEIPT\.yml|dependencies\/(?:libiconv|libjansson|libxml2|libyaml|libz)\.yml)))$/u.test(
          path
        ) ||
        /^runtime\/[a-zA-Z0-9_./+@=-]+$/u.test(path);
      check(allowed, 'RELEASE_ARCHIVE_FILE_FORBIDDEN');
      files.set(path, tar.subarray(offset + 512, offset + 512 + size));
      modes.set(path, mode);
      if (path.endsWith('.js') || path.endsWith('.mjs')) {
        const code = tar.subarray(offset + 512, offset + 512 + size).toString('utf8');
        check(
          !code.includes('@myagentroam-enterprise/') &&
            !code.includes('/* mar-release-protected */'),
          'RELEASE_ARCHIVE_PRIVATE_CODE_FORBIDDEN'
        );
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  check(
    terminated &&
      metadata !== undefined &&
      metadata !== null &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata),
    'RELEASE_PACKAGE_METADATA_MISSING'
  );
  check(
    names.has('package/LICENSE') && names.has('package/NOTICE'),
    'RELEASE_ARCHIVE_LICENSE_MISSING'
  );
  check(
    !names.has('package/scripts/install-web-browser.mjs') || metadata.name === '@myagentroam/node',
    'RELEASE_ARCHIVE_FILE_FORBIDDEN'
  );
  return { metadata, names, files, modes };
}

export function packedMetadata(bytes) {
  return packedContents(bytes).metadata;
}

function inspectRuntimeArchive(contents, expectedName) {
  const target = computerRuntimeTargets.find(({ name }) => name === expectedName);
  check(target !== undefined, 'RELEASE_RUNTIME_PACKAGE_INVALID');
  const { metadata, files } = contents;
  check(
    Array.isArray(metadata.os) &&
      metadata.os.length === 1 &&
      metadata.os[0] === target.platform &&
      Array.isArray(metadata.cpu) &&
      metadata.cpu.length === 1 &&
      metadata.cpu[0] === target.architecture,
    'RELEASE_RUNTIME_PLATFORM_INVALID'
  );
  const manifestBytes = files.get('runtime/manifest.json');
  check(manifestBytes !== undefined, 'RELEASE_RUNTIME_MANIFEST_MISSING');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('RELEASE_RUNTIME_MANIFEST_INVALID');
  }
  check(
    manifest?.formatVersion === 1 &&
      manifest.platform === target.platform &&
      manifest.architecture === target.architecture &&
      typeof manifest.runtimeVersion === 'string' &&
      manifest.runtimeVersion.length > 0 &&
      manifest.executable === target.executable &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0,
    'RELEASE_RUNTIME_MANIFEST_INVALID'
  );
  const declared = new Set();
  for (const file of manifest.files) {
    check(
      file &&
        typeof file.path === 'string' &&
        file.path.length > 0 &&
        !file.path.includes('\\') &&
        !file.path.split('/').some((part) => part === '' || part === '.' || part === '..') &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        typeof file.sha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(file.sha256) &&
        !declared.has(file.path),
      'RELEASE_RUNTIME_MANIFEST_INVALID'
    );
    declared.add(file.path);
    const bytes = files.get(`runtime/${file.path}`);
    check(
      bytes !== undefined &&
        bytes.byteLength === file.size &&
        digest(bytes, 'sha256') === file.sha256,
      'RELEASE_RUNTIME_INTEGRITY_INVALID'
    );
  }
  check(declared.has(manifest.executable), 'RELEASE_RUNTIME_EXECUTABLE_MISSING');
  const actual = [...files.keys()]
    .filter((path) => path.startsWith('runtime/') && path !== 'runtime/manifest.json')
    .map((path) => path.slice('runtime/'.length));
  check(
    actual.length === declared.size && actual.every((path) => declared.has(path)),
    'RELEASE_RUNTIME_CONTENT_MISMATCH'
  );
}

async function inspectArchive(
  path,
  expectedName,
  version,
  commonVersion = version,
  codeNavigationVersion = version
) {
  check(
    (await stat(path)).isFile() && (await stat(path)).size <= 256 * 1024 * 1024,
    'RELEASE_ARCHIVE_INVALID'
  );
  const bytes = await readFile(path);
  const contents = packedContents(bytes, expectedName === '@myagentroam/marctl');
  const pkg = contents.metadata;
  check(pkg.name === expectedName && pkg.version === version, 'RELEASE_ARCHIVE_IDENTITY_MISMATCH');
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'])
    for (const [name, dependency] of Object.entries(pkg[section] ?? {})) {
      if (commonNames.includes(name))
        check(
          dependency ===
            (name === '@myagentroam/code-navigation' ? codeNavigationVersion : commonVersion),
          'RELEASE_ARCHIVE_DEPENDENCY_MISMATCH'
        );
      check(!/^(workspace:|file:|link:)/u.test(dependency), 'RELEASE_ARCHIVE_LOCAL_DEPENDENCY');
    }
  if (computerRuntimeNames.includes(expectedName)) inspectRuntimeArchive(contents, expectedName);
  else {
    check(
      ![...contents.names].some((name) => name.startsWith('package/runtime/')),
      'RELEASE_RUNTIME_IN_MAIN_PACKAGE'
    );
    if (expectedName === '@myagentroam/node')
      check(
        [0o644, 0o755].includes(contents.modes.get('vendor/ctags/linux-x64/ctags')),
        'RELEASE_NODE_CTAGS_EXECUTABLE_INVALID'
      );
  }
  return digest(bytes, 'sha512');
}

export async function inspectComputerRuntimeArchive(path, expectedName, version) {
  check(computerRuntimeNames.includes(expectedName), 'RELEASE_RUNTIME_PACKAGE_INVALID');
  return inspectArchive(path, expectedName, version);
}

export async function inspectMarctlArchive(path, version) {
  return inspectArchive(path, '@myagentroam/marctl', version);
}

export async function verifyCommonArtifacts(manifestPath) {
  const value = validateCommonManifest(await json(manifestPath));
  for (const item of value.packages) {
    const actual = await inspectArchive(
      resolve(dirname(manifestPath), item.file),
      item.name,
      item.version,
      value.commonVersion,
      value.codeNavigationVersion ?? value.commonVersion
    );
    check(actual === item.sha512, 'RELEASE_ARCHIVE_DIGEST_MISMATCH');
  }
  return value;
}

export async function createCommonManifest(artifactDirectory, output, directory = root) {
  check(
    resolve(dirname(output)) === resolve(artifactDirectory),
    'RELEASE_MANIFEST_LOCATION_INVALID'
  );
  const { commonVersion, codeNavigationVersion } = await readReleaseVersions(directory);
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  check(git('status', '--porcelain') === '', 'RELEASE_SOURCE_DIRTY');
  const packages = [];
  for (const name of commonNames) {
    const version = name === '@myagentroam/code-navigation' ? codeNavigationVersion : commonVersion;
    const file = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    packages.push({
      name,
      version,
      file,
      sha512: await inspectArchive(
        resolve(artifactDirectory, file),
        name,
        version,
        commonVersion,
        codeNavigationVersion
      )
    });
  }
  const manifest = validateCommonManifest({
    formatVersion: 2,
    commonVersion,
    codeNavigationVersion,
    sourceCommit: git('rev-parse', 'HEAD'),
    lockfileSha256: digest(await readFile(resolve(directory, 'pnpm-lock.yaml')), 'sha256'),
    packages
  });
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function checkPublicLicense(directory = root) {
  for (const name of ['LICENSE', 'NOTICE']) {
    let content;
    try {
      content = await readFile(resolve(directory, name), 'utf8');
    } catch {
      throw new Error('RELEASE_LICENSE_MATERIALS_MISSING');
    }
    check(content.trim().length > 0, 'RELEASE_LICENSE_MATERIALS_MISSING');
  }
  for (const path of [...commonPaths, codeNavigationPath]) {
    const pkg = await json(resolve(directory, path, 'package.json'));
    check(
      typeof pkg.license === 'string' &&
        pkg.license.trim().length > 0 &&
        pkg.license !== 'UNLICENSED',
      'RELEASE_PACKAGE_LICENSE_MISSING'
    );
  }
}

export async function sealCommonArtifacts(output, directory = root) {
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  check(git('status', '--porcelain') === '', 'RELEASE_SOURCE_DIRTY');
  await assertCommonCandidateChanged(directory);
  const sourceCommit = git('rev-parse', 'HEAD');
  await readReleaseVersions(directory);
  await checkPublicLicense(directory);
  await mkdir(output);
  const snapshot = await mkdtemp(resolve(tmpdir(), 'mar-common-candidate-'));
  try {
    const archive = execFileSync('git', ['-C', directory, 'archive', sourceCommit], {
      maxBuffer: 512 * 1024 * 1024
    });
    execFileSync('tar', ['-x', '-C', snapshot], { input: archive });
    for (const path of [...commonPaths, codeNavigationPath]) {
      await copyFile(resolve(snapshot, 'LICENSE'), resolve(snapshot, path, 'LICENSE'));
      await copyFile(resolve(snapshot, 'NOTICE'), resolve(snapshot, path, 'NOTICE'));
      const packagePath = resolve(snapshot, path, 'package.json');
      const pkg = await json(packagePath);
      pkg.files = [...new Set([...(pkg.files ?? []), 'LICENSE', 'NOTICE'])];
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    const pnpm = (...args) =>
      execFileSync('pnpm', args, {
        cwd: snapshot,
        stdio: 'inherit',
        timeout: 600_000
      });
    pnpm('install', '--frozen-lockfile');
    for (const name of buildableCommonNames) pnpm('--filter', name, 'build');
    for (const name of commonNames)
      pnpm('--filter', name, 'pack', '--pack-destination', resolve(output));
    check(git('status', '--porcelain') === '', 'RELEASE_SOURCE_CHANGED');
    check(git('rev-parse', 'HEAD') === sourceCommit, 'RELEASE_SOURCE_CHANGED');
    await createCommonManifest(output, resolve(output, 'common-manifest.json'), directory);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

export async function createProductManifest(commonManifestPath, directory = root) {
  const common = await verifyCommonArtifacts(commonManifestPath);
  const versions = await readReleaseVersions(directory);
  check(
    common.commonVersion === versions.commonVersion,
    'RELEASE_SELECTED_COMMON_VERSION_MISMATCH'
  );
  check(
    (common.codeNavigationVersion ?? common.commonVersion) === versions.codeNavigationVersion,
    'RELEASE_SELECTED_CODE_NAVIGATION_VERSION_MISMATCH'
  );
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  check(git('status', '--porcelain') === '', 'RELEASE_SOURCE_DIRTY');
  const protocol = await import(
    pathToFileURL(resolve(directory, 'packages/protocol/dist/index.js')).href
  );
  const schema = await import(
    pathToFileURL(resolve(directory, 'packages/server-core/dist/mysql-schema.js')).href
  );
  const enterpriseSchema = await import(
    pathToFileURL(resolve(directory, 'ee/server/dist/mysql/enterprise-migrations.js')).href
  );
  return {
    formatVersion: 1,
    edition: 'product',
    ...versions,
    ossCommit: git('rev-parse', 'HEAD'),
    ossLockfileSha256: digest(await readFile(resolve(directory, 'pnpm-lock.yaml')), 'sha256'),
    commonManifestSha256: digest(await readFile(commonManifestPath), 'sha256'),
    common,
    protocolFormatVersions: {
      node: protocol.NODE_PROTOCOL_VERSION,
      workbench: protocol.WORKBENCH_PROTOCOL_VERSION
    },
    schemaVersions: {
      core: schema.CORE_MYSQL_MIGRATIONS.at(-1).version,
      enterprise: enterpriseSchema.ENTERPRISE_MYSQL_MIGRATIONS.at(-1).version
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'check-versions') console.log(JSON.stringify(await readReleaseVersions()));
  else if (command === 'create-common' && first && second)
    await createCommonManifest(resolve(first), resolve(second));
  else if (command === 'verify-common' && first) await verifyCommonArtifacts(resolve(first));
  else if (command === 'seal-common' && first) await sealCommonArtifacts(resolve(first));
  else if (command === 'create-product' && first && second) {
    await checkProductLicense();
    const manifest = await createProductManifest(resolve(first));
    await writeFile(resolve(second), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  } else throw new Error('RELEASE_COMMAND_INVALID');
}
