import { posix } from 'node:path';
import type { NavigationLanguageId } from '@myagentroam/code-navigation';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';
import {
  trailingPathCandidateScore,
  type PathSpecifierResolver
} from './path-specifier-resolver.js';

type StylesheetLanguageId = Extract<
  NavigationLanguageId,
  'css' | 'scss' | 'sass' | 'less' | 'html' | 'vue'
>;

function accepts(value: string): boolean {
  return /^(?:\.\.?\/)?[A-Za-z0-9_./$+@ -]+$/u.test(value);
}

function createResolver(
  languageId: StylesheetLanguageId,
  extensions: readonly string[],
  partials = false
): PathSpecifierResolver {
  const candidates = (currentPath: string, specifier: string) =>
    pathCandidates(currentPath, specifier, extensions, partials);
  const aliasCandidates = (specifier: string) =>
    pathCandidates('', specifier.slice(2), extensions, partials);
  return {
    id: `${languageId}.path-specifier`,
    accepts,
    directCandidates: (currentPath, specifier) =>
      specifier.startsWith('@/') ? [] : candidates(currentPath, specifier),
    matches: (path, currentPath, specifier) =>
      specifier.startsWith('@/')
        ? trailingPathCandidateScore(path, aliasCandidates(specifier)) !== undefined
        : candidates(currentPath, specifier).includes(path),
    score: (path, currentPath, specifier) => {
      if (specifier.startsWith('@/'))
        return (
          trailingPathCandidateScore(path, aliasCandidates(specifier)) ?? Number.MAX_SAFE_INTEGER
        );
      const index = candidates(currentPath, specifier).indexOf(path);
      return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
    }
  };
}

function pathCandidates(
  currentPath: string,
  specifier: string,
  extensions: readonly string[],
  partials: boolean
): readonly string[] {
  const resolved = posix.normalize(posix.join(posix.dirname(currentPath), specifier));
  if (resolved === '..' || resolved.startsWith('../')) return [];
  const path = resolved.replace(/^\.\//u, '');
  if (path.slice(path.lastIndexOf('/') + 1).includes('.')) return [path];
  const base = extensions.flatMap((extension) => [
    `${path}${extension}`,
    `${path}/index${extension}`
  ]);
  if (!partials) return base;
  const directory = posix.dirname(path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  return [...base, ...extensions.map((extension) => posix.join(directory, `_${name}${extension}`))];
}

function definition(
  languageId: StylesheetLanguageId,
  extensions: readonly string[],
  partials = false
): NavigationResolutionDefinition {
  return { languageId, resolver: createResolver(languageId, extensions, partials) };
}

export const cssNavigationResolutionDefinition = definition('css', ['.css']);
export const scssNavigationResolutionDefinition = definition('scss', ['.scss', '.css'], true);
export const sassNavigationResolutionDefinition = definition(
  'sass',
  ['.sass', '.scss', '.css'],
  true
);
export const lessNavigationResolutionDefinition = definition('less', ['.less', '.css']);
export const htmlNavigationResolutionDefinition = definition('html', [
  '.html',
  '.htm',
  '.css',
  '.js'
]);
export const vueNavigationResolutionDefinition = definition('vue', [
  '.vue',
  '.html',
  '.css',
  '.scss',
  '.sass',
  '.less'
]);
