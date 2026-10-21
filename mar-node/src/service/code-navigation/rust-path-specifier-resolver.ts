import { posix } from 'node:path';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';
import type { PathSpecifierResolver } from './path-specifier-resolver.js';

function accepts(value: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || /^(?:\.\.?\/)?[A-Za-z0-9_./-]+\.rs$/u.test(value)
  );
}

function matches(path: string, currentPath: string, specifier: string): boolean {
  return candidates(currentPath, specifier).includes(path);
}

function score(path: string, currentPath: string, specifier: string): number {
  const index = candidates(currentPath, specifier).indexOf(path);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function candidates(currentPath: string, specifier: string): readonly string[] {
  const directory = posix.dirname(currentPath);
  if (specifier.endsWith('.rs')) {
    const resolved = posix.normalize(posix.join(directory, specifier));
    return resolved.startsWith('../') || resolved === '..' ? [] : [resolved];
  }
  const base = directory === '.' ? specifier : `${directory}/${specifier}`;
  return [`${base}.rs`, `${base}/mod.rs`];
}

export const rustPathSpecifierResolver: PathSpecifierResolver = {
  id: 'rust.path-specifier',
  accepts,
  directCandidates: candidates,
  matches,
  score
};

export const rustNavigationResolutionDefinition = {
  languageId: 'rust',
  resolver: rustPathSpecifierResolver
} satisfies NavigationResolutionDefinition;
