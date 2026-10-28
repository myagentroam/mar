const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** Current Node business baseline; recheck against the actual delivery artifact at freeze. */
export const MIN_NODE_BUSINESS_VERSION = '0.11.38';

export function compareStableVersions(left: string, right: string): number | undefined {
  const leftMatch = STABLE_VERSION.exec(left);
  const rightMatch = STABLE_VERSION.exec(right);
  if (leftMatch === null || rightMatch === null) return undefined;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}
