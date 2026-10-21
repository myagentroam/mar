import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  validateVersionGroups,
  MAIN_PACKAGE_PATHS,
  readReleaseVersions,
  validateMarctlVersionLine,
  validateCommonManifest,
  checkPublicLicense,
  inspectMarctlArchive,
  packedMetadata,
  verifyCommonArtifacts
} from '../../scripts/release-artifacts.mjs';
import { nextPatchVersion, bumpVersion } from '../../scripts/bump-version.mjs';
import { CODE_NAVIGATION_PACKAGE_PATH } from '../../scripts/bump-code-navigation-version.mjs';
import { MARCTL_PACKAGE_PATH } from '../../scripts/bump-marctl-version.mjs';
import { COMPUTER_RUNTIME_PACKAGE_PATHS } from '../../scripts/bump-computer-runtime-version.mjs';
import {
  cleanCandidateEnvironment,
  candidateCachePaths,
  candidateNpmrcContents,
  createCandidateWorkspace,
  createIntegrationWorkspaceDefinition,
  resolveCandidatePackageTarget,
  rewriteCommonDependencies,
  validateIntegrationConfiguration,
  verifyCandidateLockfile,
  resolvePlaywrightBrowsersDir
} from '../../scripts/common-candidate-integration.mjs';
import { cleanBuildOutput } from '../../scripts/clean-build-output.mjs';
import {
  stageAllComputerUseRuntimes,
  stageComputerUseRuntime
} from '../../scripts/stage-computer-use-runtime.mjs';
import {
  computerRuntimePipTarget,
  computerUseRuntimeSourceRoot,
  computerUseRuntimeTreeSha256,
  currentComputerRuntimeId,
  defaultComputerUseRuntimeSourceRoot,
  expectedComputerUseRuntimeSource,
  readComputerUseRuntimeLock,
  verifyPreparedComputerUseRuntime
} from '../../scripts/prepare-computer-use-runtime.mjs';
import {
  computerRuntimePaths,
  computerRuntimeTargets,
  publishedComputerRuntimeTargets
} from '../../scripts/computer-runtime-packages.mjs';
import {
  computerRuntimeArtifactArguments,
  validateComputerRuntimeManifest,
  verifyComputerRuntimeArtifacts
} from '../../scripts/computer-runtime-artifacts.mjs';
import { validateMarctlManifest } from '../../scripts/marctl-release-artifacts.mjs';
import {
  assertCommonCandidateChanged,
  assertUnifiedVersionPublished,
  assertIndependentReleaseChanged,
  releaseLineStatus,
  releasePlan
} from '../../scripts/release-version-policy.mjs';

const ossRoot = fileURLToPath(new URL('../..', import.meta.url));
const commonNames = [
  '@myagentroam/protocol',
  '@myagentroam/code-navigation',
  '@myagentroam/agent',
  '@myagentroam/node'
];

test('Computer Use runtime artifact CLI accepts pnpm argument separators', () => {
  assert.deepEqual(computerRuntimeArtifactArguments(['seal', 'candidate']), {
    command: 'seal',
    first: 'candidate'
  });
  assert.deepEqual(computerRuntimeArtifactArguments(['verify', '--', 'manifest.json']), {
    command: 'verify',
    first: 'manifest.json'
  });
});

function archive(entries) {
  const blocks = entries.map(([name, content, type = '0', mode = 0o644]) => {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(mode.toString(8).padStart(7, '0'), 100, 7);
    header.write(body.length.toString(8).padStart(11, '0'), 124, 11);
    header.write(type, 156, 1);
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6);
    header[154] = 0;
    header[155] = 32;
    return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('archive verification rejects hidden source, links, duplicate entries and private code', () => {
  const pkg = ['package/package.json', '{"name":"@myagentroam/protocol","version":"1.0.0"}'];
  const materials = [
    ['package/LICENSE', 'Fixture license'],
    ['package/NOTICE', 'Fixture notice']
  ];
  assert.equal(
    packedMetadata(archive([pkg, ...materials, ['package/dist/index.js', 'export {};']])).version,
    '1.0.0'
  );
  assert.equal(
    packedMetadata(
      archive([
        pkg,
        ...materials,
        ['package/vendor/ctags/source/universal-ctags-6.2.1.tar.gz', 'fixture']
      ])
    ).version,
    '1.0.0'
  );
  for (const entry of [
    ['package/../outside.js', ''],
    ['package/.env', 'fixture'],
    ['package/dist/source.ts', 'export {};'],
    ['package/dist/index.js.map', '{}'],
    ['package/dist/index.js', '', '2'],
    ['package/dist/index.js', 'import "@myagentroam-enterprise/private";'],
    pkg
  ])
    assert.throws(() => packedMetadata(archive([pkg, ...materials, entry])));
  assert.throws(
    () => packedMetadata(archive([pkg, ['package/dist/index.js', 'export {};']])),
    /RELEASE_ARCHIVE_LICENSE_MISSING/u
  );
});

test('only Node archives may include the registered browser preparation script', () => {
  const entries = [
    ['package/LICENSE', 'Fixture license'],
    ['package/NOTICE', 'Fixture notice'],
    ['package/dist/main.js', 'export {};'],
    ['package/scripts/install-web-browser.mjs', 'export {};']
  ];
  assert.equal(
    packedMetadata(
      archive([
        ['package/package.json', '{"name":"@myagentroam/node","version":"1.0.0"}'],
        ...entries
      ])
    ).name,
    '@myagentroam/node'
  );
  assert.throws(
    () =>
      packedMetadata(
        archive([
          ['package/package.json', '{"name":"@myagentroam/agent","version":"1.0.0"}'],
          ...entries
        ])
      ),
    /RELEASE_ARCHIVE_FILE_FORBIDDEN/u
  );
  assert.throws(
    () =>
      packedMetadata(
        archive([
          ['package/package.json', '{"name":"@myagentroam/node","version":"1.0.0"}'],
          ...entries,
          ['package/scripts/unregistered.mjs', 'export {};']
        ])
      ),
    /RELEASE_ARCHIVE_FILE_FORBIDDEN/u
  );
});

test('marctl release is standalone and accepts only the current common major.minor line', async () => {
  assert.deepEqual(validateMarctlVersionLine('0.9.112', '0.9.113'), {
    marctlVersion: '0.9.112',
    commonVersion: '0.9.113'
  });
  assert.throws(
    () => validateMarctlVersionLine('0.10.0', '0.9.113'),
    /RELEASE_MARCTL_VERSION_LINE_MISMATCH/u
  );
  assert.equal(MARCTL_PACKAGE_PATH, 'marctl/package.json');

  const directory = await mkdtemp(join(tmpdir(), 'mar-marctl-release-'));
  try {
    const bytes = archive([
      [
        'package/package.json',
        '{"name":"@myagentroam/marctl","version":"0.9.112","bin":{"marctl":"bin/marctl.mjs"}}'
      ],
      ['package/LICENSE', 'Fixture license'],
      ['package/NOTICE', 'Fixture notice'],
      ['package/bin/marctl.mjs', '#!/usr/bin/env node\n', '0', 0o755],
      ['package/src/cli.mjs', 'export const main = () => 0;'],
      ['package/src/scp-worker.cjs', 'module.exports = {};'],
      ['package/src/terminal-relay-sender.d.mts', 'export interface RelaySender {}']
    ]);
    const file = 'myagentroam-marctl-0.9.112.tgz';
    await writeFile(join(directory, file), bytes);
    const manifest = {
      formatVersion: 1,
      marctlVersion: '0.9.112',
      commonVersion: '0.9.113',
      sourceCommit: 'a'.repeat(40),
      lockfileSha256: 'b'.repeat(64),
      package: {
        name: '@myagentroam/marctl',
        version: '0.9.112',
        file,
        sha512: createHash('sha512').update(bytes).digest('hex')
      }
    };
    assert.equal(validateMarctlManifest(manifest), manifest);
    await assert.doesNotReject(inspectMarctlArchive(join(directory, file), '0.9.112'));
    const unregistered = archive([
      ['package/package.json', '{"name":"@myagentroam/marctl","version":"0.9.112"}'],
      ['package/src/unregistered.d.mts', 'export interface Unregistered {}']
    ]);
    await writeFile(join(directory, 'unregistered.tgz'), unregistered);
    await assert.rejects(
      inspectMarctlArchive(join(directory, 'unregistered.tgz'), '0.9.112'),
      /RELEASE_ARCHIVE_FILE_FORBIDDEN/u
    );
    assert.throws(() => validateMarctlManifest({ ...manifest, commonVersion: '0.10.0' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('common candidate verification accepts npm-normalized Linux Ctags mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-release-ctags-mode-'));
  try {
    const packages = [
      {
        name: '@myagentroam/protocol',
        file: 'myagentroam-protocol-1.0.0.tgz',
        entries: []
      },
      {
        name: '@myagentroam/code-navigation',
        file: 'myagentroam-code-navigation-0.9.7.tgz',
        version: '0.9.7',
        entries: []
      },
      {
        name: '@myagentroam/agent',
        file: 'myagentroam-agent-1.0.0.tgz',
        entries: []
      },
      {
        name: '@myagentroam/node',
        file: 'myagentroam-node-1.0.0.tgz',
        entries: [['package/vendor/ctags/linux-x64/ctags', 'binary', '0', 0o644]],
        dependencies: {
          '@myagentroam/agent': '1.0.0',
          '@myagentroam/code-navigation': '0.9.7',
          '@myagentroam/protocol': '1.0.0'
        }
      }
    ];
    const manifestPackages = [];
    for (const pkg of packages) {
      const bytes = archive([
        [
          'package/package.json',
          JSON.stringify({
            name: pkg.name,
            version: pkg.version ?? '1.0.0',
            ...(pkg.dependencies === undefined ? {} : { dependencies: pkg.dependencies })
          })
        ],
        ['package/LICENSE', 'Fixture license'],
        ['package/NOTICE', 'Fixture notice'],
        ['package/dist/main.js', 'export {};'],
        ...pkg.entries
      ]);
      await writeFile(join(directory, pkg.file), bytes);
      manifestPackages.push({
        name: pkg.name,
        version: pkg.version ?? '1.0.0',
        file: pkg.file,
        sha512: createHash('sha512').update(bytes).digest('hex')
      });
    }
    const manifestPath = join(directory, 'common-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        formatVersion: 2,
        commonVersion: '1.0.0',
        codeNavigationVersion: '0.9.7',
        sourceCommit: 'a'.repeat(40),
        lockfileSha256: 'b'.repeat(64),
        packages: manifestPackages
      })
    );

    await assert.doesNotReject(verifyCommonArtifacts(manifestPath));
    const node = manifestPackages.find((item) => item.name === '@myagentroam/node');
    const invalidNode = archive([
      [
        'package/package.json',
        JSON.stringify({
          name: '@myagentroam/node',
          version: '1.0.0',
          dependencies: { '@myagentroam/code-navigation': '1.0.0' }
        })
      ],
      ['package/LICENSE', 'Fixture license'],
      ['package/NOTICE', 'Fixture notice'],
      ['package/dist/main.js', 'export {};'],
      ['package/vendor/ctags/linux-x64/ctags', 'binary', '0', 0o644]
    ]);
    await writeFile(join(directory, node.file), invalidNode);
    node.sha512 = createHash('sha512').update(invalidNode).digest('hex');
    await writeFile(
      manifestPath,
      JSON.stringify({
        formatVersion: 2,
        commonVersion: '1.0.0',
        codeNavigationVersion: '0.9.7',
        sourceCommit: 'a'.repeat(40),
        lockfileSha256: 'b'.repeat(64),
        packages: manifestPackages
      })
    );
    await assert.rejects(
      verifyCommonArtifacts(manifestPath),
      /RELEASE_ARCHIVE_DEPENDENCY_MISMATCH/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate sealing requires explicit license materials and package declarations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-release-license-'));
  try {
    await assert.rejects(checkPublicLicense(directory), /RELEASE_LICENSE_MATERIALS_MISSING/u);
    await writeFile(join(directory, 'LICENSE'), 'License test fixture');
    await writeFile(join(directory, 'NOTICE'), 'Notice test fixture');
    for (const path of ['packages/protocol', 'packages/code-navigation', 'mar-agent', 'mar-node']) {
      await mkdir(join(directory, path), { recursive: true });
      await writeFile(
        join(directory, path, 'package.json'),
        JSON.stringify({ license: 'UNLICENSED' })
      );
    }
    await assert.rejects(checkPublicLicense(directory), /RELEASE_PACKAGE_LICENSE_MISSING/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('all main packages require one stable release version', () => {
  const commonVersions = ['1.2.0', '1.2.0', '1.2.0'];
  assert.deepEqual(validateVersionGroups(['1.2.0', '1.2.0'], commonVersions), {
    productVersion: '1.2.0',
    commonVersion: '1.2.0'
  });
  assert.throws(
    () => validateVersionGroups(['1.2.1'], commonVersions),
    /RELEASE_VERSION_GROUP_MISMATCH/u
  );
  assert.throws(() => validateVersionGroups(['1.2.0', '1.2.1'], commonVersions));
  assert.throws(() =>
    validateVersionGroups(
      ['1.2.0'],
      commonVersions.map((version, index) => (index === 1 ? '1.1.5' : version))
    )
  );
  assert.throws(() => validateVersionGroups(['1.2.0-rc.1'], commonVersions));
});

test('Code Navigation version is independent and Node pins its exact release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-release-version-lines-'));
  try {
    const packages = [
      ...[
        '.',
        'mar-server',
        'ee/server',
        'ee/web',
        'mar-web-console',
        'packages/server-core',
        'packages/web-core'
      ].map((path) => [path, { version: '1.0.0' }]),
      ['packages/protocol', { name: '@myagentroam/protocol', version: '1.0.0' }],
      ['mar-agent', { name: '@myagentroam/agent', version: '1.0.0' }],
      [
        'mar-node',
        {
          name: '@myagentroam/node',
          version: '1.0.0',
          dependencies: {
            '@myagentroam/code-navigation': '0.9.7',
            '@myagentroam/marctl': '1.0.1'
          }
        }
      ],
      ['packages/code-navigation', { name: '@myagentroam/code-navigation', version: '0.9.7' }],
      ['marctl', { name: '@myagentroam/marctl', version: '1.0.1' }]
    ];
    for (const [path, pkg] of packages) {
      await mkdir(join(directory, path), { recursive: true });
      await writeFile(join(directory, path, 'package.json'), JSON.stringify(pkg));
    }
    assert.deepEqual(await readReleaseVersions(directory), {
      productVersion: '1.0.0',
      commonVersion: '1.0.0',
      codeNavigationVersion: '0.9.7',
      marctlVersion: '1.0.1'
    });
    const nodePackage = join(directory, 'mar-node/package.json');
    const node = JSON.parse(await readFile(nodePackage, 'utf8'));
    node.dependencies['@myagentroam/code-navigation'] = '1.0.0';
    await writeFile(nodePackage, JSON.stringify(node));
    await assert.rejects(readReleaseVersions(directory), /RELEASE_COMMON_DEPENDENCY_INVALID/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('main product release bump advances only the patch component', () => {
  assert.equal(nextPatchVersion('0.9.63'), '0.9.64');
  assert.equal(nextPatchVersion('1.2.9'), '1.2.10');
  assert.throws(() => nextPatchVersion('0.9.63-rc.1'), /RELEASE_PRODUCT_VERSION_INVALID/u);
});

test('the unified release bump covers every main package but excludes independent components', () => {
  assert.deepEqual(MAIN_PACKAGE_PATHS, [
    'package.json',
    'mar-server/package.json',
    'ee/server/package.json',
    'ee/web/package.json',
    'mar-web-console/package.json',
    'packages/server-core/package.json',
    'packages/web-core/package.json',
    'packages/protocol/package.json',
    'mar-agent/package.json',
    'mar-node/package.json'
  ]);
  assert.equal(CODE_NAVIGATION_PACKAGE_PATH, 'packages/code-navigation/package.json');
});

for (const target of ['product', 'common']) {
  test(`one ${target} release advances all main packages once without advancing independent packages`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-unified-version-'));
    const git = (...args) =>
      execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    const independent = [
      CODE_NAVIGATION_PACKAGE_PATH,
      MARCTL_PACKAGE_PATH,
      ...COMPUTER_RUNTIME_PACKAGE_PATHS
    ];
    try {
      git('init', '-b', 'develop');
      git('config', 'user.name', 'Release Test');
      git('config', 'user.email', 'release@example.invalid');
      for (const path of [...MAIN_PACKAGE_PATHS, ...independent]) {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), JSON.stringify({ version: '0.10.1' }));
      }
      git('add', '.');
      git('commit', '-m', 'fixture');
      await assert.rejects(bumpVersion(directory), /RELEASE_VERSION_NOT_PUBLISHED/u);
      git('tag', `${target}-v0.10.1`);
      await assert.rejects(bumpVersion(directory), /RELEASE_MAIN_NOT_SYNCHRONIZED/u);
      await writeFile(join(directory, 'untracked'), 'dirty');
      await assert.rejects(bumpVersion(directory), /RELEASE_SOURCE_DIRTY/u);
      await rm(join(directory, 'untracked'));
      git('switch', '-c', 'main');
      await assert.rejects(bumpVersion(directory), /RELEASE_DEVELOP_BRANCH_REQUIRED/u);
      git('switch', 'develop');
      assert.equal((await bumpVersion(directory)).version, '0.10.2');
      for (const path of MAIN_PACKAGE_PATHS)
        assert.equal(JSON.parse(await readFile(join(directory, path), 'utf8')).version, '0.10.2');
      for (const path of independent)
        assert.equal(JSON.parse(await readFile(join(directory, path), 'utf8')).version, '0.10.1');
      git('add', '.');
      git('commit', '-m', 'fixture next version');
      await assert.rejects(bumpVersion(directory), /RELEASE_VERSION_NOT_PUBLISHED/u);
      git('tag', `${target}-v0.10.2`);
      await assert.rejects(bumpVersion(directory), /RELEASE_MAIN_NOT_SYNCHRONIZED/u);
      await writeFile(
        join(directory, MAIN_PACKAGE_PATHS[1]),
        JSON.stringify({ version: '0.10.3' })
      );
      git('add', '.');
      git('commit', '-m', 'fixture version drift');
      await assert.rejects(bumpVersion(directory), /RELEASE_PRODUCT_VERSION_GROUP_MISMATCH/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const [line, path] of [
  ['code-navigation', 'packages/code-navigation/package.json'],
  ['marctl', 'marctl/package.json'],
  ['runtime', 'packages/computer-runtime-linux-x64/package.json']
]) {
  test(`${line} accepts a new minor baseline without treating empty patch bumps as changes`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-independent-baseline-'));
    const git = (...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    try {
      git('init', '-b', 'develop');
      git('config', 'user.name', 'Release Test');
      git('config', 'user.email', 'release@example.invalid');
      await mkdir(dirname(join(directory, path)), { recursive: true });
      const writeVersion = (version) =>
        writeFile(join(directory, path), JSON.stringify({ version }));
      await writeVersion('0.9.1');
      git('add', '.');
      git('commit', '-m', 'fixture baseline');
      git('tag', `${line}-v0.9.1`);
      await writeVersion('0.9.2');
      await assert.rejects(
        assertIndependentReleaseChanged(line, directory),
        /RELEASE_INDEPENDENT_PACKAGE_UNCHANGED/u
      );
      await writeVersion('0.10.1');
      const status = await assertIndependentReleaseChanged(line, directory);
      assert.equal(status.versionBaselineChanged, true);
      assert.deepEqual(status.changedPaths, []);
      git('add', '.');
      git('commit', '-m', 'fixture minor baseline');
      git('tag', `${line}-v0.10.1`);
      await assert.rejects(
        assertIndependentReleaseChanged(line, directory),
        /RELEASE_INDEPENDENT_PACKAGE_UNCHANGED/u
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('release plan includes common version changes and detects independent package content changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-release-policy-'));
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  const packages = [
    ['mar-node/package.json', '@myagentroam/node', '1.0.0'],
    ['mar-agent/package.json', '@myagentroam/agent', '1.0.0'],
    ['packages/protocol/package.json', '@myagentroam/protocol', '1.0.0'],
    ['packages/code-navigation/package.json', '@myagentroam/code-navigation', '0.9.8'],
    ['marctl/package.json', '@myagentroam/marctl', '0.9.7'],
    ['packages/computer-runtime-linux-x64/package.json', '@myagentroam/runtime', '0.9.6']
  ];
  try {
    git('init');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release@example.invalid');
    for (const [path, name, version] of packages) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), `${JSON.stringify({ name, version }, null, 2)}\n`);
    }
    await writeFile(join(directory, 'marctl/cli.mjs'), 'export const version = 1;\n');
    git('add', '.');
    git('commit', '-m', 'fixture baseline');
    git('tag', 'common-v1.0.0');
    git('tag', 'code-navigation-v0.9.8');
    git('tag', 'marctl-v0.9.7');
    git('tag', 'runtime-v0.9.6');

    const nodePackage = join(directory, 'mar-node/package.json');
    const node = JSON.parse(await readFile(nodePackage, 'utf8'));
    node.version = '1.0.1';
    await writeFile(nodePackage, `${JSON.stringify(node, null, 2)}\n`);
    assert.equal((await releaseLineStatus('common', directory)).changed, false);
    await assert.rejects(
      assertUnifiedVersionPublished(directory, '1.0.1'),
      /RELEASE_VERSION_NOT_PUBLISHED/u
    );
    for (const [path, name] of packages.slice(0, 3)) {
      await writeFile(join(directory, path), JSON.stringify({ name, version: '1.0.1' }));
    }
    const versionPlan = await releasePlan(directory);
    assert.equal(versionPlan.lines.common.changed, false);
    assert.equal(versionPlan.commonVersionChanged, true);
    assert.equal(versionPlan.commonCandidateChanged, true);
    assert.equal(versionPlan.commonRequired, true);
    await assert.doesNotReject(assertCommonCandidateChanged(directory));
    for (const [path, name, version] of packages.slice(0, 3)) {
      await writeFile(join(directory, path), JSON.stringify({ name, version }, null, 2) + '\n');
    }
    assert.equal((await releasePlan(directory)).commonVersionChanged, false);
    await assert.rejects(
      assertCommonCandidateChanged(directory),
      /RELEASE_COMMON_GROUP_UNCHANGED/u
    );

    await writeFile(join(directory, 'marctl/cli.mjs'), 'export const version = 2;\n');
    assert.equal((await releaseLineStatus('marctl', directory)).changed, true);
    await assert.doesNotReject(assertIndependentReleaseChanged('marctl', directory));
    const plan = await releasePlan(directory);
    assert.equal(plan.lines['code-navigation'].changed, false);
    assert.equal(plan.lines.runtime.changed, false);
    assert.equal(plan.commonRequired, true);
    assert.equal(plan.commonCandidateChanged, false);
    await assert.rejects(
      assertCommonCandidateChanged(directory),
      /RELEASE_COMMON_GROUP_UNCHANGED/u
    );

    const marctlPackage = join(directory, 'marctl/package.json');
    const marctl = JSON.parse(await readFile(marctlPackage, 'utf8'));
    marctl.version = '0.9.8';
    await writeFile(marctlPackage, `${JSON.stringify(marctl, null, 2)}\n`);
    git('add', '.');
    git('commit', '-m', 'release marctl');
    git('tag', 'marctl-v0.9.8');
    const afterIndependentRelease = await releasePlan(directory);
    assert.equal(afterIndependentRelease.lines.marctl.changed, false);
    assert.deepEqual(afterIndependentRelease.commonDependencyChanges.marctl, {
      currentVersion: '0.9.8',
      commonBaselineVersion: '0.9.7',
      changed: true
    });
    assert.equal(afterIndependentRelease.commonRequired, true);
    assert.equal(afterIndependentRelease.commonCandidateChanged, true);
    await assert.doesNotReject(assertCommonCandidateChanged(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('marctl release planning reads legacy tags and accounts for a same-version package rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-marctl-release-policy-'));
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release@example.invalid');
    for (const [path, name] of [
      ['mar-node', '@myagentroam/node'],
      ['mar-agent', '@myagentroam/agent'],
      ['packages/protocol', '@myagentroam/protocol'],
      ['packages/code-navigation', '@myagentroam/code-navigation'],
      ['packages/computer-runtime-linux-x64', '@myagentroam/runtime'],
      ['marmgr', '@myagentroam/marmgr']
    ]) {
      await mkdir(join(directory, path), { recursive: true });
      await writeFile(
        join(directory, path, 'package.json'),
        JSON.stringify({ name, version: '0.9.1' })
      );
    }
    git('add', '.');
    git('commit', '-m', 'legacy release baseline');
    for (const prefix of ['common', 'code-navigation', 'runtime', 'marmgr'])
      git('tag', `${prefix}-v0.9.1`);
    await rename(join(directory, 'marmgr'), join(directory, 'marctl'));
    await writeFile(
      join(directory, 'marctl/package.json'),
      JSON.stringify({ name: '@myagentroam/marctl', version: '0.9.1' })
    );
    git('add', '.');
    git('commit', '-m', 'rename CLI');
    const plan = await releasePlan(directory);
    assert.equal(plan.lines.marctl.tag, 'marmgr-v0.9.1');
    assert.equal(plan.lines.marctl.changed, true);
    assert.equal(plan.commonDependencyChanges.marctl.changed, true);
    assert.equal(plan.commonRequired, true);
    assert.equal(plan.commonCandidateChanged, true);
    const planning = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { releasePlan } from ${JSON.stringify(new URL('../../scripts/release-version-policy.mjs', import.meta.url).href)};
         await releasePlan(process.argv[1]);`,
        directory
      ],
      { encoding: 'utf8' }
    );
    assert.equal(planning.status, 0, planning.stderr);
    assert.equal(planning.stderr, '', 'Expected legacy fallback must not print fatal errors');
    git('tag', 'marctl-v0.9.1');
    assert.equal((await releaseLineStatus('marctl', directory)).tag, 'marctl-v0.9.1');
    assert.equal((await releaseLineStatus('marctl', directory)).changed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Computer Use runtime versioning covers every published platform target', () => {
  assert.deepEqual(COMPUTER_RUNTIME_PACKAGE_PATHS, [
    'packages/computer-runtime-win32-x64/package.json',
    'packages/computer-runtime-win32-arm64/package.json',
    'packages/computer-runtime-darwin-x64/package.json',
    'packages/computer-runtime-darwin-arm64/package.json',
    'packages/computer-runtime-linux-x64/package.json',
    'packages/computer-runtime-linux-arm64/package.json'
  ]);
});

test('common manifests require the complete exact component group and safe artifact names', () => {
  const manifest = {
    formatVersion: 2,
    commonVersion: '1.1.4',
    codeNavigationVersion: '1.0.8',
    sourceCommit: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64),
    packages: commonNames.map((name) => ({
      name,
      version: name === '@myagentroam/code-navigation' ? '1.0.8' : '1.1.4',
      file: `${name.slice(1).replace('/', '-')}-${name === '@myagentroam/code-navigation' ? '1.0.8' : '1.1.4'}.tgz`,
      sha512: 'c'.repeat(128)
    }))
  };
  assert.equal(validateCommonManifest(manifest), manifest);
  for (const field of [
    'commonVersion',
    'codeNavigationVersion',
    'sourceCommit',
    'lockfileSha256'
  ]) {
    assert.throws(() => validateCommonManifest({ ...manifest, [field]: [manifest[field]] }));
  }
  assert.throws(() =>
    validateCommonManifest({
      ...manifest,
      packages: manifest.packages.map((item) => ({ ...item, sha512: [item.sha512] }))
    })
  );
  assert.throws(() =>
    validateCommonManifest({ ...manifest, packages: manifest.packages.slice(1) })
  );
  assert.throws(() =>
    validateCommonManifest({
      ...manifest,
      packages: manifest.packages.map((item) => ({ ...item, file: '../outside.tgz' }))
    })
  );
  assert.throws(() => validateCommonManifest({ ...manifest, sourceCommit: 'unknown' }));
  assert.throws(() =>
    validateCommonManifest({
      ...manifest,
      packages: manifest.packages.map((item) =>
        item.name === '@myagentroam/code-navigation' ? { ...item, version: '1.1.4' } : item
      )
    })
  );
  const historical = {
    ...manifest,
    formatVersion: 1,
    packages: manifest.packages.map((item) => ({ ...item, version: '1.1.4' }))
  };
  delete historical.codeNavigationVersion;
  assert.equal(validateCommonManifest(historical), historical);
  assert.throws(() =>
    validateCommonManifest({
      ...manifest,
      packages: manifest.packages.map((item) => ({ ...item, version: '1.2.0' }))
    })
  );
});

test('Computer Use runtime manifests contain every published platform target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-runtime-artifacts-'));
  try {
    const packages = [];
    for (const target of publishedComputerRuntimeTargets) {
      const name = `@myagentroam/computer-runtime-${target.id}`;
      const file = `${name.slice(1).replace('/', '-')}-0.9.95.tgz`;
      const payload = Buffer.from(target.id);
      const runtimeManifest = {
        formatVersion: 1,
        runtimeVersion: '0.9.95',
        platform: target.platform,
        architecture: target.architecture,
        executable: target.executable,
        files: [
          {
            path: target.executable,
            size: payload.byteLength,
            sha256: createHash('sha256').update(payload).digest('hex')
          }
        ]
      };
      const bytes = archive([
        [
          'package/package.json',
          JSON.stringify({
            name,
            version: '0.9.95',
            license: 'Apache-2.0',
            os: [target.platform],
            cpu: [target.architecture]
          })
        ],
        ['package/LICENSE', 'Fixture license'],
        ['package/NOTICE', 'Fixture notice'],
        ['package/runtime/manifest.json', JSON.stringify(runtimeManifest)],
        [`package/runtime/${target.executable}`, payload]
      ]);
      await writeFile(join(directory, file), bytes);
      packages.push({
        name,
        version: '0.9.95',
        platform: target.platform,
        architecture: target.architecture,
        runtimeSourceSha256: 'c'.repeat(64),
        file,
        sha512: createHash('sha512').update(bytes).digest('hex')
      });
    }
    const manifest = {
      formatVersion: 1,
      runtimeVersion: '0.9.95',
      runtimeSourceId: 'python-3.13.15-pyautogui-0.9.54-r1',
      sourceCommit: 'a'.repeat(40),
      lockSha256: 'b'.repeat(64),
      packages
    };
    assert.equal(validateComputerRuntimeManifest(manifest), manifest);
    const manifestPath = join(directory, 'computer-runtime-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.doesNotReject(verifyComputerRuntimeArtifacts(manifestPath));
    assert.throws(() =>
      validateComputerRuntimeManifest({ ...manifest, packages: manifest.packages.slice(1) })
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate integration rewrites every common dependency to immutable archives', () => {
  const specifiers = new Map(
    commonNames.map((name) => [
      name,
      `file:/artifacts/${name.slice(1).replace('/', '-')}-1.1.4.tgz`
    ])
  );
  const rewritten = rewriteCommonDependencies(
    {
      dependencies: {
        '@myagentroam/protocol': 'workspace:*',
        other: '^1.0.0'
      },
      optionalDependencies: { '@myagentroam/agent': '1.1.4' }
    },
    specifiers,
    true
  );
  assert.equal(
    rewritten.dependencies['@myagentroam/protocol'],
    'file:/artifacts/myagentroam-protocol-1.1.4.tgz'
  );
  assert.equal(rewritten.dependencies.other, '^1.0.0');
  assert.equal(
    rewritten.optionalDependencies['@myagentroam/agent'],
    'file:/artifacts/myagentroam-agent-1.1.4.tgz'
  );
  assert.deepEqual(
    Object.keys(rewritten.devDependencies).sort(),
    [
      '@myagentroam/agent',
      '@myagentroam/code-navigation',
      '@myagentroam/node',
      '@myagentroam/protocol'
    ].sort()
  );
});

test('candidate integration workspace excludes common source packages and overrides transitive resolution', () => {
  const specifiers = new Map(
    commonNames.map((name) => [
      name,
      `file:/artifacts/${name.slice(1).replace('/', '-')}-1.1.4.tgz`
    ])
  );
  const workspace = createIntegrationWorkspaceDefinition(
    ['mar-server', 'mar-web-console', 'packages/server-core', 'packages/web-core'],
    specifiers,
    '/integration/workspace'
  );
  for (const path of ['mar-server', 'mar-web-console', 'packages/server-core', 'packages/web-core'])
    assert.match(
      workspace,
      new RegExp(JSON.stringify(path).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u')
    );
  for (const path of [
    'mar-node',
    'mar-agent',
    'packages/protocol',
    'packages/code-navigation',
    ...computerRuntimePaths
  ])
    assert.doesNotMatch(workspace, new RegExp(`- ${JSON.stringify(path)}`, 'u'));
  for (const specifier of specifiers.values()) assert.match(workspace, new RegExp(specifier, 'u'));
  assert.match(workspace, /node-pty: true/u);
  assert.match(workspace, /^minimumReleaseAge: 0$/mu);
  assert.doesNotMatch(workspace, /minimumReleaseAgeExclude/u);
  assert.ok(
    workspace.includes('"@myagentroam/node@file:../../artifacts/myagentroam-node-1.1.4.tgz": true')
  );
  assert.doesNotMatch(workspace, /['"]@myagentroam\/node['"]: true/u);
});

test('candidate integration requires an explicit product test command', () => {
  const configuration = {
    edition: 'product',
    repositories: [{ name: 'oss', source: '/source', destination: '.' }],
    workspacePackages: ['mar-server'],
    commonSourcePaths: ['packages/protocol', 'packages/code-navigation', 'mar-agent', 'mar-node'],
    buildArguments: ['build'],
    testArguments: ['--filter', '@myagentroam/server', 'test:unit'],
    versionSource: '/source'
  };
  assert.equal(validateIntegrationConfiguration(configuration), configuration);
  assert.throws(() =>
    validateIntegrationConfiguration({
      ...configuration,
      testArguments: []
    })
  );
  assert.throws(() =>
    validateIntegrationConfiguration({
      ...configuration,
      testArguments: ['']
    })
  );
});

test('root typecheck builds common declaration prerequisites before recursive checks', async () => {
  const packageJson = JSON.parse(await readFile(join(ossRoot, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts.typecheck,
    'pnpm --filter @myagentroam/protocol build && pnpm --filter @myagentroam/code-navigation build && pnpm --filter @myagentroam/agent build && pnpm --filter @myagentroam/server-core build && pnpm -r typecheck && tsc -p tsconfig.tests.json'
  );
});

test('candidate integration isolates npm configuration and verifies normalized lockfile archives', () => {
  const previous = {
    NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY,
    npm_config_proxy: process.env.npm_config_proxy,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    COREPACK_HOME: process.env.COREPACK_HOME,
    npm_config_store_dir: process.env.npm_config_store_dir,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH
  };
  process.env.NPM_CONFIG_REGISTRY = 'https://registry.invalid';
  process.env.npm_config_proxy = 'https://proxy.invalid';
  process.env.NODE_AUTH_TOKEN = 'fixture-token';
  process.env.COREPACK_HOME = '/tmp/user-corepack';
  process.env.npm_config_store_dir = '/tmp/user-store';
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/tmp/user-playwright';
  try {
    const environment = cleanCandidateEnvironment('/tmp/integration-workspace');
    assert.equal(environment.NPM_CONFIG_REGISTRY, undefined);
    assert.equal(environment.npm_config_proxy, undefined);
    assert.equal(environment.NODE_AUTH_TOKEN, undefined);
    assert.equal(environment.COREPACK_HOME, undefined);
    assert.equal(environment.npm_config_store_dir, undefined);
    assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, undefined);
    assert.equal(
      environment.NPM_CONFIG_USERCONFIG,
      '/tmp/integration-workspace/.integration-home/empty-npmrc'
    );
    assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, environment.NPM_CONFIG_USERCONFIG);
    const cached = cleanCandidateEnvironment('/tmp/integration-workspace', {
      storeDir: '/tmp/candidate-store',
      corepackHome: '/tmp/candidate-corepack',
      browsersDir: '/tmp/candidate-playwright'
    });
    assert.equal(cached.npm_config_store_dir, resolve('/tmp/candidate-store'));
    assert.equal(cached.NPM_CONFIG_STORE_DIR, resolve('/tmp/candidate-store'));
    assert.equal(cached.COREPACK_HOME, resolve('/tmp/candidate-corepack'));
    assert.equal(cached.PLAYWRIGHT_BROWSERS_PATH, resolve('/tmp/candidate-playwright'));
    assert.equal(
      candidateNpmrcContents('/tmp/candidate-store'),
      [
        `store-dir=${resolve('/tmp/candidate-store').replaceAll('\\', '/')}`,
        'prefer-offline=true',
        'verify-deps-before-run=false',
        'minimum-release-age=0',
        ''
      ].join('\n')
    );
    assert.deepEqual(candidateCachePaths('/tmp/oss'), {
      storeDir: resolve('/tmp/oss/test/runs/.pnpm-common-candidate-store-v11'),
      corepackHome: resolve('/tmp/oss/test/runs/.corepack-home'),
      browsersDir: resolve('/tmp/user-playwright')
    });
    assert.throws(() => candidateNpmrcContents(''), /RELEASE_INTEGRATION_STORE_INVALID/u);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.equal(
    resolvePlaywrightBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: '/custom/browsers' }),
    resolve('/custom/browsers')
  );
  assert.equal(
    resolvePlaywrightBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: '0' }),
    resolvePlaywrightBrowsersDir({})
  );
  if (process.platform === 'linux') {
    assert.equal(
      resolvePlaywrightBrowsersDir({ XDG_CACHE_HOME: '/tmp/xdg-cache' }),
      resolve('/tmp/xdg-cache/ms-playwright')
    );
  }

  const workspace = '/tmp/integration-workspace';
  const manifestPath = '/tmp/candidates/common-manifest.json';
  const item = {
    name: '@myagentroam/protocol',
    version: '1.1.4',
    file: 'myagentroam-protocol-1.1.4.tgz',
    sha512: 'ab'.repeat(64)
  };
  const integrity = Buffer.from(item.sha512, 'hex').toString('base64');
  const lockfile = [
    'packages:',
    '',
    "  '@myagentroam/protocol@file:../candidates/myagentroam-protocol-1.1.4.tgz':",
    `    resolution: {integrity: sha512-${integrity}, tarball: file:../candidates/myagentroam-protocol-1.1.4.tgz}`
  ].join('\n');
  assert.doesNotThrow(() =>
    verifyCandidateLockfile(lockfile, workspace, manifestPath, { packages: [item] })
  );
  assert.throws(
    () =>
      verifyCandidateLockfile(
        lockfile.replaceAll('../candidates/', './'),
        workspace,
        manifestPath,
        {
          packages: [item]
        }
      ),
    /RELEASE_INTEGRATION_LOCK_MISMATCH/u
  );
});

test('candidate integration workspace shares the persistent test/runs filesystem', async () => {
  const source = await mkdtemp(join(tmpdir(), 'mar-candidate-source-'));
  try {
    const workspace = await createCandidateWorkspace(source, 'product');
    const caches = candidateCachePaths(source);
    assert.equal(resolve(workspace, '..'), resolve(source, 'test/runs'));
    assert.equal(resolve(workspace, '..'), resolve(caches.storeDir, '..'));
    assert.equal(resolve(workspace, '..'), resolve(caches.corepackHome, '..'));
    assert.equal(caches.browsersDir, resolvePlaywrightBrowsersDir());
    assert.notEqual(caches.browsersDir, resolve(source, 'test/runs/.playwright-browsers'));
    assert.match(workspace, /[/\\]\.mar-product-candidate-/u);
    await assert.rejects(
      createCandidateWorkspace('', 'product'),
      /RELEASE_INTEGRATION_SOURCE_INVALID/u
    );
    await assert.rejects(
      createCandidateWorkspace(source, 'Product'),
      /RELEASE_INTEGRATION_EDITION_INVALID/u
    );
    await rm(workspace, { recursive: true, force: true });
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test('product candidate verification uses an acyclic command wrapper', async () => {
  const packageJson = JSON.parse(await readFile(join(ossRoot, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts['release:verify-common'],
    'node scripts/verify-common-integration.mjs'
  );
  const releaseScript = await readFile(join(ossRoot, 'scripts/release-artifacts.mjs'), 'utf8');
  assert.doesNotMatch(releaseScript, /import\(['"]\.\/common-candidate-integration\.mjs['"]\)/u);
});

test('product Server Docker runtime removes first-party declarations and source maps', async () => {
  const dockerfile = await readFile(join(ossRoot, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /find \/runtime\/server -type f -name '\*\.map' -delete/u);
  assert.match(dockerfile, /find \/runtime\/server -type f -name '\*\.d\.ts' -delete/u);
});

test('transitive candidate verification follows package resolution instead of requiring nested links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-candidate-resolution-'));
  try {
    const nodeDirectory = join(directory, 'node_modules/@myagentroam/node');
    const agentDirectory = join(directory, 'node_modules/@myagentroam/agent');
    await mkdir(nodeDirectory, { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(nodeDirectory, 'package.json'),
      JSON.stringify({
        name: '@myagentroam/node',
        version: '1.0.0',
        dependencies: { '@myagentroam/agent': '1.0.0' }
      })
    );
    await writeFile(
      join(agentDirectory, 'package.json'),
      JSON.stringify({ name: '@myagentroam/agent', version: '1.0.0' })
    );
    assert.equal(
      await resolveCandidatePackageTarget(nodeDirectory, {
        name: '@myagentroam/agent',
        version: '1.0.0'
      }),
      agentDirectory
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('build output cleanup removes stale artifacts without accepting parent paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-clean-build-'));
  try {
    await mkdir(join(directory, 'dist/old'), { recursive: true });
    await writeFile(join(directory, 'dist/old/protected.js'), '/* mar-release-protected */');
    await cleanBuildOutput('dist', directory);
    await assert.rejects(access(join(directory, 'dist')), { code: 'ENOENT' });
    await assert.rejects(cleanBuildOutput('../outside', directory), /BUILD_OUTPUT_PATH_INVALID/u);
    await assert.rejects(cleanBuildOutput(directory, directory), /BUILD_OUTPUT_PATH_INVALID/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Computer Use release staging copies a locked runtime and writes a hash manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-computer-runtime-stage-'));
  try {
    const source = join(directory, 'source');
    await mkdir(join(source, 'bin'), { recursive: true });
    await writeFile(join(source, 'bin/python3'), 'runtime', { mode: 0o755 });
    const manifest = await stageComputerUseRuntime(
      {
        source,
        platform: 'linux',
        architecture: 'x64',
        runtimeVersion: '3.13.7+pyautogui-0.9.54',
        executable: 'bin/python3'
      },
      directory
    );
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, 'bin/python3');
    assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/u);
    const persisted = JSON.parse(
      await readFile(
        join(directory, 'packages/computer-runtime-linux-x64/runtime/manifest.json'),
        'utf8'
      )
    );
    assert.deepEqual(persisted, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Computer Use release staging populates every platform package from one source root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-computer-runtime-stage-all-'));
  try {
    const sourceRoot = join(directory, 'sources');
    for (const target of computerRuntimeTargets) {
      const source = join(sourceRoot, `${target.platform}-${target.architecture}`);
      await mkdir(join(source, 'bin'), { recursive: true });
      const executable =
        target.platform === 'win32' ? join(source, 'python.exe') : join(source, 'bin/python3');
      await writeFile(executable, `${target.platform}-${target.architecture}`, {
        mode: target.platform === 'win32' ? 0o644 : 0o755
      });
    }
    const manifests = await stageAllComputerUseRuntimes(
      { sourceRoot, runtimeVersion: '3.13.7+pyautogui-0.9.54' },
      directory
    );
    assert.equal(manifests.length, computerRuntimeTargets.length);
    for (const target of computerRuntimeTargets) {
      const manifest = JSON.parse(
        await readFile(
          join(
            directory,
            `packages/computer-runtime-${target.platform}-${target.architecture}/runtime/manifest.json`
          ),
          'utf8'
        )
      );
      assert.equal(manifest.platform, target.platform);
      assert.equal(manifest.architecture, target.architecture);
      assert.equal(manifest.executable, target.executable);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Computer Use runtime lock covers every native package and has a deterministic default root', async () => {
  const lock = await readComputerUseRuntimeLock();
  assert.deepEqual(
    Object.keys(lock.targets).sort(),
    computerRuntimeTargets.map(({ id }) => id).sort()
  );
  const directory = join(tmpdir(), 'mar-runtime-default');
  assert.equal(
    defaultComputerUseRuntimeSourceRoot(lock, directory),
    join(directory, 'test/runs/computer-use-runtimes', lock.runtimeId)
  );
  assert.equal(
    computerUseRuntimeSourceRoot(
      lock,
      { MAR_COMPUTER_USE_RUNTIME_SOURCE_ROOT: './prepared-runtimes' },
      directory
    ),
    resolve('./prepared-runtimes')
  );
  assert.equal(currentComputerRuntimeId('linux', 'x64'), 'linux-x64');
  assert.equal(lock.packageIndex, 'https://pypi.org/simple');
  assert.deepEqual(lock.binaryOnlyPackages, [
    'Pillow',
    'pyobjc-core',
    'pyobjc-framework-Cocoa',
    'pyobjc-framework-Quartz'
  ]);
  assert.throws(
    () => currentComputerRuntimeId('freebsd', 'x64'),
    /COMPUTER_RUNTIME_HOST_UNSUPPORTED/u
  );
  assert.deepEqual(computerRuntimePipTarget('win32-arm64', lock.pythonVersion), {
    platform: 'win_arm64',
    sitePackages: 'Lib/site-packages',
    abi: 'cp313',
    pythonVersion: '3.13'
  });
  assert.deepEqual(computerRuntimePipTarget('linux-arm64', lock.pythonVersion), {
    platform: 'manylinux_2_28_aarch64',
    sitePackages: 'lib/python3.13/site-packages',
    abi: 'cp313',
    pythonVersion: '3.13'
  });
  assert.deepEqual(computerRuntimePipTarget('darwin-x64', lock.pythonVersion), {
    platform: 'macosx_10_13_x86_64',
    sitePackages: 'lib/python3.13/site-packages',
    abi: 'cp313',
    pythonVersion: '3.13'
  });
  assert.throws(
    () => computerRuntimePipTarget('freebsd-x64', lock.pythonVersion),
    /COMPUTER_RUNTIME_TARGET_INVALID/u
  );
});

test('Computer Use release accepts only a prepared runtime matching the source lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-runtime-source-identity-'));
  try {
    const lock = await readComputerUseRuntimeLock();
    const source = join(directory, 'linux-x64');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'python'), 'runtime');
    const identity = await expectedComputerUseRuntimeSource(
      lock,
      'linux-x64',
      await computerUseRuntimeTreeSha256(source)
    );
    await writeFile(
      join(source, '.mar-runtime-source.json'),
      `${JSON.stringify(identity, null, 2)}\n`
    );
    await assert.doesNotReject(verifyPreparedComputerUseRuntime(source, lock, 'linux-x64'));
    await writeFile(
      join(source, '.mar-runtime-source.json'),
      JSON.stringify({ ...identity, runtimeId: 'untrusted-runtime' })
    );
    await assert.rejects(
      verifyPreparedComputerUseRuntime(source, lock, 'linux-x64'),
      /COMPUTER_RUNTIME_SOURCE_IDENTITY_INVALID/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
