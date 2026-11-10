import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { computerRuntimeTargets } from './computer-runtime-packages.mjs';

// Validate the public upload boundary and own the durable, per-package submission
// state. Callers supply transport/process adapters; this module never builds,
// approves candidates, changes versions, or decides which release unit to ship.
export const publicationRepository = 'myagentroam/mar';
export const publicationPackagePaths = {
  '@myagentroam/protocol': 'packages/protocol',
  '@myagentroam/agent': 'mar-agent',
  '@myagentroam/node': 'mar-node',
  '@myagentroam/binaries': 'packages/binaries',
  '@myagentroam/server': 'mar-server',
  ...Object.fromEntries(computerRuntimeTargets.map(({ name, path }) => [name, path]))
};
const groups = {
  common: ['@myagentroam/protocol', '@myagentroam/agent', '@myagentroam/node'],
  binaries: ['@myagentroam/binaries'],
  runtime: computerRuntimeTargets.map(({ name }) => name),
  server: ['@myagentroam/server']
};
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const statuses = new Set(['pending', 'attempting', 'submitted', 'existing', 'unknown']);

export function publicationCheck(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export async function publicationDigest(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function validateNpmPublication(value) {
  publicationCheck(
    value?.formatVersion === 1 &&
      value.repository === publicationRepository &&
      Object.hasOwn(groups, value.unit) &&
      stable.test(value.version ?? '') &&
      value.tag === `${value.unit}-v${value.version}` &&
      commit.test(value.sourceCommit ?? '') &&
      sha256.test(value.lockfileSha256 ?? ''),
    'NPM_PUBLICATION_MANIFEST_INVALID'
  );
  const names = groups[value.unit];
  publicationCheck(
    Array.isArray(value.packages) && value.packages.length === names.length,
    'NPM_PUBLICATION_GROUP_INCOMPLETE'
  );
  const seen = new Set();
  for (const item of value.packages) {
    publicationCheck(
      item &&
        names.includes(item.name) &&
        !seen.has(item.name) &&
        item.version === value.version &&
        /^[a-f0-9]{128}$/u.test(item.sha512 ?? '') &&
        item.file === `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`,
      'NPM_PUBLICATION_PACKAGE_INVALID'
    );
    seen.add(item.name);
  }
  return value;
}

export function archiveMetadata(path) {
  // Read only the root manifest; do not extract or execute candidate contents.
  return JSON.parse(
    execFileSync('tar', ['-xOzf', path, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000
    })
  );
}

function checkRepository(metadata, name) {
  const value = metadata.repository;
  publicationCheck(
    value?.type === 'git' &&
      value.url === `git+https://github.com/${publicationRepository}.git` &&
      value.directory === publicationPackagePaths[name],
    'NPM_PUBLICATION_REPOSITORY_INVALID'
  );
}

export async function verifyNpmPublication(directory, sourceRoot, expected) {
  const path = resolve(directory, 'npm-publication.json');
  publicationCheck(
    sha256.test(expected.manifestSha256 ?? '') &&
      (await lstat(path)).isFile() &&
      (await lstat(path)).size <= 64 * 1024 &&
      (await publicationDigest(path)) === expected.manifestSha256,
    'NPM_PUBLICATION_MANIFEST_DIGEST_MISMATCH'
  );
  const value = validateNpmPublication(JSON.parse(await readFile(path, 'utf8')));
  publicationCheck(
    value.sourceCommit === expected.sourceCommit && value.tag === expected.tag,
    'NPM_PUBLICATION_SOURCE_MISMATCH'
  );
  publicationCheck(
    (await publicationDigest(resolve(sourceRoot, 'pnpm-lock.yaml'))) === value.lockfileSha256,
    'NPM_PUBLICATION_LOCKFILE_MISMATCH'
  );
  for (const item of value.packages) {
    const archive = resolve(directory, item.file);
    publicationCheck(
      (await lstat(archive)).isFile() &&
        (await publicationDigest(archive, 'sha512')) === item.sha512,
      'NPM_PUBLICATION_ARCHIVE_DIGEST_MISMATCH'
    );
    const metadata = archiveMetadata(archive);
    const source = JSON.parse(
      await readFile(
        resolve(sourceRoot, publicationPackagePaths[item.name], 'package.json'),
        'utf8'
      )
    );
    publicationCheck(
      metadata.name === item.name &&
        metadata.version === item.version &&
        metadata.private !== true &&
        source.name === item.name &&
        source.version === item.version,
      'NPM_PUBLICATION_IDENTITY_MISMATCH'
    );
    checkRepository(metadata, item.name);
    checkRepository(source, item.name);
    publicationCheck(
      metadata.publishConfig?.access === 'public' &&
        Object.keys(metadata.publishConfig).every((key) => key === 'access'),
      'NPM_PUBLICATION_PUBLISH_CONFIG_INVALID'
    );
  }
  return value;
}

export function assertOidcEnvironment(env, tag) {
  publicationCheck(
    env.GITHUB_ACTIONS === 'true' &&
      env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      env.GITHUB_REPOSITORY === publicationRepository &&
      commit.test(env.GITHUB_SHA ?? '') &&
      env.GITHUB_REF === `refs/tags/${tag}` &&
      env.GITHUB_RUN_ATTEMPT === '1' &&
      env.GITHUB_WORKFLOW_REF ===
        `${publicationRepository}/.github/workflows/npm-publish.yml@refs/tags/${tag}` &&
      env.ACTIONS_ID_TOKEN_REQUEST_URL &&
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'NPM_PUBLICATION_OIDC_ENVIRONMENT_REQUIRED'
  );
  publicationCheck(
    !Object.entries(env).some(
      ([key, value]) =>
        value &&
        (/^(?:NPM_TOKEN|NODE_AUTH_TOKEN)$/iu.test(key) ||
          (/^npm_config_/iu.test(key) && /auth|token|password/iu.test(key)))
    ),
    'NPM_PUBLICATION_NPM_TOKEN_FORBIDDEN'
  );
}

function validatePrevious(previous, manifest, manifestSha256) {
  publicationCheck(
    previous?.formatVersion === 1 &&
      previous.repository === manifest.repository &&
      previous.sourceCommit === manifest.sourceCommit &&
      previous.manifestSha256 === manifestSha256 &&
      previous.tag === manifest.tag &&
      /^\d+$/u.test(previous.runId ?? '') &&
      Array.isArray(previous.packages) &&
      previous.packages.length === manifest.packages.length,
    'NPM_PUBLICATION_PREVIOUS_RECEIPT_INVALID'
  );
  for (const item of manifest.packages) {
    const entries = previous.packages.filter(({ name }) => name === item.name);
    publicationCheck(
      entries.length === 1 &&
        entries[0].version === item.version &&
        entries[0].sha512 === item.sha512 &&
        statuses.has(entries[0].status),
      'NPM_PUBLICATION_PREVIOUS_RECEIPT_INVALID'
    );
  }
}

export async function submitNpmPublication(manifest, options) {
  validateNpmPublication(manifest);
  if (options.previous) validatePrevious(options.previous, manifest, options.manifestSha256);
  const report = {
    formatVersion: 1,
    repository: manifest.repository,
    sourceCommit: manifest.sourceCommit,
    tag: manifest.tag,
    manifestSha256: options.manifestSha256,
    runId: options.runId,
    state: 'validating',
    packages: manifest.packages.map(({ name, version, sha512 }) => ({
      name,
      version,
      sha512,
      status: options.previous
        ? options.previous.packages.find((item) => item.name === name).status
        : 'pending'
    }))
  };
  // A receipt must exist before any publish side effect. A killed process leaves
  // attempting, never a misleading retryable failure or success. A continuation's
  // first durable receipt must already retain its validated predecessor's states.
  await options.record(report);
  try {
    const confirmedAbsent = options.confirmedAbsent ?? [];
    publicationCheck(
      Array.isArray(confirmedAbsent) && new Set(confirmedAbsent).size === confirmedAbsent.length,
      'NPM_PUBLICATION_RESOLUTION_INVALID'
    );
    if (confirmedAbsent.length) {
      publicationCheck(
        options.previous &&
          ['rejected-before-submit', 'registry-confirmed-absent'].includes(options.resolution) &&
          confirmedAbsent.every((name) =>
            options.previous.packages.some(
              (item) => item.name === name && ['unknown', 'attempting'].includes(item.status)
            )
          ),
        'NPM_PUBLICATION_RESOLUTION_INVALID'
      );
      report.resolution = {
        previousRunId: options.previous.runId,
        mode: options.resolution,
        packages: [...confirmedAbsent]
      };
    } else
      publicationCheck(
        !options.resolution || options.resolution === 'none',
        'NPM_PUBLICATION_RESOLUTION_INVALID'
      );
    const metadata = await Promise.all(manifest.packages.map((item) => options.registry(item)));
    for (const [index, item] of manifest.packages.entries()) {
      const existing = metadata[index];
      const entry = report.packages[index];
      if (existing !== null) {
        publicationCheck(
          existing?.name === item.name &&
            existing.version === item.version &&
            existing.dist?.integrity ===
              `sha512-${Buffer.from(item.sha512, 'hex').toString('base64')}`,
          'NPM_PUBLICATION_VERSION_OCCUPIED'
        );
        entry.status = 'existing';
      } else if (options.previous) {
        const previous = options.previous.packages.find(({ name }) => name === item.name);
        publicationCheck(
          previous.status === 'pending' || confirmedAbsent.includes(item.name),
          'NPM_PUBLICATION_PREVIOUS_RESULT_UNRESOLVED'
        );
        entry.status = 'pending';
      }
    }
  } catch (error) {
    report.state = 'blocked';
    report.error = /^NPM_PUBLICATION_[A-Z_]+$/u.test(error.code ?? '')
      ? error.code
      : 'NPM_PUBLICATION_REGISTRY_CHECK_FAILED';
    await options.record(report);
    return report;
  }
  for (const entry of report.packages) if (entry.status === 'pending') entry.status = 'attempting';
  report.state = 'submitting';
  await options.record(report);
  await Promise.all(
    manifest.packages.map(async (item, index) => {
      const entry = report.packages[index];
      if (entry.status === 'existing') return;
      try {
        entry.exitCode = await options.submit(item);
        entry.status = entry.exitCode === 0 ? 'submitted' : 'unknown';
      } catch {
        entry.status = 'unknown';
      }
    })
  );
  report.state = report.packages.every(({ status }) => ['existing', 'submitted'].includes(status))
    ? 'complete'
    : 'incomplete';
  await options.record(report);
  return report;
}
