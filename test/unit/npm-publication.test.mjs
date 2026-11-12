import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertOidcEnvironment,
  publicationPackagePaths,
  submitNpmPublication,
  validateNpmPublication,
  verifyNpmPublication
} from '../../scripts/npm-publication.mjs';
import {
  downloadNpmPublication,
  downloadPreviousReceipt,
  npmPublicationArguments,
  publicationNpmEnvironment
} from '../../scripts/npm-publish-github.mjs';

import {
  commitFixtureSource,
  digest,
  fixture,
  integrity,
  repository,
  sourceCommit
} from '../support/npm-publication.mjs';

test('publication verifies original archives against the pinned source and lockfile', async (t) => {
  const input = await fixture(t);
  assert.deepEqual(
    await verifyNpmPublication(input.directory, input.source, input.expected),
    input.manifest
  );
});

test('publication supports binaries, six Runtime targets and the bundled Server', async (t) => {
  for (const unit of ['binaries', 'runtime', 'server']) {
    const input = await fixture(t, unit);
    assert.deepEqual(
      await verifyNpmPublication(input.directory, input.source, input.expected),
      input.manifest
    );
  }
});

test('publication rejects incomplete groups, foreign packages, duplicate files and unsafe paths', async (t) => {
  const { manifest } = await fixture(t);
  for (const mutate of [
    (value) => value.packages.pop(),
    (value) => {
      value.packages[0].name = '@other/protocol';
    },
    (value) => {
      value.packages[0].file = '../package.tgz';
    },
    (value) => {
      value.packages[1].file = value.packages[0].file;
    },
    (value) => {
      value.packages[0].version = '1.2.4';
    },
    (value) => {
      value.tag = 'common-v9.9.9';
    },
    (value) => {
      value.repository = 'other/repo';
    }
  ]) {
    const value = structuredClone(manifest);
    mutate(value);
    assert.throws(() => validateNpmPublication(value), /NPM_PUBLICATION_/u);
  }
});

test('publication rejects changed manifests, source commits, lockfiles and archive bytes', async (t) => {
  const input = await fixture(t);
  await assert.rejects(
    verifyNpmPublication(input.directory, input.source, {
      ...input.expected,
      manifestSha256: '0'.repeat(64)
    }),
    /MANIFEST_DIGEST/u
  );
  await assert.rejects(
    verifyNpmPublication(input.directory, input.source, {
      ...input.expected,
      sourceCommit: 'b'.repeat(40)
    }),
    /SOURCE_MISMATCH/u
  );
  await writeFile(join(input.source, 'pnpm-lock.yaml'), 'changed');
  await assert.rejects(
    verifyNpmPublication(input.directory, input.source, input.expected),
    /LOCKFILE_MISMATCH/u
  );
  await writeFile(join(input.source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(join(input.directory, input.manifest.packages[0].file), 'changed');
  await assert.rejects(
    verifyNpmPublication(input.directory, input.source, input.expected),
    /ARCHIVE_DIGEST/u
  );
});

test('publication rejects a package whose source repository metadata no longer matches', async (t) => {
  const input = await fixture(t);
  const path = join(input.source, 'mar-agent/package.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  metadata.repository.url = 'git+https://github.com/other/repo.git';
  await writeFile(path, JSON.stringify(metadata));
  await assert.rejects(
    verifyNpmPublication(input.directory, input.source, input.expected),
    /REPOSITORY/u
  );
});

test('publication rejects redirected Registry configuration inside an otherwise valid archive', async (t) => {
  const input = await fixture(t, 'server');
  const item = input.manifest.packages[0];
  const stage = join(input.root, 'server');
  const path = join(stage, 'package/package.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  metadata.publishConfig.registry = 'https://example.invalid/';
  await writeFile(path, JSON.stringify(metadata));
  execFileSync('tar', ['-czf', join(input.directory, item.file), '-C', stage, 'package']);
  item.sha512 = digest(await readFile(join(input.directory, item.file)), 'sha512');
  const bytes = JSON.stringify(input.manifest);
  await writeFile(join(input.directory, 'npm-publication.json'), bytes);
  await assert.rejects(
    verifyNpmPublication(input.directory, input.source, {
      ...input.expected,
      manifestSha256: digest(bytes)
    }),
    /PUBLISH_CONFIG_INVALID/u
  );
});

async function setExecutableFileConfiguration(input, sourceFiles, archiveFiles) {
  const item = input.manifest.packages.find(
    ({ name }) => name === '@myagentroam/binaries-linux-x64'
  );
  const stage = join(input.root, 'binaries-linux-x64');
  const archivePath = join(stage, 'package/package.json');
  const metadata = JSON.parse(await readFile(archivePath, 'utf8'));
  metadata.publishConfig.executableFiles = sourceFiles;
  await writeFile(
    join(input.source, publicationPackagePaths[item.name], 'package.json'),
    JSON.stringify(metadata)
  );
  metadata.publishConfig.executableFiles = archiveFiles;
  await writeFile(archivePath, JSON.stringify(metadata));
  execFileSync('tar', ['-czf', join(input.directory, item.file), '-C', stage, 'package']);
  item.sha512 = digest(await readFile(join(input.directory, item.file)), 'sha512');
  const bytes = JSON.stringify(input.manifest);
  await writeFile(join(input.directory, 'npm-publication.json'), bytes);
  input.expected.manifestSha256 = digest(bytes);
}

test('publication accepts source-bound executable file packaging metadata', async (t) => {
  const input = await fixture(t, 'binaries');
  const files = ['vendor/ripgrep/linux-x64/rg'];
  await setExecutableFileConfiguration(input, files, files);
  assert.deepEqual(
    await verifyNpmPublication(input.directory, input.source, input.expected),
    input.manifest
  );
});

test('publication rejects executable file metadata that is malformed or differs from source', async (t) => {
  for (const [sourceFiles, archiveFiles] of [
    [['vendor/tool'], ['vendor/other']],
    [['vendor/tool'], undefined],
    ['vendor/tool', 'vendor/tool'],
    [[42], [42]]
  ]) {
    const input = await fixture(t, 'binaries');
    await setExecutableFileConfiguration(input, sourceFiles, archiveFiles);
    await assert.rejects(
      verifyNpmPublication(input.directory, input.source, input.expected),
      /PUBLISH_CONFIG_INVALID/u
    );
  }
});

test('publication rejects archive symlinks instead of following files outside the delivery set', async (t) => {
  const input = await fixture(t);
  const path = join(input.directory, input.manifest.packages[0].file);
  const outside = join(input.root, 'outside.tgz');
  await rename(path, outside);
  await symlink(outside, path);
  await assert.rejects(
    verifyNpmPublication(input.directory, input.source, input.expected),
    /ARCHIVE_DIGEST/u
  );
});

test('all actual publication package manifests declare the correct monorepo directory', async () => {
  for (const [name, path] of Object.entries(publicationPackagePaths)) {
    const metadata = JSON.parse(
      await readFile(new URL(`../../${path}/package.json`, import.meta.url), 'utf8')
    );
    assert.equal(metadata.name, name);
    assert.deepEqual(metadata.repository, {
      type: 'git',
      url: `git+https://github.com/${repository}.git`,
      directory: path
    });
  }
});

test('OIDC publishing accepts only the designated hosted workflow without npm tokens', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: 'refs/tags/common-v1.2.3',
    GITHUB_SHA: sourceCommit,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/npm-publish.yml@refs/tags/common-v1.2.3`,
    GITHUB_RUN_ATTEMPT: '1',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only'
  };
  assert.doesNotThrow(() => assertOidcEnvironment(env, 'common-v1.2.3'));
  for (const changed of [
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
    { NPM_TOKEN: 'test-only' },
    { NODE_AUTH_TOKEN: 'test-only' },
    { npm_config__authToken: 'test-only' }
  ])
    assert.throws(
      () => assertOidcEnvironment({ ...env, ...changed }, 'common-v1.2.3'),
      /NPM_PUBLICATION_/u
    );
});

test('publication records all attempts before submitting the complete group in parallel', async (t) => {
  const { manifest, expected } = await fixture(t);
  const snapshots = [];
  const submitted = [];
  const report = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '123',
    registry: async () => null,
    record: async (value) => {
      snapshots.push(structuredClone(value));
    },
    submit: async (item) => {
      assert.equal(
        snapshots.at(-1).packages.filter((entry) => entry.status === 'attempting').length,
        3
      );
      submitted.push(item.name);
      await Promise.resolve();
      return 0;
    }
  });
  assert.deepEqual(submitted.sort(), manifest.packages.map(({ name }) => name).sort());
  assert.equal(report.state, 'complete');
  assert.ok(report.packages.every(({ status }) => status === 'submitted'));
});

test('publication preserves partial submission receipts and marks nonzero outcomes unknown', async (t) => {
  const { manifest } = await fixture(t);
  const report = await submitNpmPublication(manifest, {
    manifestSha256: '1'.repeat(64),
    runId: '123',
    registry: async () => null,
    record: async () => {},
    submit: async (item) => (item.name.endsWith('/agent') ? 1 : 0)
  });
  assert.equal(report.state, 'incomplete');
  assert.equal(report.packages.find(({ name }) => name.endsWith('/agent')).status, 'unknown');
  assert.equal(report.packages.filter(({ status }) => status === 'submitted').length, 2);
});

test('publication resumes only unattempted packages and reuses matching Registry versions', async (t) => {
  const { manifest, expected } = await fixture(t);
  const previous = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '123',
    registry: async () => {
      throw new Error('offline');
    },
    record: async () => {},
    submit: async () => assert.fail('must not submit')
  });
  const submitted = [];
  const report = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '456',
    previous,
    registry: async (item) =>
      item.name.endsWith('/protocol')
        ? { name: item.name, version: item.version, dist: { integrity: integrity(item.sha512) } }
        : null,
    record: async () => {},
    submit: async ({ name }) => {
      submitted.push(name);
      return 0;
    }
  });
  assert.equal(report.state, 'complete');
  assert.equal(report.packages[0].status, 'existing');
  assert.equal(submitted.length, 2);
});

test('publication stops on ambiguous prior attempts, mismatched receipts or occupied versions', async (t) => {
  const { manifest, expected } = await fixture(t);
  const previous = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '123',
    registry: async () => null,
    record: async () => {},
    submit: async () => 1
  });
  for (const options of [
    { previous, registry: async () => null },
    {
      registry: async (item) => ({
        name: item.name,
        version: item.version,
        dist: { integrity: 'different' }
      })
    },
    {
      registry: async () => {
        throw new Error('Registry unavailable');
      }
    }
  ]) {
    const report = await submitNpmPublication(manifest, {
      manifestSha256: expected.manifestSha256,
      runId: '456',
      record: async () => {},
      submit: async () => assert.fail('must not submit'),
      ...options
    });
    assert.equal(report.state, 'blocked');
  }
  await assert.rejects(
    submitNpmPublication(manifest, {
      manifestSha256: expected.manifestSha256,
      runId: '456',
      previous: { ...previous, manifestSha256: '0'.repeat(64) },
      registry: async () => assert.fail('must not query the Registry'),
      record: async () => assert.fail('must not create a replacement receipt'),
      submit: async () => assert.fail('must not submit')
    }),
    { code: 'NPM_PUBLICATION_PREVIOUS_RECEIPT_INVALID' }
  );
});

test('a continuation cancelled during preflight preserves prior successes in its first receipt', async (t) => {
  const { manifest, expected } = await fixture(t);
  const previous = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '123',
    registry: async () => null,
    record: async () => {},
    submit: async ({ name }) => (name.endsWith('/agent') ? 1 : 0)
  });
  const snapshots = [];
  await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '456',
    previous,
    registry: async () => {
      throw new Error('Preflight interrupted before any Registry result');
    },
    record: async (value) => snapshots.push(structuredClone(value)),
    submit: async () => assert.fail('must not submit')
  });
  assert.equal(snapshots[0].state, 'validating');
  assert.deepEqual(
    snapshots[0].packages.map(({ name, status }) => ({ name, status })),
    previous.packages.map(({ name, status }) => ({ name, status }))
  );
  const report = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '789',
    previous: snapshots[0],
    confirmedAbsent: ['@myagentroam/protocol'],
    resolution: 'registry-confirmed-absent',
    registry: async () => null,
    record: async () => {},
    submit: async () => assert.fail('must not retry a successful submission')
  });
  assert.equal(report.state, 'blocked');
  assert.equal(report.error, 'NPM_PUBLICATION_RESOLUTION_INVALID');
});

test('a blocked continuation cannot erase an earlier unknown submission', async (t) => {
  const { manifest, expected } = await fixture(t);
  const base = {
    manifestSha256: expected.manifestSha256,
    registry: async () => null,
    record: async () => {},
    submit: async () => 1
  };
  const previous = await submitNpmPublication(manifest, { ...base, runId: '123' });
  const blocked = await submitNpmPublication(manifest, {
    ...base,
    runId: '456',
    previous,
    submit: async () => assert.fail('must not submit')
  });
  assert.equal(blocked.state, 'blocked');
  assert.ok(blocked.packages.every(({ status }) => status === 'unknown'));
  const again = await submitNpmPublication(manifest, {
    ...base,
    runId: '789',
    previous: blocked,
    submit: async () => assert.fail('must not submit')
  });
  assert.equal(again.state, 'blocked');
});

test('a reviewed non-acceptance resolution retries only explicitly selected unknown packages', async (t) => {
  const { manifest, expected } = await fixture(t);
  const previous = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '123',
    registry: async () => null,
    record: async () => {},
    submit: async () => 1
  });
  const selected = '@myagentroam/agent';
  for (const resolution of ['rejected-before-submit', 'registry-confirmed-absent']) {
    const submitted = [];
    const report = await submitNpmPublication(manifest, {
      manifestSha256: expected.manifestSha256,
      runId: '456',
      previous,
      confirmedAbsent: [selected],
      resolution,
      registry: async (item) =>
        item.name === selected
          ? null
          : {
              name: item.name,
              version: item.version,
              dist: { integrity: integrity(item.sha512) }
            },
      record: async () => {},
      submit: async ({ name }) => {
        submitted.push(name);
        return 0;
      }
    });
    assert.equal(report.state, 'complete');
    assert.deepEqual(submitted, [selected]);
    assert.deepEqual(report.resolution, {
      previousRunId: '123',
      mode: resolution,
      packages: [selected]
    });
  }
});

test('non-acceptance resolution cannot override success, absent evidence, foreign packages or occupied bytes', async (t) => {
  const { manifest, expected } = await fixture(t, 'server');
  const previous = await submitNpmPublication(manifest, {
    manifestSha256: expected.manifestSha256,
    runId: '123',
    registry: async () => null,
    record: async () => {},
    submit: async () => 1
  });
  const selected = '@myagentroam/server';
  for (const changed of [
    { previous: undefined },
    { resolution: 'none' },
    { confirmedAbsent: [selected, selected] },
    { confirmedAbsent: ['@myagentroam/foreign'] },
    {
      previous: {
        ...previous,
        packages: previous.packages.map((item) => ({ ...item, status: 'submitted' }))
      }
    },
    {
      registry: async (item) => ({
        name: item.name,
        version: item.version,
        dist: { integrity: 'different' }
      })
    }
  ]) {
    const report = await submitNpmPublication(manifest, {
      manifestSha256: expected.manifestSha256,
      runId: '456',
      previous,
      confirmedAbsent: [selected],
      resolution: 'rejected-before-submit',
      registry: async () => null,
      record: async () => {},
      submit: async () => assert.fail('must not submit'),
      ...changed
    });
    assert.equal(report.state, 'blocked');
  }
});

test('public Release download uses only the fixed repository and the approved asset list', async (t) => {
  const input = await fixture(t);
  const destination = join(input.root, 'downloaded');
  const calls = [];
  await downloadNpmPublication({
    tag: input.manifest.tag,
    manifestSha256: input.expected.manifestSha256,
    directory: destination,
    runGh: async (args) => {
      calls.push(args);
      if (args[0] === 'api')
        return JSON.stringify({
          tag_name: input.manifest.tag,
          draft: false,
          assets: [
            'npm-publication.json',
            ...input.manifest.packages.map(({ file }) => file),
            'unrelated.txt'
          ].map((name) => ({ name }))
        });
      assert.equal(args[args.indexOf('--repo') + 1], repository);
      const file = args[args.indexOf('--pattern') + 1];
      await copyFile(join(input.directory, file), join(destination, file));
      return '';
    }
  });
  assert.deepEqual(
    await verifyNpmPublication(destination, input.source, input.expected),
    input.manifest
  );
  assert.equal(calls.filter((args) => args[0] === 'release').length, 4);
  assert.equal((await readdir(destination)).includes('unrelated.txt'), false);
});

test('Release download rejects drafts, missing assets and a changed authorization digest', async (t) => {
  const input = await fixture(t);
  for (const [index, options] of [
    { draft: true },
    { missing: true },
    { manifestSha256: '0'.repeat(64) }
  ].entries()) {
    let archives = 0;
    const directory = join(input.root, `rejected-${index}`);
    await assert.rejects(
      downloadNpmPublication({
        tag: input.manifest.tag,
        manifestSha256: options.manifestSha256 ?? input.expected.manifestSha256,
        directory,
        runGh: async (args) => {
          if (args[0] === 'api')
            return JSON.stringify({
              tag_name: input.manifest.tag,
              draft: options.draft ?? false,
              assets: options.missing ? [] : [{ name: 'npm-publication.json' }]
            });
          archives += 1;
          await copyFile(
            join(input.directory, 'npm-publication.json'),
            join(directory, 'npm-publication.json')
          );
          return '';
        }
      }),
      /NPM_PUBLICATION_/u
    );
    assert.ok(archives <= 1);
  }
});

test('continuation accepts receipts only from a completed first-attempt publication run', async (t) => {
  const input = await fixture(t);
  const previous = { runId: '123', tag: input.manifest.tag };
  const metadata = {
    id: 123,
    status: 'completed',
    head_sha: sourceCommit,
    head_branch: input.manifest.tag,
    event: 'workflow_dispatch',
    path: '.github/workflows/npm-publish.yml',
    run_attempt: 1
  };
  const directory = join(input.root, 'previous');
  assert.deepEqual(
    await downloadPreviousReceipt('123', directory, sourceCommit, async (args) => {
      if (args[0] === 'api') return JSON.stringify(metadata);
      await writeFile(join(directory, 'npm-publication-result.json'), JSON.stringify(previous));
      return '';
    }),
    previous
  );
  for (const changed of [
    { status: 'in_progress' },
    { run_attempt: 2 },
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'main' },
    { path: '.github/workflows/ci.yml' }
  ]) {
    await assert.rejects(
      downloadPreviousReceipt('123', join(input.root, 'unused'), sourceCommit, async (args) => {
        assert.equal(args[0], 'api');
        return JSON.stringify({ ...metadata, ...changed });
      }),
      /RESUME_RUN_INVALID/u
    );
  }
});

test('continuation accepts ref-qualified GitHub workflow paths without accepting another workflow or tag', async (t) => {
  const input = await fixture(t);
  const tag = input.manifest.tag;
  const metadata = {
    id: 123,
    status: 'completed',
    head_sha: sourceCommit,
    head_branch: tag,
    event: 'workflow_dispatch',
    run_attempt: 1
  };
  const previous = { runId: '123', tag };
  for (const ref of [tag, `refs/tags/${tag}`]) {
    const directory = join(input.root, `previous-${ref.replaceAll('/', '-')}`);
    assert.deepEqual(
      await downloadPreviousReceipt('123', directory, sourceCommit, async (args) => {
        if (args[0] === 'api')
          return JSON.stringify({ ...metadata, path: `.github/workflows/npm-publish.yml@${ref}` });
        await writeFile(join(directory, 'npm-publication-result.json'), JSON.stringify(previous));
        return '';
      }),
      previous
    );
  }
  for (const path of [
    '.github/workflows/npm-publish.yml@main',
    '.github/workflows/npm-publish.yml@refs/tags/common-v9.9.9',
    `.github/workflows/ci.yml@refs/tags/${tag}`,
    '.github/workflows/npm-publish.yml@other.yml'
  ])
    await assert.rejects(
      downloadPreviousReceipt('123', join(input.root, 'unused'), sourceCommit, async (args) => {
        assert.equal(args[0], 'api');
        return JSON.stringify({ ...metadata, path });
      }),
      /RESUME_RUN_INVALID/u
    );
  const mismatched = join(input.root, 'mismatched-tag');
  await assert.rejects(
    downloadPreviousReceipt('123', mismatched, sourceCommit, async (args) => {
      if (args[0] === 'api')
        return JSON.stringify({ ...metadata, path: '.github/workflows/npm-publish.yml' });
      await writeFile(
        join(mismatched, 'npm-publication-result.json'),
        JSON.stringify({ ...previous, tag: 'common-v9.9.9' })
      );
      return '';
    }),
    /PREVIOUS_RECEIPT_INVALID/u
  );
});

test('npm invocation uses the original tarball, no lifecycle scripts, and isolated OIDC configuration', () => {
  const env = publicationNpmEnvironment(
    {
      PATH: '/usr/bin',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only',
      GH_TOKEN: 'test-only',
      NPM_CONFIG_REGISTRY: 'https://example.invalid/',
      npm_config_userconfig: '/outside/npmrc',
      NODE_AUTH_TOKEN: 'test-only'
    },
    '/tmp/session with spaces'
  );
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NODE_AUTH_TOKEN, undefined);
  assert.equal(env.npm_config_userconfig, undefined);
  assert.equal(env.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org/');
  assert.equal(env.NPM_CONFIG_USERCONFIG, '/tmp/session with spaces/user.npmrc');
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'test-only');
  assert.deepEqual(npmPublicationArguments('/tmp/archive with spaces.tgz'), [
    'publish',
    '/tmp/archive with spaces.tgz',
    '--access',
    'public',
    '--ignore-scripts',
    '--provenance=false',
    '--tag',
    'latest',
    '--registry',
    'https://registry.npmjs.org/'
  ]);
});

test('isolated GitHub entrypoint submits real tarball paths and persists a partial-result receipt', async (t) => {
  const input = await fixture(t);
  await mkdir(join(input.source, 'scripts'));
  for (const file of [
    'npm-publication.mjs',
    'npm-publish-github.mjs',
    'computer-runtime-packages.mjs',
    'binaries-packages.mjs'
  ])
    await copyFile(
      new URL(`../../scripts/${file}`, import.meta.url),
      join(input.source, 'scripts', file)
    );
  const actualCommit = commitFixtureSource(input.source);
  input.manifest.sourceCommit = actualCommit;
  const bytes = JSON.stringify(input.manifest);
  await writeFile(join(input.directory, 'npm-publication.json'), bytes);
  await rename(input.directory, join(input.root, 'npm-publication'));
  const bin = join(input.root, 'bin');
  const audit = join(input.root, 'audit');
  await mkdir(bin);
  await mkdir(audit);
  await writeFile(
    join(bin, 'npm'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(9);',
      "if (fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8') !== '') process.exit(8);",
      "fs.writeFileSync(process.env.TEST_NPM_AUDIT + '/' + process.pid + '.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));",
      "process.exit(process.argv[3].includes('myagentroam-agent-') ? 1 : 0);"
    ].join('\n'),
    { mode: 0o755 }
  );
  const shim = join(input.root, 'fake-registry.mjs');
  await writeFile(shim, 'globalThis.fetch = async () => ({ status: 404 });\n');
  let status = 0;
  try {
    execFileSync(
      process.execPath,
      ['--import', shim, join(input.source, 'scripts/npm-publish-github.mjs'), 'publish'],
      {
        cwd: input.source,
        stdio: 'pipe',
        timeout: 15_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: input.root,
          RUNNER_TEMP: input.root,
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
          GITHUB_REPOSITORY: repository,
          GITHUB_REF: `refs/tags/${input.manifest.tag}`,
          GITHUB_SHA: actualCommit,
          GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/npm-publish.yml@refs/tags/${input.manifest.tag}`,
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_RUN_ID: '123',
          GH_TOKEN: 'test-only',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only',
          PUBLICATION_TAG: input.manifest.tag,
          PUBLICATION_MANIFEST_SHA256: digest(bytes),
          TEST_NPM_AUDIT: audit
        }
      }
    );
  } catch (error) {
    status = error.status;
  }
  assert.equal(status, 1);
  const report = JSON.parse(
    await readFile(join(input.root, 'npm-publication-result.json'), 'utf8')
  );
  assert.equal(report.state, 'incomplete');
  assert.equal(report.packages.find(({ name }) => name.endsWith('/agent')).status, 'unknown');
  assert.equal(report.packages.filter(({ status: value }) => value === 'submitted').length, 2);
  const calls = await readdir(audit);
  assert.equal(calls.length, 3);
  for (const file of calls) {
    const call = JSON.parse(await readFile(join(audit, file), 'utf8'));
    const item = input.manifest.packages.find(
      ({ file: archive }) => call.args[1] === join(input.root, 'npm-publication', archive)
    );
    assert.ok(item);
    assert.deepEqual(
      call.args,
      npmPublicationArguments(join(input.root, 'npm-publication', item.file))
    );
    assert.equal(call.cwd, join(input.root, 'npm-session'));
    assert.equal(digest(await readFile(call.args[1]), 'sha512'), item.sha512);
  }
});
