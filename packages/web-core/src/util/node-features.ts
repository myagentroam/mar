export type NodeFeature = string;

export interface NodeFeatureVersionRange {
  readonly introducedIn: string;
  readonly removedIn?: string;
}

/** Reserved example only; business code must register and query real post-baseline features. */
export const FEATURE_DEMO = '__feature-demo__';
export const SESSION_ASIDE = 'sessionAside';

export const NODE_FEATURES: Readonly<Record<string, NodeFeatureVersionRange>> = {
  [FEATURE_DEMO]: { introducedIn: '0.9.119' },
  [SESSION_ASIDE]: { introducedIn: '0.11.69' }
};

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return undefined;
  const version = match.slice(1).map(Number);
  if (!version.every(Number.isSafeInteger)) return undefined;
  return version as [number, number, number];
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

export function isNodeVersionInFeatureRange(
  nodeAppVersion: string,
  range: NodeFeatureVersionRange
): boolean {
  const version = parseVersion(nodeAppVersion);
  const introducedIn = parseVersion(range.introducedIn);
  const removedIn = range.removedIn === undefined ? undefined : parseVersion(range.removedIn);
  if (
    version === undefined ||
    introducedIn === undefined ||
    (range.removedIn !== undefined && removedIn === undefined)
  )
    return false;
  if (compareVersions(version, introducedIn) < 0) return false;
  return removedIn === undefined || compareVersions(version, removedIn) < 0;
}

export function supportsNodeFeature(nodeAppVersion: string, feature: string): boolean {
  const range = NODE_FEATURES[feature as NodeFeature];
  return range !== undefined && isNodeVersionInFeatureRange(nodeAppVersion, range);
}

export function supportsSessionAside(
  nodeAppVersion: string | undefined,
  capability: { readonly apiVersion: number } | undefined
): boolean {
  return (
    nodeAppVersion !== undefined &&
    capability?.apiVersion === 1 &&
    supportsNodeFeature(nodeAppVersion, SESSION_ASIDE)
  );
}
