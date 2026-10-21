import { matchesPathSuffix, type PathSpecifierResolver } from './path-specifier-resolver.js';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';

function accepts(value: string): boolean {
  return /^[\p{L}_\p{Nl}][\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}]*(?:\.[\p{L}_\p{Nl}][\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}]*)*$/u.test(
    value
  );
}

function matches(path: string, _currentPath: string, specifier: string): boolean {
  if (!path.endsWith('.cs')) return false;
  return namespaceSuffixes(specifier).some(
    (suffix) =>
      matchesPathSuffix(path, `${suffix}.cs`) ||
      path.startsWith(`${suffix}/`) ||
      path.includes(`/${suffix}/`)
  );
}

function score(path: string, _currentPath: string, specifier: string): number {
  const suffixes = namespaceSuffixes(specifier);
  const index = suffixes.findIndex(
    (suffix) =>
      matchesPathSuffix(path, `${suffix}.cs`) ||
      path.startsWith(`${suffix}/`) ||
      path.includes(`/${suffix}/`)
  );
  return index < 0 ? Number.MAX_SAFE_INTEGER : index * 10_000 + path.length;
}

function namespaceSuffixes(specifier: string): readonly string[] {
  const segments = specifier.split('.');
  return segments.map((_, index) => segments.slice(index).join('/'));
}

export const csharpPathSpecifierResolver: PathSpecifierResolver = {
  id: 'csharp.path-specifier',
  accepts,
  matches,
  score
};

export const csharpNavigationResolutionDefinition = {
  languageId: 'csharp',
  resolver: csharpPathSpecifierResolver
} satisfies NavigationResolutionDefinition;
