import type { FastifyReply } from 'fastify';
import { imagePreviewOptionsSchema, type ImagePreviewOptions } from '@myagentroam/protocol';
import { sendError } from './http-errors.js';

export interface ImagePreviewQuery {
  readonly maxWidth?: string;
  readonly maxHeight?: string;
  readonly originalGif?: string;
}

export function parseImagePreviewQuery(query: ImagePreviewQuery) {
  const hasBounds = query.maxWidth !== undefined || query.maxHeight !== undefined;
  return imagePreviewOptionsSchema.optional().safeParse(
    !hasBounds && query.originalGif === undefined
      ? undefined
      : {
          ...(hasBounds
            ? { maxWidth: Number(query.maxWidth), maxHeight: Number(query.maxHeight) }
            : {}),
          ...(query.originalGif === undefined ? {} : { originalGif: query.originalGif === '1' })
        }
  );
}

export interface ImageResourceResponse {
  readonly image?: {
    readonly mime?: unknown;
    readonly dataBase64?: unknown;
    readonly resized?: unknown;
  };
}

export function sendImageResource(
  reply: FastifyReply,
  result: ImageResourceResponse,
  preview?: ImagePreviewOptions
) {
  const image = result.image;
  const gif = preview !== undefined && 'originalGif' in preview;
  if (
    typeof image?.mime !== 'string' ||
    !image.mime.startsWith('image/') ||
    typeof image.dataBase64 !== 'string' ||
    (gif
      ? image.mime !== 'image/gif' || image.resized !== false
      : preview !== undefined &&
        (image.mime !== 'image/webp' || typeof image.resized !== 'boolean'))
  )
    return sendError(reply, 502, 'RUN_IMAGE_INVALID');
  if (preview !== undefined) reply.header('x-mar-image-resized', image.resized ? '1' : '0');
  return reply.type(image.mime).send(Buffer.from(image.dataBase64, 'base64'));
}
