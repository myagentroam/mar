import { execFileSync, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertOidcEnvironment,
  publicationCheck,
  publicationDigest,
  publicationRepository,
  submitNpmPublication,
  validateNpmPublication,
  verifyNpmPublication
} from './npm-publication.mjs';

// Adapt the public upload mechanism to the one authorized GitHub workflow.
// GitHub owns the runner/environment lifetime; this entrypoint owns isolated npm
// configuration and the receipt. No candidate scripts or build tools are run.
const registry = 'https://registry.npmjs.org/';
const sourceRoot = resolve(import.meta.dirname, '..');
const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  });

export async function downloadNpmPublication({ tag, manifestSha256, directory, runGh = gh }) {
  publicationCheck(
    /^(?:common|binaries|runtime|server)-v\d+\.\d+\.\d+$/u.test(tag ?? '') &&
      /^[a-f0-9]{64}$/u.test(manifestSha256 ?? ''),
    'NPM_PUBLICATION_INPUT_INVALID'
  );
  const release = JSON.parse(
    await runGh(['api', `repos/${publicationRepository}/releases/tags/${tag}`])
  );
  publicationCheck(
    release.tag_name === tag && release.draft === false && Array.isArray(release.assets),
    'NPM_PUBLICATION_RELEASE_INVALID'
  );
  const download = async (file) => {
    publicationCheck(
      release.assets.filter(({ name }) => name === file).length === 1,
      'NPM_PUBLICATION_RELEASE_ASSET_MISSING'
    );
    await runGh([
      'release',
      'download',
      tag,
      '--repo',
      publicationRepository,
      '--pattern',
      file,
      '--dir',
      directory
    ]);
  };
  await mkdir(directory);
  await download('npm-publication.json');
  publicationCheck(
    (await publicationDigest(resolve(directory, 'npm-publication.json'))) === manifestSha256,
    'NPM_PUBLICATION_MANIFEST_DIGEST_MISMATCH'
  );
  const manifest = validateNpmPublication(
    JSON.parse(await readFile(resolve(directory, 'npm-publication.json'), 'utf8'))
  );
  publicationCheck(manifest.tag === tag, 'NPM_PUBLICATION_SOURCE_MISMATCH');
  for (const { file } of manifest.packages) await download(file);
  return manifest;
}

export async function downloadPreviousReceipt(runId, directory, sourceCommit, runGh = gh) {
  publicationCheck(/^\d+$/u.test(runId ?? ''), 'NPM_PUBLICATION_RESUME_RUN_INVALID');
  const previous = JSON.parse(
    await runGh(['api', `repos/${publicationRepository}/actions/runs/${runId}`])
  );
  const workflow = '.github/workflows/npm-publish.yml';
  const tag = previous.head_branch;
  publicationCheck(
    previous.id.toString() === runId &&
      previous.status === 'completed' &&
      previous.head_sha === sourceCommit &&
      previous.event === 'workflow_dispatch' &&
      /^(?:common|binaries|runtime|server)-v\d+\.\d+\.\d+$/u.test(tag ?? '') &&
      [workflow, `${workflow}@${tag}`, `${workflow}@refs/tags/${tag}`].includes(previous.path) &&
      previous.run_attempt === 1,
    'NPM_PUBLICATION_RESUME_RUN_INVALID'
  );
  await mkdir(directory);
  await runGh([
    'run',
    'download',
    runId,
    '--repo',
    publicationRepository,
    '--name',
    `npm-publication-${runId}-1`,
    '--dir',
    directory
  ]);
  const receipt = JSON.parse(
    await readFile(resolve(directory, 'npm-publication-result.json'), 'utf8')
  );
  publicationCheck(
    receipt.runId === runId && receipt.tag === tag,
    'NPM_PUBLICATION_PREVIOUS_RECEIPT_INVALID'
  );
  return receipt;
}

export function publicationNpmEnvironment(env, directory) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^npm_config_/iu.test(key) &&
        !/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/iu.test(key)
    )
  );
  return {
    ...clean,
    HOME: directory,
    USERPROFILE: directory,
    NPM_CONFIG_USERCONFIG: resolve(directory, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: resolve(directory, 'global.npmrc'),
    NPM_CONFIG_CACHE: resolve(directory, 'cache'),
    NPM_CONFIG_REGISTRY: registry,
    NPM_CONFIG_PROVENANCE: 'false'
  };
}

async function registryMetadata(item) {
  const response = await fetch(`${registry}${encodeURIComponent(item.name)}/${item.version}`, {
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 404) return null;
  publicationCheck(response.status === 200, 'NPM_PUBLICATION_REGISTRY_CHECK_FAILED');
  return response.json();
}

export function npmPublicationArguments(archive) {
  return [
    'publish',
    archive,
    '--access',
    'public',
    '--ignore-scripts',
    '--provenance=false',
    '--tag',
    'latest',
    '--registry',
    registry
  ];
}

async function publishArchive(archive, directory, env) {
  return new Promise((done) => {
    const child = spawn('npm', npmPublicationArguments(archive), {
      cwd: directory,
      env,
      stdio: 'inherit',
      timeout: 120_000
    });
    child.once('error', () => done(null));
    child.once('close', (code) => done(code));
  });
}

async function main(mode, env) {
  const tag = env.PUBLICATION_TAG;
  assertOidcEnvironment(env, tag);
  publicationCheck(
    env.RUNNER_TEMP && /^\d+$/u.test(env.GITHUB_RUN_ID ?? ''),
    'NPM_PUBLICATION_INPUT_INVALID'
  );
  const directory = resolve(env.RUNNER_TEMP, 'npm-publication');
  const expected = {
    tag,
    manifestSha256: env.PUBLICATION_MANIFEST_SHA256,
    sourceCommit: env.GITHUB_SHA
  };
  if (mode === 'download') {
    await downloadNpmPublication({ tag, manifestSha256: expected.manifestSha256, directory });
    return;
  }
  publicationCheck(mode === 'publish', 'NPM_PUBLICATION_ARGUMENT_INVALID');
  publicationCheck(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() ===
      env.GITHUB_SHA,
    'NPM_PUBLICATION_SOURCE_MISMATCH'
  );
  const manifest = await verifyNpmPublication(directory, sourceRoot, expected);
  const previous = env.PUBLICATION_RESUME_RUN_ID
    ? await downloadPreviousReceipt(
        env.PUBLICATION_RESUME_RUN_ID,
        resolve(env.RUNNER_TEMP, 'npm-previous'),
        env.GITHUB_SHA
      )
    : undefined;
  const session = resolve(env.RUNNER_TEMP, 'npm-session');
  await mkdir(session);
  await writeFile(resolve(session, 'user.npmrc'), '');
  await writeFile(resolve(session, 'global.npmrc'), '');
  const npmEnv = publicationNpmEnvironment(env, session);
  const reportPath = resolve(env.RUNNER_TEMP, 'npm-publication-result.json');
  const report = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: env.GITHUB_RUN_ID,
    previous,
    confirmedAbsent: (env.PUBLICATION_CONFIRMED_ABSENT ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    resolution: env.PUBLICATION_RESOLUTION,
    registry: registryMetadata,
    submit: (item) => publishArchive(resolve(directory, item.file), session, npmEnv),
    record: async (value) => {
      await writeFile(`${reportPath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
      await rename(`${reportPath}.tmp`, reportPath);
    }
  });
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `## npm publication: ${report.state}\n\n${report.packages
        .map(({ name, version, status }) => `- ${name}@${version}: ${status}`)
        .join('\n')}\n${report.error ?? ''}\n`
    );
  publicationCheck(report.state === 'complete', report.error ?? 'NPM_PUBLICATION_INCOMPLETE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    publicationCheck(process.argv.length === 3, 'NPM_PUBLICATION_ARGUMENT_INVALID');
    await main(process.argv[2], process.env);
  } catch (error) {
    // Do not relay external transport errors or credential-bearing environment values.
    console.error(
      /^NPM_PUBLICATION_[A-Z_]+$/u.test(error.code ?? '') ? error.code : 'NPM_PUBLICATION_FAILED'
    );
    process.exitCode = 1;
  }
}
