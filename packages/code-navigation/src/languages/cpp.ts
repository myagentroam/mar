import { type NavigationSyntaxDefinition } from '../types.js';
import { createCPreprocessorFileSpecifierParser } from './c-preprocessor.js';

export const cppFileSpecifierParser = createCPreprocessorFileSpecifierParser('cpp');

export const cppNavigationSyntaxDefinition = {
  id: 'cpp',
  parser: cppFileSpecifierParser,
  suffixes: ['.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
  probe: (source) =>
    !/(?:@\s*(?:interface|implementation|protocol|class|import)\b|#\s*import\b)/u.test(source) &&
    /(?:\b(?:namespace|template|constexpr|decltype)\b|\bstd\s*::|(?<!@)\bclass\s+\w+)/u.test(source)
} satisfies NavigationSyntaxDefinition;
