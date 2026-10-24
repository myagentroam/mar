import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
// Reuse this build for the public-entry compiler check; no package installation is needed.
beforeAll(async () => {
  await execute('pnpm', ['build'], { cwd: process.cwd() });
});

it('allows an external strict NodeNext consumer to implement and inject the Store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-store-types-'));
  try {
    const modules = join(root, 'node_modules', '@myagentroam');
    await mkdir(modules, { recursive: true });
    await symlink(resolve('.'), join(modules, 'agent'), 'junction');
    // Compile the actual limited backend against published declarations, not source aliases.
    const source = (
      await readFile(join('test', 'support', 'text-session-store.ts'), 'utf8')
    ).replace("'../../src/index.js'", "'@myagentroam/agent'");
    await writeFile(join(root, 'store.mts'), source);
    await writeFile(
      join(root, 'consumer.mts'),
      [
        "import { createMarAgent, openMarAgentSessionCatalog, type CreateMarAgentOptions, type SessionStore } from '@myagentroam/agent';",
        "import { textSessionStore } from './store.mjs';",
        'const store: SessionStore = textSessionStore().store;',
        'declare const options: CreateMarAgentOptions;',
        'void createMarAgent({ ...options, sessionStore: store });',
        'void openMarAgentSessionCatalog({ sessionStore: store });',
        "void openMarAgentSessionCatalog({ homeDirectory: '/tmp/example' });",
        '// @ts-expect-error A Catalog must have exactly one storage source.',
        "void openMarAgentSessionCatalog({ homeDirectory: '/tmp/example', sessionStore: store });",
        '// @ts-expect-error A Catalog needs a storage source.',
        'void openMarAgentSessionCatalog({});'
      ].join('\n')
    );
    const nodeTypes = dirname(dirname(require.resolve('@types/node/package.json')));
    const result = await execute(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess',
      '--target',
      'ES2024',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      '--typeRoots',
      nodeTypes,
      join(root, 'consumer.mts')
    ]);
    expect(result.stderr).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
