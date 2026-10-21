import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('enterprise Web package boundary', () => {
  it.each(['mar-web-console/index.html'] as const)(
    'initializes the default dark Console theme before mounting: %s',
    (entry) => {
      const script = read(entry).match(/<script>([\s\S]*?)<\/script>/u)?.[1];
      expect(script).toBeDefined();

      for (const pathname of ['/', '/index.html', '/console', '/console/']) {
        for (const stored of [null, '', 'unknown-theme', 'daylight', 'vscode-dark-2026']) {
          const attributes = new Map<string, string>();
          const classes = new Set<string>();
          const themeColor = { content: '#ffffff' };
          runInNewContext(script!, {
            location: { pathname },
            localStorage: { getItem: () => stored },
            document: {
              documentElement: {
                setAttribute: (name: string, value: string) => attributes.set(name, value),
                classList: { add: (name: string) => classes.add(name) }
              },
              querySelector: () => themeColor
            }
          });

          const dark = pathname.startsWith('/console') && stored !== 'daylight';
          expect(attributes.get('data-theme')).toBe(dark ? 'vscode-dark-2026' : undefined);
          expect(classes.has('dark')).toBe(dark);
          expect(themeColor.content).toBe(dark ? '#0e1116' : '#ffffff');
        }
      }
    }
  );

  it('uses a private workspace implementation with a thin application entry', () => {
    const app = JSON.parse(read('mar-web-console/package.json'));
    const implementation = JSON.parse(read('ee/web/package.json'));
    expect(app.dependencies['@myagentroam-enterprise/web-implementation']).toBe('workspace:*');
    expect(implementation.private).toBe(true);
    expect(implementation.version).toBe(app.version);
    expect(implementation.exports['.']).toBe('./src/bootstrap.ts');
    expect(readdirSync(resolve('mar-web-console/src'))).toEqual(['main.ts']);
    expect(read('mar-web-console/src/main.ts')).toBe(
      "import '@myagentroam-enterprise/web-implementation';\n"
    );
  });
});
