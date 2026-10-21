import type { NavigationLanguageId } from '@myagentroam/code-navigation';
import type { PathSpecifierResolver } from './path-specifier-resolver.js';

export interface NavigationResolutionDefinition {
  readonly languageId: NavigationLanguageId;
  readonly resolver: PathSpecifierResolver;
}
