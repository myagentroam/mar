import { fileSpecifierParser, type FileReference } from '@myagentroam/code-navigation';

const MAX_REFERENCE_REPARSE_POSITIONS = 8;

export interface RequestedFileReference {
  readonly value: string;
  readonly from: number;
  readonly to: number;
  readonly anchor?: string | undefined;
  readonly sourceContext: { readonly text: string; readonly position: number };
}

export function reparseFileReference(
  path: string,
  requested: RequestedFileReference
): FileReference | undefined {
  const parser = fileSpecifierParser(path, requested.sourceContext.text);
  if (parser === undefined) return undefined;
  for (const position of referenceCandidatePositions(requested)) {
    const parsed = parser.find(requested.sourceContext.text, position);
    if (parsed?.value === requested.value && parsed.anchor === requested.anchor) return parsed;
  }
  return undefined;
}

export function referenceCandidatePositions(requested: RequestedFileReference): readonly number[] {
  const source = requested.sourceContext.text;
  const requestedPosition = requested.sourceContext.position;
  const positions = new Set<number>([requestedPosition, requested.from, requested.to - 1]);
  const matches: number[] = [];
  for (let offset = source.indexOf(requested.value); offset >= 0;) {
    matches.push(offset);
    offset = source.indexOf(requested.value, offset + Math.max(1, requested.value.length));
  }
  matches
    .sort(
      (left, right) =>
        Math.abs(left - requestedPosition) - Math.abs(right - requestedPosition) || left - right
    )
    .slice(0, MAX_REFERENCE_REPARSE_POSITIONS - positions.size)
    .forEach((position) => positions.add(position));
  return [...positions].filter((position) => position >= 0 && position < source.length);
}
