import type { FileReference, FileSpecifierParser, NavigationLanguageId } from '../types.js';
import { localWorkspaceFileTarget } from './file-target.js';

const stylesheetImport =
  /@(?:import|use|forward)\b(?:\s+\([^)]*\))?\s+(?:url\(\s*)?(["'])([^"'\r\n]+)\1\s*\)?/giu;
const stylesheetUrl = /\burl\(\s*(["']?)([^"'()\s\r\n]+)\1\s*\)/giu;

export function createStylesheetFileSpecifierParser(
  languageId: Extract<NavigationLanguageId, 'css' | 'scss' | 'sass' | 'less'>
): FileSpecifierParser {
  return {
    find: (source, position) => findStylesheetReference(source, position, languageId)
  };
}

export function findStylesheetReference(
  source: string,
  position: number,
  languageId: Extract<NavigationLanguageId, 'css' | 'scss' | 'sass' | 'less' | 'vue'>
): FileReference | undefined {
  for (const [expression, extractor] of [
    [stylesheetImport, 'import'],
    [stylesheetUrl, 'url']
  ] as const) {
    expression.lastIndex = 0;
    for (const match of source.matchAll(expression)) {
      const value = match[2];
      if (value === undefined) continue;
      const target = localWorkspaceFileTarget(value);
      const from = (match.index ?? 0) + match[0].indexOf(value);
      if (
        target === undefined ||
        position < from ||
        position >= from + value.length ||
        (extractor === 'url' && /^\s*@(?:import|use|forward)\b/iu.test(match[0]))
      )
        continue;
      return {
        value: target,
        from,
        to: from + value.length,
        languageId,
        extractorId: `${languageId}.${extractor}`,
        kind: 'relative-file'
      };
    }
  }
  return undefined;
}
