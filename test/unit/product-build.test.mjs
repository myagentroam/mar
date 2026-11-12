import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { access, copyFile, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { readReleaseVersions, validateVersionGroups } from '../../scripts/product-versions.mjs';
import { productCheckCommands } from '../../scripts/product-ci.mjs';
import { cleanBuildOutput } from '../../scripts/clean-build-output.mjs';
import { unexpectedNpmPackageFiles } from '../../scripts/check-release-artifacts.mjs';
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
import { computerRuntimeTargets } from '../../scripts/computer-runtime-packages.mjs';
import { binariesTargets } from '../../scripts/binaries-packages.mjs';

const ossRoot = fileURLToPath(new URL('../..', import.meta.url));

test('Node packages allow only the declared public config type and reject other source artifacts', () => {
  assert.deepEqual(
    unexpectedNpmPackageFiles('@myagentroam/node', [
      'package.json',
      'dist/main.js',
      'dist/config.d.ts',
      'dist/internal.d.ts',
      'dist/config.ts',
      'dist/main.js.map'
    ]),
    ['dist/internal.d.ts', 'dist/config.ts', 'dist/main.js.map']
  );
  assert.deepEqual(unexpectedNpmPackageFiles('@myagentroam/server', ['dist/config.d.ts']), [
    'dist/config.d.ts'
  ]);
  for (const name of ['agent', 'agent-extension-subagent', 'protocol', 'code-navigation']) {
    assert.deepEqual(
      unexpectedNpmPackageFiles(`@myagentroam/${name}`, ['dist/index.js', 'dist/index.d.ts']),
      []
    );
  }
});

test('the independent subagent peer resolves the unpublished workspace Agent from source', async () => {
  const extension = JSON.parse(
    await readFile(join(ossRoot, 'mar-agent/extensions/subagent/package.json'), 'utf8')
  );
  assert.equal(extension.peerDependencies['@myagentroam/agent'], 'workspace:*');
  assert.equal(extension.devDependencies['@myagentroam/agent'], 'workspace:*');
  const node = JSON.parse(await readFile(join(ossRoot, 'mar-node/package.json'), 'utf8'));
  assert.equal(Object.hasOwn(node.dependencies, extension.name), false);
});

test('public product build and version checks remain separate from release orchestration', async () => {
  const packageJson = JSON.parse(await readFile(join(ossRoot, 'package.json'), 'utf8'));
  const scripts = packageJson.scripts;
  assert.deepEqual(
    Object.keys(scripts).filter((name) => name.startsWith('release:')),
    []
  );
  assert.equal(Object.hasOwn(scripts, 'test:release'), false);
  assert.equal(scripts['check:versions'], 'node scripts/product-versions.mjs');
  assert.equal(scripts['test:build'], 'node --test test/unit/*.test.mjs');
});

test('product build and unit gates include the independent subagent and marctl packages', async () => {
  const { scripts } = JSON.parse(await readFile(join(ossRoot, 'package.json'), 'utf8'));
  assert.match(scripts.build, /--filter @myagentroam\/agent-extension-subagent(?:\.\.\.)?\s/u);
  assert.match(scripts['test:unit'], /--filter @myagentroam\/marctl test:unit(?:\s|$)/u);
  assert.match(
    scripts['test:unit'],
    /--filter @myagentroam\/agent-extension-subagent test(?:\s|$)/u
  );
});

test('ESLint ignores staged Web distribution but keeps Server source and tests', async () => {
  const eslint = new ESLint({ cwd: ossRoot });
  assert.equal(await eslint.isPathIgnored('mar-server/web/assets/vendor.js'), true);
  assert.equal(await eslint.isPathIgnored('mar-server/src/main.ts'), false);
  assert.equal(await eslint.isPathIgnored('test/unit/product-build.test.mjs'), false);
});

test('public CI helper lists only product checks and excludes private release commands', () => {
  const commands = productCheckCommands('Nightly-RUN');
  assert.deepEqual(commands, [
    ['frozen-install', 'pnpm', ['install', '--frozen-lockfile']],
    ['lint', 'pnpm', ['lint']],
    ['check:versions', 'pnpm', ['check:versions']],
    ['check:public-boundary', 'pnpm', ['check:public-boundary']],
    ['typecheck', 'pnpm', ['typecheck']],
    ['test:unit', 'pnpm', ['test:unit']],
    ['build', 'pnpm', ['build']],
    ['test:build', 'pnpm', ['test:build']],
    ['check:release-artifacts', 'pnpm', ['check:release-artifacts']],
    ['test:e2e', 'pnpm', ['test:e2e']],
    [
      'server-docker-build',
      'docker',
      ['build', '--target', 'server', '--tag', 'myagentroam-server-ci:nightly-run', '.']
    ]
  ]);
  assert.equal(
    commands.some(
      ([, command, args]) =>
        command === 'pnpm' &&
        args.some((argument) => argument.startsWith('release:') || argument === 'test:smoke')
    ),
    false
  );
});

test('root typecheck builds common declaration prerequisites before recursive checks', async () => {
  const packageJson = JSON.parse(await readFile(join(ossRoot, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts.typecheck,
    'pnpm --filter @myagentroam/protocol build && pnpm --filter @myagentroam/code-navigation build && pnpm --filter @myagentroam/agent build && pnpm --filter @myagentroam/server-core build && pnpm -r typecheck && tsc -p tsconfig.tests.json'
  );
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

test('Node pins binaries while navigation and CLI remain private workspace modules', async () => {
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
        'packages/web-core',
        'mar-agent/extensions/subagent'
      ].map((path) => [path, { version: '1.0.0' }]),
      ['packages/protocol', { name: '@myagentroam/protocol', version: '1.0.0' }],
      ['mar-agent', { name: '@myagentroam/agent', version: '1.0.0' }],
      [
        'mar-node',
        {
          name: '@myagentroam/node',
          version: '1.0.0',
          dependencies: {
            '@myagentroam/binaries': 'workspace:0.9.7'
          }
        }
      ],
      [
        'packages/binaries',
        {
          name: '@myagentroam/binaries',
          version: '0.9.7',
          optionalDependencies: Object.fromEntries(
            binariesTargets.map(({ name }) => [name, '0.9.7'])
          )
        }
      ],
      ...binariesTargets.map(({ path, name, id }) => {
        const [platform, architecture] = id.split('-');
        return [path, { name, version: '0.9.7', os: [platform], cpu: [architecture] }];
      }),
      [
        'packages/code-navigation',
        { name: '@myagentroam/code-navigation', version: '0.9.7', private: true }
      ],
      ['marctl', { name: '@myagentroam/marctl', version: '1.0.0', private: true }]
    ];
    for (const [path, pkg] of packages) {
      await mkdir(join(directory, path), { recursive: true });
      await writeFile(join(directory, path, 'package.json'), JSON.stringify(pkg));
    }
    assert.deepEqual(await readReleaseVersions(directory), {
      productVersion: '1.0.0',
      commonVersion: '1.0.0',
      binariesVersion: '0.9.7'
    });
    const targetFile = join(directory, binariesTargets[0].path, 'package.json');
    const target = JSON.parse(await readFile(targetFile, 'utf8'));
    target.version = '0.9.8';
    await writeFile(targetFile, JSON.stringify(target));
    await assert.rejects(readReleaseVersions(directory), /RELEASE_BINARIES_PLATFORM_INVALID/u);
    target.version = '0.9.7';
    await writeFile(targetFile, JSON.stringify(target));
    const nodePackage = join(directory, 'mar-node/package.json');
    const node = JSON.parse(await readFile(nodePackage, 'utf8'));
    node.dependencies['@myagentroam/binaries'] = 'workspace:1.0.0';
    await writeFile(nodePackage, JSON.stringify(node));
    await assert.rejects(readReleaseVersions(directory), /RELEASE_BINARIES_DEPENDENCY_INVALID/u);
    node.dependencies['@myagentroam/binaries'] = '0.9.7';
    await writeFile(nodePackage, JSON.stringify(node));
    await assert.rejects(readReleaseVersions(directory), /RELEASE_BINARIES_DEPENDENCY_INVALID/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('product Server Docker runtime removes first-party declarations and source maps', async () => {
  const dockerfile = await readFile(join(ossRoot, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /find \/runtime\/server -type f -name '\*\.map' -delete/u);
  assert.match(dockerfile, /find \/runtime\/server -type f -name '\*\.d\.ts' -delete/u);
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

test('subagent build cleans stale output before compiling', async () => {
  const extension = JSON.parse(
    await readFile(join(ossRoot, 'mar-agent/extensions/subagent/package.json'), 'utf8')
  );
  const [cleanup, compile] = extension.scripts.build.split(' && ');
  assert.equal(cleanup, 'node ../../../scripts/clean-build-output.mjs dist');
  assert.equal(compile, 'tsc -p tsconfig.json');
  const directory = await mkdtemp(join(tmpdir(), 'mar-subagent-build-'));
  try {
    const extensionRoot = join(directory, 'mar-agent/extensions/subagent');
    await mkdir(join(extensionRoot, 'dist'), { recursive: true });
    await mkdir(join(directory, 'scripts'));
    await copyFile(
      join(ossRoot, 'scripts/clean-build-output.mjs'),
      join(directory, 'scripts/clean-build-output.mjs')
    );
    await writeFile(join(extensionRoot, 'dist/stale.js'), 'stale');
    execFileSync(process.execPath, cleanup.split(' ').slice(1), { cwd: extensionRoot });
    await assert.rejects(access(join(extensionRoot, 'dist/stale.js')), { code: 'ENOENT' });
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
