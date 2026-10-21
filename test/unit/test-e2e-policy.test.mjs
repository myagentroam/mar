import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  assertSmokeReport,
  e2eOptions,
  integrationTestFiles,
  smokeTestTitles,
  smokeTitlesForPlatform
} from '../../scripts/test-e2e-policy.mjs';

test('release smoke is Linux-only by default and cannot be narrowed', () => {
  assert.equal(e2eOptions(['--smoke'], 'linux').mode, 'smoke');
  assert.throws(() => e2eOptions(['--smoke'], 'win32'), /SMOKE_PLATFORM_INVALID/);
  assert.equal(e2eOptions(['--smoke', '--windows'], 'win32').mode, 'smoke');
  assert.throws(() => e2eOptions(['--smoke', '--windows'], 'linux'), /SMOKE_PLATFORM_INVALID/);
  assert.throws(
    () => e2eOptions(['--smoke', '--grep', 'health'], 'linux'),
    /SMOKE_SELECTION_FIXED/
  );
  assert.throws(() => e2eOptions(['--windows'], 'linux'), /E2E_MODE_INVALID/);
  assert.throws(() => e2eOptions(['--smoke', '--integration'], 'linux'), /E2E_MODE_INVALID/);
});

test('integration selection preserves the existing runner arguments without a browser stack', () => {
  const options = e2eOptions(['--integration', 'test/e2e/server-auth.spec.ts']);
  assert.equal(options.mode, 'integration');
  assert.deepEqual(options.arguments, ['test/e2e/server-auth.spec.ts', '--project=integration']);
  assert.equal(e2eOptions(['--project', 'integration']).mode, 'integration');
  assert.equal(e2eOptions(['--list']).list, true);
  assert.equal(e2eOptions(['--project', 'firefox']).mode, 'full');
  assert.throws(
    () => e2eOptions(['--integration', '--project=chromium']),
    /E2E_PROJECT_SELECTION_INVALID/
  );
  assert.throws(
    () => e2eOptions(['--project=integration', '--project=firefox']),
    /E2E_PROJECT_SELECTION_INVALID/
  );
  assert.equal(new Set(integrationTestFiles).size, integrationTestFiles.length);
});

function report(status = 'expected', platform = 'linux') {
  return {
    errors: [],
    suites: [
      {
        suites: [
          {
            specs: smokeTitlesForPlatform(platform).map((title) => ({
              title,
              ok: true,
              tests: [{ projectName: 'chromium', status, results: [{ status: 'passed' }] }]
            }))
          }
        ]
      }
    ]
  };
}

test('smoke requires every fixed journey once and rejects skipped, flaky, missing and failed runs', () => {
  assert.doesNotThrow(() => assertSmokeReport(report(), 'linux'));
  for (const status of ['skipped', 'flaky', 'unexpected'])
    assert.throws(() => assertSmokeReport(report(status), 'linux'), /SMOKE_REQUIRED_TEST_FAILED/);
  assert.throws(
    () => assertSmokeReport({ suites: [], errors: [] }, 'linux'),
    /SMOKE_REQUIRED_TEST_MISSING/
  );
  const incomplete = report();
  incomplete.suites[0].suites[0].specs.pop();
  assert.throws(() => assertSmokeReport(incomplete, 'linux'), /SMOKE_REQUIRED_TEST_MISSING/);
  const duplicate = report();
  duplicate.suites[0].suites[0].specs.push(duplicate.suites[0].suites[0].specs[0]);
  assert.throws(() => assertSmokeReport(duplicate, 'linux'), /SMOKE_REQUIRED_TEST_MISSING/);
  const broken = report();
  broken.errors.push({ message: 'setup failed' });
  assert.throws(() => assertSmokeReport(broken, 'linux'), /SMOKE_RUN_FAILED/);
  const notExecuted = report();
  notExecuted.suites[0].suites[0].specs[0].tests[0].results = [];
  assert.throws(() => assertSmokeReport(notExecuted, 'linux'), /SMOKE_REQUIRED_TEST_FAILED/);
  for (const mutate of [
    (spec) => {
      spec.ok = false;
    },
    (spec) => {
      spec.tests[0].projectName = 'firefox';
    },
    (spec) => {
      spec.tests[0].results[0].status = 'skipped';
    },
    (spec) => {
      spec.tests[0].results.push({ status: 'passed' });
    }
  ]) {
    const invalid = report();
    mutate(invalid.suites[0].suites[0].specs[0]);
    assert.throws(() => assertSmokeReport(invalid, 'linux'), /SMOKE_REQUIRED_TEST_FAILED/);
  }
});

test('optional Windows smoke requires its supported journeys without Linux-only hosting', () => {
  assert.deepEqual(smokeTitlesForPlatform('win32'), smokeTestTitles.slice(0, 2));
  assert.doesNotThrow(() => assertSmokeReport(report('expected', 'win32'), 'win32'));
  assert.throws(
    () => assertSmokeReport(report('expected', 'win32'), 'linux'),
    /SMOKE_REQUIRED_TEST_MISSING/
  );
  assert.throws(() => assertSmokeReport(report(), 'win32'), /SMOKE_REQUIRED_TEST_MISSING/);
});

test('listing pure integration tests does not require database credentials or generate fixtures', () => {
  const root = resolve(import.meta.dirname, '../..');
  const home = mkdtempSync(resolve(tmpdir(), 'mar-e2e-list-'));
  const env = { ...process.env, HOME: home };
  for (const name of Object.keys(env))
    if (name.startsWith('MAR_TEST_') || name.startsWith('MAR_E2E_')) delete env[name];
  const runId = `list-policy-${randomUUID()}`;
  env.MAR_TEST_RUN_ID = runId;
  try {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/test-e2e.mjs',
        '--integration',
        '--list',
        'test/e2e/server-service-tier-migration.spec.ts'
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 }
    );
    assert.match(output, /\[integration\]/);
    assert.match(output, /Total: 1 test in 1 file/);
    assert.doesNotMatch(output, /\[firefox\]/);
    assert.equal(existsSync(resolve(root, `test/runs/playwright-license-${runId}.json`)), false);
    assert.equal(
      existsSync(resolve(root, `test/runs/playwright-license-host-${runId}.txt`)),
      false
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  'release smoke does not inherit source loaders or development conditions',
  {
    skip: !['linux', 'win32'].includes(process.platform)
  },
  () => {
    const root = resolve(import.meta.dirname, '../..');
    const directory = mkdtempSync(resolve(tmpdir(), 'mar-smoke-options-'));
    const preload = resolve(directory, 'preload.cjs');
    const log = resolve(directory, 'processes.jsonl');
    writeFileSync(
      preload,
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv[1]) + '\\n');`
    );
    const env = {
      ...process.env,
      NODE_OPTIONS: `--conditions=development --require ${JSON.stringify(preload)}`
    };
    for (const name of Object.keys(env))
      if (name.startsWith('MAR_TEST_') || name.startsWith('MAR_E2E_')) delete env[name];
    env.MAR_TEST_RUN_ID = `smoke-options-${randomUUID()}`;
    try {
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/test-e2e.mjs',
          '--smoke',
          '--list',
          ...(process.platform === 'win32' ? ['--windows'] : [])
        ],
        { cwd: root, env, encoding: 'utf8', timeout: 30_000 }
      );
      assert.match(output, new RegExp(`Total: ${smokeTitlesForPlatform().length} tests in 1 file`));
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [
        resolve(root, 'scripts/test-e2e.mjs')
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test('smoke Terminal checks decoded output across frames, not input echo or error messages', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { terminalOutput } from './test/e2e/support/release-smoke-fixture.ts';
    const frame = (type, data) => JSON.stringify({type, data});
    const frames = [frame('attach', 'RELEASE_TERMINAL_OK'), frame('error', 'RELEASE_TERMINAL_OK'),
      frame('output', 'PS> echo RELEASE_TERMINAL_OK\\r\\n')];
    const resultLine = /(?:^|[\\r\\n])RELEASE_TERMINAL_OK[ \\t]*[\\r\\n]/u;
    assert.doesNotMatch(terminalOutput(frames), resultLine);
    frames.push(frame('output', '\\x1b[32mRELEASE_TER'), frame('output', 'MINAL_OK\\x1b[0m\\r\\n'));
    assert.match(terminalOutput(frames), resultLine);
    assert.match(terminalOutput([frame('output', 'prompt> echo RELEASE_TERMINAL_OK  \\rRELEASE_TERMINAL_OK \\n')]), resultLine);
    console.log('Terminal output verified');
  `
    ],
    { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30_000 }
  );
  assert.match(output, /Terminal output verified/);
});
