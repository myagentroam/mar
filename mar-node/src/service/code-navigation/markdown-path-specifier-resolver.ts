import { posix } from 'node:path';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';
import type { PathSpecifierResolver } from './path-specifier-resolver.js';

function accepts(value: string): boolean {
  return value === '.' || /^(?:\.\.?\/)?[A-Za-z0-9_./$+ -]+$/u.test(value);
}

function matches(path: string, currentPath: string, specifier: string): boolean {
  return candidates(currentPath, specifier).includes(path);
}

function score(path: string, currentPath: string, specifier: string): number {
  const index = candidates(currentPath, specifier).indexOf(path);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function candidates(currentPath: string, specifier: string): readonly string[] {
  if (specifier === '.') return [currentPath];
  const resolved = posix.normalize(posix.join(posix.dirname(currentPath), specifier));
  if (resolved === '..' || resolved.startsWith('../')) return [];
  const path = resolved.replace(/^\.\//u, '');
  return path.includes('.')
    ? [path]
    : [path, `${path}.md`, `${path}.markdown`, `${path}/README.md`, `${path}/readme.md`];
}

export function markdownAnchorLine(source: string, anchor: string): number | undefined {
  const requested = markdownAnchorSlug(anchor);
  if (requested === '') return undefined;
  const counts = new Map<string, number>();
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = markdownHeading(lines, index);
    if (heading === undefined) continue;
    const base = markdownAnchorSlug(heading.text);
    if (base === '') continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;
    if (slug === requested) return heading.line;
  }
  return undefined;
}

function markdownHeading(
  lines: readonly string[],
  index: number
): { readonly text: string; readonly line: number } | undefined {
  const atx = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(lines[index] ?? '');
  if (atx !== null) return { text: atx[1]!, line: index + 1 };
  const underline = /^[ \t]{0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1] ?? '');
  return underline && (lines[index] ?? '').trim().length > 0
    ? { text: lines[index]!, line: index + 1 }
    : undefined;
}

function markdownAnchorSlug(value: string): string {
  return decodeURIComponentSafe(value)
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/gu, '')
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .replace(/[\s-]+/gu, '-');
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const markdownPathSpecifierResolver: PathSpecifierResolver = {
  id: 'markdown.path-specifier',
  accepts,
  directCandidates: candidates,
  matches,
  score,
  anchorLine: markdownAnchorLine
};

export const markdownNavigationResolutionDefinition = {
  languageId: 'markdown',
  resolver: markdownPathSpecifierResolver
} satisfies NavigationResolutionDefinition;
