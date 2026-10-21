import type { NavigationLanguageId } from '@myagentroam/code-navigation';
import {
  cFamilyNavigationResolutionDefinition,
  cNavigationResolutionDefinition,
  cppNavigationResolutionDefinition,
  objectiveCNavigationResolutionDefinition,
  objectiveCppNavigationResolutionDefinition
} from './c-family-path-specifier-resolver.js';
import { csharpNavigationResolutionDefinition } from './csharp-path-specifier-resolver.js';
import { ecmascriptNavigationResolutionDefinition } from './ecmascript-path-specifier-resolver.js';
import { goNavigationResolutionDefinition } from './go-path-specifier-resolver.js';
import { jvmNavigationResolutionDefinition } from './jvm-path-specifier-resolver.js';
import { markdownNavigationResolutionDefinition } from './markdown-path-specifier-resolver.js';
import type { NavigationResolutionDefinition } from './navigation-resolution-definition.js';
import { pythonNavigationResolutionDefinition } from './python-path-specifier-resolver.js';
import { rustNavigationResolutionDefinition } from './rust-path-specifier-resolver.js';
import type { PathSpecifierResolver } from './path-specifier-resolver.js';
import {
  cssNavigationResolutionDefinition,
  htmlNavigationResolutionDefinition,
  lessNavigationResolutionDefinition,
  sassNavigationResolutionDefinition,
  scssNavigationResolutionDefinition,
  vueNavigationResolutionDefinition
} from './stylesheet-path-specifier-resolver.js';

const definitionsByLanguage = {
  css: cssNavigationResolutionDefinition,
  ecmascript: ecmascriptNavigationResolutionDefinition,
  go: goNavigationResolutionDefinition,
  html: htmlNavigationResolutionDefinition,
  jvm: jvmNavigationResolutionDefinition,
  csharp: csharpNavigationResolutionDefinition,
  less: lessNavigationResolutionDefinition,
  markdown: markdownNavigationResolutionDefinition,
  python: pythonNavigationResolutionDefinition,
  sass: sassNavigationResolutionDefinition,
  scss: scssNavigationResolutionDefinition,
  c: cNavigationResolutionDefinition,
  cpp: cppNavigationResolutionDefinition,
  'objective-c': objectiveCNavigationResolutionDefinition,
  'objective-cpp': objectiveCppNavigationResolutionDefinition,
  'c-family': cFamilyNavigationResolutionDefinition,
  rust: rustNavigationResolutionDefinition,
  vue: vueNavigationResolutionDefinition
} satisfies Record<NavigationLanguageId, NavigationResolutionDefinition>;

export function navigationResolutionDefinitions(): readonly NavigationResolutionDefinition[] {
  return Object.values(definitionsByLanguage);
}

export function pathSpecifierResolver(
  languageId: NavigationLanguageId,
  specifier: string
): PathSpecifierResolver | undefined {
  const definition = definitionsByLanguage[languageId];
  return definition?.resolver.accepts(specifier) === true ? definition.resolver : undefined;
}
