import type {
  FileReference,
  FileSpecifierParser,
  NavigationLanguageId,
  NavigationSyntaxDefinition
} from '../types.js';
import { ecmascriptFileSpecifierParser } from './ecmascript.js';
import { findMarkupReference } from './markup-reference.js';
import { findStylesheetReference } from './stylesheet-reference.js';

const scriptBlock = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu;
const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu;
const styleLanguage = /\blang\s*=\s*(["'])([^"'\r\n]+)\1/iu;

function find(source: string, position: number): FileReference | undefined {
  return (
    findMarkupReference(source, position, 'vue') ??
    findEmbeddedReference(source, position, scriptBlock, ecmascriptFileSpecifierParser) ??
    findStyleReference(source, position) ??
    findReferenceWithoutBlockBoundary(source, position)
  );
}

function findReferenceWithoutBlockBoundary(
  source: string,
  position: number
): FileReference | undefined {
  const ecmascript = ecmascriptFileSpecifierParser.find(source, position);
  if (ecmascript !== undefined) return ecmascript;
  const lineFrom = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const stylesheetLanguage = /^[ \t]*@(?:use|forward)\b/iu.test(source.slice(lineFrom, position))
    ? 'scss'
    : 'vue';
  return findStylesheetReference(source, position, stylesheetLanguage);
}

function findEmbeddedReference(
  source: string,
  position: number,
  expression: RegExp,
  parser: FileSpecifierParser
): FileReference | undefined {
  expression.lastIndex = 0;
  for (const block of source.matchAll(expression)) {
    const content = block[1] ?? '';
    const contentFrom = (block.index ?? 0) + block[0].indexOf(content);
    if (position < contentFrom || position >= contentFrom + content.length) continue;
    const reference = parser.find(content, position - contentFrom);
    if (reference === undefined) continue;
    return {
      ...reference,
      from: contentFrom + reference.from,
      to: contentFrom + reference.to
    };
  }
  return undefined;
}

function findStyleReference(source: string, position: number): FileReference | undefined {
  styleBlock.lastIndex = 0;
  for (const block of source.matchAll(styleBlock)) {
    const content = block[1] ?? '';
    const contentFrom = (block.index ?? 0) + block[0].indexOf(content);
    if (position < contentFrom || position >= contentFrom + content.length) continue;
    const languageId = styleBlockLanguage(block[0]);
    if (languageId === undefined) continue;
    const reference = findStylesheetReference(content, position - contentFrom, languageId);
    if (reference === undefined) continue;
    return {
      ...reference,
      from: contentFrom + reference.from,
      to: contentFrom + reference.to
    };
  }
  return undefined;
}

function styleBlockLanguage(
  block: string
): Extract<NavigationLanguageId, 'css' | 'scss' | 'sass' | 'less'> | undefined {
  const openingTag = block.slice(0, block.indexOf('>') + 1);
  const value = styleLanguage.exec(openingTag)?.[2]?.toLowerCase();
  if (value === undefined || value === 'css') return 'css';
  return value === 'scss' || value === 'sass' || value === 'less' ? value : undefined;
}

export const vueFileSpecifierParser: FileSpecifierParser = { find };

export const vueNavigationSyntaxDefinition = {
  hyphenSeparatesSymbol: false,
  id: 'vue',
  parser: vueFileSpecifierParser,
  suffixes: ['.vue']
} satisfies NavigationSyntaxDefinition;
