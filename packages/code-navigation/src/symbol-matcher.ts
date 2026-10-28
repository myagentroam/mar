import type { SymbolNavigationLanguageDefinition } from './types.js';
import { symbolNavigationMaps } from './symbol-maps.js';

let compiled:
  | readonly {
      readonly language: SymbolNavigationLanguageDefinition;
      readonly patterns: readonly RegExp[];
    }[]
  | undefined;

export function symbolNavigationLanguageForPath(
  path: string
): SymbolNavigationLanguageDefinition | undefined {
  const name = basename(path);
  return compiledLanguages().find((entry) => entry.patterns.some((pattern) => pattern.test(name)))
    ?.language;
}

export function supportsSymbolNavigationPath(path: string): boolean {
  const name = basename(path);
  return compiledLanguages().some((entry) => entry.patterns.some((pattern) => pattern.test(name)));
}

export function symbolNavigationLanguages(): readonly SymbolNavigationLanguageDefinition[] {
  return symbolNavigationMaps;
}

function compiledLanguages(): readonly {
  readonly language: SymbolNavigationLanguageDefinition;
  readonly patterns: readonly RegExp[];
}[] {
  return (compiled ??= symbolNavigationMaps.map((language) => ({
    language,
    patterns: language.fileNamePatterns.map((pattern) => globPattern(pattern))
  })));
}

function globPattern(value: string): RegExp {
  let expression = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '*') {
      expression += '.*';
      continue;
    }
    if (character === '?') {
      expression += '.';
      continue;
    }
    if (character === '[') {
      const close = value.indexOf(']', index + 1);
      if (close >= 0) {
        expression += value.slice(index, close + 1);
        index = close;
        continue;
      }
    }
    expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  }
  return new RegExp(`^${expression}$`, 'iu');
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
