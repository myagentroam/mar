import { type NavigationSyntaxDefinition } from '../types.js';
import { createStylesheetFileSpecifierParser } from './stylesheet-reference.js';

export const cssNavigationSyntaxDefinition = {
  id: 'css',
  parser: createStylesheetFileSpecifierParser('css'),
  suffixes: ['.css']
} satisfies NavigationSyntaxDefinition;
