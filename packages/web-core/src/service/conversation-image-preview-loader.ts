import { conversationPreviewUrl } from '../util/conversation-image-url.js';

export interface LoadedImagePreview {
  readonly url: string;
  readonly resized: boolean;
  readonly release: () => void;
}

/** Direct images load through the browser; a fetched preview owns its temporary URL. */
export async function loadConversationImagePreview(
  source: string,
  original: boolean,
  signal: AbortSignal,
  direct = false
): Promise<LoadedImagePreview> {
  if (direct || !source.startsWith('/api/'))
    return { url: source, resized: false, release: () => {} };
  const url = original
    ? source
    : conversationPreviewUrl(source, { maxWidth: 2560, maxHeight: 2560 });
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('IMAGE_PREVIEW_FAILED');
  const resized = response.headers.get('x-mar-image-resized');
  if (!original && resized !== '0' && resized !== '1') throw new Error('IMAGE_PREVIEW_INVALID');
  const blob = await response.blob();
  signal.throwIfAborted();
  const objectUrl = URL.createObjectURL(blob);
  return {
    url: objectUrl,
    resized: !original && resized === '1',
    release: () => URL.revokeObjectURL(objectUrl)
  };
}
