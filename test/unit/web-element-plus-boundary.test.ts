import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:ts|vue|css)$/u.test(path) ? [path] : [];
  });
}

describe('Element Plus production boundary', () => {
  it('does not restore the full plugin or complete stylesheet in Core, EE, or the entry', () => {
    for (const root of ['packages/web-core/src', 'ee/web/src', 'mar-web-console/src']) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8');
        expect(text, file).not.toMatch(/import\s+\w+\s+from\s+['"]element-plus['"]/u);
        expect(text, file).not.toContain('element-plus/dist/index.css');
      }
    }
  });
});
