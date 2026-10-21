import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runCiPipeline } from '../../scripts/ci-release-evidence.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mar-ci-release-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = join(root, 'test/runs');
  await mkdir(evidenceRoot, { recursive: true });
  const manifestPath = join(root, 'common-manifest.json');
  const manifestBytes = Buffer.from(
    JSON.stringify({ formatVersion: 2, sourceCommit: 'candidate-commit' })
  );
  await writeFile(manifestPath, manifestBytes);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const temporaryPaths = [];
  const makeTemp = async () => {
    const directory = await mkdtemp(join(root, 'temporary-'));
    temporaryPaths.push(directory);
    return directory;
  };
  return { root, evidenceRoot, manifestPath, manifestSha256, temporaryPaths, makeTemp };
}

function runnerFor(
  manifestSha256,
  { mismatch = false, sourceMismatch = false, failAt, omit } = {}
) {
  return async (_command, args) => {
    if (args[0] === omit) return;
    if (args[0] === 'release:verify-common') {
      await writeFile(
        args[2],
        JSON.stringify({
          commonManifestSha256: mismatch ? 'wrong' : manifestSha256,
          sourceCommits: { oss: sourceMismatch ? 'wrong' : 'product-source-commit' }
        })
      );
    } else if (args[0] === 'release:sbom') {
      await writeFile(args[1], 'sbom fixture');
    } else if (args[0] === 'release:notices') {
      await writeFile(args[1], 'complete notice fixture');
    }
    if (args[0] === failAt) throw new Error(`fixture failure: ${failAt}`);
  };
}

async function execute(context, options = {}) {
  const runner = runnerFor(context.manifestSha256, options);
  return runCiPipeline({
    root: context.root,
    runId: options.runId ?? (options.mismatch ? 'binding' : 'test-run'),
    release: options.release ?? true,
    commonManifest: context.manifestPath,
    run: options.run ?? runner,
    sourceCommit: async () => 'product-source-commit',
    makeTemp: context.makeTemp,
    removeTemp:
      options.removeTemp ?? ((directory) => rm(directory, { recursive: true, force: true })),
    evidenceRoot: context.evidenceRoot
  });
}

test('release CI retains and binds evidence outside its temporary work directory', async (t) => {
  const context = await fixture(t);
  await execute(context);
  const directory = join(context.evidenceRoot, 'ci-release-test-run');
  const evidence = JSON.parse(await readFile(join(directory, 'release-evidence.json'), 'utf8'));
  assert.equal(evidence.status, 'succeeded');
  assert.equal(evidence.complete, true);
  assert.equal(evidence.sourceCommit, 'product-source-commit');
  assert.equal(evidence.candidateSourceCommit, 'candidate-commit');
  assert.equal(evidence.commonManifest.sha256, context.manifestSha256);
  for (const item of evidence.evidence) {
    const bytes = await readFile(join(directory, item.path));
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(item.bytes, bytes.length);
  }
  assert.deepEqual(
    evidence.evidence.map(({ path }) => path),
    ['product-common-integration.json', 'product-sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt']
  );
  assert.equal(
    await readFile(join(directory, 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
    'complete notice fixture'
  );
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('failed release CI retains generated evidence and records incomplete stage', async (t) => {
  const context = await fixture(t);
  await assert.rejects(execute(context, { failAt: 'release:notices' }), /fixture failure/u);
  const directory = join(context.evidenceRoot, 'ci-release-test-run');
  const evidence = JSON.parse(await readFile(join(directory, 'release-evidence.json'), 'utf8'));
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.complete, false);
  assert.equal(evidence.failedStage, 'third-party-notices');
  assert.deepEqual(evidence.completedStages.slice(-2), ['candidate-integration', 'sbom']);
  assert.equal(
    evidence.evidence.some(({ path }) => path === 'product-sbom.cdx.json'),
    true
  );
  assert.equal(
    evidence.evidence.some(({ path }) => path === 'THIRD_PARTY_NOTICES.txt'),
    true
  );
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('release CI rejects a report bound to a different candidate and never overwrites prior evidence', async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    execute(context, { mismatch: true }),
    /CI_RELEASE_REPORT_CANDIDATE_MISMATCH/u
  );
  const directory = join(context.evidenceRoot, 'ci-release-binding');
  const prior = await readFile(join(directory, 'release-evidence.json'), 'utf8');
  const evidence = JSON.parse(prior);
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failedStage, 'candidate-integration');
  await assert.rejects(execute(context, { mismatch: true }), { code: 'EEXIST' });
  assert.equal(await readFile(join(directory, 'release-evidence.json'), 'utf8'), prior);
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('temporary cleanup failure cannot leave release evidence marked successful', async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    execute(context, {
      removeTemp: async () => {
        throw new Error('cleanup failed');
      }
    }),
    /cleanup failed/u
  );
  const evidence = JSON.parse(
    await readFile(
      join(context.evidenceRoot, 'ci-release-test-run', 'release-evidence.json'),
      'utf8'
    )
  );
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.complete, false);
  assert.equal(evidence.failedStage, 'temporary-cleanup');
});

test('ordinary CI runs every existing stage without release evidence', async (t) => {
  const context = await fixture(t);
  const calls = [];
  await execute(context, {
    release: false,
    run: async (command, args) => calls.push([command, args[0]])
  });
  assert.deepEqual(calls, [
    ['pnpm', 'install'],
    ['pnpm', 'lint'],
    ['pnpm', 'check:versions'],
    ['pnpm', 'check:public-boundary'],
    ['pnpm', 'typecheck'],
    ['pnpm', 'test:unit'],
    ['pnpm', 'build'],
    ['pnpm', 'test:release'],
    ['pnpm', 'check:release-artifacts'],
    ['pnpm', 'test:e2e'],
    ['docker', 'build']
  ]);
  await assert.rejects(access(join(context.evidenceRoot, 'ci-release-test-run')));
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('release CI rejects missing required outputs instead of reporting success', async (t) => {
  for (const [omit, stage] of [
    ['release:verify-common', 'candidate-integration'],
    ['release:sbom', 'sbom'],
    ['release:notices', 'third-party-notices']
  ]) {
    await t.test(stage, async (t) => {
      const context = await fixture(t);
      await assert.rejects(execute(context, { omit }), /CI_RELEASE_EVIDENCE_MISSING/u);
      const evidence = JSON.parse(
        await readFile(
          join(context.evidenceRoot, 'ci-release-test-run/release-evidence.json'),
          'utf8'
        )
      );
      assert.equal(evidence.status, 'failed');
      assert.equal(evidence.complete, false);
      assert.equal(evidence.failedStage, stage);
      assert.equal(evidence.completedStages.includes(stage), false);
      for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
    });
  }
});

test('ordinary CI preserves a failed command and still cleans its temporary directory', async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    execute(context, { release: false, failAt: 'build' }),
    /fixture failure: build/u
  );
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('early release failure records no generated evidence and no completed failing stage', async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    execute(context, { failAt: 'scripts/check-product-license.mjs' }),
    /fixture failure/u
  );
  const evidence = JSON.parse(
    await readFile(join(context.evidenceRoot, 'ci-release-test-run/release-evidence.json'), 'utf8')
  );
  assert.equal(evidence.complete, false);
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failedStage, 'product-license');
  assert.deepEqual(evidence.completedStages, []);
  assert.deepEqual(evidence.evidence, []);
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('release CI rejects a report from different product source', async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    execute(context, { sourceMismatch: true }),
    /CI_RELEASE_REPORT_SOURCE_MISMATCH/u
  );
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('status write failure still cleans temporary output and preserves the stage error', async (t) => {
  const context = await fixture(t);
  const runner = runnerFor(context.manifestSha256);
  const blocker = join(
    context.evidenceRoot,
    'ci-release-test-run',
    '.release-evidence-' + process.pid + '.tmp'
  );
  await assert.rejects(
    execute(context, {
      run: async (command, args) => {
        await runner(command, args);
        if (args[0] === 'release:sbom') {
          await mkdir(blocker);
          throw new Error('original sbom failure');
        }
      }
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.errors[0].message, /original sbom failure/u);
      assert.equal(error.errors[1].code, 'EEXIST');
      return true;
    }
  );
  await access(join(context.evidenceRoot, 'ci-release-test-run/product-sbom.cdx.json'));
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('failed report producer preserves raw output and every validation error', async (t) => {
  for (const mode of ['truncated', 'candidate-mismatch', 'source-mismatch', 'valid-control']) {
    await t.test(mode, async (t) => {
      const context = await fixture(t);
      const directory = join(context.evidenceRoot, 'ci-release-test-run');
      const bytes = Buffer.from(
        mode === 'truncated'
          ? '{"formatVersion":1,'
          : JSON.stringify({
              commonManifestSha256:
                mode === 'candidate-mismatch' ? 'wrong' : context.manifestSha256,
              sourceCommits: { oss: mode === 'source-mismatch' ? 'wrong' : 'product-source-commit' }
            })
      );
      const producerError = Object.assign(new Error('producer output write failed'), {
        code: 'ENOSPC'
      });
      const calls = [];
      await assert.rejects(
        execute(context, {
          run: async (_command, args) => {
            calls.push(args[0]);
            if (args[0] === 'release:verify-common') {
              await writeFile(args[2], bytes);
              throw producerError;
            }
          }
        }),
        (error) => {
          if (mode === 'valid-control') assert.equal(error, producerError);
          else {
            assert.equal(error instanceof AggregateError, true);
            assert.equal(error.errors.length, 2);
            assert.equal(error.errors[0], producerError);
            if (mode === 'truncated') assert.equal(error.errors[1] instanceof SyntaxError, true);
            else
              assert.equal(
                error.errors[1].message,
                mode === 'candidate-mismatch'
                  ? 'CI_RELEASE_REPORT_CANDIDATE_MISMATCH'
                  : 'CI_RELEASE_REPORT_SOURCE_MISMATCH'
              );
          }
          return true;
        }
      );
      assert.deepEqual(await readFile(join(directory, 'product-common-integration.json')), bytes);
      const evidence = JSON.parse(await readFile(join(directory, 'release-evidence.json'), 'utf8'));
      assert.equal(evidence.status, 'failed');
      assert.equal(evidence.complete, false);
      assert.equal(evidence.failedStage, 'candidate-integration');
      assert.equal(evidence.completedStages.includes('candidate-integration'), false);
      assert.equal(calls.includes('release:sbom'), false);
      assert.equal(evidence.evidence.length, 1);
      const [item] = evidence.evidence;
      assert.equal(item.status, 'incomplete');
      assert.equal(item.validation, mode === 'valid-control' ? 'valid' : 'invalid');
      assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(item.bytes, bytes.length);
      assert.equal(evidence.failures[0].stage, 'candidate-integration');
      assert.equal(evidence.failures[0].errors[0].message, producerError.message);
      assert.equal(evidence.failures[0].errors[0].code, 'ENOSPC');
      assert.equal(evidence.failures[0].errors.length, mode === 'valid-control' ? 1 : 2);
      if (mode === 'truncated') assert.equal(evidence.failures[0].errors[1].name, 'SyntaxError');
      for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
    });
  }
});

test('successful report producer still requires parseable complete report', async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    execute(context, {
      run: async (_command, args) => {
        if (args[0] === 'release:verify-common') await writeFile(args[2], '{"formatVersion":1,');
      }
    }),
    SyntaxError
  );
  const directory = join(context.evidenceRoot, 'ci-release-test-run');
  const evidence = JSON.parse(await readFile(join(directory, 'release-evidence.json'), 'utf8'));
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.complete, false);
  assert.equal(evidence.failedStage, 'candidate-integration');
  assert.equal(evidence.completedStages.includes('candidate-integration'), false);
  assert.deepEqual(evidence.evidence, []);
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});

test('failed report export preserves producer and parse errors without overwriting evidence', async (t) => {
  const context = await fixture(t);
  const directory = join(context.evidenceRoot, 'ci-release-test-run');
  const destination = join(directory, 'product-common-integration.json');
  const producerError = Object.assign(new Error('producer output write failed'), {
    code: 'ENOSPC'
  });
  await assert.rejects(
    execute(context, {
      run: async (_command, args) => {
        if (args[0] === 'release:verify-common') {
          await writeFile(args[2], '{"formatVersion":1,');
          await writeFile(destination, 'existing evidence', { flag: 'wx' });
          throw producerError;
        }
      }
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 3);
      assert.equal(error.errors[0], producerError);
      assert.equal(error.errors[1] instanceof SyntaxError, true);
      assert.equal(error.errors[2].code, 'EEXIST');
      return true;
    }
  );
  assert.equal(await readFile(destination, 'utf8'), 'existing evidence');
  const evidence = JSON.parse(await readFile(join(directory, 'release-evidence.json'), 'utf8'));
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.complete, false);
  assert.equal(evidence.failedStage, 'candidate-integration');
  assert.deepEqual(evidence.evidence, []);
  assert.deepEqual(
    evidence.failures[0].errors.map(({ name, code }) => [name, code]),
    [
      ['Error', 'ENOSPC'],
      ['SyntaxError', undefined],
      ['Error', 'EEXIST']
    ]
  );
  for (const temporary of context.temporaryPaths) await assert.rejects(access(temporary));
});
