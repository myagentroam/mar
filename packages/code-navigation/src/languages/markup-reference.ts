import type { FileReference, FileSpecifierParser, NavigationLanguageId } from '../types.js';
import { localWorkspaceFileTarget } from './file-target.js';

const markupAttribute = /(?:^|[\s<])(?:src|href)\s*=\s*(["'])([^"'\r\n]+)\1/giu;

export function createMarkupFileSpecifierParser(
  languageId: Extract<NavigationLanguageId, 'html' | 'vue'>
): FileSpecifierParser {
  return {
    find: (source, position) => findMarkupReference(source, position, languageId)
  };
}

export function findMarkupReference(
  source: string,
  position: number,
  languageId: Extract<NavigationLanguageId, 'html' | 'vue'>
): FileReference | undefined {
  for (const match of source.matchAll(markupAttribute)) {
    const value = match[2];
    if (value === undefined) continue;
    const target = localWorkspaceFileTarget(value);
    const from = (match.index ?? 0) + match[0].indexOf(value);
    if (target === undefined || position < from || position >= from + value.length) continue;
    return {
      value: target,
      from,
      to: from + value.length,
      languageId,
      extractorId: `${languageId}.attribute`,
      kind: 'relative-file'
    };
  }
  return undefined;
}
