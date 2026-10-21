import { describe, expect, it } from 'vitest';
import {
  NODE_FEATURES,
  isNodeVersionInFeatureRange,
  supportsNodeFeature
} from '../../ee/web/src/util/node-features.js';
import { FEATURE_DEMO } from '../../packages/web-core/src/util/node-features.js';

describe('Web Node feature version gates', () => {
  it('Preserves the reserved example and real Workspace index preparation gate', () => {
    expect(NODE_FEATURES).toEqual({
      [FEATURE_DEMO]: { introducedIn: '0.9.119' },
      WORKSPACE_INDEX_PREPARATION: { introducedIn: '0.9.143' }
    });
    expect(supportsNodeFeature('0.9.142', 'WORKSPACE_INDEX_PREPARATION')).toBe(false);
    expect(supportsNodeFeature('0.9.143', 'WORKSPACE_INDEX_PREPARATION')).toBe(true);
    expect(supportsNodeFeature('0.10.1', 'WORKSPACE_INDEX_PREPARATION')).toBe(true);
    expect(supportsNodeFeature('0.9.118', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('0.9.119', FEATURE_DEMO)).toBe(true);
    expect(supportsNodeFeature('0.9.120', FEATURE_DEMO)).toBe(true);
    expect(supportsNodeFeature('unknown', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('0.9.119-beta.1', FEATURE_DEMO)).toBe(false);
    expect(supportsNodeFeature('0.9.120', 'future.feature')).toBe(false);
  });

  it('Permanent features activate at and after their declared introduction version', () => {
    expect(isNodeVersionInFeatureRange('0.1.2', { introducedIn: '0.1.3' })).toBe(false);
    expect(isNodeVersionInFeatureRange('0.1.3', { introducedIn: '0.1.3' })).toBe(true);
    expect(isNodeVersionInFeatureRange('0.2.0', { introducedIn: '0.1.3' })).toBe(true);
  });

  it('Deprecated features use inclusive lower and exclusive upper version bounds', () => {
    expect(
      isNodeVersionInFeatureRange('0.1.3', { introducedIn: '0.1.3', removedIn: '0.1.5' })
    ).toBe(true);
    expect(
      isNodeVersionInFeatureRange('0.1.5', { introducedIn: '0.1.4', removedIn: '0.1.5' })
    ).toBe(false);
  });

  it('Unknown, prerelease, and invalid versions conservatively disable features', () => {
    for (const version of ['', 'unknown', '0.1', '0.1.3-beta.1', '01.1.3', '0.1.3.1']) {
      expect(isNodeVersionInFeatureRange(version, { introducedIn: '0.1.3' })).toBe(false);
    }
  });
});
