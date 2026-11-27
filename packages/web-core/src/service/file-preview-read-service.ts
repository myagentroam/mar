import {
  binaryFilePreviewKind,
  decodeFilePreviewContent,
  FILE_TYPE_PROBE_LIMIT_BYTES,
  TEXT_FILE_PREVIEW_LIMIT_BYTES,
  usesHttpRangeFilePreview
} from '../util/file-preview.js';

/** Retains native HTTP image policy and lets media players seek without a full download. */
export function usesNativeHttpFilePreview(path: string): boolean {
  return binaryFilePreviewKind(path) === 'image' || usesHttpRangeFilePreview(path);
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
