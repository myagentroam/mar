export interface PathSpecifierResolver {
  readonly id: string;
  readonly accepts: (specifier: string) => boolean;
  readonly directCandidates?: (currentPath: string, specifier: string) => readonly string[];
  readonly matches: (path: string, currentPath: string, specifier: string) => boolean;
  readonly score: (path: string, currentPath: string, specifier: string) => number;
  readonly anchorLine?: (source: string, anchor: string) => number | undefined;
}

export function matchesPathSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`/${suffix}`);
}

export function shortestPathScore(path: string): number {
  return path.length;
}

export function trailingPathCandidateScore(
  path: string,
  candidates: readonly string[]
): number | undefined {
  let best: number | undefined;
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const pathSegments = path.split('/');
    const candidateSegments = candidate.split('/');
    let matchedSegments = 0;
    while (
      matchedSegments < pathSegments.length &&
      matchedSegments < candidateSegments.length &&
      pathSegments[pathSegments.length - matchedSegments - 1] ===
        candidateSegments[candidateSegments.length - matchedSegments - 1]
    )
      matchedSegments += 1;
    if (matchedSegments === 0) continue;
    const unmatchedSegments = candidateSegments.length - matchedSegments;
    const leadingPathSegments = pathSegments.length - matchedSegments;
    const candidateScore = unmatchedSegments * 10_000 + candidateIndex * 100 + leadingPathSegments;
    best = best === undefined ? candidateScore : Math.min(best, candidateScore);
  }
  return best;
}
