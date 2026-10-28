import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_DEMO,
  NODE_FEATURES,
  isNodeVersionInFeatureRange,
  supportsNodeFeature
} from '../../src/util/node-features.js';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|vue)$/u.test(entry.name)
        ? [path]
        : [];
  });
}

describe('Public Node Feature Gating', () => {
  it('keeps only the reserved example after the baseline', () => {
    expect(NODE_FEATURES).toEqual({ [FEATURE_DEMO]: { introducedIn: '0.9.119' } });
    expect(supportsNodeFeature('0.9.118', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('0.9.119', FEATURE_DEMO)).toBe(true);
    expect(supportsNodeFeature('unknown', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('0.9.120-beta.1', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('0.9.119', 'unknown-feature')).toBe(false);
  });

  it('Rejects unknown, invalid, prerelease, and out-of-range versions conservatively', () => {
    const range = { introducedIn: '0.9.119', removedIn: '0.9.122' };
    for (const version of ['', 'unknown', '01.9.119', '0.9.119-beta', '0.9', '0.9.122']) {
      expect(isNodeVersionInFeatureRange(version, range)).toBe(false);
    }
    expect(isNodeVersionInFeatureRange('0.9.119', range)).toBe(true);
    expect(isNodeVersionInFeatureRange('0.9.121', range)).toBe(true);
    expect(isNodeVersionInFeatureRange('0.9.121', { introducedIn: 'broken' })).toBe(false);
    expect(
      isNodeVersionInFeatureRange('0.9.121', {
        introducedIn: '0.9.119',
        removedIn: 'broken'
      })
    ).toBe(false);
  });

  it('Never references the reserved example from business source', () => {
    const sourceDirectory = fileURLToPath(new URL('../../src', import.meta.url));
    const featureDefinition = fileURLToPath(
      new URL('../../src/util/node-features.ts', import.meta.url)
    );
    for (const path of sourceFiles(sourceDirectory)) {
      if (path === featureDefinition || basename(path) === 'node-features.ts') continue;
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toContain('FEATURE_DEMO');
      expect(source, path).not.toContain('__feature-demo__');
      expect(source, path).not.toContain('supportsNodeFeature');
    }
  });
});
