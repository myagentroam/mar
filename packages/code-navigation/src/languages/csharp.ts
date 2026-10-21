import {
  rangeAtColumn,
  sourceLineAt,
  type FileSpecifierParser,
  type NavigationSyntaxDefinition
} from '../types.js';

const usingDirective =
  /^\s*(?:global\s+)?using\s+(?:(?:static\s+)|(?:[\p{L}_][\p{L}\p{N}_]*\s*=\s*))?([\p{L}_\p{Nl}][\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}]*(?:\.[\p{L}_\p{Nl}][\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}]*)*)\s*;/u;

function find(source: string, position: number) {
  const line = sourceLineAt(source, position);
  const match = usingDirective.exec(line.text);
  return rangeAtColumn(
    line.text,
    line.column,
    match,
    match?.[1],
    {
      languageId: 'csharp',
      extractorId: 'csharp.using',
      kind: 'namespace'
    },
    line.from
  );
}

export const csharpFileSpecifierParser: FileSpecifierParser = { find };

export const csharpNavigationSyntaxDefinition = {
  id: 'csharp',
  parser: csharpFileSpecifierParser,
  suffixes: ['.cs']
} satisfies NavigationSyntaxDefinition;
