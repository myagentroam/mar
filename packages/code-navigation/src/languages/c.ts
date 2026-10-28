import { type NavigationSyntaxDefinition } from '../types.js';
import { createCPreprocessorFileSpecifierParser } from './c-preprocessor.js';

export const cFileSpecifierParser = createCPreprocessorFileSpecifierParser('c');

export const cNavigationSyntaxDefinition = {
  hyphenSeparatesSymbol: true,
  id: 'c',
  parser: cFileSpecifierParser,
  suffixes: ['.c']
} satisfies NavigationSyntaxDefinition;
