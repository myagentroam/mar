import type { FastifyReply } from 'fastify';
import { imagePreviewOptionsSchema } from '@myagentroam/protocol';
import { sendError } from './http-errors.js';

export interface ImagePreviewQuery {
  readonly maxWidth?: string;
  readonly maxHeight?: string;
}

export function parseImagePreviewQuery(query: ImagePreviewQuery) {
  return imagePreviewOptionsSchema
    .optional()
    .safeParse(
      query.maxWidth === undefined && query.maxHeight === undefined
        ? undefined
        : { maxWidth: Number(query.maxWidth), maxHeight: Number(query.maxHeight) }
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
  preview: boolean
) {
  const image = result.image;
  if (
    typeof image?.mime !== 'string' ||
    !image.mime.startsWith('image/') ||
    typeof image.dataBase64 !== 'string' ||
    (preview && (image.mime !== 'image/webp' || typeof image.resized !== 'boolean'))
  )
    return sendError(reply, 502, 'RUN_IMAGE_INVALID');
  if (preview) reply.header('x-mar-image-resized', image.resized ? '1' : '0');
  return reply.type(image.mime).send(Buffer.from(image.dataBase64, 'base64'));
}
