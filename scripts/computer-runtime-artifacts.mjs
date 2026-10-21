import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishedComputerRuntimeTargets } from './computer-runtime-packages.mjs';
import {
  computerUseRuntimeSourceRoot,
  readComputerUseRuntimeLock,
  verifyPreparedComputerUseRuntime
} from './prepare-computer-use-runtime.mjs';
import { inspectComputerRuntimeArchive } from './release-artifacts.mjs';
import { stageComputerUseRuntime } from './stage-computer-use-runtime.mjs';
import { assertIndependentReleaseChanged } from './release-version-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');

function check(value, code) {
  if (!value) throw new Error(code);
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readComputerRuntimeRelease(directory = root) {
  const packages = await Promise.all(
    publishedComputerRuntimeTargets.map(async (target) => ({
      target,
      metadata: await json(resolve(directory, target.path, 'package.json'))
    }))
  );
  const versions = new Set(packages.map(({ metadata }) => metadata.version));
  check(versions.size === 1, 'RELEASE_RUNTIME_VERSION_MISMATCH');
  const runtimeVersion = packages[0]?.metadata.version;
  check(
    typeof runtimeVersion === 'string' && stable.test(runtimeVersion),
    'RELEASE_RUNTIME_VERSION_INVALID'
  );
  const nodeRuntimeSource = await readFile(
    resolve(directory, 'mar-node/src/computer-use-runtime-version.ts'),
    'utf8'
  );
  check(
    nodeRuntimeSource.includes(`export const computerUseRuntimeVersion = '${runtimeVersion}';`),
    'RELEASE_RUNTIME_NODE_VERSION_MISMATCH'
  );
  for (const { target, metadata } of packages) {
    check(metadata.name === target.name, 'RELEASE_RUNTIME_PACKAGE_INVALID');
    check(
      metadata.os?.length === 1 &&
        metadata.os[0] === target.platform &&
        metadata.cpu?.length === 1 &&
        metadata.cpu[0] === target.architecture,
      'RELEASE_RUNTIME_PLATFORM_INVALID'
    );
  }
  return { runtimeVersion, packages };
}

export function validateComputerRuntimeManifest(value) {
  check(
    value?.formatVersion === 1 &&
      typeof value.runtimeVersion === 'string' &&
      stable.test(value.runtimeVersion) &&
      typeof value.runtimeSourceId === 'string' &&
      value.runtimeSourceId.length > 0 &&
      value.runtimeSourceId.length <= 256 &&
      typeof value.sourceCommit === 'string' &&
      /^[a-f0-9]{40}$/u.test(value.sourceCommit) &&
      typeof value.lockSha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(value.lockSha256) &&
      Array.isArray(value.packages) &&
      value.packages.length === publishedComputerRuntimeTargets.length,
    'RELEASE_RUNTIME_MANIFEST_INVALID'
  );
  const names = new Set();
  for (const item of value.packages) {
    const target = publishedComputerRuntimeTargets.find(({ name }) => name === item?.name);
    check(
      target !== undefined &&
        !names.has(item.name) &&
        item.version === value.runtimeVersion &&
        item.platform === target.platform &&
        item.architecture === target.architecture &&
        typeof item.runtimeSourceSha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(item.runtimeSourceSha256) &&
        typeof item.file === 'string' &&
        /^[a-z0-9][a-z0-9.-]*\.tgz$/u.test(item.file) &&
        typeof item.sha512 === 'string' &&
        /^[a-f0-9]{128}$/u.test(item.sha512),
      'RELEASE_RUNTIME_MANIFEST_INVALID'
    );
    names.add(item.name);
  }
  return value;
}

export async function verifyComputerRuntimeArtifacts(manifestPath) {
  const value = validateComputerRuntimeManifest(await json(manifestPath));
  for (const item of value.packages) {
    const actual = await inspectComputerRuntimeArchive(
      resolve(dirname(manifestPath), item.file),
      item.name,
      item.version
    );
    check(actual === item.sha512, 'RELEASE_ARCHIVE_DIGEST_MISMATCH');
  }
  return value;
}

export async function sealComputerRuntimeArtifacts(output, directory = root) {
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  check(git('status', '--porcelain') === '', 'RELEASE_SOURCE_DIRTY');
  await assertIndependentReleaseChanged('runtime', directory);
  const sourceCommit = git('rev-parse', 'HEAD');
  const { runtimeVersion } = await readComputerRuntimeRelease(directory);
  const lockPath = resolve(directory, 'scripts/computer-use-runtime.lock.json');
  const lock = await readComputerUseRuntimeLock(lockPath);
  const sourceRoot = computerUseRuntimeSourceRoot(lock, process.env, directory);
  await mkdir(output);
  const snapshot = await mkdtemp(resolve(tmpdir(), 'mar-runtime-candidate-'));
  try {
    const archive = execFileSync('git', ['-C', directory, 'archive', sourceCommit], {
      maxBuffer: 512 * 1024 * 1024
    });
    execFileSync('tar', ['-x', '-C', snapshot], { input: archive });
    const packages = [];
    for (const target of publishedComputerRuntimeTargets) {
      const runtimeSource = resolve(sourceRoot, target.id);
      const sourceIdentity = await verifyPreparedComputerUseRuntime(runtimeSource, lock, target.id);
      await copyFile(resolve(snapshot, 'LICENSE'), resolve(snapshot, target.path, 'LICENSE'));
      await copyFile(resolve(snapshot, 'NOTICE'), resolve(snapshot, target.path, 'NOTICE'));
      await stageComputerUseRuntime(
        {
          source: runtimeSource,
          platform: target.platform,
          architecture: target.architecture,
          runtimeVersion,
          executable: target.executable
        },
        snapshot
      );
      execFileSync(
        'npm',
        ['pack', '--ignore-scripts', '--pack-destination', output, resolve(snapshot, target.path)],
        { stdio: 'inherit', timeout: 600_000 }
      );
      const file = `${target.name.slice(1).replace('/', '-')}-${runtimeVersion}.tgz`;
      packages.push({
        name: target.name,
        version: runtimeVersion,
        platform: target.platform,
        architecture: target.architecture,
        runtimeSourceSha256: sourceIdentity.runtimeTreeSha256,
        file,
        sha512: await inspectComputerRuntimeArchive(
          resolve(output, file),
          target.name,
          runtimeVersion
        )
      });
    }
    const manifest = validateComputerRuntimeManifest({
      formatVersion: 1,
      runtimeVersion,
      runtimeSourceId: lock.runtimeId,
      sourceCommit,
      lockSha256: digest(await readFile(lockPath), 'sha256'),
      packages
    });
    await writeFile(
      resolve(output, 'computer-runtime-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx' }
    );
    return manifest;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

export function computerRuntimeArtifactArguments(arguments_) {
  const [command, ...operands] = arguments_;
  return {
    command,
    first: (operands[0] === '--' ? operands.slice(1) : operands)[0]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { command, first } = computerRuntimeArtifactArguments(process.argv.slice(2));
  if (command === 'seal' && first) await sealComputerRuntimeArtifacts(resolve(first));
  else if (command === 'verify' && first) await verifyComputerRuntimeArtifacts(resolve(first));
  else throw new Error('RELEASE_RUNTIME_COMMAND_INVALID');
}
