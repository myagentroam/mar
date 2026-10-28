import { rangeAtColumn, sourceLineAt } from '../source-ranges.js';
import { type FileSpecifierParser, type NavigationSyntaxDefinition } from '../types.js';

function find(source: string, position: number) {
  const line = sourceLineAt(source, position);
  const match =
    /^\s*(?:from\s+((?:(?:\.+)?[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*)|\.+)\s+import\b|import\s+([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*))/u.exec(
      line.text
    );
  return rangeAtColumn(
    line.text,
    line.column,
    match,
    match?.[1] ?? match?.[2],
    {
      languageId: 'python',
      extractorId: 'python.import',
      kind: (match?.[1] ?? match?.[2] ?? '').startsWith('.') ? 'relative-file' : 'namespace'
    },
    line.from
  );
}

export const pythonFileSpecifierParser: FileSpecifierParser = { find };

export const pythonNavigationSyntaxDefinition = {
  hyphenSeparatesSymbol: true,
  id: 'python',
  parser: pythonFileSpecifierParser,
  suffixes: ['.py', '.pyw']
} satisfies NavigationSyntaxDefinition;
