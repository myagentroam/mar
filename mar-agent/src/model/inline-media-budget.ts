import { AgentError } from '../error.js';
import { isModelImageUrl, type ModelImage } from './image.js';
import type { ModelRequest } from './contracts.js';
import { isRealUserMessage, uniqueModelImages } from './input-images.js';

export const REQUEST_INLINE_MEDIA_HARD_LIMIT = 12 * 1_048_576;

export function inlineMediaBytes(image: ModelImage): number {
  const bytes =
    image.dataBase64 !== undefined
      ? image.dataBase64.length
      : image.byteSize !== undefined
        ? 4 * Math.ceil(image.byteSize / 3)
        : undefined;
  if (bytes === undefined)
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Resource size is unavailable.');
  return bytes + Buffer.byteLength(`data:${image.mimeType};base64,`);
}

export function inlineMediaLimit(): never {
  throw new AgentError(
    'MAR_AGENT_INLINE_MEDIA_LIMIT',
    'Inline images exceed the 12 MiB request limit. Reduce this image batch or use view_image with resize or region before retrying.'
  );
}

/** Final encoding guard; URL-only images do not consume the inline budget. */
export function assertInlineMediaBudget(request: Pick<ModelRequest, 'messages' | 'images'>): void {
  let total = 0;
  const lastUser = request.messages.findLastIndex(isRealUserMessage);
  for (const [index, message] of request.messages.entries()) {
    const images =
      message.role === 'tool'
        ? message.textBlocks === undefined && message.contentParts !== undefined
          ? message.contentParts.flatMap((part) => (part.type === 'image' ? [part.image] : []))
          : (message.images ?? [])
        : message.role === 'user'
          ? uniqueModelImages(message.images, index === lastUser ? request.images : undefined)
          : [];
    for (const image of images)
      if (!isModelImageUrl(image.url) && image.dataBase64 !== undefined)
        total += inlineMediaBytes(image);
  }
  if (total > REQUEST_INLINE_MEDIA_HARD_LIMIT) inlineMediaLimit();
}
