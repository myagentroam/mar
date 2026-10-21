import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';

const evidenceFiles = [
  ['product-common-integration.json', 'candidate-integration'],
  ['product-sbom.cdx.json', 'sbom'],
  ['THIRD_PARTY_NOTICES.txt', 'third-party-notices']
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeStatus(directory, status) {
  const path = resolve(directory, 'release-evidence.json');
  const temporary = resolve(directory, `.release-evidence-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { flag: 'wx' });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exportFile(source, directory, name) {
  const destination = resolve(directory, name);
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  const contents = await readFile(destination);
  return { path: name, sha256: sha256(contents), bytes: contents.length };
}

export async function runCiPipeline({
  root,
  runId,
  release,
  commonManifest,
  run,
  sourceCommit,
  makeTemp,
  removeTemp,
  evidenceRoot = resolve(root, 'test/runs')
}) {
  const temporary = await makeTemp();
  let evidenceDirectory;
  let evidence;
  let activeStage = 'source-validation';
  const completedStages = [];
  const exported = [];
  const failures = [];

  async function update(status, failedStage) {
    if (!release) return;
    await writeStatus(evidenceDirectory, {
      formatVersion: 1,
      status,
      complete: status === 'succeeded',
      sourceCommit: evidence.sourceCommit,
      commonManifest: { path: evidence.manifestPath, sha256: evidence.manifestSha256 },
      candidateSourceCommit: evidence.candidateSourceCommit,
      completedStages: [...completedStages],
      ...(failedStage ? { failedStage } : {}),
      evidence: [...exported],
      failures: [...failures]
    });
  }

  async function step(name, action, fileName) {
    activeStage = name;
    let actionError;
    const errors = [];
    try {
      await action();
    } catch (error) {
      actionError = error;
      errors.push(error);
    }
    if (fileName) {
      const source = resolve(temporary, fileName);
      let outputFound = false;
      try {
        if ((await stat(source)).isFile()) {
          outputFound = true;
          let validationError;
          if (fileName === evidenceFiles[0][0]) {
            try {
              const report = JSON.parse(await readFile(source, 'utf8'));
              if (report.commonManifestSha256 !== evidence.manifestSha256)
                throw new Error('CI_RELEASE_REPORT_CANDIDATE_MISMATCH');
              if (report.sourceCommits?.oss !== evidence.sourceCommit)
                throw new Error('CI_RELEASE_REPORT_SOURCE_MISMATCH');
            } catch (error) {
              validationError = error;
              errors.push(error);
            }
          }
          if (!validationError || actionError) {
            const item = await exportFile(source, evidenceDirectory, fileName);
            exported.push({
              ...item,
              status: actionError ? 'incomplete' : 'complete',
              ...(fileName === evidenceFiles[0][0]
                ? { validation: validationError ? 'invalid' : 'valid' }
                : {})
            });
          }
        } else if (!actionError) {
          throw new Error('CI_RELEASE_EVIDENCE_MISSING: ' + fileName);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' || outputFound) errors.push(error);
        else if (!actionError) errors.push(new Error('CI_RELEASE_EVIDENCE_MISSING: ' + fileName));
      }
    }
    if (errors.length) {
      failures.push({
        stage: name,
        errors: errors.map((error) => ({
          name: error.name,
          message: error.message,
          ...(error.code ? { code: error.code } : {})
        }))
      });
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, 'CI_RELEASE_STAGE_FAILED: ' + name);
    }
    completedStages.push(name);
    await update('running');
  }

  let pipelineError;
  try {
    if (release) {
      const manifestPath = resolve(commonManifest);
      const manifestBytes = await readFile(manifestPath);
      let manifest;
      try {
        manifest = JSON.parse(manifestBytes.toString('utf8'));
      } catch {
        throw new Error('CI_COMMON_MANIFEST_INVALID');
      }
      const currentSourceCommit = await sourceCommit();
      await mkdir(evidenceRoot, { recursive: true });
      evidenceDirectory = resolve(evidenceRoot, `ci-release-${runId}`);
      await mkdir(evidenceDirectory, { recursive: false });
      evidence = {
        sourceCommit: currentSourceCommit,
        manifestPath,
        manifestSha256: sha256(manifestBytes),
        candidateSourceCommit: manifest.sourceCommit ?? null
      };
      process.stdout.write(`Release CI evidence directory: ${evidenceDirectory}\n`);
      await update('running');
    }

    if (release)
      await step('product-license', () => run('node', ['scripts/check-product-license.mjs']));
    await step('frozen-install', () => run('pnpm', ['install', '--frozen-lockfile']));
    for (const script of [
      'lint',
      'check:versions',
      'check:public-boundary',
      'typecheck',
      'test:unit',
      'build',
      'test:release',
      'check:release-artifacts',
      'test:e2e'
    ])
      await step(script, () => run('pnpm', [script]));
    await step('server-docker-build', () =>
      run('docker', [
        'build',
        '--target',
        'server',
        '--tag',
        `myagentroam-server-ci:${runId.toLowerCase().slice(0, 96)}`,
        '.'
      ])
    );
    if (release) {
      await step('product-smoke', () => run('pnpm', ['test:smoke'], `${runId}-smoke`));
      await step(
        'candidate-integration',
        () =>
          run('pnpm', [
            'release:verify-common',
            resolve(commonManifest),
            resolve(temporary, evidenceFiles[0][0])
          ]),
        evidenceFiles[0][0]
      );
      await step(
        'sbom',
        () => run('pnpm', ['release:sbom', resolve(temporary, evidenceFiles[1][0])]),
        evidenceFiles[1][0]
      );
      await step(
        'third-party-notices',
        () => run('pnpm', ['release:notices', resolve(temporary, evidenceFiles[2][0])]),
        evidenceFiles[2][0]
      );
    }
  } catch (error) {
    pipelineError = error;
    if (release && evidenceDirectory && evidence) {
      try {
        await update('failed', activeStage);
      } catch (statusError) {
        pipelineError = new AggregateError([error, statusError], 'CI_RELEASE_STATUS_WRITE_FAILED');
      }
    }
  }

  activeStage = 'temporary-cleanup';
  try {
    await removeTemp(temporary);
  } catch (error) {
    pipelineError = pipelineError
      ? new AggregateError([pipelineError, error], 'CI_TEMPORARY_CLEANUP_FAILED')
      : error;
    if (release && evidenceDirectory && evidence) {
      try {
        await update('failed', activeStage);
      } catch (statusError) {
        pipelineError = new AggregateError(
          [pipelineError, statusError],
          'CI_RELEASE_STATUS_WRITE_FAILED'
        );
      }
    }
  }
  if (pipelineError) throw pipelineError;
  if (release) await update('succeeded');
}
