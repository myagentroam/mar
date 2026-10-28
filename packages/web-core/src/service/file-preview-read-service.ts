import {
  decodeFilePreviewContent,
  FILE_TYPE_PROBE_LIMIT_BYTES,
  TEXT_FILE_PREVIEW_LIMIT_BYTES,
  usesHttpRangeFilePreview
} from '../util/file-preview.js';

/** Media stays URL-backed so native players can read and seek before the file is complete. */
export async function readFilePreviewObject<T>(
  path: string,
  readComplete: () => Promise<T | undefined>
): Promise<T | undefined> {
  return usesHttpRangeFilePreview(path) ? undefined : readComplete();
}

interface FilePreviewReadResult {
  readonly size?: number;
  readonly encoding: 'utf-8' | 'base64';
  readonly nextOffset: number | null;
  readonly revision?: string;
}

/** Relay reads preserve original base64 bytes; decoding is a read-only Web concern. */
export function decodeFilePreviewRead<
  T extends FilePreviewReadResult & { readonly content: string }
>(file: T, path: string): T & { readonly previewEncoding?: string } {
  if (file.encoding !== 'base64') return file;
  const bytes = Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0));
  return {
    ...file,
    ...decodeFilePreviewContent(bytes, path, file.nextOffset === null)
  };
}

/** Probe first; only confirmed, incomplete text needs a larger independent read. */
export async function readFilePreview<T extends FilePreviewReadResult>(
  read: (limit: number) => Promise<T>,
  isCurrent: () => boolean = () => true
): Promise<T> {
  const probe = await read(FILE_TYPE_PROBE_LIMIT_BYTES);
  if (probe.encoding !== 'utf-8' || probe.nextOffset === null || !isCurrent()) return probe;
  const preview = await read(TEXT_FILE_PREVIEW_LIMIT_BYTES);
  if (
    (probe.size !== undefined && preview.size !== undefined && probe.size !== preview.size) ||
    (probe.revision !== undefined &&
      preview.revision !== undefined &&
      probe.revision !== preview.revision)
  )
    throw new Error('FILE_PREVIEW_REVISION_CHANGED');
  return preview;
}
