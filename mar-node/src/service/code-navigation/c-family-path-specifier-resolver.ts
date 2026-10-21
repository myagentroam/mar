import { posix } from 'node:path';
import type { NavigationLanguageId } from '@myagentroam/code-navigation';
import { matchesPathSuffix, type PathSpecifierResolver } from './path-specifier-resolver.js';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';

function accepts(value: string): boolean {
  return /^(?:\.\.?\/)?(?:[A-Za-z0-9_$+.-]+\/)*[A-Za-z0-9_$+.-]+$/u.test(value);
}

function matches(path: string, currentPath: string, specifier: string): boolean {
  return candidates(currentPath, specifier).some(
    (candidate) => path === candidate || matchesPathSuffix(path, candidate)
  );
}

function score(path: string, currentPath: string, specifier: string): number {
  const resolvedCandidates = candidates(currentPath, specifier);
  const exact = resolvedCandidates.indexOf(path);
  if (exact >= 0) return exact;
  const suffix = resolvedCandidates.findIndex((candidate) => matchesPathSuffix(path, candidate));
  return suffix >= 0 ? resolvedCandidates.length + suffix + path.length : Number.MAX_SAFE_INTEGER;
}

function candidates(currentPath: string, specifier: string): readonly string[] {
  const relative = posix.normalize(posix.join(posix.dirname(currentPath), specifier));
  if (relative.startsWith('../') || relative === '..' || relative === specifier) return [specifier];
  return [relative.replace(/^\.\//u, ''), specifier];
}

export const cFamilyPathSpecifierResolver: PathSpecifierResolver = {
  id: 'c-family.path-specifier',
  accepts,
  directCandidates: candidates,
  matches,
  score
};

function createCFamilyNavigationResolutionDefinition(
  languageId: Extract<
    NavigationLanguageId,
    'c' | 'cpp' | 'objective-c' | 'objective-cpp' | 'c-family'
  >
): NavigationResolutionDefinition {
  return {
    languageId,
    resolver: { ...cFamilyPathSpecifierResolver, id: `${languageId}.path-specifier` }
  };
}

export const cNavigationResolutionDefinition = createCFamilyNavigationResolutionDefinition('c');
export const cppNavigationResolutionDefinition = createCFamilyNavigationResolutionDefinition('cpp');
export const objectiveCNavigationResolutionDefinition =
  createCFamilyNavigationResolutionDefinition('objective-c');
export const objectiveCppNavigationResolutionDefinition =
  createCFamilyNavigationResolutionDefinition('objective-cpp');
export const cFamilyNavigationResolutionDefinition =
  createCFamilyNavigationResolutionDefinition('c-family');
