import { type NavigationSyntaxDefinition } from '../types.js';
import { createStylesheetFileSpecifierParser } from './stylesheet-reference.js';

export const scssNavigationSyntaxDefinition = {
  hyphenSeparatesSymbol: false,
  id: 'scss',
  parser: createStylesheetFileSpecifierParser('scss'),
  suffixes: ['.scss']
} satisfies NavigationSyntaxDefinition;
