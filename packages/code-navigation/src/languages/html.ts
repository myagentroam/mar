import { type NavigationSyntaxDefinition } from '../types.js';
import { createMarkupFileSpecifierParser } from './markup-reference.js';

export const htmlNavigationSyntaxDefinition = {
  hyphenSeparatesSymbol: false,
  id: 'html',
  parser: createMarkupFileSpecifierParser('html'),
  suffixes: ['.html', '.htm']
} satisfies NavigationSyntaxDefinition;
