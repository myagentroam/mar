import type { FileSpecifierParser, FileReference, NavigationSyntaxDefinition } from '../types.js';

const staticImport =
  /(?:^|[;\r\n])\s*import\s+(?:(?:[^;'"`]*?)\s+from\s+)?(['"])([A-Za-z0-9_@./$-]+)\1/dgu;
const staticExport = /(?:^|[;\r\n])\s*export\s+[^;'"`]*?\s+from\s+(['"])([A-Za-z0-9_@./$-]+)\1/dgu;

function find(line: string, column: number): FileReference | undefined {
  for (const [extractorId, expression] of [
    ['ecmascript.dynamic-module', /\bimport\s*\(\s*(['"])([A-Za-z0-9_@./$-]+)\1\s*\)/dgu],
    ['ecmascript.require', /\brequire\s*\(\s*(['"])([A-Za-z0-9_@./$-]+)\1\s*\)/dgu],
    [
      'typescript.reference-path',
      /\/\/\/\s*<reference\s+path\s*=\s*(['"])([A-Za-z0-9_@./$-]+)\1\s*\/?>/dgu
    ],
    [
      'ecmascript.import-meta-url',
      /\bnew\s+URL\s*\(\s*(['"])(\.[A-Za-z0-9_@./$-]*)\1\s*,\s*import\.meta\.url\s*\)/dgu
    ],
    ['ecmascript.static-module', staticImport],
    ['ecmascript.static-module', staticExport]
  ] as const) {
    for (const match of line.matchAll(expression)) {
      const value = match[2];
      const range = match.indices?.[2];
      if (value === undefined || range === undefined) continue;
      const [from, to] = range;
      if (column < from || column >= to) continue;
      return {
        value,
        from,
        to,
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
