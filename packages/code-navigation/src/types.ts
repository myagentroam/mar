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
  readonly suffixes: readonly string[];
  readonly probe?: LanguageSyntaxProbe;
  readonly fallbackForAmbiguousSuffix?: boolean;
}

/** Pure source-name metadata for the bundled symbol index, not a file-reference parser. */
export interface SymbolNavigationLanguageDefinition {
  readonly id: string;
  readonly fileNamePatterns: readonly string[];
}

export function rangeAtColumn(
  line: string,
  column: number,
  match: RegExpExecArray | null,
  value: string | undefined,
  metadata: Omit<FileReference, keyof FileSpecifierRange>,
  offset = 0
): FileReference | undefined {
  if (match === null || value === undefined || match.index === undefined) return undefined;
  const from = match.index + match[0].indexOf(value);
  return column >= from && column < from + value.length
    ? { value, from: offset + from, to: offset + from + value.length, ...metadata }
    : undefined;
}

export function sourceLineAt(
  source: string,
  position: number
): { readonly text: string; readonly column: number; readonly from: number } {
  const from = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const to = source.indexOf('\n', position);
  return {
    text: source.slice(from, to < 0 ? source.length : to),
    column: position - from,
    from
  };
}
