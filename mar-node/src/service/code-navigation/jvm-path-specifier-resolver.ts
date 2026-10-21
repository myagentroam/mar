import { matchesPathSuffix, type PathSpecifierResolver } from './path-specifier-resolver.js';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';

function accepts(value: string): boolean {
  return /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)+$/u.test(value);
}

function matches(path: string, _currentPath: string, specifier: string): boolean {
  return candidates(specifier).some((candidate) => matchesPathSuffix(path, candidate));
}

function score(path: string, _currentPath: string, specifier: string): number {
  const exact = candidates(specifier).findIndex((candidate) => matchesPathSuffix(path, candidate));
  return exact < 0 ? Number.MAX_SAFE_INTEGER : exact * 10_000 + path.length;
}

function candidates(specifier: string): readonly string[] {
  const segments = specifier.split('.');
  return segments.flatMap((_, index) => {
    const value = segments.slice(0, segments.length - index).join('/');
    return ['.java', '.kt', '.kts'].map((suffix) => `${value}${suffix}`);
  });
}

export const jvmPathSpecifierResolver: PathSpecifierResolver = {
  id: 'jvm.path-specifier',
  accepts,
  matches,
  score
};

export const jvmNavigationResolutionDefinition = {
  languageId: 'jvm',
  resolver: jvmPathSpecifierResolver
} satisfies NavigationResolutionDefinition;
