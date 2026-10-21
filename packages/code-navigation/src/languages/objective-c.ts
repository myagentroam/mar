import { type NavigationSyntaxDefinition } from '../types.js';
import { createCPreprocessorFileSpecifierParser } from './c-preprocessor.js';

const objectiveCSyntax =
  /(?:@\s*(?:interface|implementation|protocol|class|import)\b|#\s*import\b)/u;

export const objectiveCFileSpecifierParser = createCPreprocessorFileSpecifierParser('objective-c');

export const objectiveCNavigationSyntaxDefinition = {
  id: 'objective-c',
  parser: objectiveCFileSpecifierParser,
  suffixes: ['.m', '.h'],
  probe: (source) =>
    objectiveCSyntax.test(source) &&
    !/(?:\b(?:namespace|template)\b|\bstd\s*::|(?<!@)\bclass\s+\w+)/u.test(source)
} satisfies NavigationSyntaxDefinition;
