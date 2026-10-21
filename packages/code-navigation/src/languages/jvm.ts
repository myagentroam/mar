import {
  rangeAtColumn,
  sourceLineAt,
  type FileSpecifierParser,
  type NavigationSyntaxDefinition
} from '../types.js';

function find(source: string, position: number) {
  const line = sourceLineAt(source, position);
  const match =
    /^\s*import\s+(?:static\s+)?([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)+)\s*;?/u.exec(
      line.text
    );
  return rangeAtColumn(
    line.text,
    line.column,
    match,
    match?.[1],
    {
      languageId: 'jvm',
      extractorId: 'jvm.import',
      kind: 'namespace'
    },
    line.from
  );
}

export const jvmFileSpecifierParser: FileSpecifierParser = { find };

export const jvmNavigationSyntaxDefinition = {
  id: 'jvm',
  parser: jvmFileSpecifierParser,
  suffixes: ['.java', '.kt', '.kts']
} satisfies NavigationSyntaxDefinition;
