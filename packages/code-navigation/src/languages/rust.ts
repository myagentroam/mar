import {
  rangeAtColumn,
  sourceLineAt,
  type FileSpecifierParser,
  type NavigationSyntaxDefinition
} from '../types.js';

function find(source: string, position: number) {
  const line = sourceLineAt(source, position);
  const match =
    /^\s*(?:#\s*\[\s*path\s*=\s*["']([^"']+)["']\s*\]\s*)?(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/u.exec(
      line.text
    );
  const value = match?.[1] ?? match?.[2];
  return rangeAtColumn(
    line.text,
    line.column,
    match,
    value,
    {
      languageId: 'rust',
      extractorId: match?.[1] === undefined ? 'rust.module' : 'rust.path-module',
      kind: match?.[1] === undefined ? 'module' : 'relative-file'
    },
    line.from
  );
}

export const rustFileSpecifierParser: FileSpecifierParser = { find };

export const rustNavigationSyntaxDefinition = {
  id: 'rust',
  parser: rustFileSpecifierParser,
  suffixes: ['.rs']
} satisfies NavigationSyntaxDefinition;
