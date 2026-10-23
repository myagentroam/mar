import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTests, parseCases, searchTests } from '../../scripts/discover-tests.mjs';

test('literal suites, aliases, metadata and disabled cases are discovered without execution', () => {
  const parsed = parseCases(
    "import { test as check, describe } from 'vitest';\n// @test-contract session.queue\n// @test-covers src/queue.ts\nthrow new Error('must never execute');\ndescribe('queue', () => { check('cancel stops execution', () => {}); check.skip('offline', () => {}); check.each([1,2])('item %s', () => {}); });",
    'queue.test.ts'
  );
  assert.deepEqual(
    parsed.cases.map((c) => c.title),
    ['queue > cancel stops execution', 'queue > offline', 'queue > item %s']
  );
  assert.equal(parsed.cases[1].status, 'skip');
  assert.equal(parsed.cases[2].dynamic, true);
  assert.deepEqual(parsed.contracts, ['session.queue']);
  assert.deepEqual(parsed.covers, ['src/queue.ts']);
  assert.equal(parsed.runner, 'vitest');
});

test('comments are not declarations and dynamic suites remain explicitly unresolved', () => {
  const parsed = parseCases(
    "// test('fake', () => {});\ndescribe.each([1])('suite %s', () => { test(name, () => {}); });\ntest.todo('later');",
    'dynamic.test.ts'
  );
  assert.equal(parsed.cases.length, 2);
  assert.equal(parsed.cases[0].dynamic, true);
  assert.equal(parsed.cases[1].status, 'todo');
});

test('Playwright test.describe registers child cases rather than a fake suite case', () => {
  const parsed = parseCases(
    "import { test } from '@playwright/test'; test.describe.serial('queue', () => { test('resumes', () => {}); test.describe.skip('offline', () => { test('recovers', () => {}); }); });",
    'queue.spec.ts'
  );
  assert.deepEqual(
    parsed.cases.map((item) => item.title),
    ['queue > resumes', 'queue > offline > recovers']
  );
  assert.equal(parsed.cases[1].status, 'skip');
});

test('working tree discovery includes untracked additions, removes deleted files and resolves aggregate entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-test-discovery-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await mkdir(join(root, 'test/e2e'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, '.gitignore'), 'test/runs/\n');
    await writeFile(join(root, 'src/queue.ts'), 'export const queue = 1;');
    await writeFile(
      join(root, 'test/e2e/queue.cases.ts'),
      "import { test } from '@playwright/test'; import '../../src/queue.js'; test('queue resumes', () => {});"
    );
    await writeFile(join(root, 'test/e2e/app.spec.ts'), "import './queue.cases.js';");
    await mkdir(join(root, 'test/runs'), { recursive: true });
    await writeFile(join(root, 'test/runs/ignored.test.ts'), "test('ignored', () => {});");
    let index = await discoverTests(root);
    const match = searchTests(index, { paths: ['src/queue.ts'] });
    assert.equal(match.length, 1);
    assert.deepEqual(match[0].entrypoints, ['test/e2e/app.spec.ts']);
    assert.equal(match[0].requiresRunnerConfirmation, true);
    assert.ok(!index.assets.some((a) => a.source.includes('ignored')));
    assert.equal(searchTests(index, { query: ['queue resumes'] }).length, 1);
    execFileSync('git', ['add', 'test/e2e/queue.cases.ts'], { cwd: root });
    await unlink(join(root, 'test/e2e/queue.cases.ts'));
    index = await discoverTests(root);
    assert.ok(!index.assets.some((a) => a.source.endsWith('queue.cases.ts')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('component fixture queries keep the real implementation searchable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-discovery-component-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, 'Widget.vue'), '<template><p>Fixture</p></template>');
    await writeFile(
      join(root, 'widget.test.ts'),
      "import { test } from 'vitest'; import Widget from './Widget.vue?unit-render'; test('renders the widget', () => {});"
    );
    const matches = searchTests(await discoverTests(root), { paths: ['Widget.vue'] });
    assert.equal(matches.length, 1);
    assert.ok(matches[0].implementationPaths.includes('Widget.vue'));
    assert.ok(matches[0].implementationPaths.every((path) => !path.includes('?')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('independent roots do not share discoveries and custom scripts stay visible', async () => {
  const roots = await Promise.all(
    [0, 1].map(() => mkdtemp(join(tmpdir(), 'mar-discovery-isolation-')))
  );
  try {
    for (const [index, root] of roots.entries()) {
      execFileSync('git', ['init', '-q'], { cwd: root });
      await mkdir(join(root, 'test/live'), { recursive: true });
      await writeFile(join(root, 'test/live/probe.mjs'), 'throw new Error("must not execute");');
      await writeFile(
        join(root, 'case.test.mjs'),
        "import test from 'node:test'; test('case " + index + "', () => {});"
      );
    }
    const indexes = await Promise.all(roots.map(discoverTests));
    assert.ok(indexes[0].assets.some((a) => a.title === 'case 0'));
    assert.ok(!indexes[0].assets.some((a) => a.title === 'case 1'));
    assert.ok(indexes[0].diagnostics.some((d) => d.path === 'test/live/probe.mjs'));
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test('registration under loops and conditions remains dynamic and fake metadata in strings is ignored', () => {
  const parsed = parseCases(
    "const fixture = '// @test-contract fake';\nfor (const value of data) { test('same title', () => {}); }\nif (enabled) test('conditional', () => {});",
    'loop.test.ts'
  );
  assert.deepEqual(parsed.contracts, []);
  assert.equal(parsed.cases.length, 2);
  assert.ok(parsed.cases.every((item) => item.dynamic));
});

test('discovered commands keep Node execution explicit and stable identities survive line changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-discovery-commands-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const path = join(root, 'case.test.mjs');
    const content = "import test from 'node:test'; test('case is isolated', () => {});";
    await writeFile(path, content);
    const first = (await discoverTests(root)).assets[0];
    assert.deepEqual(first.commands[0], {
      kind: 'execute',
      cwd: '.',
      command: 'node',
      args: ['--test', 'case.test.mjs']
    });
    await writeFile(path, '\n\n' + content);
    const second = (await discoverTests(root)).assets[0];
    assert.equal(first.id, second.id);
    assert.notEqual(first.line, second.line);
    // Execute exactly the returned focused argv in this isolated fixture.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = execFileSync(second.commands[0].command, second.commands[0].args, {
      cwd: root,
      env,
      encoding: 'utf8'
    });
    assert.match(result, /pass 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner hooks and conditional annotations are not mistaken for cases', () => {
  const parsed = parseCases(
    "import { test } from '@playwright/test'; test.beforeAll(() => {}); test.skip(true, 'offline'); test.slow(); test('real case', () => {});",
    'annotations.spec.ts'
  );
  assert.deepEqual(
    parsed.cases.map((item) => item.title),
    ['real case']
  );
});

test('aggregate discovery follows static re-exports and CommonJS TypeScript extensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-discovery-exports-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(
      join(root, 'queue.cases.cts'),
      "import { test } from '@playwright/test'; test('resumes queued work', () => {});"
    );
    await writeFile(join(root, 'bridge.ts'), "export * from './queue.cases.cjs';");
    await writeFile(join(root, 'app.spec.ts'), "import './bridge.js';");
    await writeFile(
      join(root, 'type-import.spec.ts'),
      "import type * as Cases from './bridge.js';"
    );
    await writeFile(join(root, 'type-export.spec.ts'), "export { type Cases } from './bridge.js';");
    await writeFile(
      join(root, 'named-type-import.spec.ts'),
      "import { type Cases } from './bridge.js';"
    );
    const index = await discoverTests(root);
    assert.deepEqual(searchTests(index, { query: ['---'] }), []);
    assert.deepEqual(index.assets.find((asset) => asset.source === 'queue.cases.cts').entrypoints, [
      'app.spec.ts'
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('type-only imports remain searchable without becoming runtime registration edges', () => {
  const parsed = parseCases(
    "import type { Queue } from './queue.js'; export { type Item } from './item.js'; import './runtime.js';",
    'types.test.ts'
  );
  assert.deepEqual(parsed.imports, ['./queue.js', './item.js', './runtime.js']);
  assert.deepEqual(parsed.runtimeImports, ['./runtime.js']);
});
