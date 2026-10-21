import { type NavigationSyntaxDefinition } from '../types.js';
import { createStylesheetFileSpecifierParser } from './stylesheet-reference.js';

export const sassNavigationSyntaxDefinition = {
  id: 'sass',
  parser: createStylesheetFileSpecifierParser('sass'),
  suffixes: ['.sass']
} satisfies NavigationSyntaxDefinition;
