import {
  matchesPathSuffix,
  shortestPathScore,
  type PathSpecifierResolver
} from './path-specifier-resolver.js';
import { posix } from 'node:path';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';

function accepts(value: string): boolean {
  return (
    /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(value) ||
    /^\.+(?:[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*)?$/u.test(value)
  );
}

function matches(path: string, currentPath: string, specifier: string): boolean {
  return candidates(currentPath, specifier).some((candidate) => matchesPathSuffix(path, candidate));
}

function directCandidates(currentPath: string, specifier: string): readonly string[] {
  return specifier.startsWith('.') ? candidates(currentPath, specifier) : [];
}

function candidates(currentPath: string, specifier: string): readonly string[] {
  const packagePath = relativePackagePath(currentPath, specifier);
  if (packagePath === undefined) return [];
  return packagePath === '.'
    ? ['__init__.py']
    : [`${packagePath}.py`, `${packagePath}.pyw`, `${packagePath}/__init__.py`];
}

function relativePackagePath(currentPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return specifier.replaceAll('.', '/');
  const levels = specifier.match(/^\.+/u)?.[0].length ?? 0;
  const module = specifier.slice(levels).replaceAll('.', '/');
  const base = posix.normalize(
    posix.join(posix.dirname(currentPath), ...Array.from({ length: levels - 1 }, () => '..'))
  );
  if (base === '..' || base.startsWith('../')) return undefined;
  return module.length === 0 ? base : posix.join(base, module);
}

export const pythonPathSpecifierResolver: PathSpecifierResolver = {
  id: 'python.path-specifier',
  accepts,
  directCandidates,
  matches,
  score: shortestPathScore
};

export const pythonNavigationResolutionDefinition = {
  languageId: 'python',
  resolver: pythonPathSpecifierResolver
} satisfies NavigationResolutionDefinition;
