import { composerTagSchemas, type ComposerFileReference } from '@myagentroam/protocol';

export function normalizeComposerReferences(value: unknown): readonly ComposerFileReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((entry) => {
    const result = composerTagSchemas.mar_references.shape.references.element.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

export interface FileReferenceMatch {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export interface FileReferenceEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'FILE' | 'DIRECTORY';
}

export function fileReferenceAtCursor(
  value: string,
  cursor = value.length
): FileReferenceMatch | undefined {
  const end = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, end);
  const match = /(?:^|\s)@([^\s"]*)$/.exec(beforeCursor);
  if (match === null) return undefined;
  const query = match[1] ?? '';
  return { query, start: end - query.length - 1, end };
}

export function insertFileReference(
  value: string,
  cursor: number,
  path: string
): { readonly value: string; readonly cursor: number } {
  const match = fileReferenceAtCursor(value, cursor);
  if (match === undefined) return { value, cursor };
  const reference = /[\s"\\]/u.test(path) ? `@${JSON.stringify(path)}` : `@${path}`;
  const separator = /\s/u.test(value[match.end] ?? '') ? '' : ' ';
  const next = `${value.slice(0, match.start)}${reference}${separator}${value.slice(match.end)}`;
  return { value: next, cursor: match.start + reference.length + separator.length };
}
