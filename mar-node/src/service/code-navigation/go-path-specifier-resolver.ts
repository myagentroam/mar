import { matchesPathSuffix, type PathSpecifierResolver } from './path-specifier-resolver.js';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';

function accepts(value: string): boolean {
  return /^(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u.test(value);
}

function matches(path: string, _currentPath: string, specifier: string): boolean {
  if (!path.endsWith('.go')) return false;
  const directory = path.slice(0, path.lastIndexOf('/'));
  return packageSuffixes(specifier).some((suffix) => matchesPathSuffix(directory, suffix));
}

function score(path: string, _currentPath: string, specifier: string): number {
  const directory = path.slice(0, path.lastIndexOf('/'));
  const index = packageSuffixes(specifier).findIndex((suffix) =>
    matchesPathSuffix(directory, suffix)
  );
  return index < 0 ? Number.MAX_SAFE_INTEGER : index * 10_000 + path.length;
}

function packageSuffixes(specifier: string): readonly string[] {
  const segments = specifier.split('/');
  return segments.length < 2
    ? []
    : segments.slice(0, -1).map((_, index) => segments.slice(index).join('/'));
}

export const goPathSpecifierResolver: PathSpecifierResolver = {
  id: 'go.path-specifier',
  accepts,
  matches,
  score
};

export const goNavigationResolutionDefinition = {
  languageId: 'go',
  resolver: goPathSpecifierResolver
} satisfies NavigationResolutionDefinition;
