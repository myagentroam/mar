import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(?:ts|vue|css)$/u.test(path) ? [path] : [];
  });
}

describe('Element Plus retirement boundary', () => {
  it('keeps the product sources on MAR controls and tokens', () => {
    for (const root of [
      'packages/mar-ui',
      'packages/web-core/src',
      'ee/web/src',
      'mar-web-console/src'
    ]) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8');
        expect(text, file).not.toMatch(
          /['"](?:element-plus|@element-plus\/)[^'"]*['"]|<\/?el-[\w-]+|\bv-el-|--el-|\.el-[\w-]+/u
        );
      }
    }
  });

  it('keeps Element Plus out of runtime and development dependencies', () => {
    for (const pkg of ['packages/mar-ui', 'packages/web-core', 'ee/web', 'mar-web-console']) {
      const { dependencies = {}, devDependencies = {} } = JSON.parse(
        readFileSync(`${pkg}/package.json`, 'utf8')
      );
      const names = [...Object.keys(dependencies), ...Object.keys(devDependencies)];
      expect(names, pkg).not.toContain('element-plus');
      expect(names, pkg).not.toContain('@element-plus/icons-vue');
    }
    for (const file of ['packages/web-core/vite.config.mts', 'mar-web-console/vite.config.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/ElementPlusResolver|element-plus/u);
    }
  });
});
