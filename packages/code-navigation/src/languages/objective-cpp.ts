import { type NavigationSyntaxDefinition } from '../types.js';
import { createCPreprocessorFileSpecifierParser } from './c-preprocessor.js';

export const objectiveCppFileSpecifierParser =
  createCPreprocessorFileSpecifierParser('objective-cpp');

export const objectiveCppNavigationSyntaxDefinition = {
  id: 'objective-cpp',
  parser: objectiveCppFileSpecifierParser,
  suffixes: ['.mm', '.h'],
  probe: (source) =>
    /(?:@\s*(?:interface|implementation|protocol|class|import)\b|#\s*import\b)/u.test(source) &&
    /(?:\b(?:namespace|template)\b|\bstd\s*::|(?<!@)\bclass\s+\w+)/u.test(source)
} satisfies NavigationSyntaxDefinition;
