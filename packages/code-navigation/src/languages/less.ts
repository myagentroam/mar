import { type NavigationSyntaxDefinition } from '../types.js';
import { createStylesheetFileSpecifierParser } from './stylesheet-reference.js';

export const lessNavigationSyntaxDefinition = {
  hyphenSeparatesSymbol: false,
  id: 'less',
  parser: createStylesheetFileSpecifierParser('less'),
  suffixes: ['.less']
} satisfies NavigationSyntaxDefinition;
