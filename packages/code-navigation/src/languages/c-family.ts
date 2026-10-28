import { type NavigationSyntaxDefinition } from '../types.js';
import { createCPreprocessorFileSpecifierParser } from './c-preprocessor.js';

export const cFamilyFileSpecifierParser = createCPreprocessorFileSpecifierParser('c-family');

export const cFamilyNavigationSyntaxDefinition = {
  hyphenSeparatesSymbol: true,
  id: 'c-family',
  parser: cFamilyFileSpecifierParser,
  suffixes: ['.h', '.m'],
  fallbackForAmbiguousSuffix: true
} satisfies NavigationSyntaxDefinition;
