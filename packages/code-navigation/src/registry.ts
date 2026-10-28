import { cNavigationSyntaxDefinition } from './languages/c.js';
import { cFamilyNavigationSyntaxDefinition } from './languages/c-family.js';
import { cppNavigationSyntaxDefinition } from './languages/cpp.js';
import { csharpNavigationSyntaxDefinition } from './languages/csharp.js';
import { cssNavigationSyntaxDefinition } from './languages/css.js';
import { ecmascriptNavigationSyntaxDefinition } from './languages/ecmascript.js';
import { goNavigationSyntaxDefinition } from './languages/go.js';
import { htmlNavigationSyntaxDefinition } from './languages/html.js';
import { jvmNavigationSyntaxDefinition } from './languages/jvm.js';
import { lessNavigationSyntaxDefinition } from './languages/less.js';
import { markdownNavigationSyntaxDefinition } from './languages/markdown.js';
import { objectiveCNavigationSyntaxDefinition } from './languages/objective-c.js';
import { objectiveCppNavigationSyntaxDefinition } from './languages/objective-cpp.js';
import { pythonNavigationSyntaxDefinition } from './languages/python.js';
import { rustNavigationSyntaxDefinition } from './languages/rust.js';
import { sassNavigationSyntaxDefinition } from './languages/sass.js';
import { scssNavigationSyntaxDefinition } from './languages/scss.js';
import { vueNavigationSyntaxDefinition } from './languages/vue.js';
import type { NavigationSyntaxDefinition } from './types.js';

const languages: readonly NavigationSyntaxDefinition[] = [
  cssNavigationSyntaxDefinition,
  ecmascriptNavigationSyntaxDefinition,
  goNavigationSyntaxDefinition,
  htmlNavigationSyntaxDefinition,
  jvmNavigationSyntaxDefinition,
  csharpNavigationSyntaxDefinition,
  lessNavigationSyntaxDefinition,
  markdownNavigationSyntaxDefinition,
  pythonNavigationSyntaxDefinition,
  sassNavigationSyntaxDefinition,
  scssNavigationSyntaxDefinition,
  cNavigationSyntaxDefinition,
  cppNavigationSyntaxDefinition,
  objectiveCNavigationSyntaxDefinition,
  objectiveCppNavigationSyntaxDefinition,
  cFamilyNavigationSyntaxDefinition,
  rustNavigationSyntaxDefinition,
  vueNavigationSyntaxDefinition
];

export function navigationLanguageForPath(
  path: string,
  source?: string
): NavigationSyntaxDefinition | undefined {
  const normalized = path.toLowerCase();
  const candidates = languages.filter((language) =>
    language.suffixes.some((suffix) => normalized.endsWith(suffix))
  );
  if (candidates.length <= 1) return candidates[0];
  const probed =
    source === undefined ? [] : candidates.filter((candidate) => candidate.probe?.(source));
  if (probed.length === 1) return probed[0];
  return candidates.find((candidate) => candidate.fallbackForAmbiguousSuffix);
}

export function fileSpecifierParser(path: string, source?: string) {
  return navigationLanguageForPath(path, source)?.parser;
}

export function navigationLanguages(): readonly NavigationSyntaxDefinition[] {
  return languages;
}

export function navigationSymbolAt(
  path: string,
  source: string,
  position: number
): { readonly value: string; readonly from: number; readonly to: number } | undefined {
  const expression = hyphenSeparatesNavigationSymbol(path)
    ? /[\p{L}_$][\p{L}\p{N}_$]*/gu
    : /-*[\p{L}_$][\p{L}\p{N}_$-]*/gu;
  for (const candidate of source.matchAll(expression)) {
    const value = candidate[0];
    const from = candidate.index ?? 0;
    if (position >= from && position < from + value.length)
      return { value, from, to: from + value.length };
  }
  return undefined;
}

export function isNavigationSymbol(path: string, value: string): boolean {
  return (
    value.length > 0 && value.length <= 512 && navigationSymbolAt(path, value, 0)?.value === value
  );
}

export function hyphenSeparatesNavigationSymbol(path: string): boolean {
  return navigationLanguageForPath(path)?.hyphenSeparatesSymbol ?? false;
}
