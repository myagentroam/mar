import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPublicBoundary,
  publicSourceViolations
} from '../../scripts/check-public-boundary.mjs';

test('ignores staged Web output without excluding Server source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-public-source-'));
  try {
    await mkdir(join(root, 'mar-server', 'web'), { recursive: true });
    await writeFile(join(root, 'mar-server', 'web', 'bundle.js'), "const localized = '译文';");
    await checkPublicBoundary(root);
    await mkdir(join(root, 'mar-server', 'src'), { recursive: true });
    await writeFile(join(root, 'mar-server', 'src', 'label.ts'), "const label = '译文';");
    await assert.rejects(checkPublicBoundary(root), /PUBLIC_NON_I18N_CHINESE_FORBIDDEN/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('product composition can import EE but public cores cannot, and no import may escape', () => {
  assert.deepEqual(
    publicSourceViolations(
      'mar-server/src/app.ts',
      "import x from '@myagentroam/server-core/auth';"
    ),
    []
  );
  assert.deepEqual(
    publicSourceViolations(
      'mar-server/src/app.ts',
      "import x from '@myagentroam-enterprise/server-implementation';"
    ),
    []
  );
  for (const path of ['packages/server-core/src/app.ts', 'mar-node/src/app.ts']) {
    assert.ok(
      publicSourceViolations(
        path,
        "import x from '@myagentroam-enterprise/server-implementation';"
      ).includes('PUBLIC_CORE_EE_IMPORT_FORBIDDEN')
    );
  }
  assert.ok(
    publicSourceViolations(
      'packages/web-core/src/app.ts',
      "import x from '../../../ee/web/src/bootstrap';"
    ).includes('PUBLIC_CORE_EE_IMPORT_FORBIDDEN')
  );
  assert.ok(
    publicSourceViolations('src/app.ts', "export * from '../../private.js';").includes(
      'PUBLIC_OUTSIDE_IMPORT_FORBIDDEN'
    )
  );
  assert.ok(
    publicSourceViolations('src/app.ts', "const x = import('../../private.js');").includes(
      'PUBLIC_OUTSIDE_IMPORT_FORBIDDEN'
    )
  );
});

test('only root introductions are allowed and public instructions stay out', () => {
  assert.deepEqual(publicSourceViolations('README.zh-CN.md', ''), []);
  assert.deepEqual(publicSourceViolations('assets/readme.svg', ''), []);
  assert.deepEqual(publicSourceViolations('mar-node/README.en-US.md', ''), [
    'PUBLIC_NESTED_README_FORBIDDEN'
  ]);
  assert.deepEqual(publicSourceViolations('mar-node/README.md', ''), [
    'PUBLIC_NESTED_README_FORBIDDEN'
  ]);
  assert.deepEqual(publicSourceViolations('AGENTS.md', ''), [
    'PUBLIC_AGENT_INSTRUCTIONS_FORBIDDEN'
  ]);
  assert.ok(
    publicSourceViolations('package.json', '{"engines":{"node":">=24 <25"}}').includes(
      'PUBLIC_NODE_RUNTIME_UPPER_BOUND_FORBIDDEN'
    )
  );
});

test('release configuration and scripts cannot depend on private Harness or old product paths', () => {
  for (const [path, source] of [
    ['Dockerfile', 'COPY mar-server-enterprise/dist /runtime/server'],
    ['compose.yaml', 'image: my-agent-roam-enterprise:latest'],
    ['scripts/build.mjs', "import '../harness/routes.json'"],
    ['scripts/build.mjs', "readFile('../docs/design/PROJECT_DESIGN.md')"]
  ])
    assert.ok(
      publicSourceViolations(path, source).includes('PUBLIC_PRIVATE_IDENTIFIER_FORBIDDEN'),
      path
    );
  assert.deepEqual(
    publicSourceViolations('Dockerfile', 'COPY mar-server/dist /runtime/server'),
    []
  );
});

test('Chinese text in test assertions is allowed while other public source stays English', () => {
  const chinese = '中文';
  for (const path of [
    'test/unit/example.test.ts',
    'marctl/test/unit/example.test.mjs',
    'test/e2e/example.spec.ts',
    'test/support/example.ts',
    'test/e2e/example.cases.ts'
  ])
    assert.deepEqual(publicSourceViolations(path, `const fixture = '${chinese}';`), [], path);
  for (const [path, source] of [
    ['test/fixtures/session.jsonl', `{"title":"${chinese}"}`],
    ['packages/web-core/src/example.ts', `const label = '${chinese}';`],
    ['NOTICE', chinese]
  ])
    assert.ok(
      publicSourceViolations(path, source).includes('PUBLIC_NON_I18N_CHINESE_FORBIDDEN'),
      path
    );
  assert.deepEqual(
    publicSourceViolations(
      'packages/web-core/src/i18n/example.zh-CN.ts',
      `export default '${chinese}';`
    ),
    []
  );
  assert.deepEqual(publicSourceViolations('README.zh-CN.md', chinese), []);
  assert.deepEqual(publicSourceViolations('test/e2e/support/web-fixture.ts', chinese), []);
  for (const source of [
    `test('${chinese}', () => {});`,
    `test.describe.only('${chinese}', () => {});`,
    `it.each([1])('${chinese}', () => {});`,
    `// ${chinese}\nconst fixture = 1;`,
    `const fixture = 1; /* ${chinese} */`
  ])
    assert.ok(
      publicSourceViolations('test/unit/example.test.ts', source).includes(
        'PUBLIC_TEST_DESCRIPTION_CHINESE_FORBIDDEN'
      )
    );
  assert.deepEqual(
    publicSourceViolations(
      'test/unit/example.test.ts',
      `test('preserves Unicode', () => expect('// ${chinese}').toBe('// ${chinese}'));`
    ),
    []
  );
  assert.deepEqual(
    publicSourceViolations('docs/help/zh-CN/getting-started/overview.md', chinese),
    []
  );
  assert.ok(
    publicSourceViolations('docs/design/PROJECT_DESIGN.md', '').includes(
      'PUBLIC_PRIVATE_FILE_FORBIDDEN'
    )
  );
  assert.ok(
    publicSourceViolations('harness/routes.json', '{}').includes('PUBLIC_PRIVATE_FILE_FORBIDDEN')
  );
  assert.ok(publicSourceViolations('.env/test.env', '').includes('PUBLIC_PRIVATE_FILE_FORBIDDEN'));
});

test('EE dependencies remain excluded from independently licensed runtime packages', () => {
  const pkg = JSON.stringify({
    dependencies: { '@myagentroam-enterprise/server-implementation': 'workspace:*' }
  });
  assert.deepEqual(publicSourceViolations('mar-server/package.json', pkg), []);
  assert.ok(
    publicSourceViolations('packages/server-core/package.json', pkg).includes(
      'PUBLIC_CORE_EE_DEPENDENCY_FORBIDDEN'
    )
  );
});
