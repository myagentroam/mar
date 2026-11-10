import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const manifest = (path: string) => JSON.parse(read(`${path}/package.json`));

describe('unified Server entry and EE implementation boundary', () => {
  it('keeps the public application entrypoint separate from the EE implementation', () => {
    const app = manifest('mar-server');
    const implementation = manifest('ee/server');
    expect(app.dependencies['@myagentroam-enterprise/server-implementation']).toBe('workspace:*');
    expect(implementation.private).toBe(true);
    expect(implementation.version).toBe(app.version);
    expect(implementation.exports['.'].import).toBe('./dist/app.js');
    expect(implementation.exports['.'].development).toBe('./src/app.ts');
    expect(app.scripts.dev).toContain('--conditions=development');
    expect(read('playwright.config.mts')).toContain(
      "const serverCommand = 'node --import tsx test/e2e/support/playwright-server.ts'"
    );
    expect(implementation.files).toEqual(['dist']);
    expect(app.dependencies).not.toHaveProperty('@myagentroam/node');
    expect(readdirSync(resolve(root, 'mar-server/src')).sort()).toEqual([
      'license.ts',
      'main.ts',
      'quick-start',
      'reset-password.ts'
    ]);
    expect(read('mar-server/src/main.ts')).toContain(
      "from '@myagentroam-enterprise/server-implementation'"
    );
  });

  it('builds and packages the EE implementation with the public product', () => {
    expect(read('scripts/check-release-artifacts.mjs')).toContain('ee/server');
    expect(read('Dockerfile')).toContain('COPY ee/server/package.json ee/server/package.json');
    expect(read('Dockerfile')).toContain('COPY ee/server ee/server');
    expect(read('Dockerfile').split('FROM dependencies AS server-build')[1]).toContain(
      'pnpm --filter-prod @myagentroam/server... build'
    );
  });

  it('includes EE package unit tests in product discovery and type checking', () => {
    expect(read('vitest.config.ts')).toContain("'ee/*/test/unit/**/*.test.ts'");
    expect(JSON.parse(read('tsconfig.tests.json')).include).toContain('ee/*/test/unit/**/*.ts');
  });
});
