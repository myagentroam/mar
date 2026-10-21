import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectMarctlArchive,
  readReleaseVersions,
  validateMarctlVersionLine
} from './release-artifacts.mjs';
import { assertIndependentReleaseChanged } from './release-version-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const check = (value, code) => {
  if (!value) throw new Error(code);
};
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
export function validateMarctlManifest(value) {
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.formatVersion === 1 &&
      typeof value.marctlVersion === 'string' &&
      typeof value.commonVersion === 'string',
    'RELEASE_MARCTL_MANIFEST_INVALID'
  );
  validateMarctlVersionLine(value.marctlVersion, value.commonVersion);
  check(
    typeof value.sourceCommit === 'string' &&
      /^[a-f0-9]{40}$/u.test(value.sourceCommit) &&
      typeof value.lockfileSha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(value.lockfileSha256),
    'RELEASE_MARCTL_PROVENANCE_INVALID'
  );
  check(
    value.package?.name === '@myagentroam/marctl' &&
      value.package.version === value.marctlVersion &&
      typeof value.package.file === 'string' &&
      /^myagentroam-marctl-[a-z0-9.-]+\.tgz$/u.test(value.package.file) &&
      typeof value.package.sha512 === 'string' &&
      /^[a-f0-9]{128}$/u.test(value.package.sha512),
    'RELEASE_MARCTL_PACKAGE_INVALID'
  );
  return value;
}

async function readMarctlRelease(directory = root) {
  const pkg = await json(resolve(directory, 'marctl/package.json'));
  check(pkg.name === '@myagentroam/marctl', 'RELEASE_PACKAGE_NAME_INVALID');
  const { commonVersion } = await readReleaseVersions(directory);
  validateMarctlVersionLine(pkg.version, commonVersion);
  return { marctlVersion: pkg.version, commonVersion };
}

export async function verifyMarctlArtifacts(manifestPath) {
  const manifest = validateMarctlManifest(await json(manifestPath));
  const archive = resolve(dirname(manifestPath), manifest.package.file);
  check((await stat(archive)).isFile(), 'RELEASE_ARCHIVE_INVALID');
  const sha512 = await inspectMarctlArchive(archive, manifest.marctlVersion);
  check(sha512 === manifest.package.sha512, 'RELEASE_ARCHIVE_DIGEST_MISMATCH');
  return manifest;
}

export async function sealMarctlArtifacts(output, directory = root) {
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  check(git('status', '--porcelain') === '', 'RELEASE_SOURCE_DIRTY');
  await assertIndependentReleaseChanged('marctl', directory);
  const sourceCommit = git('rev-parse', 'HEAD');
  const { marctlVersion, commonVersion } = await readMarctlRelease(directory);
  await mkdir(output);
  const snapshot = await mkdtemp(resolve(tmpdir(), 'mar-marctl-candidate-'));
  try {
    const archive = execFileSync('git', ['-C', directory, 'archive', sourceCommit], {
      maxBuffer: 512 * 1024 * 1024
    });
    execFileSync('tar', ['-x', '-C', snapshot], { input: archive });
    for (const name of ['LICENSE', 'NOTICE']) {
      const source = resolve(snapshot, name);
      check(
        (await readFile(source, 'utf8')).trim().length > 0,
        'RELEASE_LICENSE_MATERIALS_MISSING'
      );
      await copyFile(source, resolve(snapshot, 'marctl', name));
    }
    const packagePath = resolve(snapshot, 'marctl/package.json');
    const pkg = await json(packagePath);
    pkg.files = [...new Set([...(pkg.files ?? []), 'LICENSE', 'NOTICE'])];
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    execFileSync('pnpm', ['install', '--filter', '@myagentroam/marctl...', '--frozen-lockfile'], {
      cwd: snapshot,
      stdio: 'inherit',
      timeout: 600_000
    });
    execFileSync(
      'pnpm',
      ['--filter', '@myagentroam/marctl', 'pack', '--pack-destination', resolve(output)],
      { cwd: snapshot, stdio: 'inherit', timeout: 120_000 }
    );
    const file = `myagentroam-marctl-${marctlVersion}.tgz`;
    const sha512 = await inspectMarctlArchive(resolve(output, file), marctlVersion);
    const manifest = validateMarctlManifest({
      formatVersion: 1,
      marctlVersion,
      commonVersion,
      sourceCommit,
      lockfileSha256: digest(await readFile(resolve(directory, 'pnpm-lock.yaml')), 'sha256'),
      package: { name: '@myagentroam/marctl', version: marctlVersion, file, sha512 }
    });
    await writeFile(
      resolve(output, 'marctl-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        flag: 'wx'
      }
    );
    check(git('status', '--porcelain') === '', 'RELEASE_SOURCE_CHANGED');
    check(git('rev-parse', 'HEAD') === sourceCommit, 'RELEASE_SOURCE_CHANGED');
    return manifest;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

const [command, first] = process.argv.slice(2).filter((argument) => argument !== '--');
if (command === 'seal' && first) await sealMarctlArtifacts(resolve(first));
else if (command === 'verify' && first) await verifyMarctlArtifacts(resolve(first));
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  throw new Error('Usage: marctl-release-artifacts.mjs <seal OUTPUT_DIR|verify MANIFEST>');
