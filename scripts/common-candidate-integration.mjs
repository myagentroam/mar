import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readReleaseVersions, verifyCommonArtifacts } from './release-artifacts.mjs';

const injectableCommonNames = ['protocol', 'code-navigation', 'agent', 'node'].map(
  (name) => `@myagentroam/${name}`
);
const commonNames = [...injectableCommonNames];
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
];

function check(value, code) {
  if (!value) throw new Error(code);
}

function safeRelativePath(value) {
  check(
    typeof value === 'string' &&
      value.length > 0 &&
      !isAbsolute(value) &&
      !value.includes('\\') &&
      !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
    'RELEASE_INTEGRATION_PATH_INVALID'
  );
  return value;
}

function within(root, path) {
  const value = relative(root, path);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  }).trim();
}

export function resolvePlaywrightBrowsersDir(environment = process.env) {
  const configured = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (typeof configured === 'string' && configured.length > 0 && configured !== '0')
    return resolve(configured);
  if (process.platform === 'darwin') return resolve(homedir(), 'Library/Caches/ms-playwright');
  if (process.platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    if (typeof localAppData === 'string' && localAppData.length > 0)
      return resolve(localAppData, 'ms-playwright');
    return resolve(homedir(), 'AppData/Local/ms-playwright');
  }
  const xdg = environment.XDG_CACHE_HOME;
  if (typeof xdg === 'string' && xdg.length > 0) return resolve(xdg, 'ms-playwright');
  return resolve(homedir(), '.cache/ms-playwright');
}

export function cleanCandidateEnvironment(workspace, caches = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^(?:NODE_AUTH_TOKEN|NPM_TOKEN)$/iu.test(key) ||
      /^npm_config_/iu.test(key) ||
      key === 'COREPACK_HOME' ||
      key === 'PLAYWRIGHT_BROWSERS_PATH'
    )
      delete environment[key];
  }
  const home = resolve(workspace, '.integration-home');
  const npmConfig = resolve(home, 'empty-npmrc');
  const storeDir =
    typeof caches.storeDir === 'string' && caches.storeDir.length > 0
      ? resolve(caches.storeDir)
      : undefined;
  const corepackHome =
    typeof caches.corepackHome === 'string' && caches.corepackHome.length > 0
      ? resolve(caches.corepackHome)
      : undefined;
  const browsersDir =
    typeof caches.browsersDir === 'string' && caches.browsersDir.length > 0
      ? resolve(caches.browsersDir)
      : undefined;
  return {
    ...environment,
    CI: '1',
    HOME: home,
    XDG_CONFIG_HOME: resolve(home, '.config'),
    ...(corepackHome ? { COREPACK_HOME: corepackHome } : {}),
    ...(browsersDir ? { PLAYWRIGHT_BROWSERS_PATH: browsersDir } : {}),
    NPM_CONFIG_USERCONFIG: npmConfig,
    npm_config_userconfig: npmConfig,
    NPM_CONFIG_GLOBALCONFIG: npmConfig,
    npm_config_globalconfig: npmConfig,
    ...(storeDir ? { npm_config_store_dir: storeDir, NPM_CONFIG_STORE_DIR: storeDir } : {})
  };
}

export function candidateCachePaths(versionSource) {
  const root = resolve(versionSource, 'test/runs');
  return {
    storeDir: resolve(root, '.pnpm-common-candidate-store-v11'),
    corepackHome: resolve(root, '.corepack-home'),
    browsersDir: resolvePlaywrightBrowsersDir()
  };
}

export async function createCandidateWorkspace(versionSource, edition) {
  check(
    typeof versionSource === 'string' && versionSource.length > 0,
    'RELEASE_INTEGRATION_SOURCE_INVALID'
  );
  check(
    typeof edition === 'string' && /^[a-z0-9-]+$/u.test(edition),
    'RELEASE_INTEGRATION_EDITION_INVALID'
  );
  const root = resolve(versionSource, 'test/runs');
  await mkdir(root, { recursive: true });
  return mkdtemp(resolve(root, `.mar-${edition}-candidate-`));
}

export function candidateNpmrcContents(storeDir) {
  check(typeof storeDir === 'string' && storeDir.length > 0, 'RELEASE_INTEGRATION_STORE_INVALID');
  return [
    `store-dir=${resolve(storeDir).replaceAll('\\', '/')}`,
    'prefer-offline=true',
    'verify-deps-before-run=false',
    'minimum-release-age=0',
    ''
  ].join('\n');
}

function run(directory, command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: directory,
    env: options.env ?? process.env,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? 'inherit',
    timeout: options.timeout ?? 1_200_000,
    maxBuffer: 64 * 1024 * 1024
  });
}

export function rewriteCommonDependencies(packageJson, specifiers, injectAll = false) {
  check(
    packageJson && typeof packageJson === 'object' && !Array.isArray(packageJson),
    'RELEASE_INTEGRATION_PACKAGE_INVALID'
  );
  const rewritten = structuredClone(packageJson);
  for (const section of dependencySections) {
    const dependencies = rewritten[section];
    if (dependencies === undefined) continue;
    check(
      dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies),
      'RELEASE_INTEGRATION_PACKAGE_INVALID'
    );
    for (const name of commonNames)
      if (Object.hasOwn(dependencies, name)) dependencies[name] = specifiers.get(name);
  }
  if (injectAll) {
    rewritten.devDependencies = { ...(rewritten.devDependencies ?? {}) };
    for (const name of injectableCommonNames)
      rewritten.devDependencies[name] = specifiers.get(name);
  }
  return rewritten;
}

export function createIntegrationWorkspaceDefinition(
  packagePaths,
  specifiers,
  workspace = process.cwd()
) {
  check(
    Array.isArray(packagePaths) && packagePaths.length > 0,
    'RELEASE_INTEGRATION_PACKAGES_REQUIRED'
  );
  const paths = [...new Set(packagePaths.map(safeRelativePath))];
  check(paths.length === packagePaths.length, 'RELEASE_INTEGRATION_PACKAGE_DUPLICATE');
  return [
    'packages:',
    ...paths.map((path) => `  - ${JSON.stringify(path)}`),
    'injectWorkspacePackages: true',
    'allowBuilds:',
    `  ${JSON.stringify(`@myagentroam/node@file:${portableRelativePath(workspace, specifiers.get('@myagentroam/node').slice(5))}`)}: true`,
    "  '@vue-office/docx': true",
    "  '@vue-office/excel': true",
    "  '@vue-office/pptx': true",
    '  esbuild: true',
    '  node-pty: true',
    '  vue-demi: true',
    'minimumReleaseAge: 0',
    'overrides:',
    ...commonNames.map(
      (name) => `  ${JSON.stringify(name)}: ${JSON.stringify(specifiers.get(name))}`
    ),
    ''
  ].join('\n');
}

async function archiveRepository(source, destination) {
  check(git(source, 'status', '--porcelain') === '', 'RELEASE_INTEGRATION_SOURCE_DIRTY');
  const commit = git(source, 'rev-parse', 'HEAD');
  check(/^[a-f0-9]{40}$/u.test(commit), 'RELEASE_INTEGRATION_SOURCE_INVALID');
  await mkdir(destination, { recursive: true });
  const archive = execFileSync('git', ['-C', source, 'archive', commit], {
    maxBuffer: 512 * 1024 * 1024
  });
  execFileSync('tar', ['-x', '-C', destination], {
    input: archive,
    maxBuffer: 512 * 1024 * 1024
  });
  return commit;
}

async function rewritePackage(path, specifiers, injectAll = false) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  const rewritten = rewriteCommonDependencies(value, specifiers, injectAll);
  await writeFile(path, `${JSON.stringify(rewritten, null, 2)}\n`);
  return rewritten;
}

async function candidateLinkTarget(workspace, consumer, item) {
  const link = resolve(workspace, consumer, 'node_modules', ...item.name.split('/'));
  const target = await realpath(link);
  check(
    within(resolve(workspace, 'node_modules/.pnpm'), target),
    'RELEASE_INTEGRATION_WORKSPACE_LINK'
  );
  const metadata = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
  check(
    metadata.name === item.name && metadata.version === item.version,
    'RELEASE_INTEGRATION_PACKAGE_MISMATCH'
  );
  return target;
}

async function assertCandidateLink(workspace, consumer, item, expectedTarget) {
  const target = await candidateLinkTarget(workspace, consumer, item);
  if (expectedTarget !== undefined)
    check(target === expectedTarget, 'RELEASE_INTEGRATION_CANDIDATE_MISMATCH');
  return relative(workspace, target).split(sep).join('/');
}

export async function resolveCandidatePackageTarget(consumerTarget, item) {
  const require = createRequire(resolve(consumerTarget, 'package.json'));
  let packageJson;
  try {
    packageJson = require.resolve(`${item.name}/package.json`);
  } catch {
    let entry;
    try {
      entry = require.resolve(item.name);
    } catch {
      throw new Error('RELEASE_INTEGRATION_PACKAGE_MISSING');
    }
    let current = dirname(entry);
    for (;;) {
      const candidate = resolve(current, 'package.json');
      try {
        const metadata = JSON.parse(await readFile(candidate, 'utf8'));
        if (metadata.name === item.name) {
          packageJson = candidate;
          break;
        }
      } catch {
        // Continue walking until the owning package metadata is found.
      }
      const parent = dirname(current);
      if (parent === current) throw new Error('RELEASE_INTEGRATION_PACKAGE_MISSING');
      current = parent;
    }
  }
  const target = await realpath(dirname(packageJson));
  const metadata = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
  check(
    metadata.name === item.name && metadata.version === item.version,
    'RELEASE_INTEGRATION_PACKAGE_MISMATCH'
  );
  return target;
}

async function assertCandidateResolution(workspace, consumerTarget, item, expectedTarget) {
  const target = await resolveCandidatePackageTarget(consumerTarget, item);
  check(target === expectedTarget, 'RELEASE_INTEGRATION_CANDIDATE_MISMATCH');
  return relative(workspace, target).split(sep).join('/');
}

async function assertProductSmoke(workspace, smoke) {
  for (const module of smoke.modules ?? []) {
    const path = resolve(workspace, safeRelativePath(module.path));
    const exports = await import(`${pathToFileURL(path).href}?candidate=${Date.now()}`);
    for (const name of module.exports ?? [])
      check(name in exports, 'RELEASE_INTEGRATION_EXPORT_MISSING');
  }
  for (const file of smoke.files ?? [])
    check(
      (await stat(resolve(workspace, safeRelativePath(file)))).isFile(),
      'RELEASE_INTEGRATION_BUILD_MISSING'
    );
}

function candidateSpecifiers(manifestPath, manifest) {
  return new Map(
    manifest.packages.map((item) => [
      item.name,
      `file:${resolve(dirname(manifestPath), item.file)}`
    ])
  );
}

function portableRelativePath(from, to) {
  const value = relative(from, to).split(sep).join('/');
  return value.startsWith('.') ? value : `./${value}`;
}

export function verifyCandidateLockfile(lockfile, workspace, manifestPath, manifest) {
  check(typeof lockfile === 'string', 'RELEASE_INTEGRATION_LOCK_MISMATCH');
  for (const item of manifest.packages) {
    const integrity = `sha512-${Buffer.from(item.sha512, 'hex').toString('base64')}`;
    const artifactPath = resolve(dirname(manifestPath), item.file);
    const tarball = `file:${portableRelativePath(workspace, artifactPath)}`;
    const resolution = lockfile
      .split(/\r?\n/u)
      .filter((line) => /^\s+resolution:/u.test(line))
      .find(
        (line) => line.includes(`integrity: ${integrity}`) && line.includes(`tarball: ${tarball}`)
      );
    check(resolution !== undefined, 'RELEASE_INTEGRATION_LOCK_MISMATCH');
  }
}

export function validateIntegrationConfiguration(configuration) {
  check(
    configuration &&
      configuration.edition === 'product' &&
      Array.isArray(configuration.repositories) &&
      configuration.repositories.length > 0 &&
      Array.isArray(configuration.workspacePackages) &&
      configuration.workspacePackages.length > 0 &&
      Array.isArray(configuration.commonSourcePaths) &&
      configuration.commonSourcePaths.length === commonNames.length &&
      Array.isArray(configuration.buildArguments) &&
      configuration.buildArguments.length > 0 &&
      Array.isArray(configuration.testArguments) &&
      configuration.testArguments.length > 0 &&
      configuration.testArguments.every(
        (argument) => typeof argument === 'string' && argument.length > 0
      ) &&
      typeof configuration.versionSource === 'string' &&
      configuration.versionSource.length > 0,
    'RELEASE_INTEGRATION_CONFIGURATION_INVALID'
  );
  const repositoryNames = new Set();
  for (const repository of configuration.repositories) {
    check(
      repository &&
        typeof repository.name === 'string' &&
        /^[a-z][a-z0-9-]*$/u.test(repository.name) &&
        !repositoryNames.has(repository.name) &&
        typeof repository.source === 'string' &&
        repository.source.length > 0 &&
        typeof repository.destination === 'string',
      'RELEASE_INTEGRATION_CONFIGURATION_INVALID'
    );
    repositoryNames.add(repository.name);
    if (repository.destination !== '.') safeRelativePath(repository.destination);
  }
  configuration.workspacePackages.forEach(safeRelativePath);
  configuration.commonSourcePaths.forEach(safeRelativePath);
  return configuration;
}

export async function verifyProductCommonIntegration(manifestPath, configuration, output) {
  const config = validateIntegrationConfiguration(configuration);
  const absoluteManifest = resolve(manifestPath);
  const manifest = await verifyCommonArtifacts(absoluteManifest);
  const versions = await readReleaseVersions(config.versionSource);
  check(
    versions.commonVersion === manifest.commonVersion,
    'RELEASE_SELECTED_COMMON_VERSION_MISMATCH'
  );
  check(
    versions.codeNavigationVersion === (manifest.codeNavigationVersion ?? manifest.commonVersion),
    'RELEASE_SELECTED_CODE_NAVIGATION_VERSION_MISMATCH'
  );
  const workspace = await createCandidateWorkspace(config.versionSource, config.edition);
  const { storeDir: store, corepackHome, browsersDir } = candidateCachePaths(config.versionSource);
  const environment = cleanCandidateEnvironment(workspace, {
    storeDir: store,
    corepackHome,
    browsersDir
  });
  try {
    await mkdir(environment.HOME, { recursive: true });
    await mkdir(store, { recursive: true });
    await mkdir(corepackHome, { recursive: true });
    await mkdir(browsersDir, { recursive: true });
    await writeFile(environment.NPM_CONFIG_USERCONFIG, candidateNpmrcContents(store));
    const sourceCommits = {};
    for (const repository of config.repositories) {
      const destination =
        repository.destination === '.'
          ? workspace
          : resolve(workspace, safeRelativePath(repository.destination));
      sourceCommits[repository.name] = await archiveRepository(repository.source, destination);
    }
    for (const path of config.commonSourcePaths)
      await rm(resolve(workspace, path), { recursive: true, force: true });
    await rm(resolve(workspace, '.npmrc'), { force: true });
    const specifiers = candidateSpecifiers(absoluteManifest, manifest);
    await rewritePackage(resolve(workspace, 'package.json'), specifiers, true);
    const consumers = ['.'];
    for (const packagePath of config.workspacePackages) {
      const packageJsonPath = resolve(workspace, packagePath, 'package.json');
      const rewritten = await rewritePackage(packageJsonPath, specifiers);
      if (
        dependencySections.some((section) =>
          commonNames.some((name) => Object.hasOwn(rewritten[section] ?? {}, name))
        )
      )
        consumers.push(packagePath);
    }
    await writeFile(
      resolve(workspace, 'pnpm-workspace.yaml'),
      createIntegrationWorkspaceDefinition(config.workspacePackages, specifiers, workspace)
    );
    run(
      workspace,
      'pnpm',
      ['install', '--no-frozen-lockfile', '--store-dir', store, '--prefer-offline'],
      {
        env: environment
      }
    );
    const lockfile = await readFile(resolve(workspace, 'pnpm-lock.yaml'), 'utf8');
    verifyCandidateLockfile(lockfile, workspace, absoluteManifest, manifest);
    const rootTargets = new Map(
      await Promise.all(
        manifest.packages
          .filter((item) => injectableCommonNames.includes(item.name))
          .map(async (item) => [item.name, await candidateLinkTarget(workspace, '.', item)])
      )
    );
    const resolutions = [];
    for (const consumer of consumers) {
      const metadata = JSON.parse(
        await readFile(resolve(workspace, consumer, 'package.json'), 'utf8')
      );
      for (const item of manifest.packages) {
        const declared = dependencySections.some(
          (section) => metadata[section]?.[item.name] !== undefined
        );
        if (!declared) continue;
        resolutions.push({
          consumer,
          name: item.name,
          version: item.version,
          path: await assertCandidateLink(workspace, consumer, item, rootTargets.get(item.name))
        });
      }
    }
    const nodeConsumer = rootTargets.get('@myagentroam/node');
    for (const name of [
      '@myagentroam/agent',
      '@myagentroam/code-navigation',
      '@myagentroam/protocol'
    ]) {
      const item = manifest.packages.find((candidate) => candidate.name === name);
      check(item !== undefined, 'RELEASE_COMMON_GROUP_INCOMPLETE');
      resolutions.push({
        consumer: '@myagentroam/node',
        name,
        version: item.version,
        path: await assertCandidateResolution(workspace, nodeConsumer, item, rootTargets.get(name))
      });
    }
    run(workspace, 'pnpm', config.testArguments, { env: environment });
    run(workspace, 'pnpm', config.buildArguments, { env: environment });
    await assertProductSmoke(workspace, config.smoke ?? {});
    const protocol = await import(
      `${pathToFileURL(resolve(rootTargets.get('@myagentroam/protocol'), 'dist/index.js')).href}?candidate=${Date.now()}`
    );
    check(
      Number.isSafeInteger(protocol.NODE_PROTOCOL_VERSION) &&
        Number.isSafeInteger(protocol.WORKBENCH_PROTOCOL_VERSION),
      'RELEASE_INTEGRATION_PROTOCOL_INVALID'
    );
    const agent = await import(
      `${pathToFileURL(resolve(rootTargets.get('@myagentroam/agent'), 'dist/index.js')).href}?candidate=${Date.now()}`
    );
    check(typeof agent.createMarAgent === 'function', 'RELEASE_INTEGRATION_AGENT_INVALID');
    const nodeOutput = run(
      workspace,
      process.execPath,
      [resolve(rootTargets.get('@myagentroam/node'), 'dist/main.js'), 'status'],
      { env: environment, stdio: 'pipe' }
    );
    check(JSON.parse(nodeOutput).status === 'ok', 'RELEASE_INTEGRATION_NODE_INVALID');
    const report = {
      formatVersion: 1,
      edition: config.edition,
      productVersion: versions.productVersion,
      commonVersion: manifest.commonVersion,
      codeNavigationVersion: manifest.codeNavigationVersion ?? manifest.commonVersion,
      commonManifestSha256: createHash('sha256')
        .update(await readFile(absoluteManifest))
        .digest('hex'),
      sourceCommits,
      packages: manifest.packages.map(({ name, version, sha512 }) => ({
        name,
        version,
        sha512
      })),
      resolutions,
      checks: {
        isolatedInstall: true,
        workspaceSourcesExcluded: true,
        candidateLockIntegrity: true,
        productTests: true,
        productBuild: true,
        productSmoke: true,
        protocolSmoke: true,
        agentSmoke: true,
        nodeSmoke: true
      }
    };
    if (output !== undefined)
      await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return report;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function verifyUnifiedCommonIntegration(manifestPath, output, directory) {
  const source = resolve(directory);
  return verifyProductCommonIntegration(
    manifestPath,
    {
      edition: 'product',
      versionSource: source,
      repositories: [{ name: 'oss', source, destination: '.' }],
      workspacePackages: [
        'mar-server',
        'ee/server',
        'ee/web',
        'mar-web-console',
        'packages/server-core',
        'packages/web-core'
      ],
      commonSourcePaths: ['packages/protocol', 'packages/code-navigation', 'mar-agent', 'mar-node'],
      testArguments: [
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.config.ts',
        'test/unit/server-smoke.test.ts',
        'test/unit/enterprise-server-package.test.ts'
      ],
      buildArguments: [
        '--filter',
        '@myagentroam/server...',
        '--filter',
        '@myagentroam/web-console...',
        'build'
      ],
      smoke: {
        modules: [{ path: 'ee/server/dist/app.js', exports: ['createServerApp'] }],
        files: ['mar-web-console/dist/index.html']
      }
    },
    output
  );
}
