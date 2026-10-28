export type NavigationLanguageId =
  | 'css'
  | 'ecmascript'
  | 'go'
  | 'html'
  | 'jvm'
  | 'csharp'
  | 'less'
  | 'markdown'
  | 'python'
  | 'sass'
  | 'scss'
  | 'c'
  | 'cpp'
  | 'objective-c'
  | 'objective-cpp'
  | 'c-family'
  | 'rust'
  | 'vue';
export type FileReferenceKind = 'relative-file' | 'module' | 'namespace' | 'include';

export interface FileSpecifierRange {
  readonly value: string;
  readonly from: number;
  readonly to: number;
}

export interface FileReference extends FileSpecifierRange {
  readonly languageId: NavigationLanguageId;
  readonly extractorId: string;
  readonly kind: FileReferenceKind;
  readonly anchor?: string | undefined;
}

export interface FileSpecifierParser {
  readonly find: (line: string, column: number) => FileReference | undefined;
}

export type LanguageSyntaxProbe = (source: string) => boolean;

export interface NavigationSyntaxDefinition {
  readonly id: NavigationLanguageId;
  readonly parser: FileSpecifierParser;
  readonly hyphenSeparatesSymbol: boolean;
  readonly suffixes: readonly string[];
  readonly probe?: LanguageSyntaxProbe;
  readonly fallbackForAmbiguousSuffix?: boolean;
}

/** Pure source-name metadata for the bundled symbol index, not a file-reference parser. */
export interface SymbolNavigationLanguageDefinition {
  readonly id: string;
  readonly fileNamePatterns: readonly string[];
}
