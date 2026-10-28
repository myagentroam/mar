import type { FileReference, FileSpecifierRange } from './types.js';

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
