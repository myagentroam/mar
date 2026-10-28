import { rangeAtColumn, sourceLineAt } from '../source-ranges.js';
import { type FileSpecifierParser, type NavigationSyntaxDefinition } from '../types.js';

const importPath = /^\s*(?:[._]|[\p{L}_][\p{L}\p{N}_]*)?\s*"([^"\r\n]+)"\s*;?\s*$/u;
const singleImport = /^\s*import\s+(?:[._]|[\p{L}_][\p{L}\p{N}_]*)?\s*"([^"\r\n]+)"\s*;?\s*$/u;

function find(source: string, position: number) {
  const line = sourceLineAt(source, position);
  const match =
    singleImport.exec(line.text) ??
    (isWithinImportBlock(source, line.from) ? importPath.exec(line.text) : null);
  return rangeAtColumn(
    line.text,
    line.column,
    match,
    match?.[1],
    {
      languageId: 'go',
      extractorId: 'go.import',
      kind: 'module'
    },
    line.from
  );
}

function isWithinImportBlock(source: string, lineStart: number): boolean {
  let withinImportBlock = false;
  for (const line of source.slice(0, lineStart).split(/\r?\n/u)) {
    if (/^\s*import\s*\(\s*(?:\/\/.*)?$/u.test(line)) {
      withinImportBlock = true;
      continue;
    }
    if (withinImportBlock && /^\s*\)\s*(?:\/\/.*)?$/u.test(line)) withinImportBlock = false;
  }
  return withinImportBlock;
}

export const goFileSpecifierParser: FileSpecifierParser = { find };

export const goNavigationSyntaxDefinition = {
  hyphenSeparatesSymbol: true,
  id: 'go',
  parser: goFileSpecifierParser,
  suffixes: ['.go']
} satisfies NavigationSyntaxDefinition;
