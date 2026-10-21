import type { FileSpecifierParser, FileReference, NavigationSyntaxDefinition } from '../types.js';

const staticImport =
  /(?:^|[;\r\n])\s*import\s+(?:(?:[^;'"`]*?)\s+from\s+)?(['"])([A-Za-z0-9_@./$-]+)\1/gu;
const staticExport = /(?:^|[;\r\n])\s*export\s+[^;'"`]*?\s+from\s+(['"])([A-Za-z0-9_@./$-]+)\1/gu;

function find(line: string, column: number): FileReference | undefined {
  for (const [extractorId, expression] of [
    ['ecmascript.dynamic-module', /\bimport\s*\(\s*(['"])([A-Za-z0-9_@./$-]+)\1\s*\)/gu],
    ['ecmascript.require', /\brequire\s*\(\s*(['"])([A-Za-z0-9_@./$-]+)\1\s*\)/gu],
    [
      'typescript.reference-path',
      /\/\/\/\s*<reference\s+path\s*=\s*(['"])([A-Za-z0-9_@./$-]+)\1\s*\/?>/gu
    ],
    [
      'ecmascript.import-meta-url',
      /\bnew\s+URL\s*\(\s*(['"])(\.[A-Za-z0-9_@./$-]*)\1\s*,\s*import\.meta\.url\s*\)/gu
    ],
    ['ecmascript.static-module', staticImport],
    ['ecmascript.static-module', staticExport]
  ] as const) {
    for (const match of line.matchAll(expression)) {
      const value = match[2];
      const from = (match.index ?? 0) + match[0].indexOf(value ?? '');
      if (value === undefined || column < from || column >= from + value.length) continue;
      return {
        value,
        from,
        to: from + value.length,
        languageId: 'ecmascript',
        extractorId,
        kind: value.startsWith('.') ? 'relative-file' : 'module'
      };
    }
  }
  return undefined;
}

export const ecmascriptFileSpecifierParser: FileSpecifierParser = { find };

export const ecmascriptNavigationSyntaxDefinition = {
  id: 'ecmascript',
  parser: ecmascriptFileSpecifierParser,
  suffixes: ['.js', '.jsx', '.ts', '.tsx', '.mts', '.cts']
} satisfies NavigationSyntaxDefinition;
