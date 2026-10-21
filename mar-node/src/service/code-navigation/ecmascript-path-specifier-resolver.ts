import { posix } from 'node:path';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';
import {
  trailingPathCandidateScore,
  type PathSpecifierResolver
} from './path-specifier-resolver.js';

const importExtensionMappings = [
  { importExtension: '.js', sourceExtensions: ['.ts', '.tsx'] },
  { importExtension: '.jsx', sourceExtensions: ['.tsx'] },
  { importExtension: '.mjs', sourceExtensions: ['.mts'] },
  { importExtension: '.cjs', sourceExtensions: ['.cts'] }
] as const;
const extensionlessSourceExtensions = ['.ts', '.tsx', '.js', '.jsx'] as const;

function accepts(value: string): boolean {
  return (
    /^(?:\.\.?\/)[A-Za-z0-9_./$-]+$/u.test(value) ||
    /^@\/[A-Za-z0-9_./$-]+$/u.test(value) ||
    /^(?:@?[A-Za-z0-9_$-]+)(?:\/[A-Za-z0-9_.$-]+)+$/u.test(value)
  );
}

function matches(path: string, currentPath: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return unresolvedSpecifierScore(path, specifier) !== undefined;
  const resolved = resolveRelative(currentPath, specifier);
  return (
    resolved !== undefined &&
    candidates(resolved).some(
      (candidate) =>
        path === candidate ||
        path === `${candidate}/index.ts` ||
        path === `${candidate}/index.tsx` ||
        path === `${candidate}/index.js` ||
        path === `${candidate}/index.jsx`
    )
  );
}

function score(path: string, currentPath: string, specifier: string): number {
  if (!specifier.startsWith('.'))
    return unresolvedSpecifierScore(path, specifier) ?? Number.MAX_SAFE_INTEGER;
  const resolved = resolveRelative(currentPath, specifier);
  if (resolved === undefined) return Number.MAX_SAFE_INTEGER;
  const resolvedCandidates = candidates(resolved);
  const exact = resolvedCandidates.indexOf(path);
  if (exact >= 0) return exact;
  const index = resolvedCandidates.findIndex(
    (candidate) =>
      path === `${candidate}/index.ts` ||
      path === `${candidate}/index.tsx` ||
      path === `${candidate}/index.js` ||
      path === `${candidate}/index.jsx`
  );
  return index >= 0 ? resolvedCandidates.length + index : Number.MAX_SAFE_INTEGER;
}

function directCandidates(currentPath: string, specifier: string): readonly string[] {
  if (!specifier.startsWith('.')) return [];
  const resolved = resolveRelative(currentPath, specifier);
  if (resolved === undefined) return [];
  const resolvedCandidates = candidates(resolved);
  return resolvedCandidates.flatMap((candidate) => [
    candidate,
    `${candidate}/index.ts`,
    `${candidate}/index.tsx`,
    `${candidate}/index.js`,
    `${candidate}/index.jsx`
  ]);
}

function resolveRelative(currentPath: string, specifier: string): string | undefined {
  const resolved = posix.normalize(posix.join(posix.dirname(currentPath), specifier));
  if (resolved.startsWith('../') || resolved === '..') return undefined;
  return resolved.replace(/^\.\//u, '');
}

function candidates(path: string): readonly string[] {
  const mapping = importExtensionMappings.find(({ importExtension }) =>
    path.toLowerCase().endsWith(importExtension)
  );
  if (mapping !== undefined) {
    const sourceBase = path.slice(0, -mapping.importExtension.length);
    return [path, ...mapping.sourceExtensions.map((extension) => `${sourceBase}${extension}`)];
  }
  return path.slice(path.lastIndexOf('/') + 1).includes('.')
    ? [path]
    : [path, ...extensionlessSourceExtensions.map((extension) => `${path}${extension}`)];
}

function unresolvedSpecifierScore(path: string, specifier: string): number | undefined {
  const normalizedSpecifier = specifier.startsWith('@/') ? specifier.slice(2) : specifier;
  return trailingPathCandidateScore(path, unresolvedCandidates(normalizedSpecifier));
}

function unresolvedCandidates(specifier: string): readonly string[] {
  return candidates(specifier).flatMap((candidate) => [
    candidate,
    `${candidate}/index.ts`,
    `${candidate}/index.tsx`,
    `${candidate}/index.js`,
    `${candidate}/index.jsx`
  ]);
}

export const ecmascriptPathSpecifierResolver: PathSpecifierResolver = {
  id: 'ecmascript.path-specifier',
  accepts,
  directCandidates,
  matches,
  score
};

export const ecmascriptNavigationResolutionDefinition = {
  languageId: 'ecmascript',
  resolver: ecmascriptPathSpecifierResolver
} satisfies NavigationResolutionDefinition;
