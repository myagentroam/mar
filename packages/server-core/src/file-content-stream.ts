import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { sendError } from './http-errors.js';

export interface FileContentChunk {
  readonly size: number;
  readonly offset: number;
  readonly contentBase64: string;
}

/** Shared native resource response for account and share-authorized Workspace reads. */
export async function sendWorkspaceFileContent(input: {
  reply: FastifyReply;
  method: string;
  range: string | undefined;
  path: string;
  download: boolean;
  read: (offset: number, limit: number) => Promise<FileContentChunk>;
}): Promise<FastifyReply> {
  const { reply, read } = input;
  const first = await read(0, 1);
  const range = parseHttpByteRange(input.range, first.size);
  if (range === null) return sendError(reply, 416, 'FILE_RANGE_INVALID');
  const start = range?.start ?? 0;
  const end = range?.end ?? first.size - 1;
  const length = first.size === 0 ? 0 : end - start + 1;
  const filename = input.path.split('/').at(-1) ?? 'file';
  const contentType = fileContentType(filename);
  const media = contentType.startsWith('audio/') || contentType.startsWith('video/');
  if (!input.download && !media && range === undefined && length > 20 * 1024 * 1024)
    return sendError(reply, 413, 'FILE_PREVIEW_TOO_LARGE');
  reply
    .header('accept-ranges', 'bytes')
    .header('cache-control', 'private, no-store')
    .header('content-type', contentType)
    .header(
      'content-disposition',
      `${input.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    .header('x-content-type-options', 'nosniff');
  if (contentType === 'image/svg+xml') reply.header('content-security-policy', 'sandbox');
  if (range !== undefined && first.size > 0)
    reply.code(206).header('content-range', `bytes ${start}-${end}/${first.size}`);
  if (input.method === 'HEAD') return sendFileContentHead(reply, length);
  return reply
    .header('content-length', String(length))
    .send(Readable.from(fileContentChunks(read, start, end, 512 * 1024)));
}

export function sendFileContentHead(reply: FastifyReply, length: number): FastifyReply {
  reply.hijack();
  reply.raw.statusCode = reply.statusCode;
  for (const [name, value] of Object.entries(reply.getHeaders()))
    if (value !== undefined) reply.raw.setHeader(name, value);
  reply.raw.setHeader('content-length', String(length));
  reply.raw.end();
  return reply;
}

export async function* fileContentChunks(
  readChunk: (offset: number, limit: number) => Promise<FileContentChunk>,
  start: number,
  end: number,
  chunkSize: number
): AsyncGenerator<Buffer> {
  let offset = start;
  while (offset <= end) {
    const part = await readChunk(offset, Math.min(chunkSize, end - offset + 1));
    const content = Buffer.from(part.contentBase64, 'base64');
    if (part.offset !== offset || content.length === 0 || content.length > end - offset + 1)
      throw new Error('NODE_RESPONSE_INVALID');
    offset += content.length;
    yield content;
  }
}

export function parseHttpByteRange(
  value: string | undefined,
  size: number
): { readonly start: number; readonly end: number } | undefined | null {
  if (value === undefined) return undefined;
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/u.exec(value);
  if (match === null || size === 0) return null;
  if (match[3] !== undefined) {
    const suffixLength = Number(match[3]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  )
    return null;
  return { start, end: Math.min(size - 1, requestedEnd) };
}

export function fileContentType(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return (
    {
      avif: 'image/avif',
      aac: 'audio/aac',
      bmp: 'image/bmp',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      flac: 'audio/flac',
      gif: 'image/gif',
      ico: 'image/x-icon',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      m4a: 'audio/mp4',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      m4v: 'video/x-m4v',
      mov: 'video/quicktime',
      oga: 'audio/ogg',
      ogg: 'audio/ogg',
      ogv: 'video/ogg',
      pdf: 'application/pdf',
      png: 'image/png',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      svg: 'image/svg+xml',
      wav: 'audio/wav',
      webm: 'video/webm',
      webp: 'image/webp',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }[extension] ?? 'application/octet-stream'
  );
}
