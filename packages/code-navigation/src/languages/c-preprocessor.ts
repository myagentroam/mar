import {
  rangeAtColumn,
  sourceLineAt,
  type FileSpecifierParser,
  type NavigationLanguageId
} from '../types.js';

export function createCPreprocessorFileSpecifierParser(
  languageId: Extract<
    NavigationLanguageId,
    'c' | 'cpp' | 'objective-c' | 'objective-cpp' | 'c-family'
  >
): FileSpecifierParser {
  return {
    find(source: string, position: number) {
      const line = preprocessorDirectiveAt(source, position);
      const match = /^\s*#\s*(?:include|import)\s*(?:\\\s*)*(?:"([^"\r\n]+)"|<([^>\r\n]+)>)/iu.exec(
        line.text
      );
      const value = match?.[1] ?? match?.[2];
      return rangeAtColumn(
        line.text,
        line.column,
        match,
        value,
        {
          languageId,
          extractorId: `${languageId}.include`,
          kind: 'include'
        },
        line.from
      );
    }
  };
}

function preprocessorDirectiveAt(
  source: string,
  position: number
): { readonly text: string; readonly column: number; readonly from: number } {
  const current = sourceLineAt(source, position);
  let from = current.from;
  while (from > 0) {
    const previous = sourceLineAt(source, from - 1);
    if (!previous.text.trimEnd().endsWith('\\')) break;
    from = previous.from;
  }
  return {
    text: source.slice(from, current.from + current.text.length),
    column: position - from,
    from
  };
}
