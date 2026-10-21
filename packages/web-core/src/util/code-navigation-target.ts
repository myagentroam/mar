import {
  fileSpecifierParser,
  navigationSymbolAt,
  type FileReference
} from '@myagentroam/code-navigation';

export type CodeNavigationTarget =
  | {
      readonly kind: 'reference';
      readonly reference: FileReference;
      readonly from: number;
      readonly to: number;
    }
  | { readonly kind: 'symbol'; readonly value: string; readonly from: number; readonly to: number };

/**
 * Resolves a file reference before falling back to a JavaScript-style identifier.
 * Callers own their coordinate conversion and navigation lifecycle.
 */
export function navigationTargetAtTextPosition(
  path: string,
  lineText: string,
  characterOffset: number
): CodeNavigationTarget | undefined {
  const reference = fileSpecifierParser(path, lineText)?.find(lineText, characterOffset);
  if (reference !== undefined)
    return { kind: 'reference', reference, from: reference.from, to: reference.to };
  const symbol = navigationSymbolAt(path, lineText, characterOffset);
  return symbol === undefined ? undefined : { kind: 'symbol', ...symbol };
}
