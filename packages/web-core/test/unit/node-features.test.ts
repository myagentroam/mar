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
  it('registers the reserved example and required post-baseline features', () => {
    expect(NODE_FEATURES).toMatchObject({
      'prompt-completion': { introducedIn: '0.10.21' },
      [FEATURE_DEMO]: { introducedIn: '0.9.119' },
      WORKSPACE_INDEX_PREPARATION: { introducedIn: '0.9.143' }
    });
    expect(supportsNodeFeature('0.9.119', FEATURE_DEMO)).toBe(true);
    expect(supportsNodeFeature('0.10.25', 'MAR_AGENT_AUTO')).toBe(true);
    expect(supportsNodeFeature('0.10.33', 'SESSION_PROMPT')).toBe(true);
    for (const version of ['0.10.32', '', 'unknown', '0.10.33-beta.1', '00.10.33'])
      expect(supportsNodeFeature(version, 'SESSION_PROMPT')).toBe(false);
    expect(supportsNodeFeature('0.10.24', 'MAR_AGENT_AUTO')).toBe(false);
    expect(supportsNodeFeature('0.9.118', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('unknown', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('0.9.120-beta.1', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('0.9.119', 'unknown-feature')).toBe(false);
    expect(supportsNodeFeature('0.9.143', 'WORKSPACE_INDEX_PREPARATION')).toBe(true);
    for (const version of ['0.9.142', 'unknown', '0.9.143-beta.1'])
      expect(supportsNodeFeature(version, 'WORKSPACE_INDEX_PREPARATION')).toBe(false);
    expect(supportsNodeFeature('0.10.21', 'prompt-completion')).toBe(true);
    for (const version of ['0.10.20', '', 'unknown', '0.10.21-beta.1', '00.10.21'])
      expect(supportsNodeFeature(version, 'prompt-completion')).toBe(false);
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
    }
  });
});
